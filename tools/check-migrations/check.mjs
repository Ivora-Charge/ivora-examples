// The 10-30 rule for Supabase migrations: a static check, shared by every template.
//
// Supabase exposes the public schema through its Data API, and its default privileges
// give the browser roles (anon and authenticated) every privilege on new tables and
// EXECUTE on new functions; Postgres itself gives PUBLIC EXECUTE on every function. So
// a migration is only safe when it takes those away explicitly:
//
// - Every public table (and view) enables row level security (views: security_invoker)
//   and runs `revoke all on <table> from public, anon, authenticated` in the same file.
// - A grant to anon or authenticated names explicit privileges (never ALL), and each
//   privilege on each table has a matching RLS policy for that role.
// - Every public function or procedure runs
//   `revoke execute on function <f> from public, anon, authenticated` in the same file
//   after it is created. It may then be granted to roles the migration names, but
//   never to anon or PUBLIC.
// - Every SECURITY DEFINER function sets search_path, also after `alter function`.
// - Nothing is granted to PUBLIC, no default privileges are granted, RLS is never
//   disabled, and DDL never hides inside a `do $$ … $$` block, where this check can't
//   read it.
//
// The parser is deliberately small and fails closed: it reads statement shapes, not a
// full SQL grammar. A statement it can't place in the rules above is left alone, so
// keep migrations plain.

const BROWSER_ROLES = ["anon", "authenticated"];
/** The roles every public object must be closed to. */
export const CLOSED_TO = ["public", ...BROWSER_ROLES];
const COMMANDS = ["select", "insert", "update", "delete"];
const ROLE_LIST = CLOSED_TO.join(", ");

/**
 * Splits SQL into statements. Comments are dropped, string literals become `''` and
 * dollar-quoted bodies become `$body<n>$` (the raw text is kept in `bodies`), so
 * nothing inside a literal or a function body is read as a statement.
 *
 * @param {string} sql
 * @returns {{ text: string, bodies: string[] }[]}
 */
export function statements(sql) {
  const out = [];
  let text = "";
  let bodies = [];
  const flush = () => {
    const t = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (t) out.push({ text: t, bodies });
    text = "";
    bodies = [];
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      text += " ";
    } else if (c === "/" && next === "*") {
      // Block comments nest in Postgres.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") (depth++, (i += 2));
        else if (sql[i] === "*" && sql[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
      text += " ";
    } else if (c === "'") {
      // E'…' strings allow backslash escapes.
      const escapes =
        /[eE]$/.test(text) && !/[a-zA-Z0-9_]$/.test(text.slice(0, -1));
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      text += "''";
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      text += sql.slice(i, stop);
      i = stop;
    } else if (c === "$" && !/[a-zA-Z0-9_$]$/.test(text)) {
      const tag = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(i));
      if (!tag) {
        text += c;
        i++;
        continue;
      }
      const start = i + tag[0].length;
      const end = sql.indexOf(tag[0], start);
      const stop = end === -1 ? sql.length : end;
      bodies.push(sql.slice(start, stop));
      text += ` $body${bodies.length - 1}$ `;
      i = end === -1 ? sql.length : end + tag[0].length;
    } else if (c === ";") {
      flush();
      i++;
    } else {
      text += c;
      i++;
    }
  }
  flush();
  return out;
}

const IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)`;
const QNAME = String.raw`${IDENT}(?:\.${IDENT})?`;

/** `public.x`, `x` (public by default) or null for another schema. */
function inSchemas(raw, schemas) {
  const parts = raw.trim().split(".");
  const unquote = (s) => s.replace(/^"|"$/g, "");
  if (parts.length === 1)
    return schemas.includes("public") ? unquote(parts[0]) : null;
  return schemas.includes(unquote(parts[0])) ? unquote(parts[1]) : null;
}

/** Splits on commas outside parentheses. */
function list(s) {
  const items = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

/** Role names in a GRANT/REVOKE grantee list. */
function roles(s) {
  return list(
    s
      .replace(
        /\b(with grant option|with admin option|with inherit \w+|with set \w+)\b.*$/,
        "",
      )
      .replace(/\bgranted by .*$/, "")
      .replace(/\b(cascade|restrict)$/, ""),
  ).map((r) => r.replace(/^group /, "").replace(/"/g, ""));
}

/** Privileges in a GRANT/REVOKE list, without column lists: `select (a, b), insert` → [select, insert]. */
function privileges(s) {
  return list(s.replace(/\([^)]*\)/g, "")).map((p) =>
    p === "all privileges" ? "all" : p.split(" ")[0],
  );
}

/**
 * `name(args) rest` with balanced parentheses in args (types like numeric(10, 2) and
 * defaults like now()). Args is undefined when the name has no parentheses.
 */
function signature(s) {
  const m = s.match(new RegExp(String.raw`^(${QNAME})\s*`));
  if (!m) return null;
  let i = m[0].length;
  if (s[i] !== "(")
    return { name: m[1], args: undefined, rest: s.slice(i).trim() };
  let depth = 0;
  const start = i + 1;
  for (; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) break;
  }
  return { name: m[1], args: s.slice(start, i), rest: s.slice(i + 1).trim() };
}

/** The number of input arguments in a function signature, or null when it has none written. */
function arity(args) {
  if (args === undefined) return null;
  return list(args).filter((a) => a && !/^out\s/.test(a)).length;
}

/**
 * A function key: name and input-argument count. Overloads with the same count are
 * treated as one function, which only ever asks for more revokes, never fewer.
 */
function fnKey(name, n) {
  return `${name}/${n}`;
}

function fnLabel(key, schema = "public") {
  const [name, n] = key.split("/");
  return `${schema}.${name}(${n === "null" ? "…" : `${n} arg${n === "1" ? "" : "s"}`})`;
}

/** Keywords that make a DO block DDL or dynamic SQL. */
const DO_DDL =
  /\b(create|alter|drop|grant|revoke|execute|comment|security|policy|truncate)\b/;

/**
 * @param {{ name: string, sql: string }[]} files
 * @param {{ schemas?: string[] }} [options] Schemas exposed through the Data API (default public).
 * @returns {string[]} One line per problem, prefixed with the file name. Empty when safe.
 */
export function checkMigrations(files, options = {}) {
  const schemas = options.schemas ?? ["public"];
  const problems = [];
  const policies = [];
  // Function attributes carry across files: a later `alter function` can undo them.
  const definer = new Map();
  const matviews = new Set();

  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const say = (msg) => problems.push(`${file.name}: ${msg}`);
    const pub = (raw) => inSchemas(raw, schemas);
    const relations = new Map(); // name → "table" | "view" | "materialized view"
    const rls = new Set();
    const revoked = new Map(); // relation → roles revoked with ALL
    const created = []; // function keys created in this file, in order
    const fnRevoked = new Map(); // function key → roles
    const grants = [];

    const revokeAllOn = (rel, rs) => {
      const set = revoked.get(rel) ?? new Set();
      for (const r of rs) set.add(r);
      revoked.set(rel, set);
    };
    const revokeFn = (key, rs) => {
      const set = fnRevoked.get(key) ?? new Set();
      for (const r of rs) set.add(r);
      fnRevoked.set(key, set);
    };
    const keysFor = (name, n) =>
      n === null
        ? created.filter((k) => k.startsWith(`${name}/`))
        : [fnKey(name, n)];

    for (const { text: st, bodies } of statements(file.sql)) {
      let m;
      if (/^do\b/.test(st)) {
        const code = bodies
          .map((b) =>
            statements(b)
              .map((s) => s.text)
              .join("; "),
          )
          .join("; ");
        if (DO_DDL.test(code))
          say(
            "runs DDL or dynamic SQL inside a DO block, which this check can't read; write it as plain statements",
          );
      } else if (
        (m = st.match(
          new RegExp(
            String.raw`^create (?:(?:global |local )?(?:temp|temporary) |unlogged )?table (?:if not exists )?(${QNAME})`,
          ),
        ))
      ) {
        if (/^create (?:(?:global |local )?(?:temp|temporary)) /.test(st))
          continue;
        const t = pub(m[1]);
        if (t) relations.set(t, "table");
      } else if (
        (m = st.match(
          new RegExp(
            String.raw`^create (?:or replace )?(?:(?:temp|temporary) )?(?:recursive )?view (${QNAME})`,
          ),
        ))
      ) {
        const v = pub(m[1]);
        if (!v) continue;
        relations.set(v, "view");
        if (!/security_invoker\s*=\s*(true|on|1)\b/.test(st))
          say(`view public.${v} must use security_invoker = true`);
      } else if (
        (m = st.match(
          new RegExp(
            String.raw`^create materialized view (?:if not exists )?(${QNAME})`,
          ),
        ))
      ) {
        const v = pub(m[1]);
        if (v) {
          relations.set(v, "materialized view");
          matviews.add(v);
        }
      } else if (
        (m = st.match(
          new RegExp(
            String.raw`^alter table (?:if exists )?(?:only )?(${QNAME}) (enable|disable|force|no force) row level security`,
          ),
        ))
      ) {
        const t = pub(m[1]);
        if (t && m[2] === "enable") rls.add(t);
        if (t && m[2] === "disable")
          say(`disables row level security on public.${t}`);
      } else if (
        (m = st.match(/^create (?:or replace )?(function|procedure) (.+)$/))
      ) {
        const sig = signature(m[2]);
        const f = sig && pub(sig.name);
        if (!f) continue;
        const key = fnKey(f, arity(sig.args ?? ""));
        created.push(key);
        fnRevoked.delete(key);
        // CREATE OR REPLACE resets every attribute to what this statement says.
        const isDefiner = /\bsecurity definer\b/.test(sig.rest);
        const hasPath = /\bset search_path\b/.test(sig.rest);
        definer.set(key, { definer: isDefiner, searchPath: hasPath });
        if (isDefiner && !hasPath)
          say(
            `security definer ${m[1]} ${fnLabel(key)} must set search_path (for example set search_path = '')`,
          );
      } else if ((m = st.match(/^alter (function|procedure|routine) (.+)$/))) {
        const sig = signature(m[2]);
        const f = sig && pub(sig.name);
        if (!f) continue;
        const keys =
          sig.args === undefined
            ? [...definer.keys()].filter((k) => k.startsWith(`${f}/`))
            : [fnKey(f, arity(sig.args))];
        if (!keys.length) keys.push(fnKey(f, null));
        for (const key of keys) {
          const s = definer.get(key) ?? { definer: false, searchPath: false };
          if (/\bsecurity definer\b/.test(sig.rest)) s.definer = true;
          if (/\bsecurity invoker\b/.test(sig.rest)) s.definer = false;
          if (/\bset search_path\b/.test(sig.rest)) s.searchPath = true;
          if (/\breset (search_path|all)\b/.test(sig.rest))
            s.searchPath = false;
          definer.set(key, s);
          if (s.definer && !s.searchPath)
            say(
              `security definer ${m[1]} ${fnLabel(key)} must set search_path, also when changed with alter ${m[1]}`,
            );
        }
      } else if (/^alter default privileges\b.* grant /.test(st)) {
        say("grants default privileges; grant each object explicitly instead");
      } else if (
        (m = st.match(
          new RegExp(
            String.raw`^create policy (${IDENT}) on (${QNAME})(?: as (?:permissive|restrictive))?(?: for (all|select|insert|update|delete))?(?: to (.+?))?(?: using\b| with check\b|$)`,
          ),
        ))
      ) {
        const t = pub(m[2]);
        if (t)
          policies.push({
            name: m[1].replace(/"/g, ""),
            table: t,
            command: m[3] ?? "all",
            roles: m[4] ? list(m[4]) : ["public"],
          });
      } else if (
        (m = st.match(
          new RegExp(
            String.raw`^drop policy (?:if exists )?(${IDENT}) on (${QNAME})`,
          ),
        ))
      ) {
        const name = m[1].replace(/"/g, "");
        const t = pub(m[2]);
        for (let i = policies.length - 1; i >= 0; i--)
          if (policies[i].table === t && policies[i].name === name)
            policies.splice(i, 1);
      } else if (
        (m = st.match(
          /^revoke (?:grant option for )?(.+?) on (.+?) from (.+)$/,
        ))
      ) {
        const privs = privileges(m[1]);
        const target = m[2];
        const rs = roles(m[3]);
        const full = privs.includes("all");
        let f;
        if (
          (f = target.match(
            new RegExp(String.raw`^(?:function|procedure|routine) (.+)$`),
          ))
        ) {
          if (!full && !privs.includes("execute")) continue;
          for (const item of list(f[1])) {
            const sig = signature(item);
            const name = sig && pub(sig.name);
            if (name)
              for (const key of keysFor(name, arity(sig.args)))
                revokeFn(key, rs);
          }
        } else if (
          (f = target.match(
            /^all (?:functions|procedures|routines) in schema (.+)$/,
          ))
        ) {
          if (!full && !privs.includes("execute")) continue;
          if (list(f[1]).some((s) => pub(`${s}.x`)))
            for (const key of created) revokeFn(key, rs);
        } else if ((f = target.match(/^all tables in schema (.+)$/))) {
          if (!list(f[1]).some((s) => pub(`${s}.x`))) continue;
          if (full) for (const rel of relations.keys()) revokeAllOn(rel, rs);
          else
            say(
              `revokes only ${privs.join(", ")} on all tables, which does not count as revoking all; use revoke all … from ${ROLE_LIST}`,
            );
        } else if (
          !/^(schema|sequence|all sequences|database|type|domain|language|large object|foreign|tablespace|parameter) /.test(
            target,
          )
        ) {
          for (const raw of list(target.replace(/^table /, ""))) {
            const t = pub(raw);
            if (!t) continue;
            if (full) revokeAllOn(t, rs);
            else if (relations.has(t) && rs.some((r) => CLOSED_TO.includes(r)))
              say(
                `revokes only ${privs.join(", ")} on public.${t}, which does not count as revoking all; use revoke all on public.${t} from ${ROLE_LIST}`,
              );
          }
        }
      } else if ((m = st.match(/^grant (.+?) on (.+?) to (.+)$/))) {
        const rs = roles(m[3]);
        const target = m[2];
        if (rs.includes("public")) {
          say(
            `grants ${privileges(m[1]).join(", ")} on ${target} to PUBLIC, which includes anon and authenticated`,
          );
          continue;
        }
        let f;
        if (
          (f = target.match(/^(?:function|procedure|routine) (.+)$/)) ||
          /^all (functions|procedures|routines) /.test(target)
        ) {
          if (rs.includes("anon"))
            say(
              `grants EXECUTE on ${target} to anon; functions stay closed to ${ROLE_LIST}`,
            );
          continue;
        }
        const browser = rs.filter((r) => BROWSER_ROLES.includes(r));
        if (
          !browser.length ||
          /^(schema|sequence|all sequences|database|type|domain|language|large object|foreign|tablespace|parameter) /.test(
            target,
          )
        )
          continue;
        if (/^all tables/.test(target)) {
          say(
            `grants on all tables in a schema to ${browser.join(", ")}; grant each table explicitly`,
          );
          continue;
        }
        const rels = list(target.replace(/^table /, ""))
          .map(pub)
          .filter(Boolean);
        const privs = privileges(m[1]);
        if (privs.includes("all")) {
          say(
            `grants ALL on ${rels.map((t) => `public.${t}`).join(", ")} to ${browser.join(", ")}; grant explicit privileges`,
          );
          continue;
        }
        for (const p of privs)
          if (!COMMANDS.includes(p))
            say(
              `grants ${p} on ${rels.map((t) => `public.${t}`).join(", ")} to ${browser.join(", ")}`,
            );
        grants.push({
          rels,
          privs: privs.filter((p) => COMMANDS.includes(p)),
          roles: browser,
        });
      } else if (
        (m = st.match(/^grant ([^]+?) to (.+)$/)) &&
        !/ on /.test(m[1])
      ) {
        // Role membership: anon or authenticated must never inherit another role.
        const rs = roles(m[2]);
        const bad = rs.filter((r) => CLOSED_TO.includes(r));
        if (bad.length) say(`grants role ${m[1]} to ${bad.join(", ")}`);
      }
    }

    for (const [t, kind] of relations) {
      if (kind === "table" && !rls.has(t))
        say(`creates public.${t} without enabling row level security`);
      const missing = CLOSED_TO.filter((r) => !revoked.get(t)?.has(r));
      if (missing.length)
        say(
          `creates ${kind} public.${t} without revoking all from ${missing.join(", ")} (add: revoke all on public.${t} from ${ROLE_LIST})`,
        );
    }
    for (const key of new Set(created)) {
      const missing = CLOSED_TO.filter((r) => !fnRevoked.get(key)?.has(r));
      if (missing.length)
        say(
          `creates function ${fnLabel(key)} without revoking EXECUTE from ${missing.join(", ")} (add after it: revoke execute on function … from ${ROLE_LIST})`,
        );
    }
    // Policies may come later in the same file, so grants are checked at the end.
    for (const g of grants)
      for (const t of g.rels)
        for (const r of g.roles)
          for (const p of g.privs) {
            if (matviews.has(t)) {
              say(
                `grants ${p} on materialized view public.${t} to ${r}; it can't have RLS`,
              );
              continue;
            }
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
  }
  return problems;
}
