import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkMigrations, statements } from "../check.mjs";

const NAME = "202601010001_test.sql";
const check = (sql, name = NAME) => checkMigrations([{ name, sql }]);
const only = (sql) => check(sql).map((p) => p.replace(`${NAME}: `, ""));

const SAFE_TABLE = `
create table if not exists public.things (id uuid primary key, owner uuid);
alter table public.things enable row level security;
revoke all on public.things from public, anon, authenticated;
`;
const SAFE_FN = `
create function public.f() returns int language sql security definer set search_path = '' as $$ select 1 $$;
revoke execute on function public.f() from public, anon, authenticated;
`;

describe("tables", () => {
  it("passes a table with RLS, revokes and a policy-backed grant", () => {
    assert.deepEqual(
      check(`${SAFE_TABLE}
grant select (id) on public.things to authenticated;
create policy "Own rows" on public.things for select to authenticated using (owner = auth.uid());`),
      [],
    );
  });

  it("fails a public table without RLS, also when unqualified", () => {
    assert.deepEqual(
      only(`create table things (id int);
revoke all on things from public, anon, authenticated;`),
      ["creates public.things without enabling row level security"],
    );
  });

  it("fails a table left with default grants, naming all three roles", () => {
    assert.deepEqual(
      only(`create table public.x (id int);
alter table public.x enable row level security;`),
      [
        "creates table public.x without revoking all from public, anon, authenticated (add: revoke all on public.x from public, anon, authenticated)",
      ],
    );
  });

  it("does not count a partial revoke as revoking all", () => {
    assert.deepEqual(
      only(`create table public.x (id int);
alter table public.x enable row level security;
revoke select on public.x from public, anon, authenticated;`),
      [
        "revokes only select on public.x, which does not count as revoking all; use revoke all on public.x from public, anon, authenticated",
        "creates table public.x without revoking all from public, anon, authenticated (add: revoke all on public.x from public, anon, authenticated)",
      ],
    );
  });

  it("needs the revoke in the same file as the table", () => {
    assert.deepEqual(
      checkMigrations([
        {
          name: "1.sql",
          sql: "create table public.x (id int); alter table public.x enable row level security;",
        },
        {
          name: "2.sql",
          sql: "revoke all on public.x from public, anon, authenticated;",
        },
      ]),
      [
        "1.sql: creates table public.x without revoking all from public, anon, authenticated (add: revoke all on public.x from public, anon, authenticated)",
      ],
    );
  });

  it("accepts revoke all on all tables in schema public", () => {
    assert.deepEqual(
      check(`create table public.x (id int);
alter table public.x enable row level security;
revoke all privileges on all tables in schema public from public, anon, authenticated;`),
      [],
    );
  });

  it("fails disabling RLS, and unsafe views and materialized views", () => {
    assert.deepEqual(
      only(`${SAFE_TABLE}
alter table public.things disable row level security;
create view public.v as select 1;
revoke all on public.v from public, anon, authenticated;
create materialized view public.mv as select 1;`),
      [
        "disables row level security on public.things",
        "view public.v must use security_invoker = true",
        "creates materialized view public.mv without revoking all from public, anon, authenticated (add: revoke all on public.mv from public, anon, authenticated)",
      ],
    );
  });

  it("ignores tables outside the exposed schemas", () => {
    assert.deepEqual(check("create table private.x (id int);"), []);
    assert.equal(
      checkMigrations([{ name: NAME, sql: "create table api.x (id int);" }], {
        schemas: ["public", "api"],
      }).length,
      2,
    );
  });
});

describe("grants", () => {
  it("fails a grant to anon or authenticated without a matching policy", () => {
    assert.deepEqual(
      only(`${SAFE_TABLE}
grant select on public.things to anon;
grant select, update on public.things to authenticated;
create policy "Read" on public.things for select to authenticated using (true);`),
      [
        "grants select on public.things to anon without a matching policy",
        "grants update on public.things to authenticated without a matching policy",
      ],
    );
  });

  it("accepts a policy from an earlier migration, and forgets a dropped one", () => {
    const files = [
      {
        name: "1.sql",
        sql: `${SAFE_TABLE} create policy "Read" on public.things for select to authenticated using (true);`,
      },
      { name: "2.sql", sql: "grant select on public.things to authenticated;" },
    ];
    assert.deepEqual(checkMigrations(files), []);
    assert.deepEqual(
      checkMigrations([
        ...files,
        {
          name: "3.sql",
          sql: `drop policy if exists "Read" on public.things;
grant select on public.things to authenticated;`,
        },
      ]),
      [
        "3.sql: grants select on public.things to authenticated without a matching policy",
      ],
    );
  });

  it("fails ALL, PUBLIC, schema-wide, default and role grants", () => {
    assert.deepEqual(
      only(`${SAFE_TABLE}
grant all on public.things to authenticated;
grant select on public.things to public;
grant select on all tables in schema public to anon;
alter default privileges in schema public grant select on tables to anon;
grant truncate on public.things to authenticated;
grant service_role to authenticated;`),
      [
        "grants ALL on public.things to authenticated; grant explicit privileges",
        "grants select on public.things to PUBLIC, which includes anon and authenticated",
        "grants on all tables in a schema to anon; grant each table explicitly",
        "grants default privileges; grant each object explicitly instead",
        "grants truncate on public.things to authenticated",
        "grants role service_role to authenticated",
      ],
    );
  });

  it("allows service_role grants", () => {
    assert.deepEqual(
      check(`${SAFE_TABLE} grant all on public.things to service_role;`),
      [],
    );
  });
});

describe("functions", () => {
  it("passes a function closed to all three roles, then granted by name", () => {
    assert.deepEqual(
      check(
        `${SAFE_FN} grant execute on function public.f() to authenticated, service_role;`,
      ),
      [],
    );
  });

  // The review's repro: anon could call this one in a Supabase-style database.
  it("fails a security definer function revoked only from PUBLIC, without search_path", () => {
    assert.deepEqual(
      only(`create function public.leak() returns int language sql security definer as $$ select 42 $$;
revoke all on function public.leak() from public;`),
      [
        "security definer function public.leak(0 args) must set search_path (for example set search_path = '')",
        "creates function public.leak(0 args) without revoking EXECUTE from anon, authenticated (add after it: revoke execute on function … from public, anon, authenticated)",
      ],
    );
  });

  it("fails a function with no revoke, and a grant to anon or PUBLIC", () => {
    assert.deepEqual(
      only(`create function f() returns int language sql as $$ select 1 $$;
${SAFE_FN}
grant execute on function public.f() to anon;
grant execute on function public.f() to public;`),
      [
        "grants EXECUTE on function public.f() to anon; functions stay closed to public, anon, authenticated",
        "grants execute on function public.f() to PUBLIC, which includes anon and authenticated",
      ],
    );
    assert.deepEqual(
      only(
        "create function public.g(a int) returns int language sql as $$ select a $$;",
      ),
      [
        "creates function public.g(1 arg) without revoking EXECUTE from public, anon, authenticated (add after it: revoke execute on function … from public, anon, authenticated)",
      ],
    );
  });

  it("needs the revoke after the create, on the same overload", () => {
    assert.equal(
      only(`revoke execute on function public.f() from public, anon, authenticated;
create function public.f() returns int language sql as $$ select 1 $$;`).length,
      1,
    );
    const overloads =
      only(`create function public.h(a int) returns int language sql as $$ select 1 $$;
create function public.h(a int, b numeric(10, 2) default 0) returns int language sql as $$ select 2 $$;
revoke all on function public.h(int) from public, anon, authenticated;`);
    assert.deepEqual(overloads, [
      "creates function public.h(2 args) without revoking EXECUTE from public, anon, authenticated (add after it: revoke execute on function … from public, anon, authenticated)",
    ]);
  });

  it("accepts revoking from all functions in schema public, and procedures", () => {
    assert.deepEqual(
      check(`create procedure public.p() language sql as $$ select 1 $$;
create function public.q() returns trigger language plpgsql as $$ begin return new; end $$;
revoke execute on all routines in schema public from public, anon, authenticated;`),
      [],
    );
  });

  it("checks search_path after alter function", () => {
    assert.deepEqual(
      checkMigrations([
        {
          name: "1.sql",
          sql: `create function public.f(a uuid) returns int language sql as $$ select 1 $$;
revoke execute on function public.f(uuid) from public, anon, authenticated;`,
        },
        {
          name: "2.sql",
          sql: "alter function public.f(uuid) security definer;",
        },
        { name: "3.sql", sql: "alter function public.f set search_path = '';" },
        { name: "4.sql", sql: "alter function public.f(uuid) reset all;" },
      ]),
      [
        "2.sql: security definer function public.f(1 arg) must set search_path, also when changed with alter function",
        "4.sql: security definer function public.f(1 arg) must set search_path, also when changed with alter function",
      ],
    );
  });
});

describe("DO blocks and parsing", () => {
  it("fails DDL or dynamic SQL inside a DO block", () => {
    assert.deepEqual(
      only(`do $$ begin create table public.hidden (id int); end $$;
do language plpgsql $x$ begin execute 'grant all on public.things to anon'; end $x$;
do $$ begin perform 1; end $$;`),
      [
        "runs DDL or dynamic SQL inside a DO block, which this check can't read; write it as plain statements",
        "runs DDL or dynamic SQL inside a DO block, which this check can't read; write it as plain statements",
      ],
    );
  });

  it("ignores SQL inside comments, strings and function bodies", () => {
    assert.deepEqual(
      check(`-- create table public.in_comment (id int);
/* grant all on public.things to anon; /* nested */ still a comment */
create function public.h() returns text language sql set search_path = '' as $fn$ select 'create table public.y (id int); grant all on public.y to anon' $fn$;
revoke all on function public.h() from public, anon, authenticated;
select 'grant all on public.z to anon; it''s fine', E'\\' grant all on public.z to anon';`),
      [],
    );
  });

  it("splits statements and keeps dollar-quoted bodies", () => {
    const s = statements("select 1; do $a$ select ';' $a$ ; ");
    assert.deepEqual(
      s.map((x) => x.text),
      ["select 1", "do $body0$"],
    );
    assert.deepEqual(s[1].bodies, [" select ';' "]);
  });
});

describe("statements that create, move or run things", () => {
  it("treats select … into as creating a table, but not into a temporary one", () => {
    assert.deepEqual(only("select 1 as v into public.copied;"), [
      "creates public.copied without enabling row level security",
      "creates table public.copied without revoking all from public, anon, authenticated (add: revoke all on public.copied from public, anon, authenticated)",
    ]);
    assert.deepEqual(
      check(`select 1 as v into public.copied;
alter table public.copied enable row level security;
revoke all on public.copied from public, anon, authenticated;
select 1 as v into temp scratch;
with a as (insert into public.copied values (2) returning v) select v from a;`),
      [],
    );
  });

  it("treats a table moved into public with set schema as new there", () => {
    assert.deepEqual(
      only(`create table stash.moved (v int);
alter table stash.moved set schema public;`),
      [
        "creates public.moved without enabling row level security",
        "creates table public.moved without revoking all from public, anon, authenticated (add: revoke all on public.moved from public, anon, authenticated)",
      ],
    );
    assert.deepEqual(
      check(`create table stash.moved (v int);
alter table stash.moved set schema public;
alter table public.moved enable row level security;
revoke all on public.moved from public, anon, authenticated;
alter table public.moved set schema stash;`),
      [],
    );
    assert.deepEqual(only("alter function private.f(int) set schema public;"), [
      "moves function private.f into schema public; create it there instead, with its revokes",
    ]);
  });

  it("fails running a migration's own function whose body runs DDL, also through another function", () => {
    const mk = `create function tools.mk() returns void language plpgsql as $$ begin create table public.y (v int); end $$;`;
    assert.deepEqual(only(`${mk} select tools.mk();`), [
      "runs mk(), which runs DDL or dynamic SQL this check can't read; write it as plain statements",
    ]);
    assert.deepEqual(
      only(`${mk}
create function tools.outer() returns void language plpgsql as $$ begin perform tools.mk(); end $$;
do $$ begin perform tools.outer(); end $$;
create trigger t after insert on public.things for each row execute function tools.mk();`),
      [
        "runs outer(), which runs DDL or dynamic SQL this check can't read; write it as plain statements",
        "runs mk(), which runs DDL or dynamic SQL this check can't read; write it as plain statements",
      ],
    );
    // A string body can't be read; select … into in a SQL function creates a table.
    assert.equal(
      only(
        "create function tools.s() returns void language plpgsql as 'begin end'; select tools.s();",
      ).length,
      1,
    );
    assert.equal(
      only(
        "create function tools.q() returns void language sql as $$ select 1 into public.z $$; call tools.q();",
      ).length,
      1,
    );
    // Defining, granting and dropping it runs nothing; nor does a DML-only function.
    assert.deepEqual(
      check(`${mk}
revoke execute on function tools.mk() from public;
drop function tools.mk();
create function tools.ok() returns int language plpgsql as $$ declare n int; begin select count(*) into n from public.things; return n; end $$;
select tools.ok();`),
      [],
    );
  });

  it("fails turning security_invoker off on a view", () => {
    assert.deepEqual(
      only(`alter view public.v set (security_invoker = false);
alter view if exists public.v reset (security_invoker);
alter table public.v set (security_invoker = off);
alter view private.v set (security_invoker = false);
alter view public.v set (security_invoker = true, security_barrier);
alter view public.v set (security_invoker);`),
      [
        "turns security_invoker off on view public.v",
        "turns security_invoker off on view public.v",
        "turns security_invoker off on view public.v",
      ],
    );
  });

  it("fails ownership by the browser roles, and statements that run SQL from a string", () => {
    assert.deepEqual(
      only(`alter table public.things owner to anon;
alter function public.f() owner to authenticated;
create schema api authorization anon;
select cron.schedule('job', '* * * * *', 'drop table x');
alter policy "Read" on public.things to anon;`),
      [
        "makes anon the owner of table public.things",
        "makes authenticated the owner of function public.f",
        "makes anon the owner of schema api",
        "runs SQL through cron.schedule(), which this check can't read; write it as plain statements",
      ],
    );
  });

  it("fails grants on other kinds of object beyond what an app needs", () => {
    assert.deepEqual(
      only(`grant usage on schema public to anon, authenticated;
grant create on schema public to authenticated;
grant usage, select on sequence public.s to authenticated;
grant update on sequence public.s to authenticated;
grant temporary on database postgres to anon;
grant usage on type public.k to anon;`),
      [
        "grants create on schema public to authenticated",
        "grants update on sequence public.s to authenticated",
        "grants temporary on database postgres to anon",
      ],
    );
  });

  it("follows alter policy, so a grant needs a policy that still covers the role", () => {
    assert.deepEqual(
      only(`${SAFE_TABLE}
create policy "Read" on public.things for select to authenticated using (true);
alter policy "Read" on public.things to service_role;
grant select on public.things to authenticated;`),
      [
        "grants select on public.things to authenticated without a matching policy",
      ],
    );
  });

  it("asks for an extension's schema", () => {
    assert.deepEqual(
      only(`create extension pgcrypto;
create extension if not exists pgcrypto with schema extensions;
create extension citext schema public;`),
      [
        `creates extension pgcrypto without "with schema" naming a schema the Data API doesn't expose (for example extensions); its functions would be open to PUBLIC`,
        `creates extension citext without "with schema" naming a schema the Data API doesn't expose (for example extensions); its functions would be open to PUBLIC`,
      ],
    );
  });

  it("fails closed on any statement no rule covers", () => {
    const msg = (st) =>
      `unrecognised statement: review it or add a rule (${st})`;
    for (const st of [
      "create rule r as on select to public.things do instead select 1",
      "set role anon",
      "set local session authorization anon",
      "create sequence public.s",
      "create event trigger e on ddl_command_end execute function f()",
      "alter role anon bypassrls",
      "create role helper in role anon",
      "alter publication supabase_realtime add table public.things",
      "security label for pgsodium on column public.things.id is ''",
      "import foreign schema remote from server s into public",
      "create foreign table public.ft (v int) server s",
      "create aggregate public.agg (int) (sfunc = int4pl, stype = int)",
      "explain analyze create table public.x as select 1",
      "load ''",
      "reassign owned by postgres to anon",
    ])
      assert.deepEqual(only(`${st};`), [msg(st)], st);
    const long = `create rule ${"r".repeat(100)} as on select to public.things do instead select 1`;
    assert.deepEqual(only(`${long};`), [msg(`${long.slice(0, 80)}…`)]);
  });

  it("lets through statements that can't create, expose or grant anything", () => {
    assert.deepEqual(
      check(`begin;
${SAFE_TABLE}
set statement_timeout = 0;
reset role;
create sequence private.s;
create index if not exists things_owner on public.things (owner);
create unique index things_id on public.things (id);
alter table public.things add column note text, alter column note set default '';
alter table public.things rename column note to remark;
create type public.kind as enum ('a', 'b');
alter type public.kind add value 'c';
create domain public.pos as int check (value > 0);
create schema if not exists private;
alter schema private owner to postgres;
insert into public.things (id) values (gen_random_uuid());
update public.things set owner = null;
delete from public.things;
comment on table public.things is 'x';
drop table if exists public.old;
drop view if exists public.old_v;
revoke service_role from authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter extension pgcrypto update;
commit;`),
      [],
    );
  });
});

describe("cli", () => {
  const cli = fileURLToPath(new URL("..", import.meta.url));
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

  it("exits 0 on safe migrations and 1 with messages on unsafe ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-migrations-"));
    try {
      writeFileSync(join(dir, "1_safe.sql"), SAFE_TABLE + SAFE_FN);
      let r = run(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /1 migration file\(s\) follow the 10-30 rule/);
      writeFileSync(
        join(dir, "2_bad.sql"),
        "create table public.open (id int);",
      );
      r = run(dir);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /2_bad\.sql: creates table public\.open without revoking all from public, anon, authenticated/,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("exits 2 on a usage error", () => {
    assert.equal(run().status, 2);
    assert.equal(run("/nonexistent-dir").status, 2);
  });
});
