import "server-only";
import { config } from "@/lib/server/config";
import {
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
 * How PostgREST and Postgres say "that table, column or function does not exist":
 * PGRST202 (no such function), PGRST204 (no such column), PGRST205 (no such table),
 * and Postgres's 42P01, 42703 and 42883 for the same three.
 */
const ABSENT = new Set([
  "PGRST202",
  "PGRST204",
  "PGRST205",
  "42P01",
  "42703",
  "42883",
]);

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
    const body = (await res.json().catch(() => null)) as {
      code?: unknown;
    } | null;
    return typeof body?.code === "string" && ABSENT.has(body.code)
      ? false
      : null;
  } catch {
    return null;
  }
}

export async function checkDatabase(
  transport?: SupabaseTransport,
  migrations: readonly ShippedMigration[] = MIGRATIONS,
): Promise<DatabaseCheck> {
  const request = supabaseRequest(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    transport,
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
 * every call and must not turn each into 14 database reads. A passing check is kept
 * for five minutes (migrations do not come undone), any other for 15 seconds. An
 * admin's Setup page asks afresh.
 */
const PASS_TTL_MS = 5 * 60_000;
const OTHER_TTL_MS = 15_000;

const holder = globalThis as unknown as {
  __emspDatabaseCheck?: { at: number; key: string; check: DatabaseCheck };
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
  const check = await (holder.__emspDatabaseCheckOverride ?? checkDatabase)();
  holder.__emspDatabaseCheck = { at: now, key, check };
  return check;
}

/** Tests only: use `check` instead of the database, and forget what was remembered. */
export function setDatabaseCheckForTests(
  check: (() => Promise<DatabaseCheck>) | undefined,
) {
  holder.__emspDatabaseCheckOverride = check;
  holder.__emspDatabaseCheck = undefined;
}
