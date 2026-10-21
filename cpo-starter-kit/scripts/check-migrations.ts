// The 10-30 rule for Supabase migrations, checked in CI (npm run check:migrations):
//
// - Every table created in the public schema enables row level security and revokes
//   all privileges from anon and authenticated in the same file, so nothing is exposed
//   through the Data API by default (older projects grant both roles everything).
// - A GRANT to anon or authenticated names explicit privileges (never ALL), and each
//   privilege on each table has a matching RLS policy for that role.
// - No default privileges are granted, RLS is never disabled, and public views run
//   with security_invoker.
// - Every public function revokes EXECUTE from PUBLIC (Postgres grants it by default)
//   and is never granted to anon.
//
// The parser is deliberately small: it understands the statement shapes these
// migrations use and fails closed on a table it cannot match to its RLS statement.
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface MigrationFile {
  name: string;
  sql: string;
}

type Policy = { table: string; command: string; roles: string[] };

const BROWSER_ROLES = ["anon", "authenticated"];
const COMMANDS = ["select", "insert", "update", "delete"];

/** Strip comments and the bodies of string and dollar-quoted literals. */
function normalize(sql: string): string {
  return sql
    .replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "$$body$$")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .toLowerCase();
}

function statements(sql: string): string[] {
  return normalize(sql)
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** `public.x`, `x` (public by default) or `other.x` (null: not public). */
function publicName(raw: string): string | null {
  const name = raw.replace(/"/g, "");
  if (!name.includes(".")) return name;
  const [schema, rel] = name.split(".");
  return schema === "public" ? rel : null;
}

const IDENT = String.raw`(?:"?[a-z_][a-z0-9_$]*"?\.)?"?[a-z_][a-z0-9_$]*"?`;

function list(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Privileges in a GRANT list, without column lists: `select (a, b), insert` → [select, insert]. */
function privileges(s: string): string[] {
  return list(s.replace(/\([^)]*\)/g, "")).map((p) => p.split(" ")[0]);
}

export function checkMigrations(files: MigrationFile[]): string[] {
  const problems: string[] = [];
  const policies: Policy[] = [];

  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const say = (msg: string) => problems.push(`${file.name}: ${msg}`);
    const stmts = statements(file.sql);
    const tables = new Set<string>();
    const rls = new Set<string>();
    const revoked: Record<string, Set<string>> = {};
    const functions = new Set<string>();
    const revokedFunctions = new Set<string>();
    const grants: { tables: string[]; privs: string[]; roles: string[] }[] = [];

    for (const st of stmts) {
      let m: RegExpMatchArray | null;
      if (
        (m = st.match(
          new RegExp(
            String.raw`^create (?:unlogged )?table (?:if not exists )?(${IDENT})`,
          ),
        ))
      ) {
        const t = publicName(m[1]);
        if (t) tables.add(t);
      } else if (
        (m = st.match(
          new RegExp(
            String.raw`^alter table (?:if exists )?(?:only )?(${IDENT}) (enable|disable|force|no force) row level security`,
          ),
        ))
      ) {
        const t = publicName(m[1]);
        if (t && m[2] === "enable") rls.add(t);
        if (t && m[2] === "disable") say(`disables RLS on ${t}`);
      } else if ((m = st.match(/^create (?:or replace )?view (\S+)/))) {
        const v = publicName(m[1]);
        if (v && !/security_invoker\s*=\s*(true|on)/.test(st))
          say(`view ${v} must use security_invoker = true`);
      } else if (
        (m = st.match(
          new RegExp(String.raw`^create (?:or replace )?function (${IDENT})`),
        ))
      ) {
        const f = publicName(m[1]);
        if (f) functions.add(f);
      } else if (/^alter default privileges .* grant /.test(st)) {
        say("grants default privileges");
      } else if (
        (m = st.match(
          /^create policy (?:"[^"]*"|\S+) on (\S+)(?: as (?:permissive|restrictive))?(?: for (all|select|insert|update|delete))?(?: to ([a-z_, ]+?))?(?: using| with check|$)/,
        ))
      ) {
        const t = publicName(m[1]);
        if (t)
          policies.push({
            table: t,
            command: m[2] ?? "all",
            roles: m[3] ? list(m[3]) : ["public"],
          });
      } else if (
        (m = st.match(/^revoke (.+?) on (?:table )?(.+?) from (.+)$/)) &&
        !/^(function|all functions|schema|sequence|all )/.test(m[2])
      ) {
        const roles = list(m[3]);
        for (const raw of list(m[2])) {
          const t = publicName(raw);
          if (t) for (const r of roles) (revoked[t] ??= new Set()).add(r);
        }
      } else if (
        (m = st.match(/^revoke (?:all|execute) on function (.+?) from (.+)$/))
      ) {
        const roles = list(m[2]);
        const f = publicName(m[1].replace(/\(.*$/, "").trim());
        if (f && roles.includes("public")) revokedFunctions.add(f);
      } else if ((m = st.match(/^grant (.+?) on function (.+?) to (.+)$/))) {
        const f = publicName(m[2].replace(/\(.*$/, "").trim());
        if (f && list(m[3]).includes("anon"))
          say(`grants function ${f} to anon`);
      } else if ((m = st.match(/^grant (.+?) on (.+?) to (.+)$/))) {
        const target = m[2];
        const roles = list(m[3]).filter((r) => BROWSER_ROLES.includes(r));
        if (!roles.length || /^(schema|sequence|all sequences)/.test(target))
          continue;
        if (/^all tables/.test(target)) {
          say(`grants all tables to ${roles.join(", ")}`);
          continue;
        }
        const tablesInGrant = list(target.replace(/^table /, ""))
          .map(publicName)
          .filter((t): t is string => Boolean(t));
        const privs = privileges(m[1]);
        if (privs.includes("all")) {
          say(
            `grants ALL on ${tablesInGrant.join(", ")} to ${roles.join(", ")}`,
          );
          continue;
        }
        for (const p of privs)
          if (!COMMANDS.includes(p))
            say(
              `grants ${p} on ${tablesInGrant.join(", ")} to ${roles.join(", ")}`,
            );
        grants.push({ tables: tablesInGrant, privs, roles });
      }
    }

    for (const t of tables) {
      if (!rls.has(t)) say(`creates public.${t} without enabling RLS`);
      for (const r of BROWSER_ROLES)
        if (!revoked[t]?.has(r))
          say(`creates public.${t} without revoking all from ${r}`);
    }
    for (const f of functions)
      if (!revokedFunctions.has(f))
        say(
          `creates function public.${f} without revoking EXECUTE from public`,
        );
    // Policies may come later in the same file, so grants are checked at the end.
    for (const g of grants)
      for (const t of g.tables)
        for (const r of g.roles)
          for (const p of g.privs.filter((x) => COMMANDS.includes(x)))
            if (
              !policies.some(
                (pol) =>
                  pol.table === t &&
                  (pol.command === "all" || pol.command === p) &&
                  (pol.roles.includes(r) || pol.roles.includes("public")),
              )
            )
              say(
                `grants ${p} on public.${t} to ${r} without a matching policy`,
              );
  }
  return problems;
}

export function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, "utf8") }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const files = readMigrations("supabase/migrations");
  const problems = checkMigrations(files);
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exitCode = 1;
  else console.log(`✓ ${files.length} migration file(s) follow the 10-30 rule`);
}
