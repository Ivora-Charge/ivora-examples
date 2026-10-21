import type { PGlite, Transaction } from "@electric-sql/pglite";

/**
 * Just enough of Supabase's Data API (PostgREST) over PGlite for the stores' requests:
 * GET, PATCH and DELETE with eq/lt/gte/lte/in/is filters and `select` (GET also with
 * `order`, `limit` and `offset`); POST inserts with
 * `on_conflict` and `resolution=ignore-duplicates`; and POST rpc/<function> with named
 * arguments. Each request runs in its own transaction as service_role, like PostgREST,
 * so grants and row locks are Postgres's own. Requests from concurrent callers
 * interleave between requests, which is where lost updates happen.
 */
export function pgliteRest(db: PGlite) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const prefer = new Headers(init?.headers).get("prefer") ?? "";
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.exec("set local role service_role");
        if (path.startsWith("rpc/")) return rpc(tx, path.slice(4), body ?? {});
        return table(tx, method, path, url.searchParams, body, prefer);
      });
      return rows === undefined
        ? new Response(null, { status: 204 })
        : Response.json(rows);
    } catch (e) {
      return Response.json(
        { message: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  };
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Bad identifier ${s}`);
  return `"${s}"`;
};

const RESERVED = new Set(["select", "on_conflict", "limit", "offset", "order"]);

/** `order=a.asc,b.desc`, `limit` and `offset` of a GET. */
function paging(params: URLSearchParams): string {
  let sql = "";
  const order = params.get("order");
  if (order)
    sql += ` order by ${order
      .split(",")
      .map((o) => {
        const [col, dir = "asc"] = o.split(".");
        if (dir !== "asc" && dir !== "desc") throw new Error(`Bad order ${o}`);
        return `${ident(col)} ${dir}`;
      })
      .join(", ")}`;
  for (const k of ["limit", "offset"]) {
    const v = params.get(k);
    if (v === null) continue;
    if (!/^\d+$/.test(v)) throw new Error(`Bad ${k}`);
    sql += ` ${k} ${v}`;
  }
  return sql;
}

function where(params: URLSearchParams, args: unknown[]): string {
  const out: string[] = [];
  for (const [column, filter] of params) {
    if (RESERVED.has(column)) continue;
    const dot = filter.indexOf(".");
    const op = filter.slice(0, dot);
    const value = filter.slice(dot + 1);
    const col = ident(column);
    const arg = () => `$${args.push(value)}`;
    if (op === "eq") out.push(`${col} = ${arg()}`);
    else if (op === "lt") out.push(`${col} < ${arg()}`);
    else if (op === "gte") out.push(`${col} >= ${arg()}`);
    else if (op === "lte") out.push(`${col} <= ${arg()}`);
    else if (op === "is") {
      if (!["null", "true", "false"].includes(value))
        throw new Error(`Bad is.${value}`);
      out.push(`${col} is ${value}`);
    } else if (op === "in") {
      const items = [
        ...value.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"/g),
      ].map((m) => m[1].replace(/\\(.)/g, "$1"));
      args.push(JSON.stringify(items));
      out.push(
        `${col}::text in (select jsonb_array_elements_text($${args.length}::jsonb))`,
      );
    } else throw new Error(`Unsupported filter ${op}`);
  }
  return out.length ? ` where ${out.join(" and ")}` : "";
}

const returning = (params: URLSearchParams) =>
  ` returning ${(params.get("select") ?? "*")
    .split(",")
    .map((c) => (c === "*" ? c : ident(c)))
    .join(", ")}`;

async function table(
  tx: Transaction,
  method: string,
  name: string,
  params: URLSearchParams,
  body: unknown,
  prefer: string,
) {
  const t = `public.${ident(name)}`;
  const args: unknown[] = [];
  let sql: string;
  if (method === "GET") {
    const ret = returning(params).replace(" returning ", "");
    sql = `select ${ret} from ${t}${where(params, args)}${paging(params)}`;
  } else if (method === "DELETE") {
    sql = `delete from ${t}${where(params, args)}${returning(params)}`;
  } else if (method === "PATCH") {
    const cols = Object.keys(body as object).map(ident);
    args.push(JSON.stringify(body));
    sql =
      `update ${t} set (${cols.join(", ")}) = (select ${cols.join(", ")} ` +
      `from jsonb_populate_record(null::${t}, $1::jsonb))` +
      `${where(params, args)}${returning(params)}`;
  } else if (method === "POST") {
    const rows = Array.isArray(body) ? body : [body];
    const cols = Object.keys(rows[0]).map(ident);
    args.push(JSON.stringify(rows));
    const conflict = params.get("on_conflict");
    if (!conflict || !prefer.includes("resolution=ignore-duplicates"))
      throw new Error("Only inserts that ignore duplicates are emulated");
    sql =
      `insert into ${t} (${cols.join(", ")}) select ${cols.join(", ")} ` +
      `from jsonb_populate_recordset(null::${t}, $1::jsonb) ` +
      `on conflict (${conflict.split(",").map(ident).join(", ")}) do nothing` +
      returning(params);
  } else throw new Error(`Unsupported method ${method}`);
  const { rows } = await tx.query(sql, args);
  return prefer.includes("return=minimal") ? undefined : rows;
}

async function rpc(
  tx: Transaction,
  name: string,
  body: Record<string, unknown>,
) {
  const {
    rows: [fn],
  } = await tx.query<{ names: string[]; types: string[]; void: boolean }>(
    `select p.proargnames as names,
       array(select format_type(t, null) from unnest(p.proargtypes) as t) as types,
       p.prorettype = 'void'::regtype as void
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = $1`,
    [name],
  );
  if (!fn) throw new Error(`No function ${name}`);
  // proargnames also lists OUT columns (returns table); the inputs come first.
  const names = fn.names.slice(0, fn.types.length).map(ident);
  const record = names.map((n, i) => `${n} ${fn.types[i]}`).join(", ");
  const call = names.map((n) => `${n} => x.${n}`).join(", ");
  const { rows } = await tx.query(
    `select f.* from jsonb_to_record($1::jsonb) as x (${record}),
       lateral public.${ident(name)}(${call}) as f`,
    [JSON.stringify(body)],
  );
  return fn.void ? undefined : rows;
}
