// Applies supabase/migrations/*.sql in filename order, in one transaction, and records
// each file in a ledger table so a second run applies only new files.
// Usage: npm run db:migrate (reads SUPABASE_DB_URL from .env.local).
import postgres from "postgres";
import { readFile, readdir } from "node:fs/promises";

if (!process.env.SUPABASE_DB_URL) {
  console.error(
    "Add SUPABASE_DB_URL to .env.local, or run the SQL files in supabase/migrations in filename order in the Supabase SQL editor.",
  );
  process.exit(1);
}

const sql = postgres(process.env.SUPABASE_DB_URL, {
  ssl: "require",
  max: 1,
  connect_timeout: 15,
});

try {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((f) => /^\d{12}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const applied = await sql.begin(async (tx) => {
    // One migration run at a time, even from two terminals.
    await tx`select pg_advisory_xact_lock(hashtext('cpo-starter-kit:migrations'))`;
    // The ledger follows the same rule as every table: RLS on, no anon/authenticated.
    await tx.unsafe(
      `create table if not exists public.cpo_schema_migrations (filename text primary key, applied_at timestamptz not null default now());
       alter table public.cpo_schema_migrations enable row level security;
       revoke all on public.cpo_schema_migrations from public, anon, authenticated;
       grant select on public.cpo_schema_migrations to service_role;`,
    );
    const known = new Set(
      (await tx`select filename from public.cpo_schema_migrations`).map(
        (row) => row.filename,
      ),
    );
    const changed = [];
    for (const filename of files) {
      if (known.has(filename)) continue;
      const source = await readFile(new URL(filename, directory), "utf8");
      // Every file runs inside this one transaction, together with its ledger row.
      await tx.unsafe(
        source.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, ""),
      );
      await tx`insert into public.cpo_schema_migrations(filename) values(${filename})`;
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
