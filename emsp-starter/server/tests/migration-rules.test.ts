import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMigrations, stripNoise } from "../scripts/migration-rules.mjs";

/** A public table that follows the rule: RLS on, Data API roles revoked. */
const TABLE = `create table public.t (id int);
  alter table public.t enable row level security;
  revoke all on table public.t from public, anon, authenticated;`;

const check = (...sql: string[]) =>
  checkMigrations(
    sql.map((s, i) => ({ name: `20261021000${i + 1}_m.sql`, sql: s })),
  ).map((p: { message: string }) => p.message);

describe("10-30 migration check", () => {
  it("passes a service-only table with RLS", () => {
    expect(
      check(`${TABLE} grant select, insert on table public.t to service_role;`),
    ).toEqual([]);
  });

  it("fails a public table without RLS, quoted or unqualified", () => {
    const revoke = "revoke all on t from public, anon, authenticated;";
    expect(check(`create table t (id int); ${revoke}`)).toEqual([
      expect.stringContaining("public.t is created without"),
    ]);
    expect(
      check(
        'create table if not exists "public"."T x" (id int); revoke all privileges on "public"."T x" from public, anon, authenticated;',
      ),
    ).toEqual([expect.stringContaining("public.t x is created without")]);
    expect(
      check(
        "create unlogged table public.u (id int); revoke all on public.u from public, anon, authenticated;",
      ),
    ).toHaveLength(1);
  });

  it("requires RLS in the same migration that creates the table", () => {
    expect(
      check(
        "create table public.t (id int); revoke all on public.t from public, anon, authenticated;",
        "alter table public.t enable row level security;",
      ),
    ).toHaveLength(1);
  });

  it("requires revoking the Data API roles from every new public table", () => {
    const rls = "alter table public.t enable row level security;";
    const missing = expect.stringContaining(
      'public.t is created without "revoke all on public.t from public, anon, authenticated"',
    );
    expect(check(`create table public.t (id int); ${rls}`)).toEqual([missing]);
    // Every one of public, anon and authenticated, with all privileges.
    expect(
      check(
        `create table public.t (id int); ${rls} revoke all on public.t from anon, authenticated;`,
      ),
    ).toEqual([missing]);
    expect(
      check(
        `create table public.t (id int); ${rls} revoke select on public.t from public, anon, authenticated;`,
      ),
    ).toEqual([missing]);
    // In the same migration that creates the table.
    expect(
      check(
        `create table public.t (id int); ${rls}`,
        "revoke all on public.t from public, anon, authenticated;",
      ),
    ).toEqual([missing]);
    // A list of tables, quoted names and extra roles are fine.
    expect(
      check(`create table public.t (id int); create table "u" (id int);
             alter table public.t enable row level security;
             alter table u enable row level security;
             revoke all on table t, "public"."u" from "public", anon, authenticated, service_role cascade;`),
    ).toEqual([]);
  });

  it("fails disabling row-level security", () => {
    expect(
      check(`${TABLE} alter table public.t disable row level security;`),
    ).toEqual([expect.stringContaining("may not be disabled")]);
    expect(
      check("alter table if exists only t disable row level security;"),
    ).toHaveLength(1);
  });

  it("ignores tables outside public and temporary tables", () => {
    expect(
      check(
        "create table private.t (id int); create temp table scratch (id int);",
      ),
    ).toEqual([]);
  });

  it("fails a grant to anon or authenticated without a policy", () => {
    const table = TABLE;
    expect(
      check(`${table} grant select on public.t to authenticated;`),
    ).toEqual([
      expect.stringContaining(
        "grant on public.t to authenticated without a policy",
      ),
    ]);
    expect(
      check(`${table} grant all on table t to anon, service_role;`),
    ).toEqual([expect.stringContaining("to anon without a policy")]);
    expect(check(`${table} grant select on t to public;`)).toHaveLength(1);
  });

  it("passes a grant whose table has a policy, here or in an earlier migration", () => {
    const table = TABLE;
    const policy = `create policy "own rows" on public.t for select to authenticated using (true);`;
    expect(
      check(`${table} ${policy} grant select on public.t to authenticated;`),
    ).toEqual([]);
    expect(
      check(`${table} ${policy}`, "grant select on public.t to authenticated;"),
    ).toEqual([]);
  });

  it("fails default grants and schema-wide grants", () => {
    expect(
      check(
        "alter default privileges in schema public grant select on tables to anon;",
      ),
    ).toEqual([expect.stringContaining("default grants are not allowed")]);
    expect(
      check("grant select on all tables in schema public to authenticated;"),
    ).toEqual([expect.stringContaining("schema-wide grant")]);
    expect(
      check("grant execute on all functions in schema public to anon;"),
    ).toEqual([expect.stringContaining("schema-wide grant")]);
  });

  it("ignores grants on sequences and schemas", () => {
    expect(
      check(`grant usage on schema public to anon;
             grant usage on sequence public.s to authenticated;`),
    ).toEqual([]);
  });

  describe("functions", () => {
    const fn = (extra = "") =>
      `create or replace function public.f(a int, b numeric(10, 2)) returns int
       language sql ${extra} as $$ select 1 $$;`;

    it("requires revoking execute from public on every new public function", () => {
      expect(check(fn())).toEqual([
        expect.stringContaining(
          'public.f is created without "revoke execute on function public.f from public"',
        ),
      ]);
      expect(
        check(
          `${fn()} revoke execute on function public.f(int, numeric(10, 2)) from public;`,
        ),
      ).toEqual([]);
      expect(
        check(
          `${fn()} revoke all on function f, public.g() from public, anon, authenticated;`,
        ),
      ).toEqual([]);
      // Revoking from anon and authenticated alone leaves PUBLIC's default grant.
      expect(
        check(
          `${fn()} revoke execute on function public.f from anon, authenticated;`,
        ),
      ).toHaveLength(1);
      // Procedures get the same default grant.
      expect(
        check("create procedure p() language sql as $$ select 1 $$;"),
      ).toEqual([expect.stringContaining("public.p is created without")]);
      // Functions outside public are not reachable through the Data API.
      expect(
        check(
          "create function private.f() returns int language sql as $$ select 1 $$;",
        ),
      ).toEqual([]);
    });

    it("fails an execute grant to anon, authenticated or public", () => {
      const revoked = `${fn()} revoke all on function public.f from public;`;
      expect(
        check(
          `${revoked} grant execute on function public.f(int, numeric) to authenticated;`,
        ),
      ).toEqual([
        expect.stringContaining(
          "execute grant on public.f to authenticated is not allowed",
        ),
      ]);
      expect(
        check(`${revoked} grant all on function f to anon, service_role;`),
      ).toEqual([expect.stringContaining("to anon is not allowed")]);
      expect(
        check(`${revoked} grant execute on procedure public.f to public;`),
      ).toHaveLength(1);
      expect(
        check(`${revoked} grant execute on routine public.f to service_role;`),
      ).toEqual([]);
    });

    it("requires set search_path on security definer functions", () => {
      const revoke = "revoke all on function public.f from public;";
      expect(check(`${fn("security definer")} ${revoke}`)).toEqual([
        expect.stringContaining(
          'security definer function public.f must "set search_path"',
        ),
      ]);
      expect(
        check(`${fn("security definer set search_path = ''")} ${revoke}`),
      ).toEqual([]);
      expect(check(`${fn("security invoker")} ${revoke}`)).toEqual([]);
      expect(check("alter function public.f(int) security definer;")).toEqual([
        expect.stringContaining('without "set search_path"'),
      ]);
      expect(
        check(
          "alter function public.f(int) security definer set search_path = pg_catalog;",
        ),
      ).toEqual([]);
    });
  });

  it("is not fooled by comments, strings or function bodies", () => {
    expect(
      check(`-- create table public.c (id int); don't
             /* create table public.d (id int); */
             create function public.f() returns void language plpgsql as $body$
             begin execute 'create table public.e (id int)'; end; $body$;
             revoke all on function public.f() from public;
             select 'grant select on public.x to anon;';`),
    ).toEqual([]);
    expect(stripNoise("a 'b;c' -- d\n e $$ f; $$ g")).toBe("a ''  \n e '' g");
  });

  it("passes the real migrations and fails a bad one from the command line", () => {
    const run = (dir?: string) => {
      try {
        execFileSync(
          process.execPath,
          ["scripts/check-migrations.mjs", ...(dir ? [dir] : [])],
          { stdio: "pipe" },
        );
        return { code: 0, stderr: "" };
      } catch (e) {
        const err = e as { status: number; stderr: Buffer };
        return { code: err.status, stderr: err.stderr.toString() };
      }
    };
    expect(run().code).toBe(0);

    const dir = mkdtempSync(join(tmpdir(), "emsp-migrations-"));
    try {
      writeFileSync(
        join(dir, "202610210001_bad.sql"),
        "create table t (id int);",
      );
      writeFileSync(join(dir, "bad-name.sql"), "select 1;");
      const r = run(dir);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("public.t is created without");
      expect(r.stderr).toContain("bad-name.sql: name must be");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
