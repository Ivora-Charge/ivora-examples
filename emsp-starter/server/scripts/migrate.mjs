// Applies supabase/migrations/*.sql in filename order, each once, recorded in
// public.emsp_schema_migrations. All pending files run in one transaction under an
// advisory lock, so a failure leaves the database unchanged and two runs cannot
// interleave.
//
// Usage: npm run db:migrate (reads SUPABASE_DB_URL from .env.local, else
// POSTGRES_URL_NON_POOLING, else POSTGRES_URL: the names the Supabase integration of
// the Vercel Marketplace sets).
// Without any of them, run the files in filename order in the Supabase SQL editor instead.
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Migration files are named `<YYYYMMDDNNNN>_<name>.sql`. */
export const MIGRATION_NAME = /^\d{12}_[a-z0-9_]+\.sql$/;

/** The ledger follows the 10-30 rule too: RLS on, service role only. */
export const LEDGER_SQL = `
create table if not exists public.emsp_schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
alter table public.emsp_schema_migrations enable row level security;
revoke all on table public.emsp_schema_migrations from public, anon, authenticated;
grant select, insert on table public.emsp_schema_migrations to service_role;
`;

/** The connection string's names, the first one set wins. */
export const DB_URL_NAMES = [
  "SUPABASE_DB_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
];

// Parameters of a pooled connection string that are not Postgres settings. The driver
// would send them to the server as if they were.
const NOT_FOR_THE_SERVER = ["supa", "pgbouncer"];

/**
 * The connection string and the name it came from, or undefined. As in
 * lib/server/config.ts, an empty value or `demo` counts as unset.
 */
export function databaseUrl(env) {
  for (const name of DB_URL_NAMES) {
    let url = env[name]?.trim();
    if (!url || url.toLowerCase() === "demo") continue;
    // Cut as text: a password need not be URL-encoded the way `URL` would rewrite it.
    for (const parameter of NOT_FOR_THE_SERVER)
      url = url.replace(
        new RegExp(`([?&])${parameter}=[^&#]*(&|(?=#)|$)`, "g"),
        "$1",
      );
    return { name, url: url.replace(/[?&]+(?=#|$)/, "") };
  }
  return undefined;
}

export async function listMigrations(directory) {
  return (await readdir(directory))
    .filter((f) => MIGRATION_NAME.test(f))
    .sort();
}

/** Files carry their own begin/commit for the SQL editor; the runner supplies one transaction. */
export function stripTransaction(sql) {
  return sql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
}

/** A failed migration: the file it failed in (none when it failed before any) and the error code. */
export class MigrationError extends Error {
  constructor(file, code) {
    super(
      file
        ? `Migration failed in ${file}: ${code}.`
        : `Migration failed: ${code}.`,
    );
    this.name = "MigrationError";
    this.file = file;
    this.code = code;
  }
}

/**
 * Applies the pending files in `directory` through `sql` (a postgres.js client): one
 * transaction, under an advisory lock, recorded in the ledger. Returns the files applied.
 * Throws a MigrationError that holds the file name and the error code only: a driver's
 * message can echo connection details or a row value.
 */
export async function applyPending(sql, directory) {
  const files = await listMigrations(directory);
  let current;
  try {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('emsp-starter:migrations'))`;
      await tx.unsafe(LEDGER_SQL);
      const recorded =
        await tx`select filename from public.emsp_schema_migrations`;
      const known = new Set(recorded.map((row) => row.filename));
      const changed = [];
      for (const filename of files) {
        if (known.has(filename)) continue;
        current = filename;
        const source = await readFile(new URL(filename, directory), "utf8");
        await tx.unsafe(stripTransaction(source));
        await tx`insert into public.emsp_schema_migrations (filename) values (${filename})`;
        changed.push(filename);
      }
      current = undefined;
      return changed;
    });
  } catch (error) {
    const code =
      typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/i.test(error.code)
        ? error.code
        : "connection error";
    throw new MigrationError(current, code);
  }
}

export const MIGRATIONS_DIRECTORY = new URL(
  "../supabase/migrations/",
  import.meta.url,
);

/**
 * Connects with `database` (from databaseUrl) and applies the pending migrations.
 * Logs names only, never the connection string: it holds the database password.
 */
export async function migrate(database, { log = console.log } = {}) {
  log(`Connecting with ${database.name}.`);
  const { default: postgres } = await import("postgres");
  const sql = postgres(database.url, {
    ssl: "require",
    max: 1,
    // A transaction-mode pooler (POSTGRES_URL) keeps no prepared statements.
    prepare: false,
    connect_timeout: 15,
    onnotice: () => {},
  });
  try {
    const applied = await applyPending(sql, MIGRATIONS_DIRECTORY);
    log(
      applied.length
        ? `Migrations applied: ${applied.join(", ")}`
        : "Schema is current. No changes applied.",
    );
    return applied;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function main() {
  const database = databaseUrl(process.env);
  if (!database) {
    console.error(
      `Add ${DB_URL_NAMES[0]} (or ${DB_URL_NAMES.slice(1).join(" or ")}) to .env.local, or run the SQL files in supabase/migrations in filename order in the Supabase SQL editor.`,
    );
    process.exit(1);
  }
  try {
    await migrate(database);
  } catch (error) {
    console.error(
      error instanceof MigrationError
        ? error.message
        : "Migration failed: connection error.",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
