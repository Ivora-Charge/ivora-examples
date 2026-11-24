import "server-only";
import { config } from "@/lib/server/config";
import {
  ABSENT_CODES,
  errorCode,
  supabaseRequest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import { MIGRATIONS, type ShippedMigration } from "./migrations";

/**
 * Setup's database check: which of the shipped migrations the database has, by file
 * name. Names of this build's own files only; no row is read.
 *
 * - "ok": every shipped migration is applied.
 * - "pending": some are, and `pending` names the others.
 * - "empty": none is. The database has no tables.
 * - "unreachable": a probe got no answer, or one that is not about the schema (a
 *   refused key, a server error), so nothing is known.
 */
export type DatabaseCheck = {
  state: "ok" | "pending" | "empty" | "unreachable";
  /** How many migrations this build ships. */
  shipped: number;
  applied: number;
  /** File names of the shipped migrations the database does not have. */
  pending: string[];
  /** File name of the newest shipped migration. */
  newest: string | null;
};

/**
 * How long a probe may take. Shorter than the stores' requests: the public status API
 * and the Setup page a visitor gets wait for the check, and a database that does not
 * answer must not hold them. Past it, the answer is "unreachable".
 */
export const PROBE_TIMEOUT_MS = 2_500;

/** True: applied. False: not applied. Null: the answer says nothing about the schema. */
async function probe(
  request: ReturnType<typeof supabaseRequest>,
  { probe: p }: ShippedMigration,
): Promise<boolean | null> {
  try {
    const res =
      "rpc" in p
        ? await request("POST", `rpc/${p.rpc}`, p.args)
        : await request("GET", `${p.table}?select=${p.column}&limit=0`);
    if (res.ok) {
      await res.body?.cancel();
      return true;
    }
    const code = await errorCode(res);
    return code !== null && ABSENT_CODES.has(code) ? false : null;
  } catch {
    return null;
  }
}

export async function checkDatabase(
  transport?: SupabaseTransport,
  migrations: readonly ShippedMigration[] = MIGRATIONS,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<DatabaseCheck> {
  const request = supabaseRequest(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    transport,
    timeoutMs,
  );
  const found = await Promise.all(migrations.map((m) => probe(request, m)));
  const base = {
    shipped: migrations.length,
    newest: migrations.at(-1)?.file ?? null,
  };
  if (found.some((f) => f === null))
    return { ...base, state: "unreachable", applied: 0, pending: [] };
  const pending = migrations.filter((_, i) => !found[i]).map((m) => m.file);
  const applied = migrations.length - pending.length;
  return {
    ...base,
    state: !pending.length ? "ok" : applied ? "pending" : "empty",
    applied,
    pending,
  };
}

/**
 * The check, remembered for a while per server process: the public status API asks on
 * every call and must not turn each into a round of database reads. A passing check
 * is kept for five minutes (migrations do not come undone), any other for 15 seconds.
 *
 * Callers that arrive while a round of probes is under way wait for that round and
 * share its answer, so any number of concurrent calls costs one round. An admin's
 * Setup page asks afresh: past what is remembered, but it too joins a round already
 * under way rather than start a second.
 */
const PASS_TTL_MS = 5 * 60_000;
const OTHER_TTL_MS = 15_000;

const holder = globalThis as unknown as {
  __emspDatabaseCheck?: { at: number; key: string; check: DatabaseCheck };
  __emspDatabaseCheckFlight?: { key: string; round: Promise<DatabaseCheck> };
  __emspDatabaseCheckOverride?: () => Promise<DatabaseCheck>;
};

export async function databaseCheck({
  fresh = false,
  now = Date.now(),
} = {}): Promise<DatabaseCheck> {
  // Another database is another answer (tests change the environment in one process).
  const key = config.supabaseUrl;
  const kept = holder.__emspDatabaseCheck;
  if (
    !fresh &&
    kept &&
    kept.key === key &&
    now - kept.at < (kept.check.state === "ok" ? PASS_TTL_MS : OTHER_TTL_MS)
  )
    return kept.check;
  const flying = holder.__emspDatabaseCheckFlight;
  if (flying?.key === key) return flying.round;
  // Started through a promise, so a check that throws at once is shared the same way.
  const round = Promise.resolve()
    .then(() => (holder.__emspDatabaseCheckOverride ?? checkDatabase)())
    .then((check) => {
      holder.__emspDatabaseCheck = { at: now, key, check };
      return check;
    })
    .finally(() => {
      if (holder.__emspDatabaseCheckFlight?.round === round)
        holder.__emspDatabaseCheckFlight = undefined;
    });
  holder.__emspDatabaseCheckFlight = { key, round };
  return round;
}

/** Tests only: use `check` instead of the database, and forget what was remembered. */
export function setDatabaseCheckForTests(
  check: (() => Promise<DatabaseCheck>) | undefined,
) {
  holder.__emspDatabaseCheckOverride = check;
  holder.__emspDatabaseCheck = undefined;
  holder.__emspDatabaseCheckFlight = undefined;
}
