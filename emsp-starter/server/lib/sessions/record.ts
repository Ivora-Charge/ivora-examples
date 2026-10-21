import "server-only";
import { linkSession } from "@/lib/commands/manage";
import type { CommandStore } from "@/lib/commands/store";
import { OcpiProblem } from "@/lib/ocpi/errors";
import { ourParty } from "@/lib/ocpi/identity";
import { dateTimeMs } from "@/lib/ocpi/locations";
import {
  parseSession,
  type Cdr,
  type CdrToken,
  type Session,
} from "@/lib/ocpi/session-objects";
import type { Peer, PeerStore } from "@/lib/ocpi/store";
import { sameParty, STATUS, type Party } from "@/lib/ocpi/types";
import type { TokenStore } from "@/lib/tokens/store";
import { emitSessionEvent, type SessionEvent } from "./events";
import type {
  CdrSource,
  Links,
  SessionKey,
  SessionStore,
  StoredCdr,
  StoredSession,
} from "./store";

/**
 * Storing the sessions and CDRs a CPO sends, whether it pushes them to our Receiver
 * interfaces (receiver.ts) or we pull them from its Sender interfaces (pull.ts): both
 * go through here, so a session pushed and then pulled is stored once.
 *
 * Sessions, so that pushes and pulls may arrive in any order:
 * - Each field keeps the time (the CPO's `last_updated`) of the change that last set
 *   it. A change sets the fields it carries, and a whole session (PUT, or pulled) also
 *   removes the optional fields it lacks, but only where that field's time is not newer
 *   than the change's. So a late PATCH of kWh still lands after a newer PATCH of the
 *   status, and never undoes it.
 * - `charging_periods` are merged with ours by `start_date_time`, whatever the change's
 *   time (a CPO may send only the new periods, or all of them): none goes missing.
 * - `last_updated` is the newest we have seen. The result is validated as a whole.
 * - Every write is a compare-and-swap on the session's revision: two pushes at once
 *   both land.
 *
 * CDRs are stored once, exactly as they first arrive. The same CDR again is
 * acknowledged; one with the same ID and other content is a conflict, and the first
 * stays.
 *
 * Both are linked to the driver's charge request: the START_SESSION command whose
 * `authorization_reference` they carry (of the same peer and CPO party), and the token
 * (`cdr_token`, when it is one we issued). The command's driver comes first.
 */
export type SessionDeps = {
  sessions: SessionStore;
  commands: CommandStore;
  tokens: TokenStore;
  /** For the audit log. */
  peers: PeerStore;
  now?: () => Date;
  /** For the audit log. Default "system". */
  actor?: string;
};

/**
 * - `created`: stored for the first time.
 * - `updated`: a change we applied.
 * - `unchanged`: nothing new (the same again, or older than what we hold).
 */
export type SessionOutcome = {
  outcome: "created" | "updated" | "unchanged";
  session: StoredSession;
};

/**
 * - `created`: stored now.
 * - `duplicate`: we hold this CDR already, with the same content.
 * - `conflict`: we hold a CDR with this ID and other content: the first stays.
 */
export type CdrOutcome = {
  outcome: "created" | "duplicate" | "conflict";
  cdr: StoredCdr;
};

/** Attempts at a compare-and-swap write before giving up. */
export const MAX_WRITE_ATTEMPTS = 25;

const nowOf = (deps: SessionDeps) => (deps.now?.() ?? new Date()).toISOString();

/** Ended for us: no more charging, so the driver can be billed. */
const ENDED = ["COMPLETED", "INVALID"];

const busy = () =>
  new OcpiProblem(
    503,
    STATUS.SERVER_ERROR,
    "Too many concurrent changes to this session; try again",
  );

const pause = (attempt: number) =>
  new Promise((r) => setTimeout(r, Math.random() * Math.min(50, 2 ** attempt)));

/** JSON with sorted keys: the database does not keep key order. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
}

export const sessionKey = (peerId: string, s: Session): SessionKey => ({
  peerId,
  countryCode: s.country_code,
  partyId: s.party_id,
  sessionId: s.id,
});

async function audit(
  deps: SessionDeps,
  action: string,
  subjectId: string,
  details: Record<string, unknown>,
) {
  try {
    // The subject is ours; details never name the driver or the token.
    await deps.peers.audit({
      actor: deps.actor ?? "system",
      action,
      subjectId,
      details,
    });
  } catch (e) {
    console.error(
      `Audit of ${action} ${subjectId} failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
  }
}

async function emit(event: SessionEvent, deps: SessionDeps) {
  if (event.type === "cdr.received") {
    const { cdr } = event.cdr;
    await audit(deps, event.type, event.cdr.id, {
      peer_id: event.cdr.peerId,
      country_code: cdr.country_code,
      party_id: cdr.party_id,
      cdr_id: cdr.id,
      session_id: cdr.session_id ?? null,
      credit: cdr.credit ?? false,
      command_id: event.cdr.commandId,
      source: event.cdr.source,
    });
  } else if (event.type !== "session.updated") {
    const { session } = event.session;
    await audit(deps, event.type, event.session.id, {
      peer_id: event.session.peerId,
      country_code: session.country_code,
      party_id: session.party_id,
      session_id: session.id,
      status: session.status,
      command_id: event.session.commandId,
    });
  }
  await emitSessionEvent(event);
}

/** The driver of a token we issued, by its uid and type. */
async function tokenDriver(
  t: CdrToken,
  deps: SessionDeps,
): Promise<string | null> {
  if (
    !sameParty({ countryCode: t.country_code, partyId: t.party_id }, ourParty())
  )
    return null;
  if (t.type !== "APP_USER" && t.type !== "RFID") return null;
  return (
    (await deps.tokens.getToken(t.uid.toUpperCase(), t.type))?.driverRef ?? null
  );
}

/**
 * The links of a session or CDR: the start command by authorization_reference (of
 * this peer and the object's CPO party), else just the driver by token. A session
 * also links the command to itself (linkSession), so the driver can stop it.
 */
async function resolveLinks(
  peer: Peer,
  o: {
    country_code: string;
    party_id: string;
    authorization_reference?: string;
    cdr_token: CdrToken;
  },
  held: Links | null,
  deps: SessionDeps,
  sessionId?: string,
): Promise<Links> {
  let { driverRef, commandId } = held ?? { driverRef: null, commandId: null };
  const party: Party = { countryCode: o.country_code, partyId: o.party_id };
  if (!commandId && o.authorization_reference) {
    const c = await deps.commands.getByAuthorizationReference(
      o.authorization_reference,
    );
    const ours =
      c?.type === "START_SESSION" &&
      c.peerId === peer.id &&
      sameParty(party, { countryCode: c.toCountryCode, partyId: c.toPartyId });
    if (
      c &&
      ours &&
      (sessionId === undefined ||
        (await linkSession(
          {
            peerId: peer.id,
            authorizationReference: o.authorization_reference,
            sessionId,
            party,
          },
          { commands: deps.commands, now: deps.now },
        )))
    ) {
      commandId = c.id;
      driverRef = c.driverRef;
    }
  }
  driverRef ??= await tokenDriver(o.cdr_token, deps);
  return { driverRef, commandId };
}

const startMs = (p: unknown) => {
  const v = (p as { start_date_time?: unknown } | null)?.start_date_time;
  return typeof v === "string" ? dateTimeMs(v) : NaN;
};

/**
 * Our charging periods with `incoming` merged in by start_date_time: an incoming
 * period replaces ours with the same start, the rest are added, oldest first. Raw
 * values: the merged session is validated afterwards.
 */
function mergePeriods(held: unknown[], incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return incoming;
  const out = new Map<string, unknown>();
  const key = (p: unknown, i: number, side: string) => {
    const ms = startMs(p);
    return Number.isNaN(ms) ? `${side}${i}` : String(ms);
  };
  held.forEach((p, i) => out.set(key(p, i, "held"), p));
  incoming.forEach((p, i) => out.set(key(p, i, "new"), p));
  return [...out.values()].sort((a, b) => startMs(a) - startMs(b));
}

/**
 * The Session fields a change sets one by one. Not here: the IDs, which never change,
 * charging_periods and last_updated, which are merged, and anything 2.2.1 does not
 * define, which validation drops.
 */
const FIELDS = new Set<string>([
  "start_date_time",
  "end_date_time",
  "kwh",
  "cdr_token",
  "auth_method",
  "authorization_reference",
  "location_id",
  "evse_uid",
  "connector_id",
  "meter_id",
  "currency",
  "total_cost",
  "status",
] satisfies (keyof Session)[]);

/**
 * A change applied to the session we hold (null: none, so it is created). `whole`: a
 * whole session (PUT, pulled), which also removes the fields it lacks; else a PATCH.
 * The change's last_updated is a valid DateTime. Throws a 2001 when the result is not
 * a valid session.
 */
function applyChange(
  held: StoredSession | null,
  change: Record<string, unknown>,
  ids: { country_code: string; party_id: string; id: string },
  whole: boolean,
): { session: Session; fieldTimes: Record<string, string> } {
  const at = change.last_updated as string;
  const atMs = dateTimeMs(at);
  const base: Record<string, unknown> = { ...(held?.session ?? {}) };
  const times = { ...(held?.fieldTimes ?? {}) };
  const fields = new Set(Object.keys(change));
  if (whole) for (const f of Object.keys(base)) fields.add(f);
  for (const f of fields) {
    if (!FIELDS.has(f)) continue;
    // A field set by a newer change stays.
    if (times[f] !== undefined && dateTimeMs(times[f]) > atMs) continue;
    const v = change[f];
    if (v === undefined || v === null) delete base[f];
    else base[f] = v;
    times[f] = at;
  }
  if (change.charging_periods !== undefined)
    base.charging_periods = mergePeriods(
      held?.session.charging_periods ?? [],
      change.charging_periods,
    );
  base.last_updated =
    held && dateTimeMs(held.session.last_updated) > atMs
      ? held.session.last_updated
      : at;
  const parsed = parseSession({
    ...base,
    country_code: ids.country_code,
    party_id: ids.party_id,
    id: ids.id,
  });
  if (!parsed.ok)
    throw new OcpiProblem(
      400,
      STATUS.INVALID_PARAMETERS,
      `Invalid session: ${parsed.errors.slice(0, 10).join("; ")}`,
    );
  return { session: parsed.value, fieldTimes: times };
}

/**
 * Read, change, compare-and-swap. `change` gets the session we hold (null: none) and
 * returns the new version. Emits the events of the write that landed.
 */
async function writeSession(
  peer: Peer,
  key: SessionKey,
  change: (held: StoredSession | null) => {
    session: Session;
    fieldTimes: Record<string, string>;
  },
  deps: SessionDeps,
): Promise<SessionOutcome> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const held = await deps.sessions.getSession(key);
    const next = change(held);
    const changed =
      !held || canonical(next.session) !== canonical(held.session);
    if (held && !changed && held.driverRef && held.commandId)
      return { outcome: "unchanged", session: held };
    const links = await resolveLinks(
      peer,
      next.session,
      held,
      deps,
      next.session.id,
    );
    const ended =
      ENDED.includes(next.session.status) || (await deps.sessions.hasCdr(key));
    const now = nowOf(deps);
    const write = {
      ...next,
      ...links,
      completedAt: held?.completedAt ?? (ended ? now : null),
    };

    if (!held) {
      const created = await deps.sessions.insertSession(peer.id, write, now);
      if (!created) continue; // Another write created it first: apply on top.
      await emit({ type: "session.started", session: created }, deps);
      if (created.completedAt)
        await emit({ type: "session.completed", session: created }, deps);
      return { outcome: "created", session: created };
    }

    if (
      !changed &&
      links.driverRef === held.driverRef &&
      links.commandId === held.commandId &&
      write.completedAt === held.completedAt
    )
      return { outcome: "unchanged", session: held };
    const updated = await deps.sessions.updateSession(
      held.id,
      held.revision,
      changed ? write : { ...write, fieldTimes: held.fieldTimes },
      now,
    );
    if (!updated) {
      await pause(attempt);
      continue;
    }
    if (changed)
      await emit({ type: "session.updated", session: updated }, deps);
    if (!held.completedAt && updated.completedAt)
      await emit({ type: "session.completed", session: updated }, deps);
    return { outcome: changed ? "updated" : "unchanged", session: updated };
  }
  throw busy();
}

/**
 * Stores a whole session from `peer` (a PUT, or a pulled one), already validated, with
 * its party one of the peer's.
 */
export function recordSession(
  peer: Peer,
  incoming: Session,
  deps: SessionDeps,
): Promise<SessionOutcome> {
  return writeSession(
    peer,
    sessionKey(peer.id, incoming),
    (held) => applyChange(held, incoming, incoming, true),
    deps,
  );
}

/** A session we do not hold. 2.2.1 has no status for it: a client error. */
export class UnknownSessionError extends OcpiProblem {
  constructor() {
    super(404, STATUS.CLIENT_ERROR, "Unknown session");
    this.name = "UnknownSessionError";
  }
}

/**
 * Applies a PATCH from `peer` to the session at `key`. The patch carries a valid
 * last_updated (parsePatch). Throws UnknownSessionError when we hold no such session.
 */
export function patchSession(
  peer: Peer,
  key: SessionKey,
  patch: Record<string, unknown>,
  deps: SessionDeps,
): Promise<SessionOutcome> {
  return writeSession(
    peer,
    key,
    (held) => {
      if (!held) throw new UnknownSessionError();
      return applyChange(held, patch, held.session, false);
    },
    deps,
  );
}

/** Marks a session ended because its CDR arrived. */
async function completeByCdr(key: SessionKey, deps: SessionDeps) {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const held = await deps.sessions.getSession(key);
    if (!held || held.completedAt) return;
    const updated = await deps.sessions.updateSession(
      held.id,
      held.revision,
      {
        session: held.session,
        fieldTimes: held.fieldTimes,
        driverRef: held.driverRef,
        commandId: held.commandId,
        completedAt: nowOf(deps),
      },
      nowOf(deps),
    );
    if (updated) {
      await emit({ type: "session.completed", session: updated }, deps);
      return;
    }
    await pause(attempt);
  }
  throw busy();
}

/** The same CDR, whatever its key order or last_updated. */
const sameCdr = (a: Cdr, b: Cdr) =>
  canonical({ ...a, last_updated: "" }) ===
  canonical({ ...b, last_updated: "" });

/**
 * Stores a CDR from `peer` (POSTed, or pulled), already validated, with its party one
 * of the peer's. Never changes one we hold. A CDR for a session we hold ends that
 * session for us, even if the CPO has not said COMPLETED yet.
 */
export async function recordCdr(
  peer: Peer,
  cdr: Cdr,
  source: CdrSource,
  deps: SessionDeps,
): Promise<CdrOutcome> {
  const key = {
    peerId: peer.id,
    countryCode: cdr.country_code,
    partyId: cdr.party_id,
    cdrId: cdr.id,
  };
  const known = async (held: StoredCdr): Promise<CdrOutcome> => {
    if (sameCdr(held.cdr, cdr)) return { outcome: "duplicate", cdr: held };
    await audit(deps, "cdr.conflict", held.id, {
      peer_id: peer.id,
      country_code: cdr.country_code,
      party_id: cdr.party_id,
      cdr_id: cdr.id,
      source,
    });
    return { outcome: "conflict", cdr: held };
  };
  const held = await deps.sessions.getCdr(key);
  if (held) return known(held);

  const links = await resolveLinks(peer, cdr, null, deps);
  const stored = await deps.sessions.insertCdr(
    peer.id,
    { cdr, ...links, source },
    nowOf(deps),
  );
  if (!stored) {
    const first = await deps.sessions.getCdr(key);
    if (!first) throw new Error("CDR disappeared");
    return known(first);
  }
  await emit({ type: "cdr.received", cdr: stored }, deps);
  if (cdr.session_id && !cdr.credit)
    await completeByCdr(
      {
        peerId: peer.id,
        countryCode: cdr.country_code,
        partyId: cdr.party_id,
        sessionId: cdr.session_id,
      },
      deps,
    );
  return { outcome: "created", cdr: stored };
}
