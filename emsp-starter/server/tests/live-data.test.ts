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
  POWER_MAX_AGE_MS,
  SOC_MAX_AGE_MS,
  type LiveDataAdapter,
  type LiveSessionRef,
} from "@/lib/live-data/adapter";
import {
  BLOCKED_MS,
  CACHE_MS,
  ERROR_CACHE_MS,
  ivoraAdapter,
  RATE_LIMIT_MS,
  retryAfterMs,
} from "@/lib/live-data/ivora";
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
import { setPeerNetworkForTests } from "@/lib/server/peer-fetch";
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
    headers?: Record<string, string>;
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
    if (opts.status)
      return Response.json(
        {},
        { status: opts.status, headers: opts.headers ?? {} },
      );
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
          socMeasuredAt: "2026-10-22T08:29:00Z",
          powerKw: 48.123,
          powerMeasuredAt: "2026-10-22T08:29:30Z",
        },
        now,
      ),
    ).toEqual({
      socPercent: 54.3,
      socMeasuredAt: "2026-10-22T08:29:00.000Z",
      powerKw: 48.12,
      powerMeasuredAt: "2026-10-22T08:29:30.000Z",
    });
    const at = "2026-10-22T08:29:00Z";
    expect(
      cleanLive(
        {
          socPercent: 101,
          socMeasuredAt: at,
          powerKw: -1,
          powerMeasuredAt: at,
        },
        now,
      ),
    ).toEqual({});
    expect(
      cleanLive(
        {
          socPercent: NaN,
          socMeasuredAt: at,
          powerKw: "5",
          powerMeasuredAt: at,
        },
        now,
      ),
    ).toEqual({});
    // A time alone is nothing to show.
    expect(cleanLive({ socMeasuredAt: at }, now)).toEqual({});
    expect(cleanLive(null, now)).toEqual({});
  });

  it("drops readings without a time, from the future or too old, each by its own time", () => {
    const now = Date.parse("2026-10-22T08:30:00Z");
    // No time: cannot be checked, so not shown.
    expect(cleanLive({ socPercent: 50, powerKw: 11 }, now)).toEqual({});
    expect(
      cleanLive(
        {
          socPercent: 50,
          socMeasuredAt: "2026-10-22T09:30:00Z",
          powerKw: 11,
          powerMeasuredAt: "nonsense",
        },
        now,
      ),
    ).toEqual({});
    // A charger in SuspendedEV, or offline: the power stops, the SoC ages slower.
    expect(
      cleanLive(
        {
          socPercent: 61,
          socMeasuredAt: "2026-10-22T08:20:00Z",
          powerKw: 48.5,
          powerMeasuredAt: "2026-10-22T08:20:00Z",
        },
        now,
      ),
    ).toEqual({ socPercent: 61, socMeasuredAt: "2026-10-22T08:20:00.000Z" });
    expect(
      cleanLive(
        {
          socPercent: 61,
          socMeasuredAt: new Date(now - SOC_MAX_AGE_MS - 1).toISOString(),
          powerKw: 48.5,
          powerMeasuredAt: new Date(now - POWER_MAX_AGE_MS).toISOString(),
        },
        now,
      ),
    ).toEqual({
      powerKw: 48.5,
      powerMeasuredAt: new Date(now - POWER_MAX_AGE_MS).toISOString(),
    });
    // A fresh SoC does not keep an old power alive.
    expect(
      cleanLive(
        {
          socPercent: 61,
          socMeasuredAt: "2026-10-22T08:29:50Z",
          powerKw: 48.5,
          powerMeasuredAt: "2026-10-22T07:50:00Z",
        },
        now,
      ),
    ).toEqual({ socPercent: 61, socMeasuredAt: "2026-10-22T08:29:50.000Z" });
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
      socMeasuredAt: "2026-10-22T08:29:00Z",
      powerKw: 48.5,
      powerMeasuredAt: "2026-10-22T08:29:00Z",
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
      powerMeasuredAt: "2026-10-22T08:10:00Z",
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
      socMeasuredAt: "2026-10-22T08:19:00Z",
    });
  });

  it("gives each reading its own time, so an old power is not hidden behind a fresh SoC", async () => {
    const now = Date.parse("2026-10-22T08:45:00Z");
    // The car paused at 08:05 (SuspendedEV): the power samples stopped, the SoC did not.
    const mock = ivoraMock({
      meters: [
        record(1, "2026-10-22T08:05:00Z", [soc("40"), power("48500")]),
        record(2, "2026-10-22T08:44:30Z", [soc("41")]),
        // A sample without a time cannot vouch for anything.
        { ...record(3, "", [power("7000")]), timestamp: undefined as never },
      ],
    });
    const raw = await adapter(mock, () => now).getLive(ref());
    expect(raw).toEqual({
      socPercent: 41,
      socMeasuredAt: "2026-10-22T08:44:30Z",
    });

    // And once the charger goes quiet altogether, the app gets nothing at all.
    const quiet = ivoraMock({
      meters: [record(1, "2026-10-22T08:05:00Z", [soc("40"), power("48500")])],
    });
    const old = await adapter(quiet, () => now).getLive(ref());
    expect(old).toMatchObject({ socPercent: 40, powerKw: 48.5 });
    expect(cleanLive(old, now)).toEqual({});
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

  it("reads Retry-After as seconds or a date", () => {
    const now = Date.parse("2026-10-22T08:30:00Z");
    expect(retryAfterMs("120", now)).toBe(120_000);
    expect(retryAfterMs(" 0 ", now)).toBe(0);
    expect(retryAfterMs("Thu, 22 Oct 2026 08:31:00 GMT", now)).toBe(60_000);
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs("soon", now)).toBeUndefined();
  });

  it("backs off a rate-limited API until Retry-After has passed, for every session of the peer", async () => {
    let now = Date.parse("2026-10-22T08:30:00Z");
    const mock = ivoraMock({ status: 429, headers: { "Retry-After": "120" } });
    const a = adapter(mock, () => now);
    const code = (p: Promise<unknown>) => p.catch((e) => e.code);
    expect(await code(a.getLive(ref()))).toBe("ivora_rate_limited");
    expect(mock.calls).toHaveLength(1);
    // Other sessions of the same peer wait too, and nothing is sent.
    now += 60_000;
    expect(await code(a.getLive(ref({ sessionId: "5678" })))).toBe(
      "ivora_rate_limited",
    );
    expect(await code(a.getLive(ref({ sessionId: "9012" })))).toBe(
      "ivora_rate_limited",
    );
    expect(mock.calls).toHaveLength(1);
    // Retry-After has passed: the next poll asks again.
    now += 60_001;
    expect(await code(a.getLive(ref({ sessionId: "3456" })))).toBe(
      "ivora_rate_limited",
    );
    expect(mock.calls).toHaveLength(2);

    // An HTTP-date Retry-After, and a 429 without one: a minute.
    const dated = ivoraMock({
      status: 429,
      headers: { "Retry-After": new Date(now + 300_000).toUTCString() },
    });
    const b = adapter(dated, () => now);
    await code(b.getLive(ref()));
    now += 299_000;
    await code(b.getLive(ref({ sessionId: "5678" })));
    expect(dated.calls).toHaveLength(1);
    const bare = ivoraMock({ status: 429 });
    const c = adapter(bare, () => now);
    await code(c.getLive(ref()));
    now += RATE_LIMIT_MS - 1;
    await code(c.getLive(ref({ sessionId: "5678" })));
    expect(bare.calls).toHaveLength(1);
    now += 1;
    await code(c.getLive(ref({ sessionId: "9012" })));
    expect(bare.calls).toHaveLength(2);
  });

  it("pauses a rejected key for longer, and caches other failures per session briefly", async () => {
    let now = Date.parse("2026-10-22T08:30:00Z");
    const code = (p: Promise<unknown>) => p.catch((e) => e.code);

    const revoked = ivoraMock({ status: 401 });
    const a = adapter(revoked, () => now);
    expect(await code(a.getLive(ref()))).toBe("ivora_unauthorized");
    now += BLOCKED_MS - 1;
    expect(await code(a.getLive(ref({ sessionId: "5678" })))).toBe(
      "ivora_unauthorized",
    );
    expect(revoked.calls).toHaveLength(1);
    now += 1;
    await code(a.getLive(ref({ sessionId: "9012" })));
    expect(revoked.calls).toHaveLength(2);

    let status = 502;
    const flaky = ivoraMock();
    const fetch = flaky.fetch.getMockImplementation()!;
    flaky.fetch.mockImplementation(async (url, init) =>
      status === 502
        ? (flaky.calls.push({ method: "GET", url, auth: null }),
          Response.json({}, { status }))
        : fetch(url, init),
    );
    const b = adapter(flaky, () => now);
    expect(await code(b.getLive(ref()))).toBe("ivora_http_502");
    now += ERROR_CACHE_MS - 1;
    expect(await code(b.getLive(ref()))).toBe("ivora_http_502");
    expect(flaky.calls).toHaveLength(1);
    // Another session is not held back by this one's failure.
    await code(b.getLive(ref({ sessionId: "5678" })));
    expect(flaky.calls).toHaveLength(2);
    status = 200;
    now += 1;
    expect(await b.getLive(ref())).toEqual({});
    expect(flaky.calls.length).toBeGreaterThan(2);
  });

  it("keeps the meter pages it read when a long first read is cut off", async () => {
    const meters = Array.from({ length: 700 }, (_, i) =>
      record(i + 1, "2026-10-22T08:20:00Z", [soc(String(30 + (i % 50)))]),
    );
    const mock = ivoraMock({ meters });
    const fetch = mock.fetch.getMockImplementation()!;
    let hang = true;
    mock.fetch.mockImplementation(async (url, init) => {
      const after = new URL(url).searchParams.get("after");
      if (hang && after === "500") {
        mock.calls.push({ method: "GET", url, auth: null });
        return new Promise<Response>((_, reject) =>
          init.signal!.addEventListener("abort", () =>
            reject(init.signal!.reason),
          ),
        );
      }
      return fetch(url, init);
    });
    let now = Date.parse("2026-10-22T08:30:00Z");
    const a = adapter(mock, () => now);
    const cut = new AbortController();
    const first = a.getLive(ref(), cut.signal).catch((e) => e);
    await vi.waitFor(() => expect(mock.calls).toHaveLength(3));
    cut.abort();
    expect(await first).toMatchObject({ code: "ivora_unreachable" });

    hang = false;
    mock.calls.length = 0;
    now += ERROR_CACHE_MS;
    expect(await a.getLive(ref())).toMatchObject({
      socPercent: 30 + (699 % 50),
    });
    // It went on from where the cut-off read stopped.
    expect(
      mock.calls.map((c) => new URL(c.url).searchParams.get("after")),
    ).toEqual([null, "500"]);
  });

  it("refuses an API URL that resolves to a private address, and logs it as an SSRF refusal", async () => {
    Object.assign(process.env, LIVE_ENV);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async () => Response.json(transaction()));
    for (const address of ["10.1.2.3", "127.0.0.1"]) {
      setPeerNetworkForTests({
        resolve: async () => [{ address, family: 4 }],
        send,
      });
      const a = ivoraAdapter({ baseUrl: BASE, tenantId: TENANT, apiKey: KEY });
      const err = await a.getLive(ref()).catch((e) => e);
      expect(err).toBeInstanceOf(LiveDataError);
      expect(err.code).toBe("ivora_address_refused");
      // Paused: the next poll does not even resolve the host again.
      expect(
        await a.getLive(ref({ sessionId: "5678" })).catch((e) => e.code),
      ).toBe("ivora_address_refused");
    }
    // An IP literal is checked the same way.
    const literal = ivoraAdapter({
      baseUrl: "https://127.0.0.1:8443",
      tenantId: TENANT,
      apiKey: KEY,
    });
    expect(await literal.getLive(ref()).catch((e) => e.code)).toBe(
      "ivora_address_refused",
    );
    expect(send).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("SSRF");
    expect(logged).not.toContain("ivora_unreachable");
    expect(logged).not.toContain(KEY);
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

  const NOW = Date.parse("2026-10-22T08:30:00Z");
  const at = (secondsAgo: number) =>
    new Date(NOW - secondsAgo * 1000).toISOString();
  const now = () => NOW;
  const fixed = (live: unknown): LiveDataAdapter => ({
    kind: "fixed",
    getLive: vi.fn(async () => live as never),
  });

  it("shows what the adapter returns for the driver's running session", async () => {
    const { sessions, active } = await stored();
    const a = fixed({
      socPercent: 64,
      socMeasuredAt: at(30),
      powerKw: 50,
      powerMeasuredAt: at(30),
      extra: "dropped",
    });
    const res = await sessionLive(active, "driver-1", {
      sessions,
      adapterFor: async () => a,
      now,
    });
    expect(res).toEqual({
      sessionId: active,
      status: "ACTIVE",
      kwh: charging.kwh,
      live: {
        socPercent: 64,
        socMeasuredAt: at(30),
        powerKw: 50,
        powerMeasuredAt: at(30),
      },
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

  it("drops stale readings: a suspended or offline charger shows no live power", async () => {
    const { sessions, active } = await stored();
    const stale = fixed({
      socPercent: 64,
      socMeasuredAt: at(10 * 60),
      powerKw: 48.5,
      powerMeasuredAt: at(10 * 60),
    });
    expect(
      await sessionLive(active, "driver-1", {
        sessions,
        adapterFor: async () => stale,
        now,
      }),
    ).toMatchObject({
      live: { socPercent: 64, socMeasuredAt: at(600) },
      source: "fixed",
    });
    const gone = fixed({
      socPercent: 64,
      socMeasuredAt: at(40 * 60),
      powerKw: 48.5,
      powerMeasuredAt: at(40 * 60),
    });
    expect(
      await sessionLive(active, "driver-1", {
        sessions,
        adapterFor: async () => gone,
        now,
      }),
    ).toMatchObject({ live: {}, source: null });
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
