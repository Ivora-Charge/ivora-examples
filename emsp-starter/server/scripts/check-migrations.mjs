// CI check for the 10-30 rule over supabase/migrations (see migration-rules.mjs).
// Usage: node scripts/check-migrations.mjs [directory]
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { checkMigrations } from "./migration-rules.mjs";
import { LEDGER_SQL, MIGRATION_NAME } from "./migrate.mjs";

const directory = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]) + "/")
  : new URL("../supabase/migrations/", import.meta.url);

const problems = [];
const entries = (await readdir(directory)).sort();
for (const f of entries)
  if (f.endsWith(".sql") && !MIGRATION_NAME.test(f))
    problems.push({
      file: f,
      message:
        "name must be <YYYYMMDDNNNN>_<lower_snake_name>.sql, or it is never applied",
    });

const files = [
  { name: "scripts/migrate.mjs (ledger)", sql: LEDGER_SQL },
  ...(await Promise.all(
    entries
      .filter((f) => MIGRATION_NAME.test(f))
      .map(async (name) => ({
        name,
        sql: await readFile(new URL(name, directory), "utf8"),
      })),
  )),
];
problems.push(...checkMigrations(files));

for (const p of problems) console.error(`${p.file}: ${p.message}`);
if (problems.length) {
  console.error(
    `\n${problems.length} problem(s). Every public table needs RLS and an explicit revoke, every public function a revoke from public, no default grants, no execute grants to the Data API roles, and table grants to anon or authenticated need a policy.`,
  );
  process.exitCode = 1;
} else {
  console.log(`10-30 check passed for ${files.length - 1} migration(s).`);
}
