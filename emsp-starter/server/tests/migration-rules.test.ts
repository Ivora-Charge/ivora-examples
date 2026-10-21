import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMigrations, stripNoise } from "../scripts/migration-rules.mjs";

const check = (...sql: string[]) =>
  checkMigrations(
    sql.map((s, i) => ({ name: `20261021000${i + 1}_m.sql`, sql: s })),
  ).map((p: { message: string }) => p.message);

describe("10-30 migration check", () => {
  it("passes a service-only table with RLS", () => {
    expect(
      check(`create table public.t (id int);
             alter table public.t enable row level security;
             grant select, insert on table public.t to service_role;`),
    ).toEqual([]);
  });

  it("fails a public table without RLS, quoted or unqualified", () => {
    expect(check("create table t (id int);")).toEqual([
      expect.stringContaining("public.t is created without"),
    ]);
    expect(
      check('create table if not exists "public"."T x" (id int);'),
    ).toEqual([expect.stringContaining("public.t x is created without")]);
    expect(check("create unlogged table public.u (id int);")).toHaveLength(1);
  });

  it("requires RLS in the same migration that creates the table", () => {
    expect(
      check(
        "create table public.t (id int);",
        "alter table public.t enable row level security;",
      ),
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
    const table = `create table public.t (id int); alter table public.t enable row level security;`;
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
    const table = `create table public.t (id int); alter table public.t enable row level security;`;
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
    ).toEqual([expect.stringContaining("schema-wide table grant")]);
  });

  it("ignores grants on functions, sequences and schemas", () => {
    expect(
      check(`grant usage on schema public to anon;
             grant execute on function public.f() to authenticated;
             grant usage on sequence public.s to authenticated;`),
    ).toEqual([]);
  });

  it("is not fooled by comments, strings or function bodies", () => {
    expect(
      check(`-- create table public.c (id int); don't
             /* create table public.d (id int); */
             create function public.f() returns void language plpgsql as $body$
             begin execute 'create table public.e (id int)'; end; $body$;
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
