// Applies supabase/migrations/*.sql in filename order, each once, recorded in
// public.emsp_schema_migrations. All pending files run in one transaction under an
// advisory lock, so a failure leaves the database unchanged and two runs cannot
// interleave.
//
// Usage: npm run db:migrate (reads SUPABASE_DB_URL from .env.local).
// Without it, run the files in filename order in the Supabase SQL editor instead.
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

export async function listMigrations(directory) {
  return (await readdir(directory))
    .filter((f) => MIGRATION_NAME.test(f))
    .sort();
}

/** Files carry their own begin/commit for the SQL editor; the runner supplies one transaction. */
export function stripTransaction(sql) {
  return sql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
}

async function main() {
  if (!process.env.SUPABASE_DB_URL) {
    console.error(
      "Add SUPABASE_DB_URL to .env.local, or run the SQL files in supabase/migrations in filename order in the Supabase SQL editor.",
    );
    process.exit(1);
  }
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.SUPABASE_DB_URL, {
    ssl: "require",
    max: 1,
    connect_timeout: 15,
    onnotice: () => {},
  });
  try {
    const directory = new URL("../supabase/migrations/", import.meta.url);
    const files = await listMigrations(directory);
    const applied = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('emsp-starter:migrations'))`;
      await tx.unsafe(LEDGER_SQL);
      const recorded =
        await tx`select filename from public.emsp_schema_migrations`;
      const known = new Set(recorded.map((row) => row.filename));
      const changed = [];
      for (const filename of files) {
        if (known.has(filename)) continue;
        const source = await readFile(new URL(filename, directory), "utf8");
        await tx.unsafe(stripTransaction(source));
        await tx`insert into public.emsp_schema_migrations (filename) values (${filename})`;
        changed.push(filename);
      }
      return changed;
    });
    console.log(
      applied.length
        ? `Migrations applied: ${applied.join(", ")}`
        : "Schema is current. No changes applied.",
    );
  } catch (error) {
    // The error code only: messages can echo connection details.
    console.error("Migration failed:", error?.code ?? "connection error");
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
