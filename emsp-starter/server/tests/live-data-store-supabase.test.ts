import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { SupabaseLiveDataStore } from "@/lib/live-data/store-supabase";
import { asRole, migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";

const A = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
const B = "0c5c1f0e-77a2-4f7e-8f2c-5d0a3e9b6c22";
const C = "5d2a9c3e-1b4f-4e6a-8c7d-9e0f1a2b3c44";
let db: PGlite;
let store: SupabaseLiveDataStore;

const settings = (peerId: string, over: Record<string, string> = {}) => ({
  peerId,
  kind: "ivora",
  baseUrl: "https://api.cpo.example.test",
  accountId: "42",
  keyCiphertext: "v1:aXY:Y3Q:dGFn",
  ...over,
});

beforeAll(async () => {
  db = await migratedDatabase();
  for (const id of [A, B, C])
    await db.query(
      `insert into public.emsp_ocpi_peers (id, label, direction) values ($1, 'CPO', 'outbound')`,
      [id],
    );
  store = new SupabaseLiveDataStore(
    "https://db.example.test",
    "test-service-role-key",
    pgliteRest(db),
  );
}, 20_000);

afterAll(async () => {
  await db?.close();
});

describe("Supabase live-data adapter store (PGlite)", () => {
  it(
    "creates, replaces, lists and removes a peer's settings",
    { timeout: 20_000 },
    async () => {
      expect(await store.get(A)).toBeNull();
      const first = await store.put(settings(A));
      expect(first).toMatchObject(settings(A));
      const second = await store.put(settings(A, { accountId: "43" }));
      expect(second.accountId).toBe("43");
      expect(second.createdAt).toBe(first.createdAt);
      await store.put(settings(B));
      expect((await store.list()).map((s) => s.peerId)).toEqual([A, B]);
      expect(await store.remove(A)).toBe(true);
      expect(await store.remove(A)).toBe(false);
      expect(await store.get(A)).toBeNull();
      expect(await store.get(B)).toMatchObject({ accountId: "42" });
    },
  );

  it(
    "refuses a plain key, an http URL, a bad kind or an unknown peer",
    { timeout: 20_000 },
    async () => {
      for (const over of [
        { keyCiphertext: "iv_live_plain-key-0123456789" },
        { baseUrl: "http://api.cpo.example.test" },
        { baseUrl: "https://user:pw@api.cpo.example.test" },
        { kind: "Ivora API" },
        { accountId: "4 2" },
      ] as Record<string, string>[])
        await expect(store.put(settings(C, over))).rejects.toThrow(
          /Database request failed/,
        );
      await expect(
        store.put(settings("1f0e0b5e-3c47-4c1e-9d55-4f1f0f8d2b11")),
      ).rejects.toThrow(/Database request failed/);
      expect(await store.get(C)).toBeNull();
      await expect(
        db.query(
          `insert into public.emsp_live_data_adapters (peer_id, kind, base_url, account_id, key_ciphertext)
         values ($1, 'ivora', 'https://api.cpo.example.test', '42', 'plain')`,
          [A],
        ),
      ).rejects.toThrow();
    },
  );

  it(
    "keeps the settings away from anon and authenticated",
    { timeout: 20_000 },
    async () => {
      for (const role of ["anon", "authenticated"] as const)
        await expect(
          asRole(db, role, () =>
            db.query("select * from public.emsp_live_data_adapters"),
          ),
        ).rejects.toThrow(/permission denied/);
    },
  );
});
