import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import { setLocationStoreForTests } from "@/lib/locations/registry";
import { MAX_WRITE_ATTEMPTS } from "@/lib/locations/receiver";
import { MemoryLocationStore, type LocationStore } from "@/lib/locations/store";
import { SupabaseLocationStore } from "@/lib/locations/store-supabase";
import { syncPeer } from "@/lib/locations/sync";
import type { ClientOptions } from "@/lib/ocpi/client";
import { OcpiError } from "@/lib/ocpi/errors";
import { connectToCpo } from "@/lib/ocpi/handshake";
import type { Evse, Location } from "@/lib/ocpi/locations";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore, type Peer } from "@/lib/ocpi/store";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";
import { migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";

/**
 * Concurrent writes to one location or tariff never lose each other's changes, in the
 * memory store and in the Supabase store on a real Postgres (PGlite).
 */

const saved = { ...process.env };
const client: ClientOptions = { retries: 0 };
let peers: MemoryPeerStore;
let cpo: MockCpo;
let db: PGlite | undefined;

const STORES: [string, () => Promise<LocationStore>][] = [
  ["memory store", async () => new MemoryLocationStore()],
  [
    "Supabase store on PGlite",
    async () => {
      db = await migratedDatabase();
      return new SupabaseLocationStore(
        "https://db.example.test",
        "test-service-role-key",
        pgliteRest(db),
      );
    },
  ],
];

beforeEach(() => {
  Object.assign(process.env, LIVE_ENV);
  delete process.env.DEMO_MODE;
  peers = new MemoryPeerStore();
  setPeerStoreForTests(peers);
  const net = inProcessNetwork({
    "emsp.example.test": emspHandler,
    "mock-cpo.example.test": (r) => cpo.handle(r),
  });
  cpo = createMockCpo({ transport: net.transport });
  installNetwork(net.transport);
});

afterEach(async () => {
  uninstallNetwork();
  setPeerStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  process.env = { ...saved };
  vi.restoreAllMocks();
  await db?.close();
  db = undefined;
});

async function connect(store: LocationStore): Promise<Peer> {
  setLocationStoreForTests(store);
  const peer = await connectToCpo(
    {
      label: "Mock CPO",
      versionsUrl: cpo.urls.versions,
      tokenA: cpo.issueTokenA(),
    },
    { store: peers, client },
  );
  // The location tables reference the peer registry.
  await db?.query(
    "insert into public.emsp_ocpi_peers (id, label, direction) values ($1, 'Mock CPO', 'outbound')",
    [peer.id],
  );
  return peer;
}

const T = (minute: number) =>
  new Date(Date.UTC(2026, 9, 21, 9, minute)).toISOString().replace(".000", "");

/** A location with `n` EVSEs of two connectors each, all AVAILABLE. */
function bigLocation(base: Location, n: number): Location {
  const template = base.evses![0];
  const evses: Evse[] = Array.from({ length: n }, (_, i) => ({
    ...template,
    uid: `BIG-${i}`,
    evse_id: `ZZ*MCK*E9${i}`,
    status: "AVAILABLE",
    last_updated: T(0),
    connectors: template.connectors.map((c) => ({ ...c, last_updated: T(0) })),
  }));
  return { ...base, id: "BIG", evses, last_updated: T(0) };
}

const key = (peerId: string, id: string) => ({
  peerId,
  countryCode: "ZZ",
  partyId: "MCK",
  id,
});

// Each PGlite test migrates a fresh database inside the test, which takes seconds on a
// busy CI runner: a longer timeout than vitest's 5 s default.
describe.each(STORES)(
  "concurrent pushes (%s)",
  { timeout: 20_000 },
  (_, makeStore) => {
    it("applies many parallel PATCHes on different EVSEs and connectors of one location", async () => {
      const store = await makeStore();
      const peer = await connect(store);
      const [base] = cpo.state.locations;
      const n = 12;
      await cpo.putLocation(bigLocation(base, n), { push: true });

      const results = await Promise.all([
        ...Array.from({ length: n }, (_, i) =>
          cpo.push("locations", "PATCH", ["ZZ", "MCK", "BIG", `BIG-${i}`], {
            status: "CHARGING",
            last_updated: T(1 + i),
          }),
        ),
        ...Array.from({ length: n }, (_, i) =>
          cpo.push(
            "locations",
            "PATCH",
            ["ZZ", "MCK", "BIG", `BIG-${i}`, base.evses![0].connectors[1].id],
            { max_electric_power: 7_000 + i, last_updated: T(1 + i) },
          ),
        ),
      ]);
      expect(results).toHaveLength(2 * n);

      const held = (await store.getLocation(key(peer.id, "BIG")))!.location;
      expect(held.evses!.map((e) => e.status)).toEqual(
        Array(n).fill("CHARGING"),
      );
      expect(
        held.evses!.map((e) => e.connectors[1].max_electric_power),
      ).toEqual(Array.from({ length: n }, (_, i) => 7_000 + i));
      expect(held.last_updated).toBe(T(n));
    });

    it("applies parallel tariff PATCHes to different fields", async () => {
      const store = await makeStore();
      const peer = await connect(store);
      await syncPeer(peer.id, "tariffs", { peers, locations: store, client });
      const [tariff] = cpo.state.tariffs;
      const at = new Date(Date.now() + 60_000).toISOString();
      await Promise.all([
        cpo.push("tariffs", "PATCH", ["ZZ", "MCK", tariff.id], {
          tariff_alt_text: [{ language: "en", text: "Patched" }],
          last_updated: at,
        }),
        cpo.push("tariffs", "PATCH", ["ZZ", "MCK", tariff.id], {
          max_price: { excl_vat: 50 },
          last_updated: at,
        }),
        cpo.push("tariffs", "PATCH", ["ZZ", "MCK", tariff.id], {
          min_price: { excl_vat: 1 },
          last_updated: at,
        }),
      ]);
      const held = (await store.getTariff(key(peer.id, tariff.id)))!.tariff;
      expect(held).toMatchObject({
        tariff_alt_text: [{ language: "en", text: "Patched" }],
        max_price: { excl_vat: 50 },
        min_price: { excl_vat: 1 },
      });
    });

    it("keeps a pushed change when an older pull of the same location lands after it", async () => {
      const store = await makeStore();
      const peer = await connect(store);
      const [base] = cpo.state.locations;
      const pulled = { ...base, last_updated: T(0) };
      await store.saveLocations(peer.id, [pulled], "2026-10-21T09:00:00Z");
      const before = await store.getLocation(key(peer.id, base.id));
      const pushed = { ...pulled, name: "Pushed", last_updated: T(5) };
      expect(
        await store.putLocation(peer.id, pushed, T(5), before!.revision),
      ).toBe(true);
      // The stale revision loses, and so does an insert when one is held.
      expect(
        await store.putLocation(peer.id, pushed, T(5), before!.revision),
      ).toBe(false);
      expect(await store.putLocation(peer.id, pushed, T(5), null)).toBe(false);

      // A page pulled before the push arrives after it: the push stays, seen_at moves.
      await store.saveLocations(peer.id, [pulled], "2026-10-21T10:00:00Z");
      const after = (await store.getLocation(key(peer.id, base.id)))!;
      expect(after.location.name).toBe("Pushed");
      expect(Date.parse(after.seenAt)).toBe(Date.parse("2026-10-21T10:00:00Z"));
      // A newer pull replaces it.
      await store.saveLocations(
        peer.id,
        [{ ...pulled, name: "Newer", last_updated: T(6) }],
        "2026-10-21T10:01:00Z",
      );
      const newest = (await store.getLocation(key(peer.id, base.id)))!;
      expect(newest.location.name).toBe("Newer");
      expect(newest.revision).not.toBe(after.revision);
    });

    it("deletes a tariff only if it is unchanged since read", async () => {
      const store = await makeStore();
      const peer = await connect(store);
      const [tariff] = cpo.state.tariffs;
      await store.saveTariffs(peer.id, [tariff], "2026-10-21T09:00:00Z");
      const held = (await store.getTariff(key(peer.id, tariff.id)))!;
      expect(
        await store.putTariff(
          peer.id,
          { ...tariff, currency: "CHF" },
          T(1),
          held.revision,
        ),
      ).toBe(true);
      expect(
        await store.deleteTariff(key(peer.id, tariff.id), held.revision),
      ).toBe(false);
      const now = (await store.getTariff(key(peer.id, tariff.id)))!;
      expect(now.tariff.currency).toBe("CHF");
      expect(
        await store.deleteTariff(key(peer.id, tariff.id), now.revision),
      ).toBe(true);
      expect(await store.getTariff(key(peer.id, tariff.id))).toBeNull();
    });

    it("returns the nearest candidates first, before the limit", async () => {
      const store = await makeStore();
      const peer = await connect(store);
      const [base] = cpo.state.locations;
      // Five sites going east from the search point, saved farthest first.
      const sites = [5, 4, 3, 2, 1].map((i) => ({
        ...base,
        id: `EAST${i}`,
        coordinates: {
          latitude: "52.000000",
          longitude: (5 + i / 100).toFixed(6),
        },
      }));
      await store.saveLocations(peer.id, sites, "2026-10-21T09:00:00Z");
      const found = await store.findLocations({
        peerIds: [peer.id],
        bbox: { minLat: 51, maxLat: 53, minLng: 4, maxLng: 6 },
        near: { lat: 52, lng: 5 },
        limit: 2,
      });
      expect(found.map((s) => s.location.id)).toEqual(["EAST1", "EAST2"]);
    });
  },
);

describe("compare-and-swap retries", () => {
  it("answers 503 (3000) when every attempt loses, and never writes", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const store = new MemoryLocationStore();
    const peer = await connect(store);
    const [base] = cpo.state.locations;
    await cpo.putLocation({ ...base, last_updated: T(0) }, { push: true });
    const put = vi.spyOn(store, "putLocation").mockResolvedValue(false);
    const err = await cpo
      .push("locations", "PATCH", ["ZZ", "MCK", base.id], {
        name: "Lost",
        last_updated: T(1),
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OcpiError);
    expect(err.details).toMatchObject({ httpStatus: 503, statusCode: 3000 });
    expect(put).toHaveBeenCalledTimes(MAX_WRITE_ATTEMPTS);
    put.mockRestore();
    expect(
      (await store.getLocation(key(peer.id, base.id)))!.location.name,
    ).not.toBe("Lost");
  });
});
