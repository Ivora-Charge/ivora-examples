import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { SupabaseDriverAppStore } from "@/lib/driver-app/store-supabase";
import { MAX_PUSH_TOKENS } from "@/lib/driver-app/store";
import { asRole, migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";

let db: PGlite;
let store: SupabaseDriverAppStore;
const T = (s: number) => new Date(Date.UTC(2026, 9, 22, 9, 0, s)).toISOString();
const token = (n: number) =>
  `ExponentPushToken[device${String(n).padStart(8, "0")}]`;

beforeAll(async () => {
  db = await migratedDatabase();
  store = new SupabaseDriverAppStore(
    "https://db.example.test",
    "test-service-role-key",
    pgliteRest(db),
  );
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe("Supabase driver app store (PGlite)", () => {
  it(
    "keeps push tokens per device, moves a shared device, and caps them per driver",
    { timeout: 20_000 },
    async () => {
      await store.putPushToken(
        { token: token(1), driverRef: "d1", platform: "ios", locale: "en-GB" },
        T(1),
      );
      // The same phone, now signed in as another driver.
      await store.putPushToken(
        { token: token(1), driverRef: "d2", platform: "ios", locale: "de" },
        T(2),
      );
      expect(await store.listPushTokens("d1")).toEqual([]);
      expect(await store.listPushTokens("d2")).toEqual([
        expect.objectContaining({ token: token(1), locale: "de" }),
      ]);
      for (let n = 2; n <= MAX_PUSH_TOKENS + 2; n++)
        await store.putPushToken(
          {
            token: token(n),
            driverRef: "d2",
            platform: "android",
            locale: "en",
          },
          T(n + 10),
        );
      const mine = await store.listPushTokens("d2");
      expect(mine).toHaveLength(MAX_PUSH_TOKENS);
      expect(mine[0].token).toBe(token(MAX_PUSH_TOKENS + 2));
      expect(await store.removePushToken("d1", token(5))).toBe(false);
      expect(await store.removePushToken("d2", token(5))).toBe(true);
      await store.forgetPushToken(token(6));
      expect(
        (await store.listPushTokens("d2")).map((t) => t.token),
      ).not.toContain(token(6));
    },
  );

  it("adds, lists and removes favourites", { timeout: 20_000 }, async () => {
    expect(await store.addFavourite("d1", "LOC-A", T(1))).toBe(true);
    expect(await store.addFavourite("d1", "LOC-A", T(2))).toBe(false);
    await store.addFavourite("d1", "LOC-B", T(3));
    await store.addFavourite("d2", "LOC-A", T(4));
    expect((await store.listFavourites("d1")).map((f) => f.locationId)).toEqual(
      ["LOC-B", "LOC-A"],
    );
    expect(await store.removeFavourite("d1", "LOC-A")).toBe(true);
    expect(await store.removeFavourite("d1", "LOC-A")).toBe(false);
    expect((await store.listFavourites("d2")).map((f) => f.locationId)).toEqual(
      ["LOC-A"],
    );
  });

  it(
    "stores reports with their photo, lists them without it, and resolves them once",
    { timeout: 20_000 },
    async () => {
      const photo = Buffer.from([0xff, 0xd8, 0xff, 1, 2]).toString("base64");
      const a = await store.addReport(
        {
          driverRef: "d1",
          locationId: "LOC-A",
          evseUid: "E1",
          category: "damaged",
          message: "Cable cut",
          photoType: "image/jpeg",
          photoBase64: photo,
        },
        T(10),
      );
      await store.addReport(
        {
          driverRef: "d1",
          locationId: "LOC-B",
          evseUid: null,
          category: "other",
          message: "Dark at night",
          photoType: null,
          photoBase64: null,
        },
        T(20),
      );
      const open = await store.listReports({ status: "open", limit: 10 });
      expect(open.map((r) => r.message)).toEqual([
        "Dark at night",
        "Cable cut",
      ]);
      expect(open.every((r) => r.photoBase64 === null)).toBe(true);
      expect(await store.getReport(a.id)).toMatchObject({
        photoType: "image/jpeg",
        photoBase64: photo,
      });
      expect(await store.countReportsSince("d1", T(15))).toBe(1);
      expect(
        await store.resolveReport(a.id, "admin:secret", T(30)),
      ).toMatchObject({
        status: "resolved",
        resolvedBy: "admin:secret",
      });
      expect(await store.resolveReport(a.id, "admin:secret", T(31))).toBeNull();
      expect(
        (await store.listReports({ status: "resolved", limit: 10 })).map(
          (r) => r.id,
        ),
      ).toEqual([a.id]);
    },
  );

  it(
    "is closed to the Data API roles, never deletes reports, and rejects malformed rows",
    { timeout: 20_000 },
    async () => {
      for (const role of ["anon", "authenticated"] as const)
        await asRole(db, role, async () => {
          for (const t of [
            "emsp_push_tokens",
            "emsp_favourites",
            "emsp_problem_reports",
          ])
            await expect(db.query(`select * from public.${t}`)).rejects.toThrow(
              /permission denied/,
            );
        });
      await asRole(db, "service_role", async () => {
        await expect(
          db.query("delete from public.emsp_problem_reports"),
        ).rejects.toThrow(/permission denied/);
      });
      const bad = [
        `insert into public.emsp_push_tokens (token, driver_ref, platform) values ('not-expo', 'd', 'ios')`,
        `insert into public.emsp_push_tokens (token, driver_ref, platform) values ('${token(99)}', 'd', 'web')`,
        `insert into public.emsp_push_tokens (token, driver_ref, platform, locale) values ('${token(98)}', 'd', 'ios', 'en; drop')`,
        `insert into public.emsp_problem_reports (driver_ref, location_id, category, message) values ('d', 'L', 'angry', 'x')`,
        `insert into public.emsp_problem_reports (driver_ref, location_id, category, message) values ('d', 'L', 'other', '')`,
        `insert into public.emsp_problem_reports (driver_ref, location_id, category, message, photo_type) values ('d', 'L', 'other', 'x', 'image/jpeg')`,
        `insert into public.emsp_problem_reports (driver_ref, location_id, category, message, photo_type, photo_base64) values ('d', 'L', 'other', 'x', 'image/svg+xml', 'AA==')`,
        `insert into public.emsp_problem_reports (driver_ref, location_id, category, message, status) values ('d', 'L', 'other', 'x', 'resolved')`,
      ];
      for (const sql of bad)
        await expect(db.query(sql)).rejects.toThrow(/check constraint/);
    },
  );
});
