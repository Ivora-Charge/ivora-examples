import { readdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real concurrency against a real Postgres: two connections, one transaction holding
// its row locks while the other's role change waits. PGlite has a single connection,
// so this runs only when TEST_DATABASE_URL points at a local throwaway server (CI
// starts a Postgres service container for it). It creates its own database and drops
// it afterwards, and refuses any host but localhost.

const URL_ = process.env.TEST_DATABASE_URL;
const local = (() => {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      new URL(URL_ ?? "").hostname,
    );
  } catch {
    return false;
  }
})();

const OWNER = "20000000-0000-4000-8000-000000000001";
const MANAGER = "20000000-0000-4000-8000-000000000002";
const TECH = "20000000-0000-4000-8000-000000000003";
const OWNER_2 = "20000000-0000-4000-8000-000000000004";

describe.skipIf(!URL_ || !local)("concurrent team changes (Postgres)", () => {
  const db = `cpo_kit_test_${randomBytes(4).toString("hex")}`;
  let admin: postgres.Sql;
  let a: postgres.Sql;
  let b: postgres.Sql;
  let operator: string;

  const dbUrl = () => {
    const u = new URL(URL_!);
    u.pathname = `/${db}`;
    return u.toString();
  };

  beforeAll(async () => {
    admin = postgres(URL_!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${db}`);
    const setup = postgres(dbUrl(), { max: 1, onnotice: () => undefined });
    // Supabase's roles are cluster-wide; create them once.
    await setup.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      create schema auth;
      create table auth.users(id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    `);
    for (const f of readdirSync("supabase/migrations").sort())
      if (f.endsWith(".sql"))
        await setup.unsafe(readFileSync(`supabase/migrations/${f}`, "utf8"));
    await setup.end();
    a = postgres(dbUrl(), { max: 1, onnotice: () => undefined });
    b = postgres(dbUrl(), { max: 1, onnotice: () => undefined });
  }, 30_000);

  afterAll(async () => {
    await a?.end();
    await b?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${db} with (force)`);
      await admin.end();
    }
  });

  async function reset() {
    await a`delete from cpo_operators`;
    await a`delete from auth.users`;
    await a`insert into auth.users(id, email) values
      (${OWNER}, 'owner@example.com'), (${MANAGER}, 'manager@example.com'),
      (${TECH}, 'tech@example.com'), (${OWNER_2}, 'owner-2@example.com')`;
    [{ id: operator }] = await a<
      { id: string }[]
    >`select cpo_bootstrap_owner(${OWNER}, 'owner@example.com', 'Sample Operator') as id`;
    await a`insert into cpo_staff(operator_id, user_id, email, role) values
      (${operator}, ${MANAGER}, 'manager@example.com', 'manager'),
      (${operator}, ${TECH}, 'tech@example.com', 'technician')`;
  }

  /** Resolves once the backend `pid` is waiting for a lock. */
  async function waitingForLock(pid: number) {
    for (let i = 0; i < 200; i++) {
      const [r] = await admin<
        { wait: string | null }[]
      >`select wait_event_type as wait from pg_stat_activity where pid = ${pid}`;
      if (r?.wait === "Lock") return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the second change never waited for the lock");
  }
  const pidOf = async (conn: postgres.Sql) =>
    (await conn<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid;

  /**
   * The owner promotes TECH to owner in an open transaction; meanwhile the manager's
   * change (checked against TECH as technician) starts, waits, and must then fail.
   */
  async function raceOwnerPromotion(
    managerWrite: (c: postgres.Sql) => unknown,
  ) {
    await reset();
    const managerPid = await pidOf(b);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const hasLocks = new Promise<void>((r) => (locked = r));
    const owner = a.begin(async (tx) => {
      await tx`select cpo_set_staff_role(${operator}, ${OWNER}, 'owner', ${TECH}, 'technician', 'owner')`;
      locked();
      await released;
    });
    await hasLocks;
    const manager = Promise.resolve(managerWrite(b)).then(
      () => null,
      (e: Error) => e,
    );
    await waitingForLock(managerPid);
    release();
    await owner;
    return manager;
  }

  it("refuses a manager's stale role change that waited on an owner's promotion", async () => {
    const e = await raceOwnerPromotion(
      (c) =>
        c`select cpo_set_staff_role(${operator}, ${MANAGER}, 'manager', ${TECH}, 'technician', 'viewer')`,
    );
    expect(String(e)).toMatch(/cpo_changed_meanwhile/);
    const [t] = await a`select role from cpo_staff where user_id = ${TECH}`;
    expect(t.role).toBe("owner");
  });

  it("refuses a manager's stale removal that waited on an owner's promotion", async () => {
    const e = await raceOwnerPromotion(
      (c) =>
        c`select cpo_remove_staff(${operator}, ${MANAGER}, 'manager', ${TECH}, 'technician')`,
    );
    expect(String(e)).toMatch(/cpo_changed_meanwhile/);
    const [t] = await a`select role from cpo_staff where user_id = ${TECH}`;
    expect(t.role).toBe("owner");
  });

  it("lets only one of two owners step down at the same moment", async () => {
    await reset();
    await a`insert into cpo_staff(operator_id, user_id, email, role)
      values (${operator}, ${OWNER_2}, 'owner-2@example.com', 'owner')`;
    const results = await Promise.allSettled([
      a`select cpo_set_staff_role(${operator}, ${OWNER}, 'owner', ${OWNER}, 'owner', 'manager')`,
      b`select cpo_set_staff_role(${operator}, ${OWNER_2}, 'owner', ${OWNER_2}, 'owner', 'manager')`,
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(String(rejected?.reason)).toMatch(/cpo_last_owner/);
    const owners = await a`select 1 from cpo_staff where role = 'owner'`;
    expect(owners).toHaveLength(1);
  });
});
