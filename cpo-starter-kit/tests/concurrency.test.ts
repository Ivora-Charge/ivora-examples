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

  it("refuses a manager's company save that waited on their own demotion", async () => {
    await reset();
    const managerPid = await pidOf(b);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const hasLocks = new Promise<void>((r) => (locked = r));
    const owner = a.begin(async (tx) => {
      await tx`select cpo_set_staff_role(${operator}, ${OWNER}, 'owner', ${MANAGER}, 'manager', 'technician')`;
      locked();
      await released;
    });
    await hasLocks;
    const save = Promise.resolve(
      b`select cpo_save_company(${operator}, ${MANAGER}, 'Sample Co', 'help@example.com', null, null, 'UTC', 'USD')`,
    ).then(
      () => null,
      (e: Error) => e,
    );
    await waitingForLock(managerPid);
    release();
    await owner;
    expect(String(await save)).toMatch(/cpo_not_allowed/);
    const rows = await a`select 1 from cpo_company_profiles`;
    expect(rows).toHaveLength(0);
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
  it("sends one remote test start when two claims race", async () => {
    await reset();
    const [{ id }] = await a<
      { id: string }[]
    >`select cpo_create_charger(${operator}, ${TECH}, 'RACE-01', null, 5, null, 1, 77, null) as id`;
    // An object, as the app's rpc sends it: a JSON.stringify'd string would arrive
    // as a jsonb string and the function would refuse it.
    const test = { phase: "starting", connectorNumber: 1 };
    const claim = (c: postgres.Sql | postgres.TransactionSql) =>
      c`select cpo_claim_charger_test(${operator}, ${TECH}, ${id}, ${c.json(test)}::jsonb) as n`;
    // The first claim holds its row lock in an open transaction; the second waits
    // for it, then sees the running test.
    const secondPid = await pidOf(b);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let claimed!: () => void;
    let claimFailed!: (e: unknown) => void;
    const hasClaimed = new Promise<void>((resolve, reject) => {
      claimed = resolve;
      claimFailed = reject;
    });
    const first = a.begin(async (tx) => {
      try {
        await claim(tx);
      } catch (e) {
        // Fail fast instead of waiting for the test timeout.
        claimFailed(e);
        throw e;
      }
      claimed();
      await released;
    });
    // If the claim fails, `first` rejects too; keep that from going unhandled.
    first.catch(() => undefined);
    await hasClaimed;
    const second = Promise.resolve(claim(b)).then(
      () => null,
      (e: Error) => e,
    );
    await waitingForLock(secondPid);
    release();
    await first;
    expect(String(await second)).toMatch(/cpo_charger_busy/);
    const [r] =
      await a`select test_runs, remote_test from cpo_chargers where id = ${id}`;
    expect(r.test_runs).toBe(1);
    expect(r.remote_test).toMatchObject({ phase: "starting", attempt: 1 });
  });

  /**
   * The first claim holds its insert in an open transaction; the second starts, waits
   * for it, and its outcome is returned once the first commits.
   */
  async function raceClaims(firstRequest: string, secondRequest: string) {
    await reset();
    const claim = (
      c: postgres.Sql | postgres.TransactionSql,
      request: string,
    ) =>
      c<
        { r: { id: string; created: boolean } }[]
      >`select cpo_claim_live_command(${operator}, ${TECH}, ${request}, 77, 'reset', null, null, 'soft', '{}') as r`;
    const secondPid = await pidOf(b);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let claimed!: (id: string) => void;
    let claimFailed!: (e: unknown) => void;
    const hasClaimed = new Promise<string>((resolve, reject) => {
      claimed = resolve;
      claimFailed = reject;
    });
    const first = a.begin(async (tx) => {
      try {
        const [{ r }] = await claim(tx, firstRequest);
        claimed(r.id);
      } catch (e) {
        claimFailed(e);
        throw e;
      }
      await released;
    });
    first.catch(() => undefined);
    const firstId = await hasClaimed;
    const second = Promise.resolve(claim(b, secondRequest)).then(
      ([{ r }]) => r,
      (e: Error) => e,
    );
    await waitingForLock(secondPid);
    release();
    await first;
    return { firstId, second: await second };
  }

  it("sends one live command when two taps on the same charger race", async () => {
    const { second } = await raceClaims(
      "30000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000002",
    );
    expect(String(second)).toMatch(/cpo_command_busy/);
    const rows = await a`select 1 from cpo_live_commands where station_id = 77`;
    expect(rows).toHaveLength(1);
  });

  it("gives a resubmitted tap the command it already made", async () => {
    const request = "30000000-0000-4000-8000-000000000003";
    const { firstId, second } = await raceClaims(request, request);
    expect(second).toEqual({ id: firstId, created: false });
    const rows = await a`select 1 from cpo_live_commands where station_id = 77`;
    expect(rows).toHaveLength(1);
  });

  /**
   * `first` runs in an open transaction (its row locks held); meanwhile `second`
   * starts, waits for the lock, and its answer (or error) is returned once the first
   * commits.
   */
  async function raceWrites(
    first: (tx: postgres.TransactionSql) => Promise<unknown>,
    second: (c: postgres.Sql) => Promise<unknown>,
  ) {
    const secondPid = await pidOf(b);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const hasLocks = new Promise<void>((r) => (locked = r));
    const tx = a.begin(async (t) => {
      await first(t);
      locked();
      await released;
    });
    await hasLocks;
    const out = second(b).then(
      () => null,
      (e: Error) => e,
    );
    await waitingForLock(secondPid);
    release();
    await tx;
    return out;
  }

  const DEF = { kind: "paid", currency: "USD" };

  async function liveTariff() {
    const [{ id }] = await a<
      { id: string }[]
    >`select cpo_create_tariff(${operator}, ${OWNER}, 'Standard', ${a.json(DEF)}) as id`;
    await a`select cpo_record_tariff_version(${operator}, ${OWNER}, ${id}, 1, 500)`;
    return id;
  }

  it("refuses a tariff save from a stale editor that waited on another save", async () => {
    await reset();
    const id = await liveTariff();
    const [{ revision }] = await a<
      { revision: number }[]
    >`select revision from cpo_tariffs where id = ${id}`;
    // Both editors were loaded at the same revision.
    const e = await raceWrites(
      (tx) =>
        tx`select cpo_add_tariff_version(${operator}, ${OWNER}, ${id}, ${revision}, 'Standard', ${tx.json({ ...DEF, energyMinorPerKwh: 45 })})`,
      (c) =>
        c`select cpo_add_tariff_version(${operator}, ${MANAGER}, ${id}, ${revision}, 'Standard', ${c.json({ ...DEF, idleMinorPerMinute: 50 })})`,
    );
    expect(String(e)).toMatch(/cpo_tariff_changed/);
    const rows = await a<
      { version: number; definition: { energyMinorPerKwh?: number } }[]
    >`select version, definition from cpo_tariff_versions where tariff_id = ${id} order by version`;
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[1].definition.energyMinorPerKwh).toBe(45);
  });

  it("refuses a stale station save that would reopen a private charger", async () => {
    await reset();
    const id = await liveTariff();
    const save = (
      c: postgres.Sql | postgres.TransactionSql,
      actor: string,
      expected: number,
      priv: boolean,
    ) =>
      c`select cpo_set_station_pricing(${operator}, ${actor}, 9101, ${expected}, ${id}, ${priv}, ${c.json([])})`;
    await save(a, OWNER, 0, false);
    // Both forms were loaded at revision 1; the owner makes it private first.
    const e = await raceWrites(
      (tx) => save(tx, OWNER, 1, true),
      (c) => save(c, MANAGER, 1, false),
    );
    expect(String(e)).toMatch(/cpo_station_changed/);
    const [row] = await a<
      { private: boolean; revision: number }[]
    >`select private, revision from cpo_station_pricing where station_id = 9101`;
    expect(row).toEqual({ private: true, revision: 2 });
  });

  it("saves a station's first pricing once when two forms race", async () => {
    await reset();
    const id = await liveTariff();
    const save = (
      c: postgres.Sql | postgres.TransactionSql,
      actor: string,
      priv: boolean,
    ) =>
      c`select cpo_set_station_pricing(${operator}, ${actor}, 9102, 0, ${id}, ${priv}, ${c.json([])})`;
    const e = await raceWrites(
      (tx) => save(tx, OWNER, true),
      (c) => save(c, MANAGER, false),
    );
    expect(String(e)).toMatch(/cpo_station_changed/);
    const rows = await a<
      { private: boolean }[]
    >`select private from cpo_station_pricing where station_id = 9102`;
    expect(rows).toEqual([{ private: true }]);
  });

  /** One driver's tap: a paid claim on connector 91011 of station 9101. */
  const claimCheckout = (
    c: postgres.Sql | postgres.TransactionSql,
    req: string,
  ) =>
    c<
      { r: { id?: string; created?: boolean; busy?: string } }[]
    >`select cpo_claim_checkout(${operator}, ${req}, 'paid', 'ABCD2345', 9101, 91011, 9401, 2500, 'USD') as r`.then(
      (x) => x[0].r,
    );

  it("gives a connector to one of two drivers who tap at the same moment", async () => {
    await reset();
    const secondPid = await pidOf(b);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let claimed!: (id: string) => void;
    const firstId = new Promise<string>((r) => (claimed = r));
    // The first driver's claim is inserted but not committed yet.
    const tx = a.begin(async (t) => {
      const r = await claimCheckout(t, "40000000-0000-4000-8000-000000000001");
      claimed(r.id!);
      await released;
    });
    const id = await firstId;
    // The second driver's claim waits on the first's row, then sees it: busy, and
    // nothing inserted, so no second bill or hold can follow.
    const second = claimCheckout(b, "40000000-0000-4000-8000-000000000002");
    await waitingForLock(secondPid);
    release();
    await tx;
    expect(await second).toEqual({ busy: id });
    const rows =
      await a`select 1 from cpo_checkouts where connector_id = 91011`;
    expect(rows).toHaveLength(1);
  });
});
