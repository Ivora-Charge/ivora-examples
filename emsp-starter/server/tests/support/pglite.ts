import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import {
  LEDGER_SQL,
  listMigrations,
  stripTransaction,
} from "../../scripts/migrate.mjs";

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

/**
 * The parts of a Supabase database the migrations rely on: the Data API roles, the
 * service role (which bypasses RLS) and a minimal `auth` schema. Like a project
 * created after the 10-30 change, nothing has default grants; see LEGACY_DEFAULTS
 * for older projects.
 */
const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema if not exists auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;
`;

/**
 * Older Supabase projects grant every new table, sequence and function in `public`
 * to the Data API roles by default. Migrations must stay closed there too, which is
 * why the 10-30 check asks for an explicit revoke on every new table and function.
 */
const LEGACY_DEFAULTS = `
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

/**
 * A fresh in-memory Postgres with every migration applied, the way `npm run db:migrate`
 * applies them. `legacyDefaults` models a project created before the 10-30 change.
 */
export async function migratedDatabase({
  legacyDefaults = false,
  before,
}: {
  legacyDefaults?: boolean;
  /** Stops before this migration file, to test an upgrade with `applyMigrations`. */
  before?: string;
} = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  if (legacyDefaults) await db.exec(LEGACY_DEFAULTS);
  await db.exec(LEDGER_SQL);
  await applyMigrations(db, { before });
  return db;
}

/**
 * Applies, in one transaction, the migrations not yet in the ledger (those before
 * `before`, if given), the way `npm run db:migrate` does.
 */
export async function applyMigrations(
  db: PGlite,
  { before }: { before?: string } = {},
): Promise<void> {
  const { rows } = await db.query<{ filename: string }>(
    "select filename from public.emsp_schema_migrations",
  );
  const done = new Set(rows.map((r) => r.filename));
  await db.transaction(async (tx) => {
    for (const file of await listMigrations(MIGRATIONS)) {
      if (done.has(file) || (before && file >= before)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS), "utf8");
      await tx.exec(stripTransaction(sql));
      await tx.query(
        "insert into public.emsp_schema_migrations (filename) values ($1)",
        [file],
      );
    }
  });
}

/** Runs `fn` as a database role, then switches back. */
export async function asRole<T>(
  db: PGlite,
  role: "anon" | "authenticated" | "service_role",
  fn: () => Promise<T>,
): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}
