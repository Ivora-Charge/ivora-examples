import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { totalsOf } from "@/lib/server/reports/records";
import {
  toReportCheckout,
  toReportTotals,
} from "@/lib/server/reports/supabase";

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
  "cpo_checkouts",
  "cpo_free_tokens",
  "cpo_transaction_marks",
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
          `select cpo_claim_checkout('${operatorA}','${OWNER_A}','paid','ABCD2345',1,11,1,2500,'USD')`,
          `select cpo_record_checkout('${operatorA}','${OWNER_A}','{}')`,
          `select cpo_next_tariff_attempt('${operatorA}','${OWNER_A}','${OWNER_A}',1)`,
          `select * from cpo_report_checkouts('${operatorA}',now()-interval '1 day',now(),null,'all',50,0,null,null)`,
          `select cpo_report_totals('${operatorA}',now()-interval '1 day',now(),null,'all')`,
          `select cpo_record_checkout_details('${operatorA}','${OWNER_A}',now(),now(),1,1,'Local')`,
          `select cpo_record_checkout_refund('${operatorA}','${OWNER_A}',0)`,
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

  it("records when each create attempt started", async () => {
    const id = await create(OWNER_A);
    const at = async () =>
      (
        await pg.query<{ t: Date }>(
          "select attempted_at as t from cpo_tariff_versions where tariff_id=$1 and version=1",
          [id],
        )
      ).rows[0].t.getTime();
    await pg.query(
      "update cpo_tariff_versions set attempted_at = now() - interval '1 hour' where tariff_id=$1",
      [id],
    );
    const before = await at();
    await call("select cpo_next_tariff_attempt($1,$2,$3,1)", [
      operatorA,
      OWNER_A,
      id,
    ]);
    expect((await at()) - before).toBeGreaterThan(59 * 60_000);
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

describe("driver checkouts", () => {
  const call = <T = unknown>(sql: string, params: unknown[]) =>
    as("service_role", null, () =>
      pg.query<T & Record<string, unknown>>(sql, params),
    );
  const REQ = "20000000-0000-4000-8000-000000000001";
  let r = 100;
  const nextReq = () =>
    `20000000-0000-4000-8000-${String(++r).padStart(12, "0")}`;
  const claim = (
    request = REQ,
    o: {
      code?: string;
      connector?: number;
      operator?: string;
      kind?: string;
      hold?: number;
    } = {},
  ) =>
    call<{ r: { id?: string; created?: boolean; busy?: string } }>(
      "select cpo_claim_checkout($1,$2,$3,$4,9101,$5,9401,$6,'USD') as r",
      [
        o.operator ?? operatorA,
        request,
        o.kind ?? "paid",
        o.code ?? "ABCD2345",
        o.connector ?? 91011,
        o.hold ?? 2500,
      ],
    ).then((x) => x.rows[0].r);
  const record = (id: string, changes: object, operator = operatorA) =>
    call<{ ok: boolean }>("select cpo_record_checkout($1,$2,$3::jsonb) as ok", [
      operator,
      id,
      JSON.stringify(changes),
    ]).then((x) => x.rows[0].ok);
  const row = async (id: string) =>
    (
      await pg.query<{
        phase: string;
        reference: string;
        bill_id: string | null;
        payment_id: string | null;
        checkout_url: string | null;
        start_requested_at: string | null;
        stop_requested_at: string | null;
        transaction_id: number | null;
        final_minor: number | null;
        captured_minor: number | null;
        settled_at: string | null;
        error: string | null;
      }>(
        "select phase, reference, bill_id, payment_id, checkout_url, start_requested_at, stop_requested_at, transaction_id, final_minor, captured_minor, settled_at, error from cpo_checkouts where id=$1",
        [id],
      )
    ).rows[0];
  const BILL = `bill_${"a".repeat(32)}`;
  /** Ends a checkout so the connector is free for the next test. */
  const close = (id: string) => record(id, { phase: "failed" });

  it("makes one checkout per tap, for the same sticker, kind and tariff only", async () => {
    const first = await claim();
    expect(first.created).toBe(true);
    // A double tap or a retry after an uncertain answer: the same checkout.
    expect(await claim()).toEqual({ id: first.id, created: false });
    // The same request ID for another connector, sticker or kind is refused.
    await expect(claim(REQ, { connector: 91012 })).rejects.toThrow(
      /cpo_invalid/,
    );
    await expect(claim(REQ, { code: "WXYZ2345" })).rejects.toThrow(
      /cpo_invalid/,
    );
    // The hold is not compared: the bill's may have replaced the tariff's.
    expect(await claim(REQ, { hold: 4000 })).toEqual({
      id: first.id,
      created: false,
    });
    // Another operator's request IDs are its own.
    const b = await claim(REQ, { operator: operatorB });
    expect(b.created).toBe(true);
    await expect(
      claim(nextReq(), { code: "abcd2345", connector: 91019 }),
    ).rejects.toThrow(/check/);
    // The return_reference is its own random value.
    expect((await row(first.id!)).reference).toMatch(/^ck_[0-9a-f]{32}$/);
    await close(first.id!);
    await close(b.id!);
  });

  it("holds a connector for one waiting or running checkout, before any hold is placed", async () => {
    const first = await claim(nextReq());
    expect(first.created).toBe(true);
    // A second driver at the same connector gets the first one back, nothing inserted.
    expect(await claim(nextReq())).toEqual({ busy: first.id });
    expect(await claim(nextReq(), { kind: "free", hold: 0 })).toEqual({
      busy: first.id,
    });
    // Another connector, or another operator's, is free.
    const other = await claim(nextReq(), { connector: 91012 });
    expect(other.created).toBe(true);
    // Open still holds it; settling, releasing or any end frees it.
    await record(first.id!, { phase: "open", bill_id: BILL, payment_id: "p1" });
    expect((await claim(nextReq())).busy).toBe(first.id);
    await record(first.id!, { phase: "settling" });
    const next = await claim(nextReq());
    expect(next.created).toBe(true);
    for (const id of [other.id!, next.id!]) await close(id);
  });

  it("only moves a checkout forward, and never changes a recorded ID", async () => {
    const { id } = (await claim(nextReq())) as { id: string };
    expect(await record(id, { bill_id: BILL })).toBe(true);
    await expect(
      record(id, { bill_id: `bill_${"b".repeat(32)}` }),
    ).rejects.toThrow(/cpo_invalid/);
    // The same bill again is fine (a retry).
    expect(await record(id, { bill_id: BILL, payment_id: "pay_1" })).toBe(true);
    await expect(record(id, { payment_id: "pay_2" })).rejects.toThrow(
      /cpo_invalid/,
    );
    await expect(
      record(id, { checkout_url: "http://checkout.example.com/x" }),
    ).rejects.toThrow(/check/);
    expect(await record(id, { phase: "settled" })).toBe(false);
    expect(
      await record(id, {
        checkout_url: "https://checkout.example.com/x",
        phase: "open",
      }),
    ).toBe(true);
    expect(await record(id, { phase: "creating" })).toBe(false);
    expect(
      await record(id, {
        phase: "settling",
        transaction_id: 5,
        final_minor: 361,
      }),
    ).toBe(true);
    await expect(record(id, { transaction_id: 6 })).rejects.toThrow(
      /cpo_invalid/,
    );
    // Settling never goes back to releasing or open.
    expect(await record(id, { phase: "releasing" })).toBe(false);
    // A capture above the hold is refused outright.
    await expect(record(id, { captured_minor: 2600 })).rejects.toThrow(/check/);
    expect(
      await record(id, {
        phase: "settled",
        captured_minor: 361,
        stop_requested: true,
      }),
    ).toBe(true);
    expect(await record(id, { phase: "attention" })).toBe(false);
    expect(await row(id)).toMatchObject({
      phase: "settled",
      bill_id: BILL,
      payment_id: "pay_1",
      transaction_id: 5,
      final_minor: 361,
      captured_minor: 361,
    });
    expect((await row(id)).settled_at).not.toBeNull();
    expect((await row(id)).stop_requested_at).not.toBeNull();
    // Another operator can't touch it.
    expect(await record(id, { error: "x" }, operatorB)).toBe(false);
  });

  it("follows the bill's hold while unsettled, and notes the meter, retries and alerts", async () => {
    const { id } = (await claim(nextReq())) as { id: string };
    const extra = async () =>
      (
        await pg.query<{
          hold_minor: number;
          meter_wh: number | null;
          meter_at: string | null;
          stop_retried_at: string | null;
          alert: string | null;
        }>(
          "select hold_minor, meter_wh, extract(epoch from meter_at)::bigint::text as meter_at, stop_retried_at, alert from cpo_checkouts where id=$1",
          [id],
        )
      ).rows[0];
    // The bill holds $40.00 where the tariff said $25.00: the record follows it.
    expect(await record(id, { bill_id: BILL, hold_minor: 4000 })).toBe(true);
    expect((await extra()).hold_minor).toBe(4000);
    await expect(record(id, { hold_minor: 20 })).rejects.toThrow(/check/);
    // meter_at moves only when the energy changes.
    expect(await record(id, { phase: "open", meter_wh: 1000 })).toBe(true);
    await pg.query(
      "update cpo_checkouts set meter_at = '2026-01-01T00:00:00Z' where id=$1",
      [id],
    );
    await record(id, { meter_wh: 1000 });
    const old = String(Date.parse("2026-01-01T00:00:00Z") / 1000);
    expect((await extra()).meter_at).toBe(old);
    await record(id, { meter_wh: 1200 });
    expect(await extra()).toMatchObject({ meter_wh: 1200 });
    expect((await extra()).meter_at).not.toBe(old);
    await expect(record(id, { alert: "other" })).rejects.toThrow(/check/);
    expect(
      await record(id, { stop_retried: true, alert: "hold_stop_ignored" }),
    ).toBe(true);
    expect(await extra()).toMatchObject({
      alert: "hold_stop_ignored",
      stop_retried_at: expect.anything(),
    });
    // A capture up to the bill's hold is fine; once settled, the hold stays.
    expect(
      await record(id, {
        phase: "settling",
        alert: "stalled",
        transaction_id: 7,
      }),
    ).toBe(true);
    expect(await record(id, { phase: "settled", captured_minor: 3000 })).toBe(
      true,
    );
    expect(await record(id, { hold_minor: 2500 })).toBe(true);
    expect(await extra()).toMatchObject({ hold_minor: 4000, alert: "stalled" });
  });

  it("takes a connector back only if no one else holds it (a late start after releasing)", async () => {
    const a = (await claim(nextReq())) as { id: string };
    await record(a.id, { phase: "open", bill_id: BILL, payment_id: "pa" });
    await record(a.id, { phase: "releasing" });
    const b = (await claim(nextReq())) as { id: string };
    expect(b.id).toBeTruthy();
    // The released one's start ran after all, but b holds the connector now.
    expect(await record(a.id, { phase: "open" })).toBe(true);
    expect((await row(a.id)).phase).toBe("releasing");
    await close(b.id);
    await record(a.id, { phase: "open" });
    expect((await row(a.id)).phase).toBe("open");
    await record(a.id, { phase: "released" });
  });

  it("keeps free sessions free: no hold, and paid ones within Ivora Checkout's limits", async () => {
    // (Each on its own connector: the claim checks the connector first.)
    await expect(
      claim(nextReq(), { kind: "free", hold: 2500, connector: 91021 }),
    ).rejects.toThrow(/check/);
    await expect(
      claim(nextReq(), { hold: 20, connector: 91022 }),
    ).rejects.toThrow(/check/);
    await expect(
      claim(nextReq(), { kind: "gift", hold: 0, connector: 91023 }),
    ).rejects.toThrow(/check/);
    const free = (await claim(nextReq(), { kind: "free", hold: 0 })) as {
      id: string;
    };
    expect(free.id).toBeTruthy();
    await close(free.id);
  });

  it("is not readable or writable from the browser", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await as(role, OWNER_A, async () => {
        await expect(pg.query("select * from cpo_checkouts")).rejects.toThrow(
          /permission denied/,
        );
        await expect(pg.query("select * from cpo_free_tokens")).rejects.toThrow(
          /permission denied/,
        );
        await expect(
          pg.query(
            "insert into cpo_checkouts(operator_id, request_id, sticker_code, station_id, connector_id, tariff_id, hold_minor, currency) values ($1,$2,'ABCD2345',1,1,1,2500,'USD')",
            [operatorA, REQ],
          ),
        ).rejects.toThrow(/permission denied/);
      });
  });
});

describe("reports", () => {
  const call = <T = unknown>(sql: string, params: unknown[]) =>
    as("service_role", null, () =>
      pg.query<T & Record<string, unknown>>(sql, params),
    );
  let r = 0;
  /** A checkout written directly (the table's own checks still apply). */
  async function insert(o: Record<string, unknown>) {
    const row: Record<string, unknown> = {
      operator_id: operatorB,
      request_id: `30000000-0000-4000-8000-${String(++r).padStart(12, "0")}`,
      kind: "paid",
      sticker_code: "ABCD2345",
      station_id: 9101,
      connector_id: 9000 + r,
      tariff_id: 9401,
      hold_minor: 2500,
      currency: "USD",
      phase: "settled",
      created_at: "2025-10-10T12:00:00Z",
      ...o,
    };
    const cols = Object.keys(row);
    const { rows } = await pg.query<{ id: string }>(
      `insert into cpo_checkouts (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
      Object.values(row),
    );
    return rows[0].id;
  }
  const FROM = "2025-10-01T00:00:00Z";
  const TO = "2025-11-01T00:00:00Z";
  const totals = (status = "all", station: number | null = null) =>
    call<{ t: unknown }>("select cpo_report_totals($1,$2,$3,$4,$5) as t", [
      operatorB,
      FROM,
      TO,
      station,
      status,
    ]).then((x) => toReportTotals(x.rows[0].t));
  const list = (
    o: {
      status?: string;
      limit?: number;
      offset?: number;
      after?: [string, string];
    } = {},
  ) =>
    call<Record<string, unknown>>(
      "select * from cpo_report_checkouts($1,$2,$3,null,$4,$5,$6,$7,$8)",
      [
        operatorB,
        FROM,
        TO,
        o.status ?? "all",
        o.limit ?? 50,
        o.offset ?? 0,
        o.after?.[0] ?? null,
        o.after?.[1] ?? null,
      ],
    ).then((x) => x.rows);

  const ids: Record<string, string> = {};
  beforeAll(async () => {
    // $12.40 captured, $3.00 of it refunded.
    ids.refunded = await insert({
      transaction_id: 1,
      final_minor: 1240,
      captured_minor: 1240,
      refunded_minor: 300,
      created_at: "2025-10-10T12:00:00Z",
    });
    // A $0.30 bill under Stripe's minimum: released, nothing captured.
    ids.small = await insert({
      transaction_id: 2,
      final_minor: 30,
      captured_minor: 0,
      created_at: "2025-10-11T12:00:00Z",
    });
    // A $27.40 bill above the $25 hold: needs the operator, nothing captured by the kit.
    ids.above = await insert({
      phase: "attention",
      transaction_id: 3,
      final_minor: 2740,
      created_at: "2025-10-12T12:00:00Z",
    });
    ids.free = await insert({
      kind: "free",
      hold_minor: 0,
      transaction_id: 4,
      created_at: "2025-10-13T12:00:00Z",
    });
    ids.open = await insert({
      phase: "open",
      created_at: "2025-10-14T12:00:00Z",
    });
    ids.eur = await insert({
      currency: "EUR",
      transaction_id: 5,
      final_minor: 500,
      captured_minor: 500,
      station_id: 9102,
      created_at: "2025-10-15T12:00:00Z",
    });
    // Outside the period, and another operator's.
    await insert({ created_at: "2025-11-01T00:00:00Z", captured_minor: 999 });
    await insert({ operator_id: operatorA, captured_minor: 999 });
  });

  it("totals collected money as captured minus refunded, never the bill", async () => {
    const t = await totals();
    expect(t).toMatchObject({
      checkouts: 6,
      paid: 5,
      free: 1,
      withSession: 5,
      byStatus: { in_progress: 1, charged: 2, no_charge: 2, attention: 1 },
      refundsUnchecked: 2,
    });
    expect(t.currencies).toEqual([
      {
        currency: "EUR",
        charged: 1,
        billedMinor: 500,
        capturedMinor: 500,
        refundedMinor: 0,
      },
      {
        currency: "USD",
        charged: 1,
        billedMinor: 1240 + 30 + 2740,
        capturedMinor: 1240,
        refundedMinor: 300,
      },
    ]);
    expect((await totals("refunded")).checkouts).toBe(1);
    expect((await totals("all", 9102)).checkouts).toBe(1);
  });

  it("agrees with the demo store's rules on the same records", async () => {
    for (const status of [
      "all",
      "in_progress",
      "charged",
      "refunded",
      "no_charge",
      "attention",
    ]) {
      const rows = (await list({ status, limit: 500 })).map((x) =>
        toReportCheckout(x as never),
      );
      expect(totalsOf(rows)).toEqual(await totals(status));
    }
  });

  it("lists newest first, by offset or after a row, at most 500", async () => {
    const all = await list();
    expect(all.map((x) => x.id)).toEqual([
      ids.eur,
      ids.open,
      ids.free,
      ids.above,
      ids.small,
      ids.refunded,
    ]);
    expect((await list({ limit: 2, offset: 2 })).map((x) => x.id)).toEqual([
      ids.free,
      ids.above,
    ]);
    const third = all[2] as { created_at: string; id: string };
    const after = await list({
      limit: 2,
      after: [new Date(third.created_at).toISOString(), third.id],
    });
    expect(after.map((x) => x.id)).toEqual([ids.above, ids.small]);
    expect((await list({ status: "attention" })).map((x) => x.id)).toEqual([
      ids.above,
    ]);
  });

  it("keeps an ended session's details once, and notes every check", async () => {
    const record = (ended: string | null, wh: number) =>
      call<{ ok: boolean }>(
        "select cpo_record_checkout_details($1,$2,'2025-10-10T12:01:00Z',$3,$4,2,'Local') as ok",
        [operatorB, ids.small, ended, wh],
      ).then((x) => x.rows[0].ok);
    const row = async () =>
      (
        await pg.query<{
          energy_wh: number | null;
          detail_at: string | null;
          detail_checked_at: string | null;
        }>(
          "select energy_wh, detail_at, detail_checked_at from cpo_checkouts where id=$1",
          [ids.small],
        )
      ).rows[0];
    // Still running: nothing kept, but the check is noted.
    expect(await record(null, 100)).toBe(true);
    expect(await row()).toMatchObject({ energy_wh: null, detail_at: null });
    expect((await row()).detail_checked_at).not.toBeNull();
    expect(await record("2025-10-10T13:00:00Z", 860)).toBe(true);
    expect((await row()).energy_wh).toBe(860);
    // Once kept, never overwritten.
    await record("2025-10-10T14:00:00Z", 999);
    expect((await row()).energy_wh).toBe(860);
    // Another operator's call changes nothing.
    expect(
      (
        await call<{ ok: boolean }>(
          "select cpo_record_checkout_details($1,$2,now(),now(),1,1,'x') as ok",
          [operatorA, ids.small],
        )
      ).rows[0].ok,
    ).toBe(false);
  });

  it("records refunds only on charged, settled paid checkouts, capped at the capture", async () => {
    const refund = (id: string, minor: number, op = operatorB) =>
      call<{ ok: boolean }>(
        "select cpo_record_checkout_refund($1,$2,$3) as ok",
        [op, id, minor],
      ).then((x) => x.rows[0].ok);
    const refunded = async (id: string) =>
      (
        await pg.query<{ refunded_minor: number | null }>(
          "select refunded_minor from cpo_checkouts where id=$1",
          [id],
        )
      ).rows[0].refunded_minor;
    expect(await refund(ids.refunded, 5000)).toBe(true);
    expect(await refunded(ids.refunded)).toBe(1240);
    // A refund that failed in the end: the payment says 0 again.
    expect(await refund(ids.refunded, 0)).toBe(true);
    expect(await refunded(ids.refunded)).toBe(0);
    for (const id of [ids.small, ids.above, ids.free, ids.open])
      expect(await refund(id, 10)).toBe(false);
    expect(await refund(ids.eur, 10, operatorA)).toBe(false);
    await expect(refund(ids.eur, -1)).rejects.toThrow(/cpo_invalid/);
    await refund(ids.refunded, 300);
  });
});

describe("transaction marks", () => {
  const mark = async (station: number) =>
    (
      await pg.query<{ last_transaction_id: string }>(
        "select last_transaction_id from cpo_transaction_marks where station_id=$1",
        [station],
      )
    ).rows[0]?.last_transaction_id;
  const advance = (station: number, id: number) =>
    pg.query("select public.cpo_advance_transaction_mark($1, $2)", [
      station,
      id,
    ]);

  it("only moves up", async () => {
    await as("service_role", null, async () => {
      await advance(9103, 1200);
      expect(String(await mark(9103))).toBe("1200");
      await advance(9103, 900);
      expect(String(await mark(9103))).toBe("1200");
      await advance(9103, 1201);
      expect(String(await mark(9103))).toBe("1201");
      await expect(advance(0, 1)).rejects.toThrow(/cpo_invalid/);
      await expect(advance(9103, -1)).rejects.toThrow(/cpo_invalid/);
    });
  });

  it("is not readable or writable from the browser", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await as(role, OWNER_A, async () => {
        await expect(
          pg.query("select * from cpo_transaction_marks"),
        ).rejects.toThrow(/permission denied/);
        await expect(advance(9103, 5000)).rejects.toThrow(/permission denied/);
      });
  });
});
