import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleLocations, sampleTariffs } from "@/lib/mock-cpo/sample-data";
import {
  DEMO_PEER_ID,
  locationStore,
  setLocationStoreForTests,
  visiblePeerIds,
} from "@/lib/locations/registry";
import { MemoryLocationStore, type SyncState } from "@/lib/locations/store";
import { SupabaseLocationStore } from "@/lib/locations/store-supabase";
import { LIVE_ENV } from "./support/network";

const PEER = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
const KEY = "test-service-role-key";
const PARTY = { countryCode: "ZZ", partyId: "MCK" };
let requests: Request[];
let replies: Response[];
const transport = async (url: string | URL, init?: RequestInit) => {
  requests.push(new Request(url, init));
  return replies.shift() ?? Response.json([]);
};
const store = new SupabaseLocationStore(
  "https://db.example.test",
  KEY,
  transport,
);
const query = (r: Request) => decodeURIComponent(new URL(r.url).search);

beforeEach(() => {
  requests = [];
  replies = [];
});

describe("Supabase location store (PostgREST)", () => {
  it("upserts a page of locations in one request, with the search columns", async () => {
    const locations = sampleLocations(PARTY, 2);
    await store.saveLocations(PEER, locations, "2026-10-21T10:00:00Z");
    const [r] = requests;
    expect(r.method).toBe("POST");
    expect(new URL(r.url).pathname).toBe("/rest/v1/emsp_ocpi_locations");
    expect(query(r)).toBe(
      "?on_conflict=peer_id,country_code,party_id,location_id",
    );
    expect(r.headers.get("prefer")).toBe(
      "resolution=merge-duplicates,return=minimal",
    );
    expect(r.headers.get("apikey")).toBe(KEY);
    const body = await r.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      peer_id: PEER,
      country_code: "ZZ",
      party_id: "MCK",
      location_id: "LOC1",
      publish: true,
      latitude: 52.09274,
      search_text: "station square 1 station square 1000 aa sample city",
      search_ids: [
        "LOC1",
        "LOC11",
        "ZZMCKE11",
        "A1",
        "LOC12",
        "ZZMCKE12",
        "A2",
      ],
      last_updated: "2026-10-01T00:00:00Z",
      seen_at: "2026-10-21T10:00:00Z",
      data: locations[0],
    });
    await store.saveLocations(PEER, [], "2026-10-21T10:00:00Z");
    expect(requests).toHaveLength(1);
  });

  it("narrows candidates by peer, publish, box, words and ID", async () => {
    replies.push(
      Response.json([
        { peer_id: PEER, data: sampleLocations(PARTY, 1)[0], seen_at: "x" },
      ]),
    );
    const found = await store.findLocations({
      peerIds: [PEER, 'odd"peer,(id)'],
      bbox: { minLat: 52, maxLat: 52.2, minLng: 5, maxLng: 5.2 },
      words: ["market", "hall"],
      id: "ZZMCKE11",
      limit: 1000,
    });
    expect(found[0].location.id).toBe("LOC1");
    expect(query(requests[0])).toBe(
      `?peer_id=in.("${PEER}","odd\\"peer,(id)")&publish=is.true&select=peer_id,data,seen_at&limit=1000` +
        "&latitude=gte.52&latitude=lte.52.2&longitude=gte.5&longitude=lte.5.2" +
        "&search_text=ilike.*market*&search_text=ilike.*hall*&search_ids=cs.{ZZMCKE11}",
    );
    expect(await store.findLocations({ peerIds: [], limit: 10 })).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("reads, saves, deletes and prunes tariffs by peer and key", async () => {
    const [t] = sampleTariffs(PARTY);
    await store.saveTariffs(PEER, [t], "2026-10-21T10:00:00Z");
    await store.findTariffs(PEER, ["DC_FAST", "HPC"]);
    await store.deleteTariff({
      peerId: PEER,
      countryCode: "zz",
      partyId: "mck",
      id: "A&B",
    });
    replies.push(Response.json([{ tariff_id: "x" }, { tariff_id: "y" }]));
    expect(await store.pruneTariffs(PEER, "2026-10-21T10:00:00Z")).toBe(2);
    expect(query(requests[1])).toBe(
      `?peer_id=eq.${PEER}&tariff_id=in.("DC_FAST","HPC")&select=peer_id,data,seen_at`,
    );
    expect(requests[2].method).toBe("DELETE");
    expect(new URL(requests[2].url).search).toBe(
      `?peer_id=eq.${PEER}&country_code=eq.ZZ&party_id=eq.MCK&tariff_id=eq.A%26B`,
    );
    expect(requests[3].method).toBe("DELETE");
    expect(query(requests[3])).toBe(
      `?peer_id=eq.${PEER}&seen_at=lt.2026-10-21T10:00:00Z&select=tariff_id`,
    );
  });

  it("saves sync state only while the expected run owns it", async () => {
    const state: SyncState = {
      peerId: PEER,
      module: "locations",
      lastFullSyncAt: null,
      cursor: null,
      run: null,
      lastResult: null,
    };
    // An existing row with the expected run: one conditional PATCH.
    replies.push(Response.json([{}]));
    expect(await store.saveSyncState(state, "run-1")).toBe(true);
    expect(requests[0].method).toBe("PATCH");
    expect(query(requests[0])).toBe(
      `?peer_id=eq.${PEER}&module=eq.locations&run_id=eq.run-1`,
    );
    // Another run owns it: refused, no insert.
    replies.push(Response.json([]));
    expect(await store.saveSyncState(state, "run-1")).toBe(false);
    expect(requests).toHaveLength(2);
    // No row yet: PATCH matches nothing, then an insert that ignores duplicates.
    replies.push(Response.json([]), Response.json([{}]));
    expect(await store.saveSyncState(state, null)).toBe(true);
    expect(query(requests[2])).toContain("run_id=is.null");
    expect(requests[3].headers.get("prefer")).toBe(
      "resolution=ignore-duplicates,return=representation",
    );
    // A row owned by a running pull: both match nothing.
    replies.push(Response.json([]), Response.json([]));
    expect(await store.saveSyncState(state, null)).toBe(false);
  });

  it("reports failures by table and status only", async () => {
    replies.push(new Response(`{"message":"bad ${KEY}"}`, { status: 400 }));
    await expect(
      store.getLocation({
        peerId: PEER,
        countryCode: "ZZ",
        partyId: "MCK",
        id: "1",
      }),
    ).rejects.toThrow(
      new Error("Database request failed: GET emsp_ocpi_locations (HTTP 400)"),
    );
  });
});

describe("location store selection", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setLocationStoreForTests(undefined);
    vi.unstubAllGlobals();
  });

  it("serves the mock CPO's sample data in demo mode, and Supabase in live mode", async () => {
    process.env.DEMO_MODE = "true";
    const demo = locationStore();
    expect(demo).toBeInstanceOf(MemoryLocationStore);
    expect(locationStore()).toBe(demo);
    expect(await visiblePeerIds()).toEqual([DEMO_PEER_ID]);
    expect((demo as MemoryLocationStore).locations.size).toBe(12);
    Object.assign(process.env, LIVE_ENV);
    delete process.env.DEMO_MODE;
    expect(locationStore()).toBeInstanceOf(SupabaseLocationStore);
  });

  it("never reaches the database in demo mode", async () => {
    process.env.DEMO_MODE = "true";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const live = new SupabaseLocationStore("https://db.example.test", KEY);
    await expect(live.findTariffs(PEER, ["x"])).rejects.toThrow(/Demo mode/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
