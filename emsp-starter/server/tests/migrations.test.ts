import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asRole, migratedDatabase } from "./support/pglite";

let db: PGlite;
let legacy: PGlite;
beforeAll(async () => {
  db = await migratedDatabase();
  legacy = await migratedDatabase({ legacyDefaults: true });
}, 60_000);
afterAll(async () => {
  await db?.close();
  await legacy?.close();
});

/** Tables in public that a Data API role may use, and the role. */
const EXPOSED_TABLES = `
  select c.relname as table, r.rolname as role
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) as r(rolname)
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
    and has_table_privilege(r.rolname, c.oid, 'select, insert, update, delete, truncate, references, trigger')
    and not exists (select 1 from pg_policies p
                    where p.schemaname = 'public' and p.tablename = c.relname)`;

/** Functions in public that a Data API role (or PUBLIC, which they inherit) may execute. */
const EXPOSED_FUNCTIONS = `
  select p.oid::regprocedure::text as function, r.rolname as role
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated')) as r(rolname)
  where n.nspname = 'public' and has_function_privilege(r.rolname, p.oid, 'execute')`;

describe("migrations on PGlite", () => {
  it("records every applied migration in the ledger", async () => {
    const { rows } = await db.query<{ filename: string }>(
      "select filename from public.emsp_schema_migrations order by filename",
    );
    expect(rows.map((r) => r.filename)).toContain("202610210001_baseline.sql");
  });

  it("enables RLS on every public table (10-30 rule)", async () => {
    const { rows } = await db.query<{ table: string }>(
      `select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("grants the Data API roles nothing on tables without a policy (10-30 rule)", async () => {
    const { rows } = await db.query<{ table: string; grantee: string }>(
      `select g.table_name as table, g.grantee from information_schema.role_table_grants g
       where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated', 'PUBLIC')
         and not exists (select 1 from pg_policies p
                         where p.schemaname = 'public' and p.tablename = g.table_name)`,
    );
    expect(rows).toEqual([]);
  });

  it("lets anon and authenticated execute no public function", async () => {
    const { rows } = await db.query(EXPOSED_FUNCTIONS);
    expect(rows).toEqual([]);
  });

  it("sets search_path on every security definer function", async () => {
    const { rows } = await db.query(
      `select p.oid::regprocedure::text as function from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c
                         where c like 'search_path=%')`,
    );
    expect(rows).toEqual([]);
  });

  it("stays closed on a project with legacy default grants", async () => {
    // Sanity check: the legacy defaults really do grant new objects.
    await legacy.exec(
      "create table public.probe (id int); create function public.probe() returns int language sql as $$ select 1 $$;",
    );
    expect(
      (await legacy.query(`${EXPOSED_TABLES} and c.relname = 'probe'`)).rows,
    ).toHaveLength(2);
    expect(
      (await legacy.query(`${EXPOSED_FUNCTIONS} and p.proname = 'probe'`)).rows,
    ).toHaveLength(2);
    await legacy.exec("drop table public.probe; drop function public.probe();");

    expect((await legacy.query(EXPOSED_TABLES)).rows).toEqual([]);
    expect((await legacy.query(EXPOSED_FUNCTIONS)).rows).toEqual([]);
    await asRole(legacy, "anon", async () => {
      await expect(
        legacy.query("select * from public.emsp_audit_log"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("keeps the audit log away from anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await asRole(db, role, async () => {
        await expect(
          db.query("select * from public.emsp_audit_log"),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query(
            "insert into public.emsp_audit_log (actor, action) values ('x', 'y')",
          ),
        ).rejects.toThrow(/permission denied/);
      });
    }
  });

  it("lets the service role append and read the audit log, but never change it", async () => {
    await asRole(db, "service_role", async () => {
      await db.query(
        `insert into public.emsp_audit_log (actor, action, subject_type, subject_id, details)
         values ('system', 'test.ran', 'test', '1', '{"ok": true}')`,
      );
      const { rows } = await db.query<{ action: string }>(
        "select action from public.emsp_audit_log where subject_id = '1'",
      );
      expect(rows).toEqual([{ action: "test.ran" }]);
      await expect(
        db.query("update public.emsp_audit_log set action = 'changed'"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("delete from public.emsp_audit_log"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("refuses updates and deletes even from the table owner", async () => {
    await expect(
      db.query("update public.emsp_audit_log set action = 'changed'"),
    ).rejects.toThrow(/append-only/);
    await expect(db.query("delete from public.emsp_audit_log")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query("truncate public.emsp_audit_log")).rejects.toThrow(
      /append-only/,
    );
  });

  it("rejects malformed audit entries", async () => {
    await expect(
      db.query(
        "insert into public.emsp_audit_log (actor, action, details) values ('system', 'x', '[]')",
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query(
        "insert into public.emsp_audit_log (actor, action) values ('', 'x')",
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
