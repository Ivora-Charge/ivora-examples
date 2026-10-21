// The proof behind the rules: the same SQL runs in an in-process Postgres (PGlite) set
// up like a Supabase project, with its default privileges on new tables AND functions.
// What the checker passes, anon can't read or call; what it fails, anon can.
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { checkMigrations } from "../check.mjs";

/** Supabase's roles and default privileges, as a new project has them. */
const SUPABASE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const SAFE = `
create table public.notes (id int primary key, owner uuid, body text);
alter table public.notes enable row level security;
revoke all on public.notes from public, anon, authenticated;
grant select (id, body) on public.notes to authenticated;
create policy "Own notes" on public.notes for select to authenticated using (owner = auth.uid());

create view public.note_ids with (security_invoker = true) as select id from public.notes;
revoke all on public.note_ids from public, anon, authenticated;

create function public.count_notes() returns bigint language sql security definer set search_path = '' as
  $$ select count(*) from public.notes $$;
revoke execute on function public.count_notes() from public, anon, authenticated;
grant execute on function public.count_notes() to service_role;

create function public.add(a int, b int default 1) returns int language sql as $$ select a + b $$;
revoke all on function public.add(int, int) from public, anon, authenticated;
`;

/** Each is one mistake: the checker must fail it, and in Postgres anon gets in. */
const UNSAFE = [
  {
    name: "security definer revoked only from PUBLIC (the review's repro)",
    sql: `create function public.leak() returns int language sql security definer as $$ select 42 $$;
revoke all on function public.leak() from public;`,
    anon: "select public.leak() as v",
  },
  {
    name: "function with no revoke at all",
    sql: "create function public.open_fn() returns int language sql as $$ select 7 $$;",
    anon: "select public.open_fn() as v",
  },
  {
    name: "table with RLS but default grants and a permissive policy",
    sql: `create table public.open_t (v int);
alter table public.open_t enable row level security;
create policy "All" on public.open_t for select using (true);
insert into public.open_t values (1);`,
    anon: "select v from public.open_t",
  },
  {
    name: "table revoked with a partial revoke",
    sql: `create table public.part_t (v int);
alter table public.part_t enable row level security;
revoke select on public.part_t from public, anon, authenticated;
create policy "Add" on public.part_t for insert with check (true);`,
    // Without SELECT, anon still writes.
    anon: "insert into public.part_t values (2)",
  },
  {
    name: "table created inside a DO block",
    sql: "do $$ begin execute 'create table public.hidden_t (v int)'; insert into public.hidden_t values (3); end $$;",
    anon: "select v from public.hidden_t",
  },
  {
    name: "grant to PUBLIC",
    sql: `create table public.pub_t (v int);
alter table public.pub_t enable row level security;
revoke all on public.pub_t from public, anon, authenticated;
grant select on public.pub_t to public;
create policy "All" on public.pub_t for select using (true);
insert into public.pub_t values (4);`,
    anon: "select v from public.pub_t",
  },
];

let pg;

async function asRole(role, sql) {
  await pg.exec(`set role ${role}`);
  try {
    return await pg.query(sql);
  } finally {
    await pg.exec("reset role");
  }
}

before(async () => {
  pg = new PGlite();
  await pg.exec(SUPABASE);
});
after(async () => {
  await pg?.close();
});

describe("in a Supabase-style database", () => {
  it("passes the safe migration, and anon can't read or call anything in it", async () => {
    assert.deepEqual(checkMigrations([{ name: "safe.sql", sql: SAFE }]), []);
    await pg.exec(SAFE);
    for (const sql of [
      "select * from public.notes",
      "select * from public.note_ids",
      "select public.count_notes()",
      "select public.add(1)",
    ])
      await assert.rejects(asRole("anon", sql), /permission denied/, sql);
    // Every public relation and function, checked through the catalog too.
    const open = await pg.query(`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','v','m','p')
          and (has_table_privilege('anon', c.oid, 'select,insert,update,delete')
            or has_table_privilege('authenticated', c.oid, 'insert,update,delete'))
      union all
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute'))`);
    assert.deepEqual(open.rows, []);
  });

  it("lets authenticated read only the granted columns of their own rows", async () => {
    const me = "10000000-0000-4000-8000-000000000001";
    await pg.query(
      `insert into public.notes values (1, $1, 'mine'), (2, '10000000-0000-4000-8000-000000000002', 'theirs')`,
      [me],
    );
    await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [
      me,
    ]);
    const r = await asRole(
      "authenticated",
      "select id, body from public.notes",
    );
    assert.deepEqual(r.rows, [{ id: 1, body: "mine" }]);
    await assert.rejects(
      asRole("authenticated", "select owner from public.notes"),
      /permission denied/,
    );
  });

  for (const c of UNSAFE)
    it(`fails, and anon gets in: ${c.name}`, async () => {
      assert.notDeepEqual(
        checkMigrations([{ name: "unsafe.sql", sql: c.sql }]),
        [],
      );
      await pg.exec(c.sql);
      const r = await asRole("anon", c.anon);
      assert.equal(r.rows.length || r.affectedRows, 1);
    });
});
