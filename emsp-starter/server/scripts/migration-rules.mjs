// The 10-30 rule for Supabase migrations, as a static check over the SQL files:
//
// 1. Every table created in the public schema enables row-level security and runs
//    `revoke all on <table> from public, anon, authenticated` in the same migration.
//    The revoke keeps older Supabase projects, whose default privileges still grant
//    new tables to the Data API roles, as closed as new ones. No migration may
//    `disable row level security`.
// 2. No default grants (`alter default privileges ... grant`) and no schema-wide
//    grants (`grant ... on all tables/functions/... in schema`).
// 3. A table grant to a Data API role (anon, authenticated, or public) needs a policy
//    on that table, in the same migration or an earlier one.
// 4. Every function or procedure created in the public schema runs
//    `revoke execute (or all) on function <name> from public` in the same migration,
//    since Postgres grants EXECUTE to PUBLIC by default. No migration grants EXECUTE
//    to anon, authenticated or public: the app calls the server API, never an RPC.
// 5. Every `security definer` function sets `search_path`.
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
const DISABLE_RLS = /\bdisable\s+row\s+level\s+security\b/i;
const REVOKE =
  /^revoke\s+(?:grant\s+option\s+for\s+)?([\s\S]+?)\s+on\s+([\s\S]+?)\s+from\s+([\s\S]+?)(?:\s+(?:cascade|restrict))?\s*$/i;
const CREATE_FUNCTION = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?(function|procedure)\s+${NAME}\s*\(`,
  "i",
);
const ALTER_FUNCTION = new RegExp(
  String.raw`^alter\s+(?:function|procedure|routine)\s+${NAME}\s*\(`,
  "i",
);
const ROUTINE_OBJECT = /^(?:function|procedure|routine)\s+/i;
const GRANT =
  /^grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?\s*$/i;
/** `revoke all on t, u from ...` -> the listed names; `on function f(int), g()` -> `f`, `g`. */
function objectNames(target) {
  let bare = target;
  while (/\([^()]*\)/.test(bare)) bare = bare.replace(/\([^()]*\)/g, "");
  return bare
    .split(",")
    .map((t) => tableName(t.trim()))
    .filter((t) => t !== "public.");
}

/** Role list of a grant or revoke, lower-cased and unquoted. */
function roleList(raw) {
  return raw.split(",").map((r) => r.trim().replace(/"/g, "").toLowerCase());
}

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
    const tableRevoked = new Set();
    const functions = [];
    const functionRevoked = new Set();
    for (const s of statements) {
      let m;
      if ((m = REVOKE.exec(s))) {
        const privileges = m[1].trim();
        const target = m[2].trim();
        const roles = new Set(roleList(m[3]));
        if (ROUTINE_OBJECT.test(target)) {
          if (/^(?:all|execute)\b/i.test(privileges) && roles.has("public"))
            for (const f of objectNames(target.replace(ROUTINE_OBJECT, "")))
              functionRevoked.add(f);
        } else if (
          !NON_TABLE_OBJECT.test(target) &&
          /^all\b/i.test(privileges) &&
          [...DATA_API_ROLES].every((r) => roles.has(r))
        ) {
          for (const t of objectNames(target.replace(/^table\s+/i, "")))
            tableRevoked.add(t);
        }
      } else if ((m = CREATE_FUNCTION.exec(s))) {
        const fn = tableName(m[2]);
        if (fn.startsWith("public.")) functions.push(fn);
        if (
          /\bsecurity\s+definer\b/i.test(s) &&
          !/\bset\s+search_path\b/i.test(s)
        )
          problems.push({
            file: name,
            message: `security definer ${m[1].toLowerCase()} ${fn} must "set search_path"`,
          });
      } else if ((m = ALTER_FUNCTION.exec(s))) {
        if (
          /\bsecurity\s+definer\b/i.test(s) &&
          !/\bset\s+search_path\b/i.test(s)
        )
          problems.push({
            file: name,
            message: `${tableName(m[1])} is made security definer without "set search_path"`,
          });
      } else if ((m = CREATE_TABLE.exec(s))) {
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
      if (/^alter\s+table\b/i.test(s) && DISABLE_RLS.test(s)) {
        problems.push({
          file: name,
          message: `row-level security may not be disabled: "${s.slice(0, 80)}"`,
        });
        continue;
      }
      if (/^alter\s+default\s+privileges\b/i.test(s) && /\bgrant\b/i.test(s)) {
        problems.push({
          file: name,
          message: `default grants are not allowed: "${s.slice(0, 80)}"`,
        });
        continue;
      }
      const m = GRANT.exec(s);
      if (!m) continue;
      const exposed = roleList(m[3]).filter((r) => DATA_API_ROLES.has(r));
      if (exposed.length === 0) continue;
      const target = m[2].trim();
      if (/^all\s+\w+\s+in\s+schema\b/i.test(target)) {
        problems.push({
          file: name,
          message: `schema-wide grant to ${exposed.join(", ")} is not allowed`,
        });
        continue;
      }
      if (ROUTINE_OBJECT.test(target)) {
        problems.push({
          file: name,
          message: `execute grant on ${objectNames(target.replace(ROUTINE_OBJECT, "")).join(", ")} to ${exposed.join(", ")} is not allowed`,
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
    for (const table of created) {
      if (!rls.has(table))
        problems.push({
          file: name,
          message: `${table} is created without "alter table ${table} enable row level security"`,
        });
      if (!tableRevoked.has(table))
        problems.push({
          file: name,
          message: `${table} is created without "revoke all on ${table} from public, anon, authenticated"`,
        });
    }
    for (const fn of functions)
      if (!functionRevoked.has(fn))
        problems.push({
          file: name,
          message: `${fn} is created without "revoke execute on function ${fn} from public"`,
        });
  }
  return problems;
}
