import "server-only";
import { brand } from "@/brand";
import { ourParty } from "@/lib/ocpi/identity";
import {
  isWhitelistType,
  type Token,
  type WhitelistType,
} from "@/lib/ocpi/token-objects";
import { newAppUserUid, newContractId, normalizeRfidUid } from "./contract-id";
import { pushToken, type PushDeps, type PushOutcome } from "./push";
import type {
  DriverToken,
  DriverTokenType,
  TokenPatch,
  TokenStatus,
} from "./store";

/**
 * Issuing and changing our drivers' tokens. Every change is pushed to every CPO at once
 * (push.ts) and written to the audit log.
 *
 * - A driver gets one APP_USER token with a new contract ID (eMA ID) from our party.
 * - RFID cards belong to a driver that has an app token, and share its contract ID and
 *   group ID, so a CPO sees them as one contract.
 * - Blocking takes effect for real-time authorization at once, and for CPOs that
 *   cache tokens (whitelists) as soon as the push lands.
 */
export type TokenDeps = PushDeps & { actor: string };

export type TokenResult = { token: DriverToken; pushes: PushOutcome[] };

/** A refusal the admin may see. Never carries a token value or peer data. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

/**
 * When a CPO may let a token charge without asking us (OCPI 2.2.1 WhitelistType):
 *
 * - ALWAYS: never asks; blocks and expiries reach it only through pushes.
 * - ALLOWED: may ask, or may let the token charge from its cached copy, even while we
 *   are reachable.
 * - ALLOWED_OFFLINE: must ask us in real time; may let the token charge from its
 *   cached copy only when it cannot reach us.
 * - NEVER: must ask us in real time; no answer, no charging.
 *
 * The default, ALLOWED_OFFLINE, keeps every block, expiry and NO_CREDIT
 * checked while we are reachable, and lets drivers charge through an outage.
 */
export const DEFAULT_WHITELIST: WhitelistType = "ALLOWED_OFFLINE";

/**
 * RFID cards are always NEVER until RFID billing lands (a later part): a card has no
 * payment hold behind it, so a CPO must never let one charge from a cached copy. With
 * NEVER it asks us in real time, and we answer NOT_ALLOWED (see authorize.ts).
 */
export const RFID_WHITELIST: WhitelistType = "NEVER";

function rfidWhitelist(input: string | undefined): WhitelistType {
  if (input === undefined || input === "" || input === RFID_WHITELIST)
    return RFID_WHITELIST;
  throw new TokenError(
    "RFID cards are NEVER until RFID billing is available: a card has no payment hold.",
  );
}

/** Attempts at a compare-and-swap change before giving up. */
const MAX_ATTEMPTS = 5;

const DRIVER_REF = /^[\x21-\x7e]{1,64}$/;

function driverRef(input: string): string {
  const ref = input.trim();
  if (!DRIVER_REF.test(ref))
    throw new TokenError(
      "Driver reference must be 1 to 64 printable characters without spaces.",
    );
  return ref;
}

function whitelist(input: string | undefined): WhitelistType {
  if (input === undefined || input === "") return DEFAULT_WHITELIST;
  if (!isWhitelistType(input))
    throw new TokenError(
      "Whitelist must be ALWAYS, ALLOWED, ALLOWED_OFFLINE or NEVER.",
    );
  return input;
}

/**
 * OCPI last_updated for a change: now, but at least a second after the previous value,
 * so a CPO that keeps the newest version never mistakes two quick changes for one.
 */
export function nextLastUpdated(previous: string | null, now: Date): string {
  const t = Math.floor(now.getTime() / 1000) * 1000;
  const after = previous ? Date.parse(previous) + 1000 : 0;
  return new Date(Math.max(t, after)).toISOString();
}

async function audit(
  deps: TokenDeps,
  action: string,
  t: DriverToken,
  pushes: PushOutcome[],
  details: Record<string, unknown> = {},
) {
  await deps.peers.audit({
    actor: deps.actor,
    action,
    subjectId: t.id,
    // subjectId names the token; the details never repeat its uid or driver.
    details: {
      type: t.type,
      ...details,
      pushed_to: pushes.filter((p) => p.ok).map((p) => p.peerId),
      queued_for: pushes.filter((p) => !p.ok).map((p) => p.peerId),
    },
  });
}

/** A driver's app token, made with a new contract ID. One per driver. */
export async function createAppToken(
  input: { driverRef: string; whitelist?: string; language?: string },
  deps: TokenDeps,
): Promise<TokenResult> {
  const ref = driverRef(input.driverRef);
  const language = input.language?.trim().toLowerCase() || null;
  if (language && !/^[a-z]{2}$/.test(language))
    throw new TokenError("Language must be a 2-letter ISO 639-1 code.");
  const list = whitelist(input.whitelist);
  if ((await deps.tokens.listByDriver(ref)).some((t) => t.type === "APP_USER"))
    throw new TokenError("This driver already has an app token.");
  const now = deps.now?.() ?? new Date();
  const party = ourParty();
  let token: DriverToken | null = null;
  // A new uid (80 random bits) is never taken in practice; retry anyway.
  for (let i = 0; i < 3 && !token; i++) {
    const contractId = newContractId(party);
    token = await deps.tokens.insertToken({
      countryCode: party.countryCode,
      partyId: party.partyId,
      uid: newAppUserUid(),
      type: "APP_USER",
      contractId,
      driverRef: ref,
      visualNumber: null,
      groupId: contractId,
      issuer: brand.name.slice(0, 64),
      whitelist: list,
      language,
      expiresAt: null,
      lastUpdated: nextLastUpdated(null, now),
    });
  }
  if (!token) throw new TokenError("Could not create a token. Try again.");
  const pushes = await pushToken(token, { method: "PUT" }, deps);
  await audit(deps, "token.create", token, pushes);
  return { token, pushes };
}

/** An RFID card for a driver that has an app token, with its contract ID. */
export async function addRfidCard(
  input: {
    driverRef: string;
    uid: string;
    visualNumber?: string;
    expiresAt?: string;
    whitelist?: string;
  },
  deps: TokenDeps,
): Promise<TokenResult> {
  const ref = driverRef(input.driverRef);
  const uid = normalizeRfidUid(input.uid);
  if (!uid)
    throw new TokenError(
      "Card UID must be 4 to 36 letters and digits (separators are ignored).",
    );
  const visual = input.visualNumber?.trim() || null;
  if (visual && visual.length > 64)
    throw new TokenError("Printed number must be at most 64 characters.");
  let expiresAt: string | null = null;
  if (input.expiresAt?.trim()) {
    const ms = Date.parse(input.expiresAt.trim());
    if (Number.isNaN(ms)) throw new TokenError("Expiry must be a date.");
    expiresAt = new Date(ms).toISOString();
  }
  const list = rfidWhitelist(input.whitelist);
  const app = (await deps.tokens.listByDriver(ref)).find(
    (t) => t.type === "APP_USER",
  );
  if (!app)
    throw new TokenError(
      "This driver has no app token yet: create one first, then add the card.",
    );
  const now = deps.now?.() ?? new Date();
  const token = await deps.tokens.insertToken({
    countryCode: app.countryCode,
    partyId: app.partyId,
    uid,
    type: "RFID",
    contractId: app.contractId,
    driverRef: ref,
    visualNumber: visual,
    groupId: app.groupId,
    issuer: app.issuer,
    whitelist: list,
    language: app.language,
    expiresAt,
    lastUpdated: nextLastUpdated(null, now),
  });
  if (!token) throw new TokenError("This card is already registered.");
  const pushes = await pushToken(token, { method: "PUT" }, deps);
  await audit(deps, "token.create", token, pushes);
  return { token, pushes };
}

/**
 * Reads, changes and writes a token with compare-and-swap, then pushes the changed
 * fields. `change` returns the patch, or null when there is nothing to change.
 */
async function changeToken(
  uid: string,
  type: DriverTokenType,
  deps: TokenDeps,
  action: string,
  change: (t: DriverToken) => Omit<TokenPatch, "lastUpdated"> | null,
  fields: (keyof Token)[],
): Promise<TokenResult> {
  const key = uid.trim().toUpperCase();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const held = await deps.tokens.getToken(key, type);
    if (!held) throw new TokenError("No such token.");
    const patch = change(held);
    if (!patch) return { token: held, pushes: [] };
    const now = deps.now?.() ?? new Date();
    const token = await deps.tokens.updateToken(
      held.id,
      { ...patch, lastUpdated: nextLastUpdated(held.lastUpdated, now) },
      held.revision,
    );
    if (!token) continue;
    const pushes = await pushToken(token, { method: "PATCH", fields }, deps);
    await audit(deps, action, token, pushes, {
      from: held.status,
      to: token.status,
    });
    return { token, pushes };
  }
  throw new TokenError("The token changed meanwhile. Try again.");
}

/** Blocks a token: real-time authorization answers BLOCKED from now on. */
export function blockToken(
  uid: string,
  type: DriverTokenType,
  deps: TokenDeps,
): Promise<TokenResult> {
  return changeToken(
    uid,
    type,
    deps,
    "token.block",
    (t) => (t.status === "blocked" ? null : { status: "blocked" }),
    ["valid"],
  );
}

/** Unblocks a blocked token. An expired one stays expired. */
export function unblockToken(
  uid: string,
  type: DriverTokenType,
  deps: TokenDeps,
): Promise<TokenResult> {
  return changeToken(
    uid,
    type,
    deps,
    "token.unblock",
    (t) => {
      if (t.status === "expired")
        throw new TokenError("This token has expired; issue a new one.");
      return t.status === "blocked" ? { status: "active" } : null;
    },
    ["valid"],
  );
}

/** Changes when a CPO may let the token charge without asking us. */
export async function setWhitelist(
  uid: string,
  type: DriverTokenType,
  value: string,
  deps: TokenDeps,
): Promise<TokenResult> {
  const list = type === "RFID" ? rfidWhitelist(value) : whitelist(value);
  return changeToken(
    uid,
    type,
    deps,
    "token.whitelist",
    (t) => (t.whitelist === list ? null : { whitelist: list }),
    ["whitelist"],
  );
}

/**
 * Marks active tokens past their expiry as expired and pushes `valid: false`, for the
 * cron route. Real-time authorization answers EXPIRED from the expiry on, sweep or not.
 */
export async function expireTokens(
  deps: TokenDeps,
  { limit = 100 } = {},
): Promise<number> {
  const now = deps.now?.() ?? new Date();
  let expired = 0;
  for (const t of await deps.tokens.listExpired(now.toISOString(), limit)) {
    try {
      await changeToken(
        t.uid,
        t.type,
        deps,
        "token.expire",
        (held) =>
          held.status === "active" &&
          held.expiresAt &&
          Date.parse(held.expiresAt) <= now.getTime()
            ? { status: "expired" satisfies TokenStatus }
            : null,
        ["valid"],
      );
      expired++;
    } catch (e) {
      if (!(e instanceof TokenError)) throw e;
    }
  }
  return expired;
}

export const isDriverTokenType = (v: unknown): v is DriverTokenType =>
  v === "APP_USER" || v === "RFID";
