import { describe, expect, it } from "vitest";
import { checkMigrations, readMigrations } from "../scripts/check-migrations";

const file = (sql: string, name = "202601010001_test.sql") => ({ name, sql });

const SAFE_TABLE = `
create table if not exists public.cpo_things (id uuid primary key, owner uuid);
alter table public.cpo_things enable row level security;
revoke all on public.cpo_things from public, anon, authenticated;
`;

describe("migration check (10-30 rule)", () => {
  it("passes the kit's own migrations", () => {
    expect(checkMigrations(readMigrations("supabase/migrations"))).toEqual([]);
  });

  it("passes a table with RLS, revokes and a policy-backed grant", () => {
    expect(
      checkMigrations([
        file(`${SAFE_TABLE}
grant select (id) on public.cpo_things to authenticated;
create policy "Own rows" on public.cpo_things for select to authenticated using (owner = auth.uid());`),
      ]),
    ).toEqual([]);
  });

  it("fails a public table without RLS", () => {
    expect(
      checkMigrations([
        file(`create table public.cpo_open (id int);
revoke all on public.cpo_open from anon, authenticated;`),
      ]),
    ).toEqual([
      "202601010001_test.sql: creates public.cpo_open without enabling RLS",
    ]);
  });

  it("treats an unqualified table as public", () => {
    expect(checkMigrations([file("create table cpo_bare (id int);")])).toEqual(
      expect.arrayContaining([
        "202601010001_test.sql: creates public.cpo_bare without enabling RLS",
      ]),
    );
  });

  it("fails a table left with default grants", () => {
    expect(
      checkMigrations([
        file(`create table public.cpo_x (id int);
alter table public.cpo_x enable row level security;`),
      ]),
    ).toEqual([
      "202601010001_test.sql: creates public.cpo_x without revoking all from anon",
      "202601010001_test.sql: creates public.cpo_x without revoking all from authenticated",
    ]);
  });

  it("fails a grant to anon or authenticated without a matching policy", () => {
    const problems = checkMigrations([
      file(`${SAFE_TABLE}
grant select on public.cpo_things to anon;
grant select, update on public.cpo_things to authenticated;
create policy "Read" on public.cpo_things for select to authenticated using (true);`),
    ]);
    expect(problems).toEqual([
      "202601010001_test.sql: grants select on public.cpo_things to anon without a matching policy",
      "202601010001_test.sql: grants update on public.cpo_things to authenticated without a matching policy",
    ]);
  });

  it("accepts a policy from an earlier migration", () => {
    expect(
      checkMigrations([
        file(
          `${SAFE_TABLE}
create policy "Read" on public.cpo_things for select to authenticated using (true);`,
          "202601010001_a.sql",
        ),
        file(
          "grant select on public.cpo_things to authenticated;",
          "202601010002_b.sql",
        ),
      ]),
    ).toEqual([]);
  });

  it("fails ALL grants, default privileges, disabled RLS and unsafe views", () => {
    const problems = checkMigrations([
      file(`${SAFE_TABLE}
grant all on public.cpo_things to authenticated;
grant select on all tables in schema public to anon;
alter default privileges in schema public grant select on tables to anon;
alter table public.cpo_things disable row level security;
create view public.cpo_v as select 1;`),
    ]);
    expect(problems).toEqual([
      "202601010001_test.sql: grants ALL on cpo_things to authenticated",
      "202601010001_test.sql: grants all tables to anon",
      "202601010001_test.sql: grants default privileges",
      "202601010001_test.sql: disables RLS on cpo_things",
      "202601010001_test.sql: view cpo_v must use security_invoker = true",
    ]);
  });

  it("fails a function still executable by PUBLIC, or granted to anon", () => {
    const problems = checkMigrations([
      file(`create function public.cpo_f() returns int language sql as $$ select 1; $$;
create function public.cpo_g() returns int language sql as $$ select 2 $$;
revoke all on function public.cpo_g() from public, anon, authenticated;
grant execute on function public.cpo_g() to anon;`),
    ]);
    expect(problems).toEqual([
      "202601010001_test.sql: grants function cpo_g to anon",
      "202601010001_test.sql: creates function public.cpo_f without revoking EXECUTE from public",
    ]);
  });

  it("ignores SQL inside comments, strings and function bodies", () => {
    expect(
      checkMigrations([
        file(`-- create table public.cpo_in_comment (id int);
/* grant all on public.cpo_things to anon; */
create function public.cpo_h() returns text language sql as $$ select 'create table public.y (id int); grant all on public.y to anon' $$;
revoke all on function public.cpo_h() from public;
select 'grant all on public.z to anon';`),
      ]),
    ).toEqual([]);
  });
});
