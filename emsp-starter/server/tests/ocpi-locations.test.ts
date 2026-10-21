import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import { setLocationStoreForTests } from "@/lib/locations/registry";
import { searchLocations } from "@/lib/locations/search";
import { MemoryLocationStore } from "@/lib/locations/store";
import {
  STALE_RUN_MS,
  syncAllPeers,
  syncPeer,
  SyncError,
  type SyncDeps,
} from "@/lib/locations/sync";
import { ocpiRequest, type ClientOptions } from "@/lib/ocpi/client";
import { OcpiError } from "@/lib/ocpi/errors";
import { connectToCpo, invitePeer } from "@/lib/ocpi/handshake";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore, type Peer } from "@/lib/ocpi/store";
import { DemoModeError } from "@/lib/server/demo";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";

const EMSP = "https://emsp.example.test/ocpi/2.2.1";
const T0 = new Date("2026-10-21T10:00:00Z");

let peers: MemoryPeerStore;
let locations: MemoryLocationStore;
let cpo: MockCpo;
let cpo2: MockCpo;
let net: ReturnType<typeof inProcessNetwork>;
/** Answers a mock CPO request instead of the CPO, when it returns a Response. */
let intercept: (r: Request) => Response | undefined;
let clock: Date;
const saved = { ...process.env };
const client: ClientOptions = { retries: 0 };

const deps = (): SyncDeps => ({
  peers,
  locations,
  client,
  now: () => clock,
});

beforeEach(() => {
  Object.assign(process.env, LIVE_ENV);
  delete process.env.DEMO_MODE;
  peers = new MemoryPeerStore();
  locations = new MemoryLocationStore();
  setPeerStoreForTests(peers);
  setLocationStoreForTests(locations);
  intercept = () => undefined;
  clock = T0;
  net = inProcessNetwork({
    "emsp.example.test": emspHandler,
    "mock-cpo.example.test": async (r) => intercept(r) ?? cpo.handle(r),
    "cpo-two.example.test": (r) => cpo2.handle(r),
  });
  // Two CPOs on different platforms that happen to use the same location and
  // tariff IDs (LOC1..LOC6, DC_FAST, ...).
  cpo = createMockCpo({ transport: net.transport });
  cpo2 = createMockCpo({
    transport: net.transport,
    baseUrl: "https://cpo-two.example.test",
    party: { countryCode: "YY", partyId: "TWO" },
    name: "Second CPO",
    sample: { center: { lat: 48.85, lng: 2.35 }, currency: "GBP" },
  });
  installNetwork(net.transport);
});

afterEach(() => {
  uninstallNetwork();
  setPeerStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  process.env = { ...saved };
  vi.restoreAllMocks();
});

/** We register at the first CPO; the second registers with us. */
async function registerBoth(): Promise<[Peer, Peer]> {
  const one = await connectToCpo(
    {
      label: "Mock CPO",
      versionsUrl: cpo.urls.versions,
      tokenA: cpo.issueTokenA(),
    },
    { store: peers, client },
  );
  const invite = await invitePeer({ label: "Second CPO" }, { store: peers });
  await cpo2.registerWith(invite.versionsUrl, invite.tokenA);
  return [one, (await peers.getPeer(invite.peer.id))!];
}

const stored = (peerId: string, id: string, party = { cc: "ZZ", pid: "MCK" }) =>
  locations.getLocation({
    peerId,
    countryCode: party.cc,
    partyId: party.pid,
    id,
  });

const locationRequests = (mock: MockCpo) =>
  mock.state.requests.filter((r) => r.path === "/ocpi/2.2.1/locations");

describe("pulling locations and tariffs", () => {
  it("pulls every page from both peers and keeps overlapping IDs apart", async () => {
    const [one, two] = await registerBoth();
    const results = await syncAllPeers(deps());
    expect(results).toEqual([
      expect.objectContaining({ peerId: one.id, module: "tariffs", items: 6 }),
      expect.objectContaining({
        peerId: one.id,
        module: "locations",
        items: 6,
      }),
      expect.objectContaining({ peerId: two.id, module: "tariffs", items: 6 }),
      expect.objectContaining({
        peerId: two.id,
        module: "locations",
        items: 6,
      }),
    ]);
    expect(results.every((r) => r.ok && r.complete)).toBe(true);
    expect(locations.locations.size).toBe(12);
    expect(locations.tariffs.size).toBe(12);

    const a = await stored(one.id, "LOC1");
    const b = await stored(two.id, "LOC1", { cc: "YY", pid: "TWO" });
    expect(a?.location.coordinates.latitude).not.toBe(
      b?.location.coordinates.latitude,
    );
    // Same tariff ID, different peers: each keeps its own.
    const [t1] = await locations.findTariffs(one.id, ["DC_FAST"]);
    const [t2] = await locations.findTariffs(two.id, ["DC_FAST"]);
    expect([t1.tariff.currency, t2.tariff.currency]).toEqual(["EUR", "GBP"]);
    // A peer's own data only: nothing of peer one under peer two's ID.
    expect(await stored(two.id, "LOC1")).toBeNull();

    // Pages followed the Link header, with our token, routing headers and limit.
    const reqs = locationRequests(cpo);
    expect(reqs).toHaveLength(3);
    expect(reqs[0].headers).toMatchObject({
      "ocpi-from-country-code": "NL",
      "ocpi-from-party-id": "ABC",
      "ocpi-to-country-code": "ZZ",
      "ocpi-to-party-id": "MCK",
    });
    expect(reqs[0].token).toBe([...cpo.state.issued][0]);

    const state = await locations.getSyncState(one.id, "locations");
    expect(state).toMatchObject({
      lastFullSyncAt: T0.toISOString(),
      cursor: T0.toISOString(),
      run: null,
      lastResult: { ok: true, mode: "full", items: 6, invalid: 0 },
    });
  });

  it("then pulls only what changed since the last pull, with date_from", async () => {
    const [one] = await registerBoth();
    await syncPeer(one.id, "locations", deps());
    await cpo.setEvseStatus("LOC2", "LOC2-1", "CHARGING", {
      at: new Date("2026-10-21T10:30:00Z"),
    });
    clock = new Date("2026-10-21T11:00:00Z");
    cpo.state.requests.length = 0;

    const report = await syncPeer(one.id, "locations", deps());
    expect(report).toMatchObject({
      mode: "incremental",
      items: 1,
      complete: true,
    });
    const [req] = locationRequests(cpo);
    // The last pull started at 10:00; five minutes back for clock skew.
    expect(req).toBeDefined();
    const sent = net.calls.filter((c) => c.url.includes("/locations?")).at(-1)!;
    expect(new URL(sent.url).searchParams.get("date_from")).toBe(
      "2026-10-21T09:55:00Z",
    );
    const loc2 = await stored(one.id, "LOC2");
    expect(loc2?.location.evses?.[0].status).toBe("CHARGING");
    expect(loc2?.location.last_updated).toBe("2026-10-21T10:30:00Z");
    expect((await locations.getSyncState(one.id, "locations"))?.cursor).toBe(
      "2026-10-21T11:00:00.000Z",
    );
  });

  it("resumes a pull that failed at a page from that page", async () => {
    const [one] = await registerBoth();
    let calls = 0;
    intercept = (r) => {
      if (!new URL(r.url).pathname.endsWith("/locations")) return undefined;
      calls++;
      return calls === 2
        ? Response.json(
            { status_code: 3000, timestamp: "2026-10-21T10:00:00Z" },
            { status: 503 },
          )
        : undefined;
    };
    await expect(syncPeer(one.id, "locations", deps())).rejects.toThrow(
      /Pulling locations from Mock CPO failed: GET mock-cpo.example.test\/ocpi\/2.2.1\/locations failed with HTTP 503/,
    );
    const failed = await locations.getSyncState(one.id, "locations");
    expect(failed).toMatchObject({
      lastFullSyncAt: null,
      run: { mode: "full", pages: 1, items: 2 },
      lastResult: { ok: false, items: 2 },
    });
    expect(new URL(failed!.run!.nextUrl!).searchParams.get("offset")).toBe("2");

    // The next call starts at the page that failed, not at the beginning.
    clock = new Date(T0.getTime() + 60_000);
    const before = net.calls.length;
    const report = await syncPeer(one.id, "locations", deps());
    expect(report).toMatchObject({
      resumed: true,
      complete: true,
      pages: 3,
      items: 6,
      removed: 0,
    });
    const urls = net.calls.slice(before).map((c) => new URL(c.url));
    expect(urls[0].searchParams.get("offset")).toBe("2");
    expect(locations.locations.size).toBe(6);
    expect(
      (await locations.getSyncState(one.id, "locations"))?.lastFullSyncAt,
    ).toBe(T0.toISOString());
  });

  it("stops after maxPages and continues on the next call", async () => {
    const [one] = await registerBoth();
    const first = await syncPeer(one.id, "locations", deps(), { maxPages: 1 });
    expect(first).toMatchObject({ complete: false, pages: 1, items: 2 });
    // Parked, not running: the next call may resume at once.
    const second = await syncPeer(one.id, "locations", deps(), { maxPages: 1 });
    expect(second).toMatchObject({ complete: false, resumed: true, pages: 2 });
    const third = await syncPeer(one.id, "locations", deps(), { maxPages: 1 });
    expect(third).toMatchObject({ complete: true, pages: 3, items: 6 });
  });

  it("refuses a second pull while one is running, until it goes stale", async () => {
    const [one] = await registerBoth();
    await locations.saveSyncState(
      {
        peerId: one.id,
        module: "locations",
        lastFullSyncAt: null,
        cursor: null,
        run: {
          id: "11111111-1111-4111-8111-111111111111",
          mode: "full",
          startedAt: T0.toISOString(),
          dateFrom: null,
          nextUrl: null,
          pages: 0,
          items: 0,
          invalid: 0,
          heartbeatAt: T0.toISOString(),
        },
        lastResult: null,
      },
      null,
    );
    await expect(syncPeer(one.id, "locations", deps())).rejects.toThrow(
      "A locations pull from Mock CPO is already running",
    );
    clock = new Date(T0.getTime() + STALE_RUN_MS + 1000);
    await expect(syncPeer(one.id, "locations", deps())).resolves.toMatchObject({
      resumed: true,
      complete: true,
    });
  });

  it("removes what a full pull no longer sees, for that peer only", async () => {
    const [one, two] = await registerBoth();
    await syncAllPeers(deps());
    cpo.state.locations = cpo.state.locations.filter((l) => l.id !== "LOC6");
    cpo.state.tariffs = cpo.state.tariffs.filter((t) => t.id !== "HPC_ADHOC");
    clock = new Date("2026-10-22T10:00:00Z");
    expect(
      await syncPeer(one.id, "locations", deps(), { mode: "full" }),
    ).toMatchObject({ removed: 1 });
    expect(
      await syncPeer(one.id, "tariffs", deps(), { mode: "full" }),
    ).toMatchObject({ removed: 1 });
    expect(await stored(one.id, "LOC6")).toBeNull();
    expect(
      await stored(two.id, "LOC6", { cc: "YY", pid: "TWO" }),
    ).not.toBeNull();
    expect(await locations.findTariffs(one.id, ["HPC_ADHOC"])).toEqual([]);
  });

  it("skips invalid objects and other parties' objects, and keeps newer pushed data", async () => {
    const [one] = await registerBoth();
    const [loc1] = cpo.state.locations;
    cpo.state.locations.push(
      { ...loc1, id: "BROKEN", coordinates: { latitude: "x", longitude: "y" } },
      { ...loc1, id: "FOREIGN", country_code: "XX", party_id: "OTH" },
    );
    // A push newer than what the CPO's Sender still serves.
    await syncPeer(one.id, "locations", deps());
    await cpo.setEvseStatus("LOC1", "LOC1-1", "OUTOFORDER", {
      push: true,
      at: new Date("2026-10-21T10:30:00Z"),
    });
    const served = cpo.state.locations.find((l) => l.id === "LOC1")!;
    served.evses![0].status = "AVAILABLE";
    served.last_updated = "2026-10-21T10:10:00Z";

    clock = new Date("2026-10-21T11:00:00Z");
    const report = await syncPeer(one.id, "locations", deps(), {
      mode: "full",
    });
    expect(report).toMatchObject({ items: 6, invalid: 2 });
    expect(await stored(one.id, "BROKEN")).toBeNull();
    const loc = await stored(one.id, "LOC1");
    expect(loc?.location.evses?.[0].status).toBe("OUTOFORDER");
    // Seen by the pull, so the full pull's clean-up keeps it.
    expect(loc?.seenAt).toBe("2026-10-21T11:00:00.000Z");
  });

  it("needs a registered peer with a Sender endpoint, and is refused in demo mode", async () => {
    const [one] = await registerBoth();
    await expect(syncPeer("nope", "locations", deps())).rejects.toThrow(
      "No such peer",
    );
    const pending = await invitePeer({ label: "Pending" }, { store: peers });
    await expect(
      syncPeer(pending.peer.id, "locations", deps()),
    ).rejects.toThrow("Pending is pending, not registered");
    await peers.updatePeer(one.id, {
      endpoints: one.endpoints.filter((e) => e.identifier !== "tariffs"),
    });
    await expect(syncPeer(one.id, "tariffs", deps())).rejects.toBeInstanceOf(
      SyncError,
    );

    process.env.DEMO_MODE = "true";
    const before = net.calls.length;
    await expect(syncPeer(one.id, "locations", deps())).rejects.toBeInstanceOf(
      DemoModeError,
    );
    await expect(syncAllPeers(deps())).rejects.toBeInstanceOf(DemoModeError);
    expect(net.calls.length).toBe(before);
  });
});

describe("receiving pushes", () => {
  it("lists the Receiver endpoints in our version details", async () => {
    await registerBoth();
    expect(cpo.state.emsp!.endpoints).toEqual(
      expect.arrayContaining([
        { identifier: "locations", role: "RECEIVER", url: `${EMSP}/locations` },
        { identifier: "tariffs", role: "RECEIVER", url: `${EMSP}/tariffs` },
      ]),
    );
  });

  it("applies EVSE status PATCHes and keeps REMOVED EVSEs out of search", async () => {
    const [one, two] = await registerBoth();
    await syncAllPeers(deps());
    await cpo.setEvseStatus("LOC1", "LOC1-1", "CHARGING", { push: true });
    const loc = await stored(one.id, "LOC1");
    expect(loc?.location.evses?.[0].status).toBe("CHARGING");
    // The location's last_updated follows its EVSE.
    expect(loc?.location.last_updated).toBe(
      loc?.location.evses?.[0].last_updated,
    );
    // Peer two's LOC1 is untouched.
    expect(
      (await stored(two.id, "LOC1", { cc: "YY", pid: "TWO" }))?.location
        .evses?.[0].status,
    ).toBe("AVAILABLE");

    const find = () =>
      searchLocations(locations, [one.id], {
        chargerId: "LOC1",
        limit: 10,
        offset: 0,
      });
    expect((await find()).items[0]).toMatchObject({ evse_count: 2 });
    await cpo.setEvseStatus("LOC1", "LOC1-1", "REMOVED", { push: true });
    expect((await find()).items[0]).toMatchObject({ evse_count: 1 });
  });

  it("creates and replaces locations, EVSEs, connectors and tariffs with PUT", async () => {
    const [one] = await registerBoth();
    const [base] = cpo.state.locations;
    await cpo.putLocation(
      {
        ...base,
        id: "NEW1",
        name: "New site",
        last_updated: "2026-10-21T09:00:00Z",
      },
      { push: true },
    );
    expect((await stored(one.id, "NEW1"))?.location.name).toBe("New site");

    const evse = {
      ...base.evses![0],
      uid: "NEW1-9",
      last_updated: "2026-10-21T09:30:00Z",
    };
    await cpo.push("locations", "PUT", ["ZZ", "MCK", "NEW1", "NEW1-9"], evse);
    const connector = {
      ...evse.connectors[0],
      id: "7",
      last_updated: "2026-10-21T09:45:00Z",
    };
    await cpo.push(
      "locations",
      "PUT",
      ["ZZ", "MCK", "NEW1", "NEW1-9", "7"],
      connector,
    );
    const loc = (await stored(one.id, "NEW1"))!.location;
    const added = loc.evses!.find((e) => e.uid === "NEW1-9")!;
    expect(added.connectors.map((c) => c.id)).toEqual(["1", "2", "7"]);
    expect(added.last_updated).toBe("2026-10-21T09:45:00Z");
    expect(loc.last_updated).toBe("2026-10-21T09:45:00Z");

    // The CPO reads back what we hold.
    const role = cpo.state.emsp!.credentials.roles[0];
    const back = await ocpiRequest(
      {
        url: `${EMSP}/locations/ZZ/MCK/NEW1/NEW1-9/7`,
        token: cpo.state.emsp!.token,
        routing: {
          from: cpo.party,
          to: { countryCode: role.country_code, partyId: role.party_id },
        },
      },
      { transport: net.transport, retries: 0 },
    );
    expect(back.data).toEqual(connector);

    const [tariff] = cpo.state.tariffs;
    await cpo.putTariff(
      { ...tariff, currency: "CHF", last_updated: "2026-10-21T09:00:00Z" },
      { push: true },
    );
    const [held] = await locations.findTariffs(one.id, [tariff.id]);
    expect(held.tariff.currency).toBe("CHF");
    await cpo.deleteTariff(tariff.id, { push: true });
    expect(await locations.findTariffs(one.id, [tariff.id])).toEqual([]);
  });

  it("ignores a push older than what we hold", async () => {
    const [one] = await registerBoth();
    await syncPeer(one.id, "locations", deps());
    await cpo.push("locations", "PATCH", ["ZZ", "MCK", "LOC1", "LOC1-1"], {
      status: "BLOCKED",
      last_updated: "2025-01-01T00:00:00Z",
    });
    expect((await stored(one.id, "LOC1"))?.location.evses?.[0].status).toBe(
      "AVAILABLE",
    );
  });

  it("refuses unknown objects, invalid bodies, other parties and mismatched IDs", async () => {
    const [one] = await registerBoth();
    await syncPeer(one.id, "locations", deps());
    const fails = async (p: Promise<unknown>) => {
      const e = await p.then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(OcpiError);
      const err = e as OcpiError;
      return {
        http: err.httpStatus,
        code: err.statusCode,
        message: err.message,
      };
    };
    const now = "2026-10-21T12:00:00Z";

    expect(
      await fails(
        cpo.push("locations", "PATCH", ["ZZ", "MCK", "NOPE"], {
          name: "x",
          last_updated: now,
        }),
      ),
    ).toMatchObject({ http: 404, code: 2003 });
    expect(
      await fails(
        cpo.push("locations", "PUT", ["ZZ", "MCK", "NOPE", "E1"], {
          ...cpo.state.locations[0].evses![0],
          uid: "E1",
        }),
      ),
    ).toMatchObject({ http: 404, code: 2003 });
    // 2003 is Unknown Location: an unknown tariff is a plain client error.
    expect(
      await fails(cpo.push("tariffs", "DELETE", ["ZZ", "MCK", "NOPE"])),
    ).toMatchObject({
      http: 404,
      code: 2000,
      message: expect.stringContaining("Unknown tariff"),
    });
    const invalid = await fails(
      cpo.push("locations", "PATCH", ["ZZ", "MCK", "LOC1", "LOC1-1"], {
        status: "EXPLODED",
        last_updated: now,
      }),
    );
    expect(invalid).toMatchObject({ http: 400, code: 2001 });
    expect(invalid.message).toMatch(/evse.status must be one of/);
    expect(
      await fails(
        cpo.push("locations", "PATCH", ["ZZ", "MCK", "LOC1"], {
          name: "No date",
        }),
      ),
    ).toMatchObject({ http: 400, code: 2001 });
    expect(
      await fails(
        cpo.push("locations", "PUT", ["ZZ", "MCK", "LOC1"], {
          ...cpo.state.locations[0],
          id: "LOC2",
        }),
      ),
    ).toMatchObject({
      http: 400,
      code: 2001,
      message: expect.stringMatching(/id in the body does not match the URL/),
    });
    // Another CPO's party: refused, and nothing of the other peer changes.
    expect(
      await fails(
        cpo.push("locations", "PUT", ["YY", "TWO", "LOC1"], {
          ...cpo.state.locations[0],
          country_code: "YY",
          party_id: "TWO",
        }),
      ),
    ).toMatchObject({ http: 403, code: 2000 });
    expect(locations.locations.size).toBe(6);
    expect(
      await fails(cpo.push("tariffs", "DELETE", ["ZZ", "MCK", "NOPE"])),
    ).toMatchObject({ http: 404 });
  });

  it("refuses unknown tokens and missing routing headers", async () => {
    await registerBoth();
    const url = `${EMSP}/locations/ZZ/MCK/LOC1`;
    const unknown = await ocpiRequest(
      { url, token: "not-a-token-we-issued" },
      { transport: net.transport, retries: 0 },
    ).catch((e: OcpiError) => e);
    expect(unknown).toMatchObject({ httpStatus: 401 });
    const noRouting = await ocpiRequest(
      { url, token: cpo.state.emsp!.token },
      { transport: net.transport, retries: 0 },
    ).catch((e: OcpiError) => e);
    expect(noRouting).toMatchObject({ httpStatus: 400, statusCode: 2001 });
  });
});
