import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  emailSearchTerm,
  MemoryAccountStore,
  type AccountStore,
  type DriverCursor,
} from "@/lib/accounts/store";
import { SupabaseAccountStore } from "@/lib/accounts/store-supabase";
import { applyMigrations, migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";

/**
 * The driver list and its counts, held to the same answers in memory and in Postgres
 * (PGlite, through the stand-in for the Data API), and on a database without the
 * 202611260001 migration.
 */
const URL = "https://db.example.test";
const KEY = "test-service-role-key";
const MIGRATION = "202611260001_driver_last_sign_in.sql";
const SINCE = "2026-10-27T00:00:00.000Z";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Accounts 1 to 7; 3, 4 and 5 joined at the same instant. */
const JOINED = [1, 2, 3, 3, 3, 6, 7].map(
  (day) => `2026-10-0${day}T10:00:00.000Z`,
);
const EMAILS = [
  "ana@example.com",
  "bo_b@example.org",
  "boxb@example.org",
  "per%cent@example.net",
  "percent@example.net",
  "back\\slash@example.net",
  "zed+tag@example.com",
];

async function seed(store: AccountStore, signIns = true) {
  for (const [i, email] of EMAILS.entries())
    await store.ensureDriver(id(i + 1), email, JOINED[i]);
  await store.updateDriver(id(2), { status: "restricted" }, JOINED[6]);
  await store.updateDriver(
    id(3),
    { defaultPaymentMethodId: "pm_1Abc" },
    JOINED[6],
  );
  if (!signIns) return;
  await store.recordSignIn(id(1), "2026-11-20T08:00:00.000Z");
  await store.recordSignIn(id(2), "2026-10-26T23:59:59.000Z");
  await store.recordSignIn(id(3), SINCE);
}

const ids = (drivers: { id: string }[]) =>
  drivers.map((d) => Number(d.id.slice(-12)));

/** Every page of a list, and how many pages there were. */
async function walk(store: AccountStore, limit: number, email?: string) {
  const seen: number[] = [];
  let after: DriverCursor | undefined;
  let pages = 0;
  do {
    const page = await store.listDrivers({ email, after, limit });
    seen.push(...ids(page.drivers));
    after = page.next ?? undefined;
    pages++;
  } while (after && pages < 20);
  return { seen, pages };
}

let db: PGlite;
beforeAll(async () => {
  db = await migratedDatabase();
}, 60_000);
afterAll(async () => {
  await db?.close();
});

const stores: [string, () => Promise<AccountStore>][] = [
  ["memory", async () => new MemoryAccountStore()],
  [
    "Supabase",
    async () => {
      await db.exec("delete from public.emsp_drivers");
      return new SupabaseAccountStore(URL, KEY, pgliteRest(db));
    },
  ],
];

describe.each(stores)("driver list (%s)", (_name, make) => {
  let store: AccountStore;
  beforeEach(async () => {
    store = await make();
    await seed(store);
  });

  it("lists newest first, then by ID, and pages without skipping or repeating", async () => {
    const all = [7, 6, 5, 4, 3, 2, 1];
    for (const limit of [1, 2, 3, 6, 7, 25]) {
      const { seen, pages } = await walk(store, limit);
      expect(seen, `limit ${limit}`).toEqual(all);
      // No empty last page.
      expect(pages, `limit ${limit}`).toBe(Math.ceil(7 / limit));
    }
  });

  it("searches part of an email in any letter case, with every character literal", async () => {
    const found = async (typed: string) =>
      ids(
        (
          await store.listDrivers({
            email: emailSearchTerm(typed)!,
            limit: 25,
          })
        ).drivers,
      );
    expect(await found("ANA@Example")).toEqual([1]);
    expect(await found("example.org")).toEqual([3, 2]);
    // "_" and "%" are not wildcards, nor is a backslash an escape.
    expect(await found("o_b")).toEqual([2]);
    expect(await found("r%c")).toEqual([4]);
    expect(await found("%")).toEqual([4]);
    expect(await found("+tag")).toEqual([7]);
    expect(await found("nobody")).toEqual([]);
    expect((await walk(store, 1, "example.net")).seen).toEqual([6, 5, 4]);
  });

  it("refuses a term that was not checked", async () => {
    for (const email of ["*", "a*", "ANA", " ana", "a b", ""]) {
      await expect(store.listDrivers({ email, limit: 5 })).rejects.toThrow(
        /Unchecked/,
      );
      await expect(
        store.countDrivers({ email, signedInSince: SINCE }),
      ).rejects.toThrow(/Unchecked/);
    }
  });

  it("finds an account by its exact reference only", async () => {
    expect(
      ids((await store.listDrivers({ reference: id(4), limit: 1 })).drivers),
    ).toEqual([4]);
    for (const reference of [
      id(99),
      "support-card-1",
      id(4).slice(0, -1),
      `{${id(4)}}`,
      `${id(4)},id.neq.x`,
    ]) {
      expect(await store.listDrivers({ reference, limit: 5 })).toEqual({
        drivers: [],
        next: null,
      });
      expect(
        (await store.countDrivers({ reference, signedInSince: SINCE }))
          .matching,
      ).toBe(0);
    }
  });

  it("counts every account, and how many the filter matches", async () => {
    const every = {
      total: 7,
      blocked: 1,
      withCard: 1,
      signedInSince: 2,
    };
    expect(await store.countDrivers({ signedInSince: SINCE })).toEqual({
      ...every,
      matching: 7,
    });
    expect(
      await store.countDrivers({ email: "example.net", signedInSince: SINCE }),
    ).toEqual({ ...every, matching: 3 });
    expect(
      await store.countDrivers({ reference: id(1), signedInSince: SINCE }),
    ).toEqual({ ...every, matching: 1 });
  });

  it("records the last sign-in, and nothing for a user without an account", async () => {
    expect((await store.getDriver(id(4)))!.lastSignInAt).toBeNull();
    await store.recordSignIn(id(4), "2026-11-25T12:00:00.000Z");
    const held = (await store.getDriver(id(4)))!;
    expect(held.lastSignInAt).toBe("2026-11-25T12:00:00.000Z");
    // Signing in changes nothing else about the account.
    expect(held.updatedAt).toBe(JOINED[3]);
    await store.recordSignIn(id(99), "2026-11-25T12:00:00.000Z");
    expect(await store.getDriver(id(99))).toBeNull();
  });
});

describe("the Supabase store's requests", () => {
  it("keeps the database's timestamp, to the microsecond, in the cursor", async () => {
    const asked: string[] = [];
    const at = "2026-10-03T10:00:00.123456+00:00";
    const store = new SupabaseAccountStore(URL, KEY, async (input) => {
      asked.push(decodeURIComponent(String(input)));
      return Response.json(
        [1, 2].map((n) => ({
          id: id(n),
          email: "ana@example.com",
          status: "active",
          created_at: at,
          updated_at: at,
        })),
      );
    });
    const { next, drivers } = await store.listDrivers({ limit: 1 });
    expect(next).toEqual({ createdAt: at, id: id(1) });
    expect(drivers[0].createdAt).toBe("2026-10-03T10:00:00.123Z");
    await store.listDrivers({ after: next!, limit: 1 });
    expect(asked[1]).toContain(
      `or=(created_at.lt."${at}",and(created_at.eq."${at}",id.lt.${id(1)}))`,
    );
  });

  it("refuses a cursor that could change the filter, without asking", async () => {
    const store = new SupabaseAccountStore(URL, KEY, async () => {
      throw new Error("asked");
    });
    for (const after of [
      { createdAt: '2026-10-03T10:00:00Z",id.neq."', id: id(1) },
      { createdAt: "2026-10-03T10:00:00Z", id: `${id(1)}))` },
    ])
      await expect(store.listDrivers({ after, limit: 1 })).rejects.toThrow(
        "Unchecked driver cursor",
      );
  });

  it("fails a count the database refuses for another reason", async () => {
    const store = new SupabaseAccountStore(URL, KEY, async (input, init) =>
      String(input).includes("last_sign_in_at")
        ? new Response(init?.method === "HEAD" ? null : "[]", {
            status: init?.method === "HEAD" ? 500 : 200,
          })
        : new Response(null, {
            status: 200,
            headers: { "Content-Range": "*/0" },
          }),
    );
    await expect(store.countDrivers({ signedInSince: SINCE })).rejects.toThrow(
      "Database request failed: HEAD emsp_drivers (HTTP 500)",
    );
  });
});

describe("a database before the 202611260001 migration", () => {
  let old: PGlite;
  let store: SupabaseAccountStore;
  beforeAll(async () => {
    old = await migratedDatabase({ before: MIGRATION });
    store = new SupabaseAccountStore(URL, KEY, pgliteRest(old));
    await seed(store, false);
  }, 60_000);
  afterAll(async () => {
    await old?.close();
  });

  const columns = async () =>
    (
      await old.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
        data_type: string;
      }>(
        `select column_name, is_nullable, column_default, data_type
         from information_schema.columns
         where table_name = 'emsp_drivers' order by ordinal_position`,
      )
    ).rows;

  it("still lists and counts, with no sign-in times", async () => {
    expect((await walk(store, 3)).seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect((await store.getDriver(id(1)))!.lastSignInAt).toBeNull();
    expect(await store.countDrivers({ signedInSince: SINCE })).toEqual({
      total: 7,
      blocked: 1,
      withCard: 1,
      signedInSince: null,
      matching: 7,
    });
    await expect(store.recordSignIn(id(1), SINCE)).rejects.toThrow(
      "Database request failed: PATCH emsp_drivers (HTTP 400)",
    );
  });

  it("gains one nullable column from the migration, and keeps every row", async () => {
    const before = await columns();
    const rows = async () =>
      (
        await old.query<Record<string, unknown>>(
          "select * from public.emsp_drivers order by id",
        )
      ).rows;
    const held = await rows();
    await applyMigrations(old);
    expect(await columns()).toEqual([
      ...before,
      {
        column_name: "last_sign_in_at",
        is_nullable: "YES",
        column_default: null,
        data_type: "timestamp with time zone",
      },
    ]);
    expect(await rows()).toEqual(
      held.map((r) => ({ ...r, last_sign_in_at: null })),
    );
    await store.recordSignIn(id(1), SINCE);
    expect((await store.getDriver(id(1)))!.lastSignInAt).toBe(SINCE);
  });
});
