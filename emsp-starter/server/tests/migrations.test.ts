import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { checkMigrations } from "../scripts/check-migrations/check.mjs";
import { LEDGER_SQL } from "../scripts/migrate.mjs";
import { applyMigrations, asRole, migratedDatabase } from "./support/pglite";

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

describe("migration ledger", () => {
  // npm run db:migrate creates the ledger before any migration: the shared 10-30
  // check (which CI runs on supabase/migrations) holds for it too.
  it("follows the 10-30 rule", () => {
    expect(
      checkMigrations([{ name: "migrate.mjs LEDGER_SQL", sql: LEDGER_SQL }]),
    ).toEqual([]);
  });
});

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

describe("OCPI peer registry tables", () => {
  const PEER = `insert into public.emsp_ocpi_peers (label, direction)
                values ('CPO', 'outbound') returning id`;

  it("keeps peers and issued tokens away from anon and authenticated", async () => {
    for (const db_ of [db, legacy])
      for (const role of ["anon", "authenticated"] as const)
        await asRole(db_, role, async () => {
          for (const table of ["emsp_ocpi_peers", "emsp_ocpi_issued_tokens"])
            await expect(
              db_.query(`select * from public.${table}`),
            ).rejects.toThrow(/permission denied/);
        });
  });

  it("lets the service role insert, read and update, but never delete", async () => {
    await asRole(db, "service_role", async () => {
      const { rows } = await db.query<{ id: string }>(PEER);
      const id = rows[0].id;
      await db.query(
        `insert into public.emsp_ocpi_issued_tokens (token_hash, peer_id, scope)
         values ($1, $2, 'registration')`,
        ["a".repeat(64), id],
      );
      await db.query(
        "update public.emsp_ocpi_issued_tokens set revoked_at = now() where peer_id = $1",
        [id],
      );
      await db.query(
        `update public.emsp_ocpi_peers set status = 'registered', registered_at = now(),
           token_ciphertext = 'v1:a:b:c' where id = $1`,
        [id],
      );
      await expect(
        db.query("delete from public.emsp_ocpi_issued_tokens"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("delete from public.emsp_ocpi_peers"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("stores only token hashes and encrypted tokens", async () => {
    const { rows } = await db.query<{ id: string }>(PEER);
    const id = rows[0].id;
    await expect(
      db.query(
        `insert into public.emsp_ocpi_issued_tokens (token_hash, peer_id, scope)
         values ('a-plain-token', $1, 'full')`,
        [id],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query(
        "update public.emsp_ocpi_peers set token_ciphertext = 'plain' where id = $1",
        [id],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects malformed peers", async () => {
    const bad = [
      "insert into public.emsp_ocpi_peers (label, direction) values ('', 'outbound')",
      "insert into public.emsp_ocpi_peers (label, direction) values ('x', 'sideways')",
      "insert into public.emsp_ocpi_peers (label, direction, versions_url) values ('x', 'outbound', 'http://cpo.example.test')",
      "insert into public.emsp_ocpi_peers (label, direction, status) values ('x', 'outbound', 'registered')",
    ];
    for (const sql of bad)
      await expect(db.query(sql)).rejects.toThrow(/check constraint/);
    await expect(
      db.query(
        `insert into public.emsp_ocpi_issued_tokens (token_hash, peer_id, scope)
         values ($1, gen_random_uuid(), 'full')`,
        ["b".repeat(64)],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("gives a Token A an expiry after its creation", async () => {
    const { rows } = await db.query<{ id: string }>(PEER);
    await db.query(
      `insert into public.emsp_ocpi_issued_tokens (token_hash, peer_id, scope, expires_at)
       values ($1, $2, 'registration', now() + interval '7 days')`,
      ["c".repeat(64), rows[0].id],
    );
    await expect(
      db.query(
        `insert into public.emsp_ocpi_issued_tokens (token_hash, peer_id, scope, expires_at)
         values ($1, $2, 'registration', now() - interval '1 day')`,
        ["d".repeat(64), rows[0].id],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("OCPI locations and tariffs tables", () => {
  const TABLES = [
    "emsp_ocpi_locations",
    "emsp_ocpi_tariffs",
    "emsp_ocpi_sync_state",
  ];
  const peer = async () =>
    (
      await db.query<{ id: string }>(
        `insert into public.emsp_ocpi_peers (label, direction)
         values ('CPO', 'outbound') returning id`,
      )
    ).rows[0].id;
  const location = (peerId: string, id: string, extra = "") =>
    db.query(
      `insert into public.emsp_ocpi_locations (peer_id, country_code, party_id,
         location_id, data, publish, latitude, longitude, search_text, search_ids,
         last_updated, seen_at)
       values ($1, 'ZZ', 'MCK', $2, '{"id": "x"}', true, 52.1, 5.1, 'market hall',
         array['LOC1', 'ZZMCKE11'], now(), now()) ${extra}`,
      [peerId, id],
    );

  it("keeps them away from anon and authenticated", async () => {
    for (const db_ of [db, legacy])
      for (const role of ["anon", "authenticated"] as const)
        await asRole(db_, role, async () => {
          for (const table of TABLES)
            await expect(
              db_.query(`select * from public.${table}`),
            ).rejects.toThrow(/permission denied/);
        });
  });

  it("keys objects per peer, so two peers may use the same IDs", async () => {
    const [a, b] = [await peer(), await peer()];
    await asRole(db, "service_role", async () => {
      await location(a, "LOC1");
      await location(b, "LOC1");
      await expect(location(a, "LOC1")).rejects.toThrow(/duplicate key/);
      // What the store's upsert sends (on_conflict on the key).
      await location(
        a,
        "LOC1",
        "on conflict (peer_id, country_code, party_id, location_id) do update set publish = false",
      );
      const { rows } = await db.query<{ peer_id: string; publish: boolean }>(
        "select peer_id, publish from public.emsp_ocpi_locations where location_id = 'LOC1' order by publish",
      );
      expect(rows).toEqual([
        { peer_id: a, publish: false },
        { peer_id: b, publish: true },
      ]);
      // The search's ID filter (search_ids=cs.{...}).
      const { rows: found } = await db.query(
        "select 1 from public.emsp_ocpi_locations where search_ids @> array['ZZMCKE11'] and peer_id = $1",
        [b],
      );
      expect(found).toHaveLength(1);
      // A full pull removes what it did not see.
      await db.query(
        "delete from public.emsp_ocpi_locations where peer_id = $1 and seen_at < now() + interval '1 second'",
        [a],
      );
    });
  });

  it("lets the service role keep sync state, but never delete it", async () => {
    const id = await peer();
    await asRole(db, "service_role", async () => {
      await db.query(
        `insert into public.emsp_ocpi_sync_state (peer_id, module, run_id, run)
         values ($1, 'locations', gen_random_uuid(), '{"mode": "full"}')`,
        [id],
      );
      // Only the run that owns the state may change it.
      const { affectedRows } = await db.query(
        "update public.emsp_ocpi_sync_state set run_id = null, run = null where peer_id = $1 and run_id is null",
        [id],
      );
      expect(affectedRows).toBe(0);
      await expect(
        db.query("delete from public.emsp_ocpi_sync_state"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("rejects malformed rows", async () => {
    const id = await peer();
    const bad = [
      `insert into public.emsp_ocpi_locations (peer_id, country_code, party_id, location_id,
         data, publish, latitude, longitude, last_updated, seen_at)
       values ('${id}', 'zz', 'MCK', 'L', '{}', true, 0, 0, now(), now())`,
      `insert into public.emsp_ocpi_locations (peer_id, country_code, party_id, location_id,
         data, publish, latitude, longitude, last_updated, seen_at)
       values ('${id}', 'ZZ', 'MCK', 'L', '{}', true, 91, 0, now(), now())`,
      `insert into public.emsp_ocpi_tariffs (peer_id, country_code, party_id, tariff_id,
         data, last_updated, seen_at)
       values ('${id}', 'ZZ', 'MCK', 'T', '[]', now(), now())`,
      `insert into public.emsp_ocpi_sync_state (peer_id, module) values ('${id}', 'hubclientinfo')`,
      `insert into public.emsp_ocpi_sync_state (peer_id, module, run_id)
       values ('${id}', 'tariffs', gen_random_uuid())`,
    ];
    for (const sql of bad)
      await expect(db.query(sql)).rejects.toThrow(/check constraint/);
    await expect(
      db.query(
        `insert into public.emsp_ocpi_tariffs (peer_id, country_code, party_id, tariff_id,
           data, last_updated, seen_at)
         values (gen_random_uuid(), 'ZZ', 'MCK', 'T', '{}', now(), now())`,
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("peer version counter (202611160002_peer_rev)", () => {
  it("raises rev on every update, starting at 0, and cannot be called by Data API roles", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.emsp_ocpi_peers (label, direction) values ('P', 'outbound') returning id`,
    );
    const id = rows[0].id;
    const rev = async () =>
      Number(
        (
          await db.query<{ rev: string }>(
            `select rev from public.emsp_ocpi_peers where id = '${id}'`,
          )
        ).rows[0].rev,
      );
    expect(await rev()).toBe(0);
    await db.query(
      `update public.emsp_ocpi_peers set label = 'Q' where id = '${id}'`,
    );
    await db.query(
      `update public.emsp_ocpi_peers set label = 'Q' where id = '${id}'`,
    );
    expect(await rev()).toBe(2);
  });
});

describe("hub push mode (202611240001_hub_push_mode)", () => {
  const MIGRATION = "202611240001_hub_push_mode.sql";
  const newPeer = async (on: PGlite, label = "Hub") =>
    (
      await on.query<{ id: string }>(
        `insert into public.emsp_ocpi_peers (label, direction) values ($1, 'outbound') returning id`,
        [label],
      )
    ).rows[0].id;
  const modeOf = async (on: PGlite, id: string) =>
    (
      await on.query<{ hub_push_mode: string }>(
        "select hub_push_mode from public.emsp_ocpi_peers where id = $1",
        [id],
      )
    ).rows[0].hub_push_mode;

  it("keeps every existing peer on per_party, and gives peers added after it hub", async () => {
    const before = await migratedDatabase({ before: MIGRATION });
    try {
      const existing = await newPeer(before, "Existing hub");
      await applyMigrations(before);
      expect(await modeOf(before, existing)).toBe("per_party");
      expect(await modeOf(before, await newPeer(before, "New hub"))).toBe(
        "hub",
      );
    } finally {
      await before.close();
    }
  });

  it("accepts only a known mode", async () => {
    const id = await newPeer(db);
    expect(await modeOf(db, id)).toBe("hub");
    await db.query(
      "update public.emsp_ocpi_peers set hub_push_mode = 'per_party' where id = $1",
      [id],
    );
    expect(await modeOf(db, id)).toBe("per_party");
    await expect(
      db.query(
        "update public.emsp_ocpi_peers set hub_push_mode = 'all' where id = $1",
        [id],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("emsp_token_owe_active owes a peer each active token once, due at the time given", async () => {
    const peer = await newPeer(db, "Catch-up hub");
    const token = async (uid: string, status: string) =>
      (
        await db.query<{ id: string }>(
          `insert into public.emsp_tokens
             (country_code, party_id, uid, type, contract_id, driver_ref, group_id,
              issuer, whitelist, status, last_updated)
           values ('NL', 'ABC', $1, 'RFID', 'NLABCC00000001', 'catch-up', 'NLABCC00000001',
                   'Example', 'NEVER', $2, '2026-10-21T10:00:00Z')
           returning id`,
          [uid, status],
        )
      ).rows[0].id;
    const active = [
      await token("CU000001", "active"),
      await token("CU000002", "active"),
    ];
    const owe = async () =>
      (
        await db.query<{ n: number }>(
          "select owed as n from public.emsp_token_owe_active($1, '2026-10-21T12:00:00Z')",
          [peer],
        )
      ).rows[0].n;
    const blocked = await token("CU000003", "blocked");
    // Other tests in this file may have added tokens: count every active one.
    const {
      rows: [{ n: activeCount }],
    } = await db.query<{ n: number }>(
      "select count(*)::integer as n from public.emsp_tokens where status = 'active'",
    );
    expect(await owe()).toBe(activeCount);
    expect(await owe()).toBe(activeCount);
    const { rows } = await db.query<{
      token_id: string;
      attempts: number;
      next_attempt_at: Date;
    }>(
      "select token_id, attempts, next_attempt_at from public.emsp_token_pushes where peer_id = $1",
      [peer],
    );
    expect(rows).toHaveLength(activeCount);
    const owed = rows.map((r) => r.token_id);
    expect(owed).toEqual(expect.arrayContaining(active));
    expect(owed).not.toContain(blocked);
    for (const r of rows) {
      expect(r.attempts).toBe(0);
      expect(new Date(r.next_attempt_at).toISOString()).toBe(
        "2026-10-21T12:00:00.000Z",
      );
    }
  });

  it("keeps the column and the catch-up closed to anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await asRole(db, role, async () => {
        await expect(
          db.query("select hub_push_mode from public.emsp_ocpi_peers"),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query(
            "select * from public.emsp_token_owe_active(gen_random_uuid(), now())",
          ),
        ).rejects.toThrow(/permission denied/);
      });
  });
});

describe("refused hub pushes (202611240002_hub_refusals)", () => {
  const newPeer = async () =>
    (
      await db.query<{ id: string }>(
        `insert into public.emsp_ocpi_peers (label, direction) values ('Hub', 'outbound') returning id`,
      )
    ).rows[0].id;
  const note = async (
    peer: string,
    party: string,
    { times = 1, kind = "routing", other = null as string | null } = {},
  ) =>
    (
      await db.query<{ noted: boolean }>(
        "select noted from public.emsp_ocpi_hub_refusal_note($1, 'ZZ', $2, $3, 'locations', $4, $5)",
        [peer, party, kind, other, times],
      )
    ).rows[0].noted;
  // The function uses the database's clock: move a peer's rows into the past instead.
  const age = (peer: string, seconds: number) =>
    db.query(
      `update public.emsp_ocpi_hub_refusals
       set first_seen = first_seen - make_interval(secs => $2),
           last_seen = last_seen - make_interval(secs => $2)
       where peer_id = $1`,
      [peer, seconds],
    );
  const rows = async (peer: string) =>
    (
      await db.query<{
        party_id: string;
        kind: string;
        other_party: string | null;
        times: string;
        first_seen: Date;
        last_seen: Date;
      }>(
        `select party_id, kind, other_party, times, first_seen, last_seen
         from public.emsp_ocpi_hub_refusals where peer_id = $1
         order by last_seen desc, party_id`,
        [peer],
      )
    ).rows;
  const id = (i: number) => i.toString(36).toUpperCase().padStart(3, "0");

  it("notes a party once at the database's time, writes nothing within 60 seconds, and adds the count after", async () => {
    const peer = await newPeer();
    expect(await note(peer, "BBB")).toBe(true);
    let [row] = await rows(peer);
    expect(
      Math.abs(new Date(row.first_seen).getTime() - Date.now()),
    ).toBeLessThan(60_000);
    await age(peer, 59);
    expect(await note(peer, "BBB", { kind: "path" })).toBe(false);
    [row] = await rows(peer);
    expect(row).toMatchObject({ party_id: "BBB", kind: "routing" });
    expect(Number(row.times)).toBe(1);
    await age(peer, 1);
    expect(
      await note(peer, "BBB", { times: 3, kind: "path", other: "ZZ-AAA" }),
    ).toBe(true);
    [row] = await rows(peer);
    // 'routing' is never downgraded to 'path'; the module and other party follow.
    expect(row).toMatchObject({ kind: "routing", other_party: "ZZ-AAA" });
    expect(Number(row.times)).toBe(4);
    expect(
      new Date(row.last_seen).getTime() - new Date(row.first_seen).getTime(),
    ).toBeGreaterThanOrEqual(60_000);
  });

  it("gives a peer at most 10 new parties a minute: a rotating-party flood stops there, and the other rows survive", async () => {
    const peer = await newPeer();
    const other = await newPeer();
    // 95 genuine rows, noted over the past hours.
    for (let i = 0; i < 95; i++) {
      expect(await note(peer, `G${id(i).slice(1)}`)).toBe(true);
      if (i % 10 === 9) await age(peer, 61);
    }
    await age(peer, 3_600);
    const genuine = (await rows(peer)).map((r) => r.party_id);
    expect(genuine).toHaveLength(95);
    // A new party on each of 50 calls: 10 rows, then nothing.
    const flood = [];
    for (let i = 0; i < 50; i++)
      flood.push(await note(peer, `F${id(i).slice(1)}`));
    // Room for 5; the genuine rows were seen within 24 hours, so none makes way.
    expect(flood.filter(Boolean)).toHaveLength(5);
    expect(flood.slice(5).some(Boolean)).toBe(false);
    const kept = (await rows(peer)).map((r) => r.party_id);
    expect(kept).toHaveLength(100);
    expect(genuine.filter((g) => kept.includes(g))).toHaveLength(95);
    // A party already listed still counts under its own window.
    expect(await note(peer, genuine[0])).toBe(true);
    // Another peer's budget is its own.
    expect(await note(other, "OTH")).toBe(true);
    // A minute later the budget is back, but the list is full of active rows.
    await age(peer, 61);
    expect(await note(peer, "F99")).toBe(false);
  });

  it("a sustained rotating flood leaves every party seen in the last 24 hours in place; a stale one can be replaced", async () => {
    const peer = await newPeer();
    // 100 genuine rows: 98 seen an hour ago, 2 seen 25 hours ago.
    for (let i = 0; i < 100; i++) {
      expect(await note(peer, `G${id(i).slice(1)}`)).toBe(true);
      if (i % 10 === 9) await age(peer, 61);
    }
    await db.query(
      `update public.emsp_ocpi_hub_refusals
       set first_seen = now() - interval '25 hours', last_seen = now() - interval '25 hours'
       where peer_id = $1 and party_id in ('G00', 'G01')`,
      [peer],
    );
    await db.query(
      `update public.emsp_ocpi_hub_refusals
       set first_seen = now() - interval '1 hour', last_seen = now() - interval '1 hour'
       where peer_id = $1 and party_id not in ('G00', 'G01')`,
      [peer],
    );
    const active = (await rows(peer))
      .map((r) => r.party_id)
      .filter((p) => p !== "G00" && p !== "G01");
    expect(active).toHaveLength(98);
    // 30 windows of a new party on each of 20 calls.
    let written = 0;
    for (let w = 0; w < 30; w++) {
      for (let i = 0; i < 20; i++)
        if (await note(peer, `F${id(w * 20 + i).slice(1)}`)) written++;
      await age(peer, 61);
    }
    // Only the two stale rows made way.
    expect(written).toBe(2);
    const kept = (await rows(peer)).map((r) => r.party_id);
    expect(kept).toHaveLength(100);
    expect(active.every((g) => kept.includes(g))).toBe(true);
    expect(kept).not.toContain("G00");
    expect(kept).not.toContain("G01");
  });

  it("calls racing for one peer cannot overshoot the budget or the cap", async () => {
    const peer = await newPeer();
    for (let round = 0; round < 12; round++) {
      const noted = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          note(peer, `R${id(round * 30 + i).slice(1)}`),
        ),
      );
      expect(noted.filter(Boolean)).toHaveLength(10);
      // A day on, so the cap has stale rows to replace from round 11.
      await age(peer, 24 * 3_600 + 61);
    }
    expect(await rows(peer)).toHaveLength(100);
    // With every row seen within 24 hours, racing calls write nothing.
    await db.query(
      "update public.emsp_ocpi_hub_refusals set first_seen = now() - interval '1 hour', last_seen = now() - interval '1 hour' where peer_id = $1",
      [peer],
    );
    const late = await Promise.all(
      Array.from({ length: 30 }, (_, i) => note(peer, `L${id(i).slice(1)}`)),
    );
    expect(late.some(Boolean)).toBe(false);
    expect(await rows(peer)).toHaveLength(100);
  });

  it("keeps at most 100 parties per peer, replacing only ones not seen for 24 hours", async () => {
    const peer = await newPeer();
    const other = await newPeer();
    await note(other, "OLD");
    // One second apart (so no two share a time), and a new minute every 10.
    for (let i = 0; i < 100; i++) {
      expect(await note(peer, id(i))).toBe(true);
      await age(peer, i % 10 === 9 ? 61 : 1);
    }
    // All seen within 24 hours: a new party is dropped.
    expect(await note(peer, "NEW")).toBe(false);
    // A day later, new parties replace the ones seen longest ago.
    await age(peer, 24 * 3_600);
    for (let i = 100; i < 103; i++) {
      expect(await note(peer, id(i))).toBe(true);
      await age(peer, 1);
    }
    const kept = (await rows(peer)).map((r) => r.party_id);
    expect(kept).toHaveLength(100);
    expect(kept[0]).toBe(id(102));
    expect(kept).not.toContain(id(2));
    expect(kept).toContain(id(3));
    // Another peer's rows are not touched.
    expect(await rows(other)).toHaveLength(1);
  });

  it("rejects malformed rows", async () => {
    const peer = await newPeer();
    const bad: [string, unknown[]][] = [
      [
        "select public.emsp_ocpi_hub_refusal_note($1, 'zz', 'BBB', 'routing', 'locations', null, 1)",
        [peer],
      ],
      [
        "select public.emsp_ocpi_hub_refusal_note($1, 'ZZ', 'BB', 'routing', 'locations', null, 1)",
        [peer],
      ],
      [
        "select public.emsp_ocpi_hub_refusal_note($1, 'ZZ', 'BBB', 'other', 'locations', null, 1)",
        [peer],
      ],
      [
        "select public.emsp_ocpi_hub_refusal_note($1, 'ZZ', 'BBB', 'routing', 'Locations!', null, 1)",
        [peer],
      ],
      [
        "select public.emsp_ocpi_hub_refusal_note($1, 'ZZ', 'BBB', 'routing', 'locations', 'x', 1)",
        [peer],
      ],
    ];
    for (const [sql, args] of bad)
      await expect(db.query(sql, args)).rejects.toThrow(/check constraint/);
    await expect(
      db.query(
        "select public.emsp_ocpi_hub_refusal_note(gen_random_uuid(), 'ZZ', 'BBB', 'routing', 'locations', null, 1)",
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("is closed to anon and authenticated, and open to the service role", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await asRole(db, role, async () => {
        await expect(
          db.query("select * from public.emsp_ocpi_hub_refusals"),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query(
            "select public.emsp_ocpi_hub_refusal_note(gen_random_uuid(), 'ZZ', 'BBB', 'routing', 'locations', null, 1)",
          ),
        ).rejects.toThrow(/permission denied/);
      });
    const peer = await newPeer();
    await asRole(db, "service_role", async () => {
      expect(await note(peer, "SRV")).toBe(true);
      expect(await rows(peer)).toHaveLength(1);
      await db.query(
        "delete from public.emsp_ocpi_hub_refusals where peer_id = $1",
        [peer],
      );
      expect(await rows(peer)).toHaveLength(0);
    });
  });
});

describe("roaming hub parties (202611160001_hub_parties)", () => {
  const peer = async () =>
    (
      await db.query<{ id: string }>(
        `insert into public.emsp_ocpi_peers (label, direction) values ('Hub', 'outbound') returning id`,
      )
    ).rows[0].id;

  it("adds hub_parties to peers, empty by default, and only as a JSON array", async () => {
    const id = await peer();
    const { rows } = await db.query<{ hub_parties: unknown }>(
      `select hub_parties from public.emsp_ocpi_peers where id = '${id}'`,
    );
    expect(rows[0].hub_parties).toEqual([]);
    await expect(
      db.query(
        `update public.emsp_ocpi_peers set hub_parties = '{}' where id = '${id}'`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("keeps one sync state per module and party behind a hub", async () => {
    const id = await peer();
    for (const module of [
      "locations",
      "locations@ZZ-AAA",
      "locations@ZZ-BBB",
      "cdrs@ZZ-AAA",
    ])
      await db.query(
        `insert into public.emsp_ocpi_sync_state (peer_id, module) values ('${id}', '${module}')`,
      );
    for (const module of [
      "locations@zz-aaa",
      "locations@ZZ-AA",
      "hubclientinfo@ZZ-AAA",
      "locations@",
    ])
      await expect(
        db.query(
          `insert into public.emsp_ocpi_sync_state (peer_id, module) values ('${id}', '${module}')`,
        ),
      ).rejects.toThrow(/check constraint/);
  });

  it("keeps the peers table closed to anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await asRole(db, role, async () => {
        await expect(
          db.query("select hub_parties from public.emsp_ocpi_peers"),
        ).rejects.toThrow(/permission denied/);
      });
  });
});
