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
