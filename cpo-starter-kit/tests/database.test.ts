import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// The migrations run in an in-process Postgres (PGlite) with the Supabase roles,
// default privileges and auth.uid() stubbed, so RLS and grants are tested without a
// real project.

const MIGRATIONS = "supabase/migrations";
const migrations = () =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8"));

const OWNER_A = "10000000-0000-4000-8000-00000000000a";
const TECH_A = "10000000-0000-4000-8000-00000000000b";
const OWNER_B = "10000000-0000-4000-8000-00000000000c";
const OUTSIDER = "10000000-0000-4000-8000-00000000000d";
const HASH = (c: string) => c.repeat(64);

let pg: PGlite;
let operatorA: string;
let operatorB: string;

async function as<T>(
  role: "anon" | "authenticated" | "service_role",
  userId: string | null,
  run: () => Promise<T>,
): Promise<T> {
  await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [
    userId ?? "",
  ]);
  await pg.exec(`set role ${role}`);
  try {
    return await run();
  } finally {
    await pg.exec("reset role");
  }
}

const TABLES = [
  "cpo_operators",
  "cpo_staff",
  "cpo_invites",
  "cpo_rate_limits",
  "cpo_company_profiles",
  "cpo_chargers",
  "cpo_sticker_codes",
  "cpo_live_commands",
  "cpo_ivora_events",
  "cpo_staff_tokens",
  "cpo_tariffs",
  "cpo_tariff_versions",
  "cpo_station_pricing",
  "cpo_connector_tariffs",
] as const;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    -- Supabase grants browser roles everything on new public tables, sequences and
    -- functions (and Postgres grants PUBLIC EXECUTE on every function).
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  for (const sql of migrations()) await pg.exec(sql);
  await pg.query(
    "insert into auth.users(id,email) values ($1,'owner-a@example.com'),($2,'tech-a@example.com'),($3,'owner-b@example.com'),($4,'outsider@example.com')",
    [OWNER_A, TECH_A, OWNER_B, OUTSIDER],
  );
  operatorA = (
    await as("service_role", null, () =>
      pg.query<{ id: string }>(
        "select cpo_bootstrap_owner($1,'Owner-A@example.com','Sample Operator A') as id",
        [OWNER_A],
      ),
    )
  ).rows[0].id;
  // A second operator in the same database, for isolation tests.
  operatorB = (
    await pg.query<{ id: string }>(
      "insert into cpo_operators(name) values ('Sample Operator B') returning id",
    )
  ).rows[0].id;
  await pg.query(
    "insert into cpo_staff(operator_id,user_id,email,role) values ($1,$2,'tech-a@example.com','technician'),($3,$4,'owner-b@example.com','owner')",
    [operatorA, TECH_A, operatorB, OWNER_B],
  );
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("row level security", () => {
  it("is enabled on every public table", async () => {
    const { rows } = await pg.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(
      "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(TABLES.length);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it("lets a staff member read only their own operator and team", async () => {
    await as("authenticated", TECH_A, async () => {
      const ops = await pg.query<{ id: string; name: string }>(
        "select id, name from cpo_operators",
      );
      expect(ops.rows).toEqual([{ id: operatorA, name: "Sample Operator A" }]);
      const staff = await pg.query<{ email: string; role: string }>(
        "select email, role from cpo_staff order by email",
      );
      expect(staff.rows).toEqual([
        { email: "owner-a@example.com", role: "owner" },
        { email: "tech-a@example.com", role: "technician" },
      ]);
    });
    await as("authenticated", OWNER_B, async () => {
      const staff = await pg.query<{ email: string }>(
        "select email from cpo_staff",
      );
      expect(staff.rows).toEqual([{ email: "owner-b@example.com" }]);
    });
  });

  it("shows a signed-in user who is not staff nothing", async () => {
    await as("authenticated", OUTSIDER, async () => {
      expect((await pg.query("select id from cpo_operators")).rows).toEqual([]);
      expect(
        (await pg.query("select operator_id from cpo_staff")).rows,
      ).toEqual([]);
    });
  });

  it("gives anon nothing at all, despite permissive default privileges", async () => {
    await as("anon", null, async () => {
      for (const t of TABLES)
        await expect(pg.query(`select * from ${t}`)).rejects.toThrow(
          /permission denied/,
        );
    });
  });

  it("keeps invites and rate limits server-only, and staff read-only", async () => {
    await as("authenticated", OWNER_A, async () => {
      for (const t of ["cpo_invites", "cpo_rate_limits"])
        await expect(pg.query(`select * from ${t}`)).rejects.toThrow(
          /permission denied/,
        );
      // Owners included: role changes go through the server, never the Data API.
      await expect(
        pg.query("update cpo_staff set role='owner' where user_id=$1", [
          TECH_A,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pg.query(
          "insert into cpo_staff(operator_id,user_id,email,role) values ($1,$2,'x@example.com','owner')",
          [operatorA, OUTSIDER],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(pg.query("delete from cpo_staff")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        pg.query("update cpo_operators set name='x'"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("does not let browser roles run the server functions", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await as(role, OUTSIDER, async () => {
        for (const q of [
          `select cpo_bootstrap_owner('${OUTSIDER}','x@example.com','X')`,
          `select cpo_accept_invite('${HASH("a")}','${OUTSIDER}','x@example.com')`,
          `select cpo_create_invite('${operatorA}','x@example.com','owner','${HASH("a")}',null,now())`,
          "select cpo_take_rate_limit('k',100,60)",
          `select cpo_set_staff_role('${operatorA}','${OWNER_A}','owner','${TECH_A}','technician','owner')`,
          `select cpo_remove_staff('${operatorA}','${OWNER_A}','owner','${TECH_A}','technician')`,
          `select cpo_lock_checked_roles('${operatorA}','${OWNER_A}','owner','${TECH_A}','technician')`,
          `select cpo_save_company('${operatorA}','${OWNER_A}','X','x@example.com',null,null,'UTC','USD')`,
          `select cpo_save_brand('${operatorA}','${OWNER_A}','#000000')`,
          `select cpo_record_branding('${operatorA}','${OWNER_A}',null,null,false)`,
          `select cpo_lock_onboarding_actor('${operatorA}','${OWNER_A}')`,
          `select cpo_lock_charger_actor('${operatorA}','${OWNER_A}',false)`,
          `select cpo_create_charger('${operatorA}','${OWNER_A}','X-1-ABC',null,1,null,1,null,null)`,
          `select cpo_update_charger('${operatorA}','${OWNER_A}','${OWNER_A}','{}')`,
          `select cpo_next_charger_seq('${operatorA}','${OWNER_A}','${OWNER_A}','edit')`,
          `select cpo_claim_charger_test('${operatorA}','${OWNER_A}','${OWNER_A}','{}')`,
          `select cpo_add_sticker_codes('${operatorA}','${OWNER_A}','${OWNER_A}','[]')`,
          `select cpo_remove_charger('${operatorA}','${OWNER_A}','${OWNER_A}')`,
          `select cpo_claim_live_command('${operatorA}','${OWNER_A}','${OWNER_A}',1,'reset',null,null,'soft','{}')`,
          `select cpo_record_live_command('${operatorA}','${OWNER_A}','{}')`,
          "select cpo_record_ivora_event('evt_x','webhook.test',null)",
        ])
          await expect(pg.query(q)).rejects.toThrow(/permission denied/);
      });
  });

  it("leaves browser roles only the one function the RLS policies need", async () => {
    const { rows } = await pg.query<{ fn: string; role: string }>(`
      select p.proname as fn, r.role from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('authenticated')) r(role)
        where n.nspname = 'public' and has_function_privilege(r.role, p.oid, 'execute')
        order by 1, 2`);
    expect(rows).toEqual([
      { fn: "cpo_my_operator_ids", role: "authenticated" },
    ]);
  });
});

describe("role changes and removals", () => {
  const setRole = (
    actor: string,
    actorRole: string,
    user: string,
    expected: string,
    to: string,
  ) =>
    as("service_role", null, () =>
      pg.query("select cpo_set_staff_role($1,$2,$3,$4,$5,$6)", [
        operatorA,
        actor,
        actorRole,
        user,
        expected,
        to,
      ]),
    );
  const remove = (
    actor: string,
    actorRole: string,
    user: string,
    expected: string,
  ) =>
    as("service_role", null, () =>
      pg.query("select cpo_remove_staff($1,$2,$3,$4,$5)", [
        operatorA,
        actor,
        actorRole,
        user,
        expected,
      ]),
    );
  const roleOf = async (user: string) =>
    (
      await pg.query<{ role: string }>(
        "select role from cpo_staff where user_id=$1",
        [user],
      )
    ).rows[0]?.role;

  it("applies a change only while the checked roles still hold", async () => {
    await setRole(OWNER_A, "owner", TECH_A, "technician", "viewer");
    expect(await roleOf(TECH_A)).toBe("viewer");
    // Stale target role: the server checked "technician", it is "viewer" now.
    await expect(
      setRole(OWNER_A, "owner", TECH_A, "technician", "manager"),
    ).rejects.toThrow(/cpo_changed_meanwhile/);
    await expect(
      remove(OWNER_A, "owner", TECH_A, "technician"),
    ).rejects.toThrow(/cpo_changed_meanwhile/);
    // Stale actor role, and an actor from another operator.
    await expect(
      setRole(OWNER_A, "manager", TECH_A, "viewer", "technician"),
    ).rejects.toThrow(/cpo_changed_meanwhile/);
    await expect(
      setRole(OWNER_B, "owner", TECH_A, "viewer", "technician"),
    ).rejects.toThrow(/cpo_changed_meanwhile/);
    expect(await roleOf(TECH_A)).toBe("viewer");
    await setRole(OWNER_A, "owner", TECH_A, "viewer", "technician");
  });

  it("does not let a manager demote or remove someone promoted to owner meanwhile", async () => {
    await pg.query("update cpo_staff set role='manager' where user_id=$1", [
      TECH_A,
    ]);
    await pg.query(
      "insert into cpo_staff(operator_id,user_id,email,role) values ($1,$2,'outsider@example.com','technician')",
      [operatorA, OUTSIDER],
    );
    try {
      // The manager's page showed OUTSIDER as a technician; an owner promotes them.
      await setRole(OWNER_A, "owner", OUTSIDER, "technician", "owner");
      await expect(
        setRole(TECH_A, "manager", OUTSIDER, "technician", "viewer"),
      ).rejects.toThrow(/cpo_changed_meanwhile/);
      await expect(
        remove(TECH_A, "manager", OUTSIDER, "technician"),
      ).rejects.toThrow(/cpo_changed_meanwhile/);
      expect(await roleOf(OUTSIDER)).toBe("owner");
    } finally {
      await pg.query("delete from cpo_staff where user_id=$1", [OUTSIDER]);
      await pg.query(
        "update cpo_staff set role='technician' where user_id=$1",
        [TECH_A],
      );
    }
  });

  it("still refuses to demote the last owner", async () => {
    await expect(
      setRole(OWNER_A, "owner", OWNER_A, "owner", "manager"),
    ).rejects.toThrow(/cpo_last_owner/);
  });

  it("revokes pending invites the person may no longer send", async () => {
    await pg.query("update cpo_staff set role='manager' where user_id=$1", [
      TECH_A,
    ]);
    const invite = (email: string, role: string, hash: string) =>
      as("service_role", null, () =>
        pg.query(
          "select cpo_create_invite($1,$2,$3,$4,$5,now() + interval '1 day')",
          [operatorA, email, role, hash, TECH_A],
        ),
      );
    const pending = async () =>
      (
        await pg.query<{ email: string }>(
          "select email from cpo_invites where invited_by=$1 and accepted_at is null and revoked_at is null order by email",
          [TECH_A],
        )
      ).rows.map((r) => r.email);
    await invite("by-manager-1@example.com", "viewer", HASH("6"));
    await invite("by-manager-2@example.com", "technician", HASH("7"));
    await setRole(OWNER_A, "owner", TECH_A, "manager", "viewer");
    expect(await pending()).toEqual([]);

    await pg.query("update cpo_staff set role='manager' where user_id=$1", [
      TECH_A,
    ]);
    await invite("by-manager-3@example.com", "viewer", HASH("8"));
    await remove(OWNER_A, "owner", TECH_A, "manager");
    expect(await pending()).toEqual([]);
    await pg.query(
      "insert into cpo_staff(operator_id,user_id,email,role) values ($1,$2,'tech-a@example.com','technician')",
      [operatorA, TECH_A],
    );
  });
});

describe("owners", () => {
  it("creates the first owner once; later setups are refused", async () => {
    await as("service_role", null, async () => {
      await expect(
        pg.query(
          "select cpo_bootstrap_owner($1,'outsider@example.com','Another')",
          [OUTSIDER],
        ),
      ).rejects.toThrow(/cpo_setup_done/);
    });
  });

  it("never removes or demotes the last owner", async () => {
    await expect(
      pg.query("update cpo_staff set role='manager' where user_id=$1", [
        OWNER_A,
      ]),
    ).rejects.toThrow(/cpo_last_owner/);
    await expect(
      pg.query("delete from cpo_staff where user_id=$1", [OWNER_A]),
    ).rejects.toThrow(/cpo_last_owner/);
    // Deleting the login cascades to the staff row, so it is refused too.
    await expect(
      pg.query("delete from auth.users where id=$1", [OWNER_A]),
    ).rejects.toThrow(/cpo_last_owner/);

    // With a second owner, either may step down, but not both.
    await pg.query("update cpo_staff set role='owner' where user_id=$1", [
      TECH_A,
    ]);
    await pg.query("update cpo_staff set role='manager' where user_id=$1", [
      OWNER_A,
    ]);
    await expect(
      pg.query("update cpo_staff set role='viewer' where user_id=$1", [TECH_A]),
    ).rejects.toThrow(/cpo_last_owner/);
    // Restore for the other tests.
    await pg.query("update cpo_staff set role='owner' where user_id=$1", [
      OWNER_A,
    ]);
    await pg.query("update cpo_staff set role='technician' where user_id=$1", [
      TECH_A,
    ]);
  });

  it("lets a whole operator be deleted with its staff", async () => {
    const op = (
      await pg.query<{ id: string }>(
        "insert into cpo_operators(name) values ('Sample Temp') returning id",
      )
    ).rows[0].id;
    await pg.query(
      "insert into cpo_staff(operator_id,user_id,email,role) values ($1,$2,'outsider@example.com','owner')",
      [op, OUTSIDER],
    );
    await pg.query("delete from cpo_operators where id=$1", [op]);
    expect(
      (await pg.query("select 1 from cpo_staff where user_id=$1", [OUTSIDER]))
        .rows,
    ).toEqual([]);
  });
});

describe("invites", () => {
  const create = (email: string, hash: string, expires = "1 day") =>
    as("service_role", null, () =>
      pg.query<{ id: string }>(
        `select cpo_create_invite($1,$2,'viewer',$3,$4,now() + interval '${expires}') as id`,
        [operatorA, email, hash, OWNER_A],
      ),
    );
  const accept = (hash: string, user: string, email: string) =>
    as("service_role", null, () =>
      pg.query("select cpo_accept_invite($1,$2,$3)", [hash, user, email]),
    );

  it("is single use and bound to the invited email", async () => {
    await create("outsider@example.com", HASH("1"));
    await expect(
      accept(HASH("1"), OUTSIDER, "someone-else@example.com"),
    ).rejects.toThrow(/cpo_invite_invalid/);
    await accept(HASH("1"), OUTSIDER, "Outsider@example.com");
    await expect(
      accept(HASH("1"), OUTSIDER, "outsider@example.com"),
    ).rejects.toThrow(/cpo_invite_invalid/);
    const { rows } = await pg.query<{ role: string }>(
      "select role from cpo_staff where user_id=$1",
      [OUTSIDER],
    );
    expect(rows).toEqual([{ role: "viewer" }]);
    await pg.query("delete from cpo_staff where user_id=$1", [OUTSIDER]);
  });

  it("refuses expired invites and replaces a pending one for the same email", async () => {
    await create("late@example.com", HASH("2"), "-1 minute");
    await expect(
      accept(HASH("2"), OUTSIDER, "late@example.com"),
    ).rejects.toThrow(/cpo_invite_invalid/);
    await create("again@example.com", HASH("3"));
    await create("again@example.com", HASH("4"));
    await expect(
      accept(HASH("3"), OUTSIDER, "again@example.com"),
    ).rejects.toThrow(/cpo_invite_invalid/);
    const pending = await pg.query(
      "select 1 from cpo_invites where email='again@example.com' and accepted_at is null and revoked_at is null",
    );
    expect(pending.rows).toHaveLength(1);
  });

  it("refuses to invite someone already on the team", async () => {
    await expect(create("tech-a@example.com", HASH("5"))).rejects.toThrow(
      /cpo_already_staff/,
    );
  });
});

describe("rate limits", () => {
  it("allows the quota once across concurrent callers and resets after the window", async () => {
    await as("service_role", null, async () => {
      const take = () =>
        pg.query<{ ok: boolean }>(
          "select cpo_take_rate_limit('test-digest',1,60) as ok",
        );
      const r = await Promise.all([take(), take(), take()]);
      expect(r.filter((x) => x.rows[0].ok)).toHaveLength(1);
      await pg.exec(
        "update cpo_rate_limits set resets_at = now() - interval '1 second'",
      );
      expect((await take()).rows[0].ok).toBe(true);
    });
  });

  it("purges long-expired windows as it goes", async () => {
    await as("service_role", null, async () => {
      await pg.exec(
        "insert into cpo_rate_limits values ('old-digest', 1, now() - interval '2 hours')",
      );
      await pg.query("select cpo_take_rate_limit('other-digest',1,60)");
      expect(
        (await pg.query("select 1 from cpo_rate_limits where key='old-digest'"))
          .rows,
      ).toEqual([]);
    });
  });
});

describe("company profile", () => {
  const HEX = "a".repeat(64);
  const save = (actor: string, operator = operatorA, name = "Sample Co A") =>
    as("service_role", null, () =>
      pg.query(
        "select cpo_save_company($1,$2,$3,'Help@Example.com','https://example.com/help',null,'Europe/Berlin','EUR')",
        [operator, actor, name],
      ),
    );
  const profile = async () =>
    (
      await pg.query<{
        name: string;
        support_email: string;
        primary_color: string | null;
        branding_hash: string | null;
        branding_syncs: number;
        logo_uploads: number;
        logo_url: string | null;
      }>("select * from cpo_company_profiles where operator_id=$1", [operatorA])
    ).rows[0];

  it("lets owners and managers save, and refuses everyone else", async () => {
    await save(OWNER_A);
    expect(await profile()).toMatchObject({
      name: "Sample Co A",
      support_email: "help@example.com",
      branding_syncs: 0,
    });
    await expect(save(TECH_A)).rejects.toThrow(/cpo_not_allowed/);
    // An owner of another operator can't write this one.
    await expect(save(OWNER_B)).rejects.toThrow(/cpo_not_allowed/);
    await expect(save(OUTSIDER)).rejects.toThrow(/cpo_not_allowed/);
    await pg.query("update cpo_staff set role='manager' where user_id=$1", [
      TECH_A,
    ]);
    try {
      await save(TECH_A, operatorA, "By Manager");
      expect((await profile()).name).toBe("By Manager");
    } finally {
      await pg.query(
        "update cpo_staff set role='technician' where user_id=$1",
        [TECH_A],
      );
    }
  });

  it("saves the brand colour and records what Ivora shows", async () => {
    const brand = (actor: string, color: string | null) =>
      as("service_role", null, () =>
        pg.query("select cpo_save_brand($1,$2,$3)", [operatorA, actor, color]),
      );
    const record = (hash: string | null, url: string | null, logo: boolean) =>
      as("service_role", null, () =>
        pg.query("select cpo_record_branding($1,$2,$3,$4,$5)", [
          operatorA,
          OWNER_A,
          hash,
          url,
          logo,
        ]),
      );
    await brand(OWNER_A, "#1D3FA8");
    expect((await profile()).primary_color).toBe("#1d3fa8");
    await expect(brand(TECH_A, "#000000")).rejects.toThrow(/cpo_not_allowed/);
    await expect(brand(OWNER_A, "red")).rejects.toThrow(/check constraint/);
    await record(HEX, null, false);
    await record(null, "https://api.example.test/logo.png", true);
    expect(await profile()).toMatchObject({
      branding_hash: HEX,
      branding_syncs: 1,
      logo_uploads: 1,
      logo_url: "https://api.example.test/logo.png",
    });
    await expect(
      as("service_role", null, () =>
        pg.query("select cpo_record_branding($1,$2,null,null,false)", [
          operatorB,
          OWNER_B,
        ]),
      ),
    ).rejects.toThrow(/cpo_no_company/);
  });

  it("refuses plain-http support links and bad currencies", async () => {
    await expect(
      pg.query(
        "update cpo_company_profiles set support_url='http://example.com' where operator_id=$1",
        [operatorA],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      pg.query(
        "update cpo_company_profiles set currency='usd' where operator_id=$1",
        [operatorA],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("is not readable or writable from the browser, even by an owner", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await as(role, OWNER_A, async () => {
        await expect(
          pg.query("select * from cpo_company_profiles"),
        ).rejects.toThrow(/permission denied/);
        await expect(
          pg.query("update cpo_company_profiles set name='x'"),
        ).rejects.toThrow(/permission denied/);
      });
  });
});

describe("chargers", () => {
  const svc = <T>(sql: string, params: unknown[]) =>
    as("service_role", null, () => pg.query<T>(sql, params));
  const create = (
    actor: string,
    name: string,
    station: number | null = null,
    operator = operatorA,
  ) =>
    svc<{ id: string }>(
      "select cpo_create_charger($1,$2,$3,null,5,null,2,$4,null) as id",
      [operator, actor, name, station],
    ).then((r) => r.rows[0].id);
  const update = (actor: string, id: string, changes: object) =>
    svc("select cpo_update_charger($1,$2,$3,$4)", [
      operatorA,
      actor,
      id,
      JSON.stringify(changes),
    ]);
  const remove = (actor: string, id: string) =>
    svc("select cpo_remove_charger($1,$2,$3)", [operatorA, actor, id]);
  const row = async (id: string) =>
    (
      await pg.query<{
        station_id: number | null;
        label: string | null;
        remote_test: unknown;
        removed_at: string | null;
      }>("select * from cpo_chargers where id=$1", [id])
    ).rows[0];

  it("lets technicians and above add and update, and refuses everyone else", async () => {
    const id = await create(TECH_A, "DB-TECH-01");
    await update(TECH_A, id, {
      station_id: 101,
      label: "Bay 1",
      remote_test: { phase: "passed" },
    });
    expect(await row(id)).toMatchObject({
      station_id: 101,
      label: "Bay 1",
      remote_test: { phase: "passed" },
    });
    // A JSON null clears; keys left out stay.
    await update(OWNER_A, id, { label: null });
    expect(await row(id)).toMatchObject({ label: null, station_id: 101 });
    await expect(create(OWNER_B, "DB-B-01")).rejects.toThrow(/cpo_not_allowed/);
    await expect(create(OUTSIDER, "DB-X-01")).rejects.toThrow(
      /cpo_not_allowed/,
    );
    await expect(update(OWNER_B, id, { label: "x" })).rejects.toThrow(
      /cpo_not_allowed/,
    );
    await pg.query("update cpo_staff set role='viewer' where user_id=$1", [
      TECH_A,
    ]);
    try {
      await expect(create(TECH_A, "DB-VIEW-01")).rejects.toThrow(
        /cpo_not_allowed/,
      );
    } finally {
      await pg.query(
        "update cpo_staff set role='technician' where user_id=$1",
        [TECH_A],
      );
    }
    await expect(create(TECH_A, "bad name")).rejects.toThrow(
      /check constraint/,
    );
  });

  it("keeps one active record per station and counts keys atomically", async () => {
    await create(TECH_A, "DB-ONE-01", 202);
    await expect(create(TECH_A, "DB-ONE-02", 202)).rejects.toThrow(
      /cpo_charger_exists/,
    );
    const id = await create(TECH_A, "DB-SEQ-01");
    const next = () =>
      svc<{ n: number }>(
        "select cpo_next_charger_seq($1,$2,$3,'credentials') as n",
        [operatorA, TECH_A, id],
      ).then((r) => r.rows[0].n);
    const all = await Promise.all([next(), next(), next()]);
    expect(all.sort()).toEqual([1, 2, 3]);
    await expect(
      svc("select cpo_next_charger_seq($1,$2,$3,'test')", [
        operatorA,
        TECH_A,
        id,
      ]),
    ).rejects.toThrow(/cpo_invalid/);
    await expect(
      svc("select cpo_next_charger_seq($1,$2,$3,'other')", [
        operatorA,
        TECH_A,
        id,
      ]),
    ).rejects.toThrow(/cpo_invalid/);
  });

  it("claims the remote test once until it has finished", async () => {
    const id = await create(TECH_A, "DB-TEST-01", 303);
    const claim = (actor: string, phase = "starting") =>
      svc<{ n: number }>("select cpo_claim_charger_test($1,$2,$3,$4) as n", [
        operatorA,
        actor,
        id,
        JSON.stringify({ phase, connectorNumber: 1, attempt: 99 }),
      ]).then((r) => r.rows[0].n);
    expect(await claim(TECH_A)).toBe(1);
    // The attempt is the database's count, not the caller's.
    expect(await row(id)).toMatchObject({
      remote_test: { phase: "starting", attempt: 1 },
    });
    for (const phase of ["starting", "charging", "stopping"]) {
      await update(TECH_A, id, { remote_test: { phase, attempt: 1 } });
      await expect(claim(TECH_A)).rejects.toThrow(/cpo_charger_busy/);
    }
    await update(TECH_A, id, { remote_test: { phase: "failed", attempt: 1 } });
    expect(await claim(OWNER_A)).toBe(2);
    await update(TECH_A, id, { remote_test: { phase: "passed", attempt: 2 } });
    await pg.query("update cpo_staff set role='viewer' where user_id=$1", [
      TECH_A,
    ]);
    try {
      await expect(claim(TECH_A)).rejects.toThrow(/cpo_not_allowed/);
    } finally {
      await pg.query(
        "update cpo_staff set role='technician' where user_id=$1",
        [TECH_A],
      );
    }
    await expect(claim(OWNER_B)).rejects.toThrow(/cpo_not_allowed/);
    await remove(OWNER_A, id);
    await expect(claim(OWNER_A)).rejects.toThrow(/cpo_charger_not_found/);
  });

  it("lets only managers remove a registered charger, and keeps its codes", async () => {
    const pending = await create(TECH_A, "DB-PEND-01");
    // Never registered in Ivora: the technician may discard it.
    await remove(TECH_A, pending);
    expect((await row(pending)).removed_at).not.toBeNull();
    await expect(update(TECH_A, pending, { label: "x" })).rejects.toThrow(
      /cpo_charger_not_found/,
    );

    const id = await create(TECH_A, "DB-REG-01", 303);
    await svc("select cpo_add_sticker_codes($1,$2,$3,$4)", [
      operatorA,
      TECH_A,
      id,
      JSON.stringify([
        { code: "ABCD2345", connector_number: 1, connector_id: 9 },
        { code: "ABCD2346", connector_number: 1, connector_id: 9 },
        { code: "ABCD2347", connector_number: 2, connector_id: null },
      ]),
    ]);
    const codes = await pg.query<{ code: string }>(
      "select code from cpo_sticker_codes where charger_id=$1 order by code",
      [id],
    );
    // One code per connector: the second for connector 1 is skipped.
    expect(codes.rows.map((r) => r.code)).toEqual(["ABCD2345", "ABCD2347"]);
    await expect(
      svc("select cpo_add_sticker_codes($1,$2,$3,$4)", [
        operatorA,
        TECH_A,
        id,
        JSON.stringify([
          { code: "abc", connector_number: 3, connector_id: null },
        ]),
      ]),
    ).rejects.toThrow(/check constraint/);
    await expect(remove(TECH_A, id)).rejects.toThrow(/cpo_not_allowed/);
    await remove(OWNER_A, id);
    expect((await row(id)).removed_at).not.toBeNull();
    expect(
      (
        await pg.query("select 1 from cpo_sticker_codes where charger_id=$1", [
          id,
        ])
      ).rows,
    ).toHaveLength(2);
    // The station can be taken over again by a new record.
    await create(TECH_A, "DB-REG-01", 303);
  });

  it("is not readable or writable from the browser, even by an owner", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await as(role, OWNER_A, async () => {
        for (const t of ["cpo_chargers", "cpo_sticker_codes"]) {
          await expect(pg.query(`select * from ${t}`)).rejects.toThrow(
            /permission denied/,
          );
          await expect(pg.query(`delete from ${t}`)).rejects.toThrow(
            /permission denied/,
          );
        }
      });
  });
});

describe("live commands", () => {
  const svc = <T>(sql: string, params: unknown[]) =>
    as("service_role", null, () => pg.query<T>(sql, params));
  let n = 0;
  const rid = () => `30000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const claim = (
    actor: string,
    o: {
      request?: string;
      station?: number;
      action?: string;
      connector?: number | null;
      transaction?: number | null;
      mode?: string | null;
      sessions?: number[];
      operator?: string;
    } = {},
  ) =>
    svc<{ r: { id: string; created: boolean } }>(
      "select cpo_claim_live_command($1,$2,$3,$4,$5,$6,$7,$8,$9) as r",
      [
        o.operator ?? operatorA,
        actor,
        o.request ?? rid(),
        o.station ?? 501,
        o.action ?? "reset",
        o.connector ?? null,
        o.transaction ?? null,
        o.mode === undefined ? "soft" : o.mode,
        o.sessions ?? [],
      ],
    ).then((r) => r.rows[0].r);
  const record = (id: string, changes: object) =>
    svc<{ ok: boolean }>("select cpo_record_live_command($1,$2,$3) as ok", [
      operatorA,
      id,
      JSON.stringify(changes),
    ]).then((r) => r.rows[0].ok);
  const row = async (id: string) =>
    (
      await pg.query<{
        phase: string;
        operation_id: string | null;
        error: string | null;
        finished_at: string | null;
        confirmed_sessions: number[];
        requested_by: string;
      }>("select * from cpo_live_commands where id=$1", [id])
    ).rows[0];

  it("lets technicians and above claim a command, and refuses everyone else", async () => {
    const c = await claim(TECH_A, { station: 500, sessions: [91, 92] });
    expect(c.created).toBe(true);
    expect(await row(c.id)).toMatchObject({
      phase: "pending",
      confirmed_sessions: [91, 92],
      requested_by: TECH_A,
    });
    await record(c.id, { phase: "accepted" });
    await expect(claim(OWNER_B, { station: 500 })).rejects.toThrow(
      /cpo_not_allowed/,
    );
    await expect(claim(OUTSIDER, { station: 500 })).rejects.toThrow(
      /cpo_not_allowed/,
    );
    await pg.query("update cpo_staff set role='viewer' where user_id=$1", [
      TECH_A,
    ]);
    try {
      await expect(claim(TECH_A, { station: 500 })).rejects.toThrow(
        /cpo_not_allowed/,
      );
    } finally {
      await pg.query(
        "update cpo_staff set role='technician' where user_id=$1",
        [TECH_A],
      );
    }
    // Each action needs its own target.
    await expect(
      claim(TECH_A, { station: 500, action: "start", mode: null }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      claim(TECH_A, { station: 500, action: "explode" }),
    ).rejects.toThrow(/check constraint/);
  });

  it("makes one command per tap and keeps one pending per charger", async () => {
    const request = rid();
    const first = await claim(TECH_A, { request, station: 502 });
    // The same tap again returns the same command, not a new one.
    expect(await claim(OWNER_A, { request, station: 502 })).toEqual({
      id: first.id,
      created: false,
    });
    // ... but not for a different command.
    await expect(
      claim(TECH_A, { request, station: 502, mode: "hard" }),
    ).rejects.toThrow(/cpo_invalid/);
    // Another tap on the same charger waits until the first is answered.
    await expect(claim(OWNER_A, { station: 502 })).rejects.toThrow(
      /cpo_command_busy/,
    );
    expect((await claim(OWNER_A, { station: 503 })).created).toBe(true);
    expect(await record(first.id, { phase: "failed", error: "x" })).toBe(true);
    expect((await claim(OWNER_A, { station: 502 })).created).toBe(true);
    const all = await pg.query(
      "select 1 from cpo_live_commands where station_id=502",
    );
    expect(all.rows).toHaveLength(2);
  });

  it("records answers only while pending, and never reopens a final command", async () => {
    const c = await claim(TECH_A, { station: 504 });
    expect(await record(c.id, { operation_id: "op_1" })).toBe(true);
    expect(await row(c.id)).toMatchObject({
      phase: "pending",
      operation_id: "op_1",
      finished_at: null,
    });
    expect(await record(c.id, { phase: "accepted", error: null })).toBe(true);
    expect((await row(c.id)).finished_at).not.toBeNull();
    // A late or repeated report changes nothing.
    expect(await record(c.id, { phase: "failed", error: "late" })).toBe(false);
    expect(await record(c.id, { phase: "pending" })).toBe(false);
    expect(await row(c.id)).toMatchObject({ phase: "accepted", error: null });
    await expect(record(c.id, { phase: "done" })).rejects.toThrow(
      /cpo_invalid/,
    );
    // Another operator's ID changes nothing either.
    const other = await svc<{ ok: boolean }>(
      "select cpo_record_live_command($1,$2,$3) as ok",
      [operatorB, c.id, JSON.stringify({ phase: "failed" })],
    );
    expect(other.rows[0].ok).toBe(false);
  });

  it("closes a command left pending for 15 minutes as unknown, never resending it", async () => {
    const c = await claim(TECH_A, { station: 505 });
    await pg.query(
      "update cpo_live_commands set requested_at = now() - interval '16 minutes' where id=$1",
      [c.id],
    );
    expect((await claim(TECH_A, { station: 505 })).created).toBe(true);
    expect(await row(c.id)).toMatchObject({ phase: "unknown" });
    expect((await row(c.id)).error).toMatch(/within 15 minutes/);
  });

  it("stores each webhook event once and purges old ones", async () => {
    const put = (id: string) =>
      svc<{ fresh: boolean }>(
        "select cpo_record_ivora_event($1,'station.connected',7) as fresh",
        [id],
      ).then((r) => r.rows[0].fresh);
    expect(await put("evt_1")).toBe(true);
    expect(await put("evt_1")).toBe(false);
    await pg.query(
      "update cpo_ivora_events set received_at = now() - interval '8 days' where id='evt_1'",
    );
    expect(await put("evt_2")).toBe(true);
    const left = await pg.query<{ id: string }>(
      "select id from cpo_ivora_events order by id",
    );
    expect(left.rows.map((r) => r.id)).toEqual(["evt_2"]);
  });

  it("is not readable or writable from the browser, even by an owner", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await as(role, OWNER_A, async () => {
        for (const t of [
          "cpo_live_commands",
          "cpo_ivora_events",
          "cpo_staff_tokens",
        ]) {
          await expect(pg.query(`select * from ${t}`)).rejects.toThrow(
            /permission denied/,
          );
          await expect(pg.query(`delete from ${t}`)).rejects.toThrow(
            /permission denied/,
          );
        }
      });
  });
});

describe("pricing", () => {
  const DEF = JSON.stringify({ kind: "paid", currency: "USD" });
  const call = <T = unknown>(sql: string, params: unknown[]) =>
    as("service_role", null, () =>
      pg.query<T & Record<string, unknown>>(sql, params),
    );
  const create = (actor: string, operator = operatorA, name = "Standard") =>
    call<{ id: string }>("select cpo_create_tariff($1,$2,$3,$4::jsonb) as id", [
      operator,
      actor,
      name,
      DEF,
    ]).then((r) => r.rows[0].id);
  const revision = async (id: string) =>
    (
      await pg.query<{ revision: number }>(
        "select revision from cpo_tariffs where id=$1",
        [id],
      )
    ).rows[0]?.revision ?? 0;
  /** A new version from an editor loaded now, or at `expected`. */
  const addVersion = async (
    actor: string,
    id: string,
    operator = operatorA,
    expected?: number,
  ) =>
    call<{ v: number }>(
      "select cpo_add_tariff_version($1,$2,$3,$4,'Standard',$5::jsonb) as v",
      [operator, actor, id, expected ?? (await revision(id)), DEF],
    ).then((r) => r.rows[0].v);
  const drop = (id: string, version: number) =>
    call("select cpo_drop_tariff_version($1,$2,$3,$4)", [
      operatorA,
      OWNER_A,
      id,
      version,
    ]);
  const record = (
    id: string,
    version: number,
    ivoraId: number,
    actor = OWNER_A,
  ) =>
    call("select cpo_record_tariff_version($1,$2,$3,$4,$5)", [
      operatorA,
      actor,
      id,
      version,
      ivoraId,
    ]);
  const versions = async (id: string) =>
    (
      await pg.query<{
        version: number;
        ivora_tariff_id: string | null;
        archived_at: string | null;
      }>(
        "select version, ivora_tariff_id, archived_at from cpo_tariff_versions where tariff_id=$1 order by version",
        [id],
      )
    ).rows.map((r) => [
      r.version,
      r.ivora_tariff_id === null ? null : Number(r.ivora_tariff_id),
      Boolean(r.archived_at),
    ]);
  const stationRevision = async (operator = operatorA) =>
    (
      await pg.query<{ revision: number }>(
        "select revision from cpo_station_pricing where operator_id=$1 and station_id=9101",
        [operator],
      )
    ).rows[0]?.revision ?? 0;
  /** A station save from a form loaded now, or at `expected`. */
  const setStation = async (
    actor: string,
    tariff: string | null,
    priv: boolean,
    connectors: unknown[] = [],
    operator = operatorA,
    expected?: number,
  ) =>
    call("select cpo_set_station_pricing($1,$2,9101,$3,$4,$5,$6::jsonb)", [
      operator,
      actor,
      expected ?? (await stationRevision(operator)),
      tariff,
      priv,
      JSON.stringify(connectors),
    ]);

  it("lets owners and managers create tariffs, and refuses everyone else", async () => {
    const id = await create(OWNER_A);
    expect(await versions(id)).toEqual([[1, null, false]]);
    await expect(create(TECH_A)).rejects.toThrow(/cpo_not_allowed/);
    await expect(create(OWNER_B)).rejects.toThrow(/cpo_not_allowed/);
    await expect(create(OUTSIDER)).rejects.toThrow(/cpo_not_allowed/);
    await expect(record(id, 1, 500, TECH_A)).rejects.toThrow(/cpo_not_allowed/);
    await pg.query("update cpo_staff set role='manager' where user_id=$1", [
      TECH_A,
    ]);
    try {
      await record(id, 1, 500, TECH_A);
    } finally {
      await pg.query(
        "update cpo_staff set role='technician' where user_id=$1",
        [TECH_A],
      );
    }
    expect(await versions(id)).toEqual([[1, 500, false]]);
  });

  it("adds versions one at a time and never gives a version a second Ivora tariff", async () => {
    const id = await create(OWNER_A);
    // Version 1 is unconfirmed: another save is refused until it is.
    await expect(addVersion(OWNER_A, id)).rejects.toThrow(/cpo_tariff_busy/);
    await record(id, 1, 600);
    await record(id, 1, 600); // repeating it is harmless
    await expect(record(id, 1, 601)).rejects.toThrow(/cpo_tariff_not_found/);
    expect(await addVersion(OWNER_A, id)).toBe(2);
    await expect(addVersion(OWNER_A, id)).rejects.toThrow(/cpo_tariff_busy/);
    await record(id, 2, 602);
    await call("select cpo_record_tariff_archived($1,$2,$3,1)", [
      operatorA,
      OWNER_A,
      id,
    ]);
    expect(await versions(id)).toEqual([
      [1, 600, true],
      [2, 602, false],
    ]);
    // Another operator's owner can't add to it.
    await expect(addVersion(OWNER_B, id, operatorB)).rejects.toThrow(
      /cpo_tariff_not_found/,
    );
  });

  it("refuses a version from an editor loaded before another change", async () => {
    const id = await create(OWNER_A);
    await record(id, 1, 650);
    const opened = await revision(id);
    expect(await addVersion(OWNER_A, id, operatorA, opened)).toBe(2);
    await record(id, 2, 651);
    // The second editor, loaded at the same revision, is refused.
    await expect(addVersion(OWNER_A, id, operatorA, opened)).rejects.toThrow(
      /cpo_tariff_changed/,
    );
    expect((await versions(id)).map((v) => v[0])).toEqual([1, 2]);
    // A dropped version moves the revision too: the editor showed it.
    const before = await revision(id);
    expect(await addVersion(OWNER_A, id)).toBe(3);
    await drop(id, 3);
    await expect(
      addVersion(OWNER_A, id, operatorA, before + 1),
    ).rejects.toThrow(/cpo_tariff_changed/);
  });

  it("never reuses a version number, and counts create attempts", async () => {
    const id = await create(OWNER_A);
    await record(id, 1, 660);
    expect(await addVersion(OWNER_A, id)).toBe(2);
    await drop(id, 2);
    // Number 2 is gone for good: its key and reference are never sent again.
    expect(await addVersion(OWNER_A, id)).toBe(3);
    const attempt = () =>
      call<{ a: number }>("select cpo_next_tariff_attempt($1,$2,$3,3) as a", [
        operatorA,
        OWNER_A,
        id,
      ]).then((r) => r.rows[0].a);
    expect(await attempt()).toBe(2);
    expect(await attempt()).toBe(3);
    await expect(
      call("select cpo_next_tariff_attempt($1,$2,$3,3)", [
        operatorA,
        TECH_A,
        id,
      ]),
    ).rejects.toThrow(/cpo_not_allowed/);
    await record(id, 3, 661);
    // A confirmed version takes no more attempts.
    await expect(attempt()).rejects.toThrow(/cpo_tariff_not_found/);
    expect(await versions(id)).toEqual([
      [1, 660, false],
      [3, 661, false],
    ]);
  });

  it("drops only unconfirmed versions, and a tariff left with none", async () => {
    const id = await create(OWNER_A);
    await drop(id, 1);
    expect(
      (await pg.query("select 1 from cpo_tariffs where id=$1", [id])).rows,
    ).toEqual([]);
    const kept = await create(OWNER_A);
    await record(kept, 1, 700);
    await drop(kept, 1);
    expect(await versions(kept)).toEqual([[1, 700, false]]);
  });

  it("assigns only confirmed tariffs of the same operator, in one statement", async () => {
    const live = await create(OWNER_A);
    await record(live, 1, 800);
    const pending = await create(OWNER_A);
    await expect(setStation(OWNER_A, pending, false)).rejects.toThrow(
      /cpo_tariff_not_ready/,
    );
    await expect(
      setStation(OWNER_A, live, false, [
        { connector_id: 91012, tariff_id: pending },
      ]),
    ).rejects.toThrow(/cpo_tariff_not_ready/);
    await expect(setStation(TECH_A, live, false)).rejects.toThrow(
      /cpo_not_allowed/,
    );
    // Operator B can't point its station at operator A's tariff.
    await expect(
      setStation(OWNER_B, live, false, [], operatorB),
    ).rejects.toThrow(/cpo_tariff_not_ready/);
    await setStation(OWNER_A, live, true, [
      { connector_id: 91012, tariff_id: live },
    ]);
    const rows = async () => ({
      station: (
        await pg.query(
          "select tariff_id, private from cpo_station_pricing where operator_id=$1",
          [operatorA],
        )
      ).rows,
      connectors: (
        await pg.query<{ connector_id: string; tariff_id: string }>(
          "select connector_id, tariff_id from cpo_connector_tariffs where operator_id=$1",
          [operatorA],
        )
      ).rows.map((r) => ({ ...r, connector_id: Number(r.connector_id) })),
    });
    expect(await rows()).toEqual({
      station: [{ tariff_id: live, private: true }],
      connectors: [{ connector_id: 91012, tariff_id: live }],
    });
    // The whole station is replaced: no tariff, not private, no overrides. The row
    // stays, so its revision only grows.
    await setStation(OWNER_A, null, false);
    expect(await rows()).toEqual({
      station: [{ tariff_id: null, private: false }],
      connectors: [],
    });
    // A tariff in use can't be deleted from under a station.
    await setStation(OWNER_A, live, false);
    await expect(
      pg.query("delete from cpo_tariffs where id=$1", [live]),
    ).rejects.toThrow(/foreign key/);
  });

  it("refuses a station save from a form loaded before another change", async () => {
    await pg.query("delete from cpo_station_pricing where operator_id=$1", [
      operatorA,
    ]);
    const live = await create(OWNER_A);
    await record(live, 1, 900);
    // Two forms opened before the station had pricing: the first save wins.
    await setStation(OWNER_A, live, true, [], operatorA, 0);
    await expect(
      setStation(OWNER_A, live, false, [], operatorA, 0),
    ).rejects.toThrow(/cpo_station_changed/);
    const opened = await stationRevision();
    expect(opened).toBe(1);
    await setStation(OWNER_A, live, true, [], operatorA, opened);
    // The stale form would make the charger public again: refused.
    await expect(
      setStation(OWNER_A, live, false, [], operatorA, opened),
    ).rejects.toThrow(/cpo_station_changed/);
    const r = await pg.query<{ private: boolean; revision: number }>(
      "select private, revision from cpo_station_pricing where operator_id=$1",
      [operatorA],
    );
    expect(r.rows).toEqual([{ private: true, revision: 2 }]);
  });

  it("is not readable or writable from the browser, even by an owner", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await as(role, OWNER_A, async () => {
        for (const t of [
          "cpo_tariffs",
          "cpo_tariff_versions",
          "cpo_station_pricing",
          "cpo_connector_tariffs",
        ]) {
          await expect(pg.query(`select * from ${t}`)).rejects.toThrow(
            /permission denied/,
          );
          await expect(pg.query(`delete from ${t}`)).rejects.toThrow(
            /permission denied/,
          );
        }
        await expect(
          pg.query("select cpo_create_tariff($1,$2,'x','{}'::jsonb)", [
            operatorA,
            OWNER_A,
          ]),
        ).rejects.toThrow(/permission denied/);
      });
  });
});
