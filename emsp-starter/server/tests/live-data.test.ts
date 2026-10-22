import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listAdaptersAction,
  removeAdapterAction,
  setAdapterAction,
} from "@/app/admin/live-data/actions";
import {
  cleanLive,
  LiveDataError,
  nullAdapter,
  type LiveDataAdapter,
  type LiveSessionRef,
} from "@/lib/live-data/adapter";
import { CACHE_MS, ivoraAdapter } from "@/lib/live-data/ivora";
import { sessionLive } from "@/lib/live-data/live";
import {
  LiveDataSettingsError,
  removeAdapter,
  setAdapter,
} from "@/lib/live-data/manage";
import {
  adapterFor,
  keyContext,
  setLiveDataStoreForTests,
} from "@/lib/live-data/registry";
import { MemoryLiveDataStore } from "@/lib/live-data/store";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { sampleSessions } from "@/lib/mock-cpo/sample-data";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { decryptToken } from "@/lib/ocpi/tokens";
import { DemoModeError } from "@/lib/server/demo";
import { resetAdminLimitForTests } from "@/lib/server/admin";
import { MemorySessionStore } from "@/lib/sessions/store";
import {
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";

const KEY = "iv_live_test-read-only-key-0123456789";
const BASE = "https://api.cpo.example.test";
const TENANT = "42";
const START = "2026-10-22T08:00:00.000Z";
const SECRET = "s".repeat(32);
const saved = { ...process.env };

const ref = (over: Partial<LiveSessionRef> = {}): LiveSessionRef => ({
  peerId: "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11",
  countryCode: "US",
  partyId: "CPO",
  sessionId: "1234",
  status: "ACTIVE",
  startDateTime: START,
  locationId: "LOC1",
  evseUid: "LOC1-1",
  connectorId: "1",
  tokenUid: "NLABCAPP0000ABCD",
  ...over,
});

const transaction = (over: Record<string, unknown> = {}) => ({
  id: 1234,
  transaction_id: "77",
  test: false,
  active: true,
  started_at: "2026-10-22T08:00:40Z",
  ended_at: null,
  id_token: "****ABCD",
  energy_wh: 4200,
  ...over,
});

type Sample = Record<string, unknown>;
const record = (id: number, timestamp: string, samples: Sample[]) => ({
  id,
  timestamp,
  source: "MeterValues",
  samples,
});
const soc = (value: string, unit = "Percent") => ({
  measurand: "SoC",
  value,
  unit,
  multiplier: 0,
  phase: null,
  context: "Sample.Periodic",
});
const power = (value: string, unit = "W", multiplier = 0, phase = null) => ({
  measurand: "Power.Active.Import",
  value,
  unit,
  multiplier,
  phase,
  context: "Sample.Periodic",
});

/**
 * The Ivora API as an HTTP mock: one transaction and its meter values, paginated by
 * `after`. Every request is recorded; nothing leaves the process.
 */
function ivoraMock(
  opts: {
    tx?: Record<string, unknown> | null;
    meters?: ReturnType<typeof record>[];
    status?: number;
  } = {},
) {
  const calls: { method: string; url: string; auth: string | null }[] = [];
  let meters = opts.meters ?? [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    calls.push({
      method: request.method,
      url,
      auth: request.headers.get("authorization"),
    });
    if (opts.status) return Response.json({}, { status: opts.status });
    const u = new URL(url);
    const m = /^\/v1\/tenants\/42\/transactions\/(\d+)(\/meter-values)?$/.exec(
      u.pathname,
    );
    if (!m) return Response.json({}, { status: 404 });
    if (!m[2])
      return opts.tx === null
        ? Response.json({ error: { code: "not_found" } }, { status: 404 })
        : Response.json(opts.tx ?? transaction());
    const after = Number(u.searchParams.get("after") ?? 0);
    const limit = Number(u.searchParams.get("limit") ?? 100);
    const data = meters.filter((r) => r.id > after).slice(0, limit);
    return Response.json({
      transaction_id: Number(m[1]),
      data,
      next_cursor: data.length ? data[data.length - 1].id : after,
    });
  });
  return {
    fetch,
    calls,
    setMeters: (m: ReturnType<typeof record>[]) => (meters = m),
  };
}

const adapter = (
  mock: ReturnType<typeof ivoraMock>,
  now: () => number = () => Date.parse("2026-10-22T08:30:00Z"),
) =>
  ivoraAdapter(
    { baseUrl: BASE, tenantId: TENANT, apiKey: KEY },
    { fetch: mock.fetch, now },
  );

beforeEach(() => {
  for (const k of [...Object.keys(LIVE_ENV), "DEMO_MODE", "ADMIN_SECRET"])
    delete process.env[k];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("no network in tests");
    }),
  );
});

afterEach(() => {
  uninstallNetwork();
  setLiveDataStoreForTests(undefined);
  setPeerStoreForTests(undefined);
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe("live data shape", () => {
  it("the null adapter adds nothing", async () => {
    expect(nullAdapter.kind).toBe("none");
    expect(await nullAdapter.getLive(ref())).toEqual({});
  });

  it("keeps only readings that make sense", () => {
    const now = Date.parse("2026-10-22T08:30:00Z");
    expect(
      cleanLive(
        {
          socPercent: 54.26,
          powerKw: 48.123,
          measuredAt: "2026-10-22T08:29:00Z",
        },
        now,
      ),
    ).toEqual({
      socPercent: 54.3,
      powerKw: 48.12,
      measuredAt: "2026-10-22T08:29:00.000Z",
    });
    expect(cleanLive({ socPercent: 101, powerKw: -1 }, now)).toEqual({});
    expect(cleanLive({ socPercent: NaN, powerKw: "5" }, now)).toEqual({});
    expect(
      cleanLive({ socPercent: 50, measuredAt: "2026-10-22T09:30:00Z" }, now),
    ).toEqual({ socPercent: 50 });
    // A time alone is nothing to show.
    expect(cleanLive({ measuredAt: "2026-10-22T08:29:00Z" }, now)).toEqual({});
    expect(cleanLive(null, now)).toEqual({});
  });
});

describe("Ivora live-data adapter (HTTP mocks only)", () => {
  it("reads the matching transaction's newest SoC and power, with GETs only", async () => {
    const mock = ivoraMock({
      meters: [
        record(1, "2026-10-22T08:01:00Z", [soc("31"), power("50000")]),
        record(2, "2026-10-22T08:29:00Z", [
          soc("54"),
          power("48.5", "kW"),
          power("16000", "W", 0, "L1" as never),
        ]),
      ],
    });
    expect(await adapter(mock).getLive(ref())).toEqual({
      socPercent: 54,
      powerKw: 48.5,
      measuredAt: "2026-10-22T08:29:00.000Z",
    });
    expect(mock.calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `${BASE}/v1/tenants/42/transactions/1234`],
      [
        "GET",
        `${BASE}/v1/tenants/42/transactions/1234/meter-values?after=0&limit=500`,
      ],
    ]);
    expect(mock.calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
  });

  it("applies multipliers and accepts an SoC whose unit the charger omitted", async () => {
    const mock = ivoraMock({
      meters: [
        record(1, "2026-10-22T08:10:00Z", [
          soc("62", "Wh"),
          { ...power("7", "kW"), multiplier: 1 },
        ]),
      ],
    });
    expect(await adapter(mock).getLive(ref())).toMatchObject({
      socPercent: 62,
      powerKw: 70,
    });
  });

  it("gives no SoC when the charger reports none", async () => {
    const mock = ivoraMock({
      meters: [
        record(1, "2026-10-22T08:10:00Z", [
          power("11000"),
          {
            measurand: "Energy.Active.Import.Register",
            value: "5000",
            unit: "Wh",
          },
        ]),
      ],
    });
    const live = await adapter(mock).getLive(ref());
    expect(live).toEqual({
      powerKw: 11,
      measuredAt: "2026-10-22T08:10:00.000Z",
    });
    expect(live).not.toHaveProperty("socPercent");
  });

  it("drops the power of a transaction that has ended", async () => {
    const mock = ivoraMock({
      tx: transaction({ active: false, ended_at: "2026-10-22T08:20:00Z" }),
      meters: [record(1, "2026-10-22T08:19:00Z", [soc("80"), power("50000")])],
    });
    expect(await adapter(mock).getLive(ref())).toEqual({
      socPercent: 80,
      measuredAt: "2026-10-22T08:19:00.000Z",
    });
  });

  it("returns nothing, without reading meters, for a transaction that is not the session's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const tx of [
      transaction({ test: true }),
      transaction({ id: 999 }),
      transaction({ started_at: "2026-10-22T07:30:00Z" }),
      transaction({ started_at: null }),
      transaction({ id_token: "****WXYZ" }),
      transaction({ id_token: "****" }),
    ]) {
      const mock = ivoraMock({
        tx,
        meters: [record(1, "2026-10-22T08:10:00Z", [soc("50")])],
      });
      expect(await adapter(mock).getLive(ref())).toEqual({});
      expect(mock.calls).toHaveLength(1);
    }
    // Logged by IDs only, never the key or the token.
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("ABCD");
  });

  it("matches without a token when Ivora shows none", async () => {
    const mock = ivoraMock({
      tx: transaction({ id_token: null }),
      meters: [record(1, "2026-10-22T08:10:00Z", [soc("40")])],
    });
    expect(await adapter(mock).getLive(ref())).toMatchObject({
      socPercent: 40,
    });
  });

  it("asks nothing for a session ID that is not an Ivora transaction ID, and returns nothing on 404", async () => {
    const mock = ivoraMock({ tx: null });
    expect(await adapter(mock).getLive(ref({ sessionId: "S-1" }))).toEqual({});
    expect(mock.calls).toHaveLength(0);
    expect(await adapter(mock).getLive(ref())).toEqual({});
    expect(mock.calls).toHaveLength(1);
  });

  it("answers repeated polls from its cache, then reads only new meter values", async () => {
    let now = Date.parse("2026-10-22T08:30:00Z");
    const meters = Array.from({ length: 501 }, (_, i) =>
      record(
        i + 1,
        `2026-10-22T08:${String(Math.floor(i / 20)).padStart(2, "0")}:00Z`,
        [soc(String(30 + Math.floor(i / 25)))],
      ),
    );
    const mock = ivoraMock({ meters });
    const a = adapter(mock, () => now);
    expect((await a.getLive(ref())).socPercent).toBe(50);
    // Two pages: 500, then the last one.
    expect(
      mock.calls.map((c) => new URL(c.url).searchParams.get("after")),
    ).toEqual([null, "0", "500"]);
    mock.calls.length = 0;
    now += CACHE_MS - 1;
    expect((await a.getLive(ref())).socPercent).toBe(50);
    expect(mock.calls).toHaveLength(0);

    mock.setMeters([
      ...meters,
      record(502, "2026-10-22T08:31:00Z", [soc("61")]),
    ]);
    now += 2;
    expect((await a.getLive(ref())).socPercent).toBe(61);
    expect(
      mock.calls.map((c) => new URL(c.url).searchParams.get("after")),
    ).toEqual([null, "501"]);
  });

  it("fails with a code, never the key, on HTTP errors and an unreachable API", async () => {
    for (const [status, code] of [
      [401, "ivora_unauthorized"],
      [403, "ivora_unauthorized"],
      [429, "ivora_rate_limited"],
      [502, "ivora_http_502"],
    ] as const) {
      const err = await adapter(ivoraMock({ status }))
        .getLive(ref())
        .catch((e) => e);
      expect(err).toBeInstanceOf(LiveDataError);
      expect(err.code).toBe(code);
      expect(err.message).not.toContain(KEY);
    }
    const down = ivoraAdapter(
      { baseUrl: BASE, tenantId: TENANT, apiKey: KEY },
      {
        fetch: async () => {
          throw new TypeError(`fetch failed for ${KEY}`);
        },
      },
    );
    const err = await down.getLive(ref()).catch((e) => e);
    expect(err).toMatchObject({ code: "ivora_unreachable" });
    expect(err.message).not.toContain(KEY);
  });

  it("refuses settings that are not https, a numeric tenant and a plausible key", () => {
    const ok = { baseUrl: BASE, tenantId: TENANT, apiKey: KEY };
    expect(() => ivoraAdapter(ok)).not.toThrow();
    for (const bad of [
      { ...ok, baseUrl: "http://api.cpo.example.test" },
      { ...ok, baseUrl: "https://user:pw@api.cpo.example.test" },
      { ...ok, tenantId: "t-42" },
      { ...ok, apiKey: "short" },
      { ...ok, apiKey: `${KEY} with spaces` },
    ])
      expect(() => ivoraAdapter(bad)).toThrow(LiveDataError);
  });

  it("goes through peerFetch: refused in demo mode, public https hosts in live mode", async () => {
    const live = ivoraAdapter({ baseUrl: BASE, tenantId: TENANT, apiKey: KEY });
    const send = vi.fn(async () => Response.json(transaction()));
    installNetwork(
      inProcessNetwork({ "api.cpo.example.test": send }).transport,
    );
    await expect(live.getLive(ref())).rejects.toBeInstanceOf(DemoModeError);
    expect(send).not.toHaveBeenCalled();

    Object.assign(process.env, LIVE_ENV);
    const mock = ivoraMock({
      meters: [record(1, "2026-10-22T08:10:00Z", [soc("45")])],
    });
    installNetwork(
      inProcessNetwork({
        "api.cpo.example.test": (r) => mock.fetch(r.url, r),
      }).transport,
    );
    expect(await live.getLive(ref())).toMatchObject({ socPercent: 45 });
    expect(mock.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("adapters per peer", () => {
  const PEER = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
  const OTHER = "0c5c1f0e-77a2-4f7e-8f2c-5d0a3e9b6c22";
  let store: MemoryLiveDataStore;
  let peers: MemoryPeerStore;

  beforeEach(async () => {
    store = new MemoryLiveDataStore();
    peers = new MemoryPeerStore();
    setLiveDataStoreForTests(store);
    setPeerStoreForTests(peers);
    const p = await peers.createPeer({
      label: "Example CPO",
      direction: "outbound",
    });
    peers.peers.delete(p.id);
    peers.peers.set(PEER, { ...p, id: PEER, status: "registered" });
    peers.peers.set(OTHER, { ...p, id: OTHER, status: "unregistered" });
  });

  const input = (over: Record<string, string> = {}) => ({
    peerId: PEER,
    kind: "ivora",
    baseUrl: `${BASE}/`,
    accountId: TENANT,
    apiKey: KEY,
    ...over,
  });

  it("stores the key encrypted and bound to the peer, and audits without it", async () => {
    const saved = await setAdapter(input(), {
      store,
      peers,
      actor: "admin",
    });
    expect(saved).toMatchObject({
      peerId: PEER,
      kind: "ivora",
      baseUrl: BASE,
      accountId: TENANT,
    });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    const row = store.rows.get(PEER)!;
    expect(row.keyCiphertext).toMatch(/^v1:/);
    expect(row.keyCiphertext).not.toContain(KEY);
    expect(decryptToken(row.keyCiphertext, keyContext(PEER))).toBe(KEY);
    // Copied to another peer, or read as a peer token, it does not decrypt.
    expect(() => decryptToken(row.keyCiphertext, keyContext(OTHER))).toThrow();
    expect(() => decryptToken(row.keyCiphertext, PEER)).toThrow();
    expect(peers.auditLog).toEqual([
      expect.objectContaining({
        action: "live_data.adapter_set",
        subjectId: PEER,
        details: { kind: "ivora", host: "api.cpo.example.test" },
      }),
    ]);
    expect(JSON.stringify(peers.auditLog)).not.toContain(KEY);

    expect(await removeAdapter(PEER, { store, peers, actor: "admin" })).toBe(
      true,
    );
    expect(await removeAdapter(PEER, { store, peers, actor: "admin" })).toBe(
      false,
    );
    expect(store.rows.size).toBe(0);
  });

  it("refuses unknown kinds and peers, and invalid settings, naming the field only", async () => {
    for (const over of [
      { kind: "other" },
      { peerId: OTHER },
      { peerId: "0c5c1f0e-0000-4f7e-8f2c-5d0a3e9b6c22" },
      { baseUrl: "http://api.cpo.example.test" },
      { baseUrl: `${BASE}?key=x` },
      { accountId: "tenant" },
      { apiKey: "short" },
    ] as Record<string, string>[]) {
      const err = await setAdapter(input(over), {
        store,
        peers,
        actor: "admin",
      }).catch((e) => e);
      expect(err).toBeInstanceOf(LiveDataSettingsError);
      expect(err.message).not.toContain(KEY);
    }
    expect(store.rows.size).toBe(0);
  });

  it("uses the demo adapter for the mock CPO in demo mode, and sends nothing", async () => {
    const demo = await adapterFor(DEMO_PEER_ID);
    expect(demo.kind).toBe("demo");
    const [, , charging] = sampleSessions(
      { countryCode: "ZZ", partyId: "MCK" },
      { countryCode: "ZZ", partyId: "DMO" },
    );
    const live = await demo.getLive(
      ref({ status: "ACTIVE", startDateTime: charging.start_date_time }),
    );
    expect(live.socPercent).toBeGreaterThanOrEqual(30);
    expect(await demo.getLive(ref({ status: "COMPLETED" }))).toEqual({});
    // Saved settings are ignored in demo mode.
    await setAdapter(input(), { store, peers, actor: "admin" });
    expect(await adapterFor(PEER)).toBe(nullAdapter);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("builds the configured adapter in live mode, with the decrypted key", async () => {
    Object.assign(process.env, LIVE_ENV);
    expect(await adapterFor(PEER)).toBe(nullAdapter);
    await setAdapter(input(), { store, peers, actor: "admin" });
    const a = await adapterFor(PEER);
    expect(a.kind).toBe("ivora");
    // Kept while the settings stay the same.
    expect(await adapterFor(PEER)).toBe(a);

    const mock = ivoraMock({
      meters: [record(1, "2026-10-22T08:10:00Z", [soc("70")])],
    });
    installNetwork(
      inProcessNetwork({
        "api.cpo.example.test": (r) => mock.fetch(r.url, r),
      }).transport,
    );
    expect(await a.getLive(ref())).toMatchObject({ socPercent: 70 });
    expect(mock.calls[0].auth).toBe(`Bearer ${KEY}`);

    // An adapter kind this server does not know: nothing extra.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.rows.set(PEER, {
      ...store.rows.get(PEER)!,
      kind: "gone",
      updatedAt: "x",
    });
    expect(await adapterFor(PEER)).toBe(nullAdapter);
    expect(warn).toHaveBeenCalled();
  });
});

describe("a driver's session live data", () => {
  const PEER = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
  const [, completed, charging] = sampleSessions(
    { countryCode: "US", partyId: "CPO" },
    { countryCode: "NL", partyId: "ABC" },
  );

  async function stored() {
    const sessions = new MemorySessionStore();
    const now = new Date().toISOString();
    const a = await sessions.insertSession(
      PEER,
      {
        session: charging,
        fieldTimes: {},
        driverRef: "driver-1",
        commandId: null,
        completedAt: null,
      },
      now,
    );
    const b = await sessions.insertSession(
      PEER,
      {
        session: completed,
        fieldTimes: {},
        driverRef: "driver-1",
        commandId: null,
        completedAt: now,
      },
      now,
    );
    return { sessions, active: a!.id, done: b!.id };
  }

  const fixed = (live: unknown): LiveDataAdapter => ({
    kind: "fixed",
    getLive: vi.fn(async () => live as never),
  });

  it("shows what the adapter returns for the driver's running session", async () => {
    const { sessions, active } = await stored();
    const a = fixed({ socPercent: 64, powerKw: 50, extra: "dropped" });
    const res = await sessionLive(active, "driver-1", {
      sessions,
      adapterFor: async () => a,
    });
    expect(res).toEqual({
      sessionId: active,
      status: "ACTIVE",
      kwh: charging.kwh,
      live: { socPercent: 64, powerKw: 50 },
      source: "fixed",
    });
    expect(a.getLive).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: PEER,
        sessionId: charging.id,
        tokenUid: charging.cdr_token.uid,
      }),
      expect.any(AbortSignal),
    );
  });

  it("hides live data when the adapter has none, and never asks for a finished session", async () => {
    const { sessions, active, done } = await stored();
    const none = await sessionLive(active, "driver-1", {
      sessions,
      adapterFor: async () => nullAdapter,
    });
    expect(none).toMatchObject({ live: {}, source: null });
    const a = fixed({ socPercent: 90 });
    expect(
      await sessionLive(done, "driver-1", {
        sessions,
        adapterFor: async () => a,
      }),
    ).toMatchObject({ status: "COMPLETED", live: {}, source: null });
    expect(a.getLive).not.toHaveBeenCalled();
  });

  it("is not found for another driver's session or an unknown one", async () => {
    const { sessions, active } = await stored();
    const a = fixed({ socPercent: 64 });
    for (const [id, driver] of [
      [active, "driver-2"],
      ["missing", "driver-1"],
    ])
      expect(
        await sessionLive(id, driver, { sessions, adapterFor: async () => a }),
      ).toBeNull();
    expect(a.getLive).not.toHaveBeenCalled();
  });

  it("shows the session without extras when the adapter fails, logging the code only", async () => {
    const { sessions, active } = await stored();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: LiveDataAdapter = {
      kind: "ivora",
      getLive: async () => {
        throw new LiveDataError(
          "ivora_unauthorized",
          "Ivora API answered HTTP 401",
        );
      },
    };
    expect(
      await sessionLive(active, "driver-1", {
        sessions,
        adapterFor: async () => failing,
      }),
    ).toMatchObject({ live: {}, source: null });
    expect(warn.mock.calls.flat().join(" ")).toContain("ivora_unauthorized");
  });
});

describe("live-data admin actions", () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  let store: MemoryLiveDataStore;
  let peers: MemoryPeerStore;

  beforeEach(() => {
    resetAdminLimitForTests();
    store = new MemoryLiveDataStore();
    peers = new MemoryPeerStore();
    setLiveDataStoreForTests(store);
    setPeerStoreForTests(peers);
  });

  it("need the admin secret", async () => {
    process.env.ADMIN_SECRET = SECRET;
    for (const action of [
      setAdapterAction,
      removeAdapterAction,
      listAdaptersAction,
    ]) {
      resetAdminLimitForTests();
      expect(await action({}, form({ adminSecret: "wrong" }))).toEqual({
        ok: false,
        message: "Wrong admin secret.",
      });
    }
  });

  it("set, list and remove an adapter, never returning the key", async () => {
    process.env.ADMIN_SECRET = SECRET;
    const peer = await peers.createPeer({
      label: "Example CPO",
      direction: "inbound",
    });
    const fields = {
      adminSecret: SECRET,
      peerId: peer.id,
      kind: "ivora",
      baseUrl: BASE,
      accountId: TENANT,
      apiKey: KEY,
    };
    const set = await setAdapterAction({}, form(fields));
    expect(set).toMatchObject({ ok: true, adapters: [{ peerId: peer.id }] });
    expect(JSON.stringify(set)).not.toContain(KEY);
    const list = await listAdaptersAction({}, form({ adminSecret: SECRET }));
    expect(list).toMatchObject({
      ok: true,
      adapters: [{ peerLabel: "Example CPO", kindLabel: "Ivora API" }],
    });
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(
      await setAdapterAction({}, form({ ...fields, accountId: "x" })),
    ).toEqual({ ok: false, message: "Tenant ID is invalid." });
    expect(
      await removeAdapterAction(
        {},
        form({ adminSecret: SECRET, peerId: peer.id }),
      ),
    ).toMatchObject({ ok: true });
    expect(store.rows.size).toBe(0);
  });
});
