// The 10-30 rule for Supabase migrations, as a static check over the SQL files:
//
// 1. Every table created in the public schema enables row-level security in the same
//    migration.
// 2. No default grants (`alter default privileges ... grant`) and no schema-wide
//    grants (`grant ... on all tables in schema`).
// 3. A table grant to a Data API role (anon, authenticated, or public) needs a policy
//    on that table, in the same migration or an earlier one.
//
// Grants to service_role need no policy: the server's role bypasses RLS.
// The PGlite tests check the same rules against the migrated database.

const DATA_API_ROLES = new Set(["anon", "authenticated", "public"]);

/**
 * Replaces comments with a space, and string literals and dollar-quoted bodies
 * (function bodies) with `''`, since they may contain any text, including `;`.
 */
export function stripNoise(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (!tag) {
        out += c;
        i++;
        continue;
      }
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      out += "''";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** `public.foo`, `"public"."foo"` or `foo` -> `public.foo`; other schemas keep theirs. */
function tableName(raw) {
  const parts = raw.replace(/"/g, "").toLowerCase().split(".");
  return parts.length === 1 ? `public.${parts[0]}` : parts.join(".");
}

const NAME = String.raw`((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)`;
const CREATE_TABLE = new RegExp(
  String.raw`^create\s+(?:(?:global\s+|local\s+)?(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}`,
  "i",
);
const ENABLE_RLS = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+.*\benable\s+row\s+level\s+security`,
  "is",
);
const CREATE_POLICY = new RegExp(
  String.raw`^create\s+policy\s+(?:"[^"]+"|[\w$]+)\s+on\s+${NAME}`,
  "i",
);
const GRANT =
  /^grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?\s*$/i;
const NON_TABLE_OBJECT =
  /^(schema|function|functions|procedure|procedures|routine|routines|sequence|sequences|type|domain|database|language|foreign|large|tablespace|parameter)\b/i;

/**
 * Checks migrations in order. `files` is a list of `{ name, sql }`.
 * Returns a list of `{ file, message }`; empty means the rules hold.
 */
export function checkMigrations(files) {
  const problems = [];
  const policies = new Set();
  for (const { name, sql } of files) {
    const statements = stripNoise(sql)
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const created = [];
    const rls = new Set();
    for (const s of statements) {
      let m;
      if ((m = CREATE_TABLE.exec(s))) {
        const table = tableName(m[1]);
        if (
          /^create\s+(?:(?:global\s+|local\s+)?(?:temp|temporary)\s)/i.test(s)
        )
          continue;
        if (table.startsWith("public.")) created.push(table);
      } else if ((m = ENABLE_RLS.exec(s))) {
        rls.add(tableName(m[1]));
      } else if ((m = CREATE_POLICY.exec(s))) {
        policies.add(tableName(m[1]));
      }
    }
    for (const s of statements) {
      if (/^alter\s+default\s+privileges\b/i.test(s) && /\bgrant\b/i.test(s)) {
        problems.push({
          file: name,
          message: `default grants are not allowed: "${s.slice(0, 80)}"`,
        });
        continue;
      }
      const m = GRANT.exec(s);
      if (!m) continue;
      const roles = m[3]
        .split(",")
        .map((r) => r.trim().replace(/"/g, "").toLowerCase());
      const exposed = roles.filter((r) => DATA_API_ROLES.has(r));
      if (exposed.length === 0) continue;
      const target = m[2].trim();
      if (/^all\s+tables\s+in\s+schema\b/i.test(target)) {
        problems.push({
          file: name,
          message: `schema-wide table grant to ${exposed.join(", ")} is not allowed`,
        });
        continue;
      }
      if (NON_TABLE_OBJECT.test(target)) continue;
      const tables = target
        .replace(/^table\s+/i, "")
        .split(",")
        .map((t) => tableName(t.trim()));
      for (const table of tables)
        if (!policies.has(table))
          problems.push({
            file: name,
            message: `grant on ${table} to ${exposed.join(", ")} without a policy on ${table}`,
          });
    }
    for (const table of created)
      if (!rls.has(table))
        problems.push({
          file: name,
          message: `${table} is created without "alter table ${table} enable row level security"`,
        });
  }
  return problems;
}
