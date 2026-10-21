#!/usr/bin/env node
// node tools/check-migrations <migrations dir> [--schema <name>]...
//
// Exits 0 when every migration follows the 10-30 rule, 1 with one line per problem
// otherwise, and 2 on a usage error. Needs Node 22 and no npm install.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkMigrations } from "./check.mjs";

const USAGE =
  "Usage: node tools/check-migrations <migrations dir> [--schema <name>]...";

const args = process.argv.slice(2);
const schemas = [];
let dir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--schema" && args[i + 1]) schemas.push(args[++i]);
  else if (!dir && !args[i].startsWith("-")) dir = args[i];
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
if (!dir || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(dir ? `Not a directory: ${dir}` : USAGE);
  process.exit(2);
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
if (!files.length) {
  console.error(`No .sql files in ${dir}`);
  process.exit(2);
}
const problems = checkMigrations(files, {
  schemas: schemas.length ? schemas : undefined,
});
for (const p of problems) console.error(`✗ ${p}`);
if (problems.length) {
  console.error(
    `\n${problems.length} problem(s). The 10-30 rule: see tools/check-migrations/README.md.`,
  );
  process.exit(1);
}
console.log(`✓ ${files.length} migration file(s) follow the 10-30 rule`);
