import "server-only";
import { createHash } from "node:crypto";
import { atLeast } from "@/lib/roles";
import { AccessDeniedError } from "../auth";
import {
  idempotencyKey,
  IvoraError,
  type IvoraClient,
  type TokenRecord,
  type TokenUpdate,
} from "../ivora";
import type { OnboardingStore } from "../onboarding/types";
import type { PricingStore } from "../pricing/types";
import { localDate, nextDate, zonedToUtc } from "../pricing/time";
import type { Staff } from "../team/types";
import {
  cardKey,
  cardValueProblem,
  formatLabel,
  holderKind,
  holderName,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  isCardIntent,
  maskCard,
  OCPP16_MAX,
  parseCardsCsv,
  parseLabel,
  REQUEST_ID,
  validDate,
  type CardIntent,
  type CsvCard,
} from "./input";
import {
  FleetError,
  type Card,
  type CardDetail,
  type CardLedger,
  type CardRow,
  type CardsView,
  type CardState,
  type CardUsage,
} from "./types";
import type { ImportLine, ImportOutcome } from "@/lib/cards-state";

// The optional fleet module: RFID cards in Ivora's token list (`/tokens`), each
// labelled for a driver or a vehicle, and each card's sessions and energy from the
// kit's card ledger. Ivora holds the cards; the kit keeps no copy of them. Cards are
// project-wide: Ivora authorizes a card at every charger of the project, private ones
// included.

export interface FleetDeps {
  ivora: IvoraClient;
  ledger: CardLedger;
  /** Private chargers (Pricing): cards and staff only. */
  pricing: Pick<PricingStore, "load">;
  /** The company's time zone, for expiry dates and session times. */
  company: Pick<OnboardingStore, "load">;
  /** FLEET_MODULE is on. */
  enabled: boolean;
  now?: () => number;
}

const DAY_MS = 86_400_000;
/** The periods the Cards pages offer, in days. */
export const PERIODS = [7, 30, 90, 365] as const;
/** Sessions listed on a card's page. */
export const CARD_SESSIONS = 200;

/** Everyone on the team sees the cards; owners and managers change them. */
function allowed(actor: Staff, min: "viewer" | "manager") {
  if (!atLeast(actor.role, min)) throw new AccessDeniedError(min);
}

function enabled(d: FleetDeps) {
  if (!d.enabled)
    throw new FleetError(
      "off",
      "The Cards module is off. Set FLEET_MODULE=1 in the deployment's environment to turn it on.",
    );
}

const clock = (d: FleetDeps) => (d.now ?? Date.now)();

export function parseDays(raw: string | null | undefined): number {
  const n = Number(raw);
  return (PERIODS as readonly number[]).includes(n) ? n : 30;
}

/** The kit's own staff and free charging tokens: in the list, but not cards. */
export function isKitToken(t: Pick<TokenRecord, "external_reference">) {
  const r = t.external_reference ?? "";
  return r.startsWith("cpo-staff-") || r.startsWith("cpo-free-");
}

/** The external_reference of a card added from the kit: from its value, never stored. */
export const cardReference = (value: string) =>
  `cpo-card-${createHash("sha256").update(value.toUpperCase()).digest("hex").slice(0, 24)}`;

export function cardState(
  t: Pick<TokenRecord, "status" | "expires_at">,
  now: number,
): CardState {
  if (t.status === "Blocked") return "blocked";
  if (t.status === "Expired") return "expired";
  if (t.status !== "Accepted") return "other";
  if (t.expires_at && Date.parse(t.expires_at) <= now) return "expired";
  return "active";
}

export function toCard(t: TokenRecord, now: number): Card {
  return {
    id: t.id,
    masked: maskCard(t.id_token),
    key: cardKey(t.id_token),
    holder: parseLabel(t.label),
    status: t.status,
    state: cardState(t, now),
    expiresAt: t.expires_at ?? null,
    ocpp16: t.ocpp16_compatible ?? t.id_token.length <= OCPP16_MAX,
    revision: t.updated_at ?? t.created_at ?? "unknown",
    kit: (t.external_reference ?? "").startsWith("cpo-card-"),
  };
}

/** How many tokens in the list end in each 4 characters. */
function keyCounts(tokens: TokenRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) {
    const k = cardKey(t.id_token);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

const NONE: CardUsage = { sessions: 0, running: 0, energyWh: 0 };

async function zoneOf(d: FleetDeps, actor: Staff): Promise<string> {
  try {
    return (await d.company.load(actor.operatorId)).timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

function ledgerError(e: unknown): string {
  console.error("cpo-starter-kit: card ledger read failed:", {
    error: e instanceof Error ? e.name : "error",
  });
  return "Could not read the card sessions. If you run this deployment, check that the migrations ran (see the README).";
}

async function privateChargers(d: FleetDeps, actor: Staff) {
  try {
    const priv = (await d.pricing.load(actor.operatorId)).stations.filter(
      (s) => s.private,
    );
    if (!priv.length) return [];
    const names = new Map(
      (await d.ivora.listAllStations()).data.map((s) => [s.id, s.name]),
    );
    return priv
      .filter((s) => names.has(s.stationId))
      .map((s) => ({ id: s.stationId, name: names.get(s.stationId)! }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // A convenience on this page: Pricing shows them too.
    return [];
  }
}

export const STATE_FILTERS = ["all", "active", "blocked", "expired"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

export async function loadCards(
  d: FleetDeps,
  actor: Staff,
  q: {
    days?: string | null;
    state?: string | null;
    search?: string | null;
  } = {},
): Promise<CardsView> {
  allowed(actor, "viewer");
  enabled(d);
  const now = clock(d);
  const days = parseDays(q.days);
  const listed = await d.ivora.listAllTokens();
  const counts = keyCounts(listed.data);
  let usage = new Map<string, CardUsage>();
  let usageError: string | null = null;
  try {
    usage = new Map(
      (await d.ledger.usage(now - days * DAY_MS, now + 1)).map(
        ({ key, ...u }) => [key, u],
      ),
    );
  } catch (e) {
    usageError = ledgerError(e);
  }
  const all: CardRow[] = listed.data
    .filter((t) => !isKitToken(t))
    .map((t) => {
      const card = toCard(t, now);
      const sharedWith = (counts.get(card.key) ?? 1) - 1;
      return {
        ...card,
        sharedWith,
        usage: sharedWith ? null : (usage.get(card.key) ?? NONE),
      };
    })
    .sort(
      (a, b) =>
        a.holder.name.localeCompare(b.holder.name, "en", {
          sensitivity: "base",
        }) || a.id - b.id,
    );
  const state = (STATE_FILTERS as readonly string[]).includes(q.state ?? "")
    ? (q.state as StateFilter)
    : "all";
  const search = (q.search ?? "").trim().toLowerCase().slice(0, 80);
  const cards = all.filter(
    (c) =>
      (state === "all" || c.state === state) &&
      (!search ||
        c.holder.name.toLowerCase().includes(search) ||
        // The last characters of the card, as staff read them off it.
        (search.length <= 4 && c.key.toLowerCase().endsWith(search))),
  );
  return {
    demo: d.ivora.mode === "demo",
    cards,
    total: all.length,
    truncated: listed.truncated,
    days,
    zone: await zoneOf(d, actor),
    usageError,
    privateChargers: await privateChargers(d, actor),
  };
}

const notFound = () =>
  new FleetError(
    "not_found",
    "This card is not in your Ivora token list (it may have been deleted there).",
  );

async function readCard(d: FleetDeps, id: number): Promise<TokenRecord> {
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
  try {
    const t = await d.ivora.getToken(id);
    if (isKitToken(t)) throw notFound();
    return t;
  } catch (e) {
    if (e instanceof IvoraError && e.status === 404) throw notFound();
    throw e;
  }
}

export async function loadCard(
  d: FleetDeps,
  actor: Staff,
  id: number,
  daysRaw?: string | null,
): Promise<CardDetail> {
  allowed(actor, "viewer");
  enabled(d);
  const now = clock(d);
  const days = parseDays(daysRaw);
  const t = await readCard(d, id);
  const card = toCard(t, now);
  const same = (await d.ivora.listAllTokens()).data.filter(
    (x) => x.id !== t.id && cardKey(x.id_token) === card.key,
  );
  const shared = same.length > 0;
  let usage: CardUsage | null = null;
  let sessions: CardDetail["sessions"] = [];
  let usageError: string | null = null;
  try {
    const since = now - days * DAY_MS;
    const [all, rows] = await Promise.all([
      d.ledger.usage(since, now + 1),
      d.ledger.sessions(card.key, since, now + 1, CARD_SESSIONS),
    ]);
    if (!shared) {
      const found = all.find((u) => u.key === card.key);
      usage = found
        ? {
            sessions: found.sessions,
            running: found.running,
            energyWh: found.energyWh,
          }
        : NONE;
    }
    let names = new Map<number, string>();
    if (rows.length)
      try {
        names = new Map(
          (await d.ivora.listAllStations()).data.map((s) => [s.id, s.name]),
        );
      } catch {
        // Names are a convenience: the station IDs still show.
      }
    sessions = rows.map((r) => ({
      ...r,
      stationName: names.get(r.stationId) ?? null,
    }));
  } catch (e) {
    usageError = ledgerError(e);
  }
  return {
    demo: d.ivora.mode === "demo",
    card,
    usage,
    sharedWith: same.filter((x) => !isKitToken(x)).map((x) => toCard(x, now)),
    sharedOther: same.filter(isKitToken).length,
    sessions,
    days,
    zone: await zoneOf(d, actor),
    usageError,
  };
}

function sharedWarning(n: number, masked: string) {
  return n
    ? `${n === 1 ? "Another token in your list ends" : `${n} other tokens in your list end`} in the same 4 characters as ${masked}. Ivora shows only the last 4 characters of a session's card, so the kit can't tell their sessions apart and shows no figures for them.`
    : null;
}

export interface AddCardForm {
  value?: string;
  kind?: string;
  name?: string;
  requestId?: string;
}

export interface CardAdded {
  card: Card;
  warnings: string[];
}

/**
 * Adds a card to Ivora's token list (`POST /tokens`, type ISO14443, Accepted). The key
 * comes from the form's random request ID, so a double submit makes one card; the
 * external_reference from the value, so a create that may have happened is found.
 */
export async function addCard(
  d: FleetDeps,
  actor: Staff,
  form: AddCardForm,
): Promise<CardAdded> {
  allowed(actor, "manager");
  enabled(d);
  const value = (form.value ?? "").trim();
  const problems: string[] = [];
  const bad = cardValueProblem(value);
  if (bad) problems.push(`Card value: ${bad}`);
  const kind = holderKind(form.kind);
  if (!kind) problems.push("Holder: choose a driver or a vehicle.");
  const name = holderName(form.name ?? "");
  if ("problem" in name) problems.push(`Name: ${name.problem}`);
  if (!REQUEST_ID.test(form.requestId ?? ""))
    problems.push("Reload the page and try again.");
  if (problems.length)
    throw new FleetError("invalid", problems[0], problems.slice(1));
  const label = formatLabel(kind!, (name as { name: string }).name);
  const reference = cardReference(value);
  const now = clock(d);

  const tokens = (await d.ivora.listAllTokens()).data;
  const same = tokens.find(
    (t) => t.id_token.toUpperCase() === value.toUpperCase(),
  );
  // A repeated submit of the same add: the card is there, as asked.
  const replay =
    same && same.external_reference === reference && same.label === label;
  if (same && isKitToken(same))
    throw new FleetError(
      "kit_token",
      "This value is the kit's own staff or free charging token, so it can't be a card.",
    );
  if (same && !replay)
    throw new FleetError(
      "exists",
      `This card is already in your list (${maskCard(same.id_token)}${same.label ? `, ${same.label}` : ""}). Open it to change its holder or status.`,
    );

  let created: TokenRecord;
  if (replay) created = same;
  else
    try {
      created = await d.ivora.createToken(
        {
          id_token: value,
          type: "ISO14443",
          status: "Accepted",
          label,
          external_reference: reference,
        },
        idempotencyKey("card", form.requestId!, "create"),
      );
    } catch (e) {
      if (e instanceof IvoraError && e.code === "token_exists")
        throw new FleetError(
          "exists",
          "This card is already in your Ivora token list. Reload the page to see it.",
        );
      if (e instanceof IvoraError && e.code === "token_reserved")
        throw new FleetError(
          "invalid",
          "Card value: Ivora keeps this kind of value for payment tokens; it can't be a card.",
        );
      throw e;
    }
  console.info("cpo-starter-kit: card added", {
    user: actor.userId,
    action: "card_add",
    card: created.id,
  });
  const card = toCard(created, now);
  const others = tokens.filter(
    (t) => t.id !== created.id && cardKey(t.id_token) === card.key,
  ).length;
  const warnings = [
    sharedWarning(others, card.masked),
    card.ocpp16
      ? null
      : `This value is longer than ${OCPP16_MAX} characters: OCPP 1.6 chargers can't read it (OCPP 2.0.1 chargers can).`,
  ].filter((w): w is string => w !== null);
  return { card, warnings };
}

interface Prepared {
  /** Rows to send, in file order. */
  rows: CsvCard[];
  /** Lines refused before anything was sent. */
  local: ImportLine[];
}

/** Reads the file and refuses what Ivora would refuse, or must not get. */
async function prepareImport(d: FleetDeps, text: string): Promise<Prepared> {
  if (Buffer.byteLength(text, "utf8") > IMPORT_MAX_BYTES)
    throw new FleetError(
      "invalid",
      `The file is larger than ${IMPORT_MAX_BYTES / 1024} KB. Split it into smaller files.`,
    );
  const parsed = parseCardsCsv(text);
  if (!parsed.rows.length && !parsed.errors.length)
    throw new FleetError(
      "invalid",
      "The file has no cards. Each line is: card, holder (driver or vehicle), name.",
    );
  if (parsed.rows.length > IMPORT_MAX_ROWS)
    throw new FleetError(
      "invalid",
      `The file has ${parsed.rows.length} cards; import at most ${IMPORT_MAX_ROWS} at a time.`,
    );
  const kit = new Set(
    (await d.ivora.listAllTokens()).data
      .filter(isKitToken)
      .map((t) => t.id_token.toUpperCase()),
  );
  const local: ImportLine[] = parsed.errors.map((e) => ({
    line: e.line,
    masked: null,
    label: null,
    action: "error",
    message: e.message,
  }));
  const rows: CsvCard[] = [];
  for (const r of parsed.rows) {
    if (kit.has(r.value.toUpperCase()))
      local.push({
        line: r.line,
        masked: maskCard(r.value),
        label: formatLabel(r.kind, r.name),
        action: "error",
        message:
          "This value is the kit's own staff or free charging token, so it can't be a card.",
      });
    else rows.push(r);
  }
  return { rows, local };
}

function outcome(
  dryRun: boolean,
  p: Prepared,
  res: Awaited<ReturnType<IvoraClient["importTokens"]>> | null,
): ImportOutcome {
  const counts = {
    create: res?.counts.create ?? 0,
    update: res?.counts.update ?? 0,
    unchanged: res?.counts.unchanged ?? 0,
    error: (res?.counts.error ?? 0) + p.local.length,
  };
  const lines = [...p.local];
  for (const r of res?.rows ?? []) {
    const sent = p.rows[r.row - 1];
    if (!sent) continue;
    lines.push({
      line: sent.line,
      masked: maskCard(sent.value),
      label: formatLabel(sent.kind, sent.name),
      action: r.action,
      message:
        r.action === "error"
          ? `${r.message ?? "Refused"}${r.code ? ` (${r.code})` : ""}`
          : null,
    });
  }
  lines.sort((a, b) => a.line - b.line);
  return { dryRun, counts, lines, sendable: p.rows.length };
}

const importRows = (rows: CsvCard[]) =>
  rows.map((r) => ({ id_token: r.value, label: formatLabel(r.kind, r.name) }));

/**
 * Checks an import file without changing anything: the kit's own rules first, then
 * Ivora's plan for the rest (`POST /tokens/import?dry_run=true`, which stores nothing).
 */
export async function checkImport(
  d: FleetDeps,
  actor: Staff,
  text: string,
): Promise<ImportOutcome> {
  allowed(actor, "manager");
  enabled(d);
  const p = await prepareImport(d, text);
  const res = p.rows.length
    ? await d.ivora.importTokens(importRows(p.rows), { dryRun: true })
    : null;
  return outcome(true, p, res);
}

/**
 * Imports the cards of a checked file (`POST /tokens/import`). Each row carries the
 * card's value and holder label only: no status, so an import never unblocks a card,
 * and no external_reference, so cards set up elsewhere keep theirs. Re-running a file
 * is safe (Ivora reports applied rows unchanged). The key comes from the rows and the
 * form's request ID: a double submit is one import, and after an uncertain answer a
 * new try gets a new key, as Ivora asks.
 */
export async function applyImport(
  d: FleetDeps,
  actor: Staff,
  text: string,
  requestId: string,
): Promise<ImportOutcome> {
  allowed(actor, "manager");
  enabled(d);
  if (!REQUEST_ID.test(requestId))
    throw new FleetError(
      "invalid",
      "Reload the page and check the file again.",
    );
  const p = await prepareImport(d, text);
  if (!p.rows.length)
    throw new FleetError(
      "invalid",
      "No line of the file can be imported. Fix the lines listed and check it again.",
    );
  const rows = importRows(p.rows);
  const digest = createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex")
    .slice(0, 24);
  let res;
  try {
    res = await d.ivora.importTokens(rows, {
      dryRun: false,
      key: idempotencyKey("card-import", `${digest}-${requestId}`, "apply"),
    });
  } catch (e) {
    if (
      e instanceof IvoraError &&
      (e.code === "outcome_unknown" || e.code === "request_in_progress")
    )
      throw new FleetError(
        "uncertain",
        "Ivora could not confirm the import, so some cards may be in and others not. Check the file and import it again: cards already in are reported unchanged.",
      );
    throw e;
  }
  console.info("cpo-starter-kit: cards imported", {
    user: actor.userId,
    action: "card_import",
    created: res.counts.create ?? 0,
    updated: res.counts.update ?? 0,
    errors: res.counts.error ?? 0,
  });
  return outcome(false, p, res);
}

export interface CardForm {
  intent?: string;
  revision?: string;
  kind?: string;
  name?: string;
  /** YYYY-MM-DD, the last day the card works (in the company's time zone). */
  date?: string;
}

export interface CardChanged {
  card: Card;
  /** False when the card already was as asked (a repeated submit): nothing was sent. */
  changed: boolean;
  message: string;
}

/** The last day an expiry leaves the card working, in `zone`. */
export function lastValidDay(expiresAt: string, zone: string): string {
  return localDate(zone, Date.parse(expiresAt) - 1);
}

const sameTime = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? null) === (b ?? null) ||
  (a != null && b != null && Date.parse(a) === Date.parse(b));

/** Is every field of `body` already the card's? */
function alreadyApplied(t: TokenRecord, body: TokenUpdate): boolean {
  return (
    (body.status === undefined || body.status === t.status) &&
    (body.label === undefined || body.label === (t.label ?? null)) &&
    (body.expires_at === undefined || sameTime(body.expires_at, t.expires_at))
  );
}

function changeOf(
  intent: CardIntent,
  t: TokenRecord,
  form: CardForm,
  zone: string,
  now: number,
): TokenUpdate {
  switch (intent) {
    case "label": {
      const kind = holderKind(form.kind);
      const name = holderName(form.name ?? "");
      const problems = [
        kind ? null : "Holder: choose a driver or a vehicle.",
        "problem" in name ? `Name: ${name.problem}` : null,
      ].filter((p): p is string => p !== null);
      if (problems.length)
        throw new FleetError("invalid", problems[0], problems.slice(1));
      return { label: formatLabel(kind!, (name as { name: string }).name) };
    }
    case "block":
      return { status: "Blocked" };
    case "expire":
      return { status: "Expired" };
    case "unblock":
      // An expiry date that has passed would still refuse the card: clear it too.
      return t.expires_at && Date.parse(t.expires_at) <= now
        ? { status: "Accepted", expires_at: null }
        : { status: "Accepted" };
    case "expiry": {
      if (!validDate(form.date))
        throw new FleetError("invalid", "Valid until: pick a date.");
      if (form.date < localDate(zone, now))
        throw new FleetError(
          "invalid",
          "Valid until: pick today or a later date. To stop the card now, use Expire now or Block.",
        );
      // The card works through that whole day in the company's time zone.
      return {
        expires_at: zonedToUtc(
          nextDate(form.date),
          "00:00",
          zone,
        ).toISOString(),
      };
    }
    case "clear-expiry":
      return { expires_at: null };
  }
}

function changedMessage(intent: CardIntent, c: Card, zone: string): string {
  switch (intent) {
    case "label":
      return `Card ${c.masked} is now labelled "${formatLabel(c.holder.kind ?? "driver", c.holder.name)}".`;
    case "block":
      return `Card ${c.masked} is blocked: Ivora refuses it at its next tap.`;
    case "expire":
      return `Card ${c.masked} is expired: Ivora refuses it at its next tap.`;
    case "unblock":
      return `Card ${c.masked} is active again.`;
    case "expiry":
      return `Card ${c.masked} works until the end of ${lastValidDay(c.expiresAt!, zone)} (${zone}).`;
    case "clear-expiry":
      return `Card ${c.masked} no longer has an expiry date.`;
  }
}

/**
 * Changes a card (`PATCH /tokens/{id}`): its holder label, block, unblock, expire now,
 * or an expiry date. The form names the card's revision (Ivora's updated_at) it was
 * loaded at; a change over a newer one is refused unless the card already is as asked.
 * The key comes from the card, the action and that revision, so a retry is one change.
 */
export async function updateCard(
  d: FleetDeps,
  actor: Staff,
  id: number,
  form: CardForm,
): Promise<CardChanged> {
  allowed(actor, "manager");
  enabled(d);
  if (!isCardIntent(form.intent) || !form.revision)
    throw new FleetError("invalid", "Reload the page and try again.");
  const intent = form.intent;
  const now = clock(d);
  const zone = await zoneOf(d, actor);
  const t = await readCard(d, id);
  const body = changeOf(intent, t, form, zone, now);
  if (alreadyApplied(t, body)) {
    const card = toCard(t, now);
    return {
      card,
      changed: false,
      message: changedMessage(intent, card, zone),
    };
  }
  if ((t.updated_at ?? t.created_at ?? "unknown") !== form.revision)
    throw new FleetError(
      "stale",
      "Someone changed this card since you opened this page. Reload it to see their change, then make yours again.",
    );
  const digest = createHash("sha256")
    .update(`${form.revision}\n${JSON.stringify(body)}`)
    .digest("hex")
    .slice(0, 16);
  let updated: TokenRecord;
  try {
    updated = await d.ivora.updateToken(
      id,
      body,
      idempotencyKey("card", id, `${intent}-${digest}`),
    );
  } catch (e) {
    if (e instanceof IvoraError && e.status === 404) throw notFound();
    throw e;
  }
  console.info("cpo-starter-kit: card changed", {
    user: actor.userId,
    action: `card_${intent.replace("-", "_")}`,
    card: id,
  });
  const card = toCard(updated, now);
  return { card, changed: true, message: changedMessage(intent, card, zone) };
}
