import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeError,
  getIvora,
  idempotencyKey,
  IvoraError,
  resetIvoraForTests,
} from "@/lib/server/ivora";
import {
  createLiveClient,
  MAX_LIST_PAGES,
  MAX_REQUEST_SECONDS,
  parseRetryAfter,
} from "@/lib/server/ivora/live";

// The Ivora API is replaced by a fake fetch: no network, no real credentials.
const API_KEY = "test-key-not-real";
const BASE = "https://api.example.test";

type Call = { url: string; init: RequestInit };

function fakeApi(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next();
    },
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const err =
  (status: number, code: string, headers: HeadersInit = {}) =>
  () =>
    Response.json(
      { error: { code, message: `${code} message` }, request_id: "req_1" },
      { status, headers },
    );
const ok =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });

const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

const LOCATION = { name: "Site", external_reference: "cpo-site-1" };
const KEY = "cpo-location-1-create";

/** A fake clock: sleeping moves it on, and so does each request (`tryMs`). */
function client(responses: (() => Response)[], tryMs = 0) {
  let t = 0;
  const api = fakeApi(
    responses.map((r) => () => {
      t += tryMs;
      return r();
    }),
  );
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  const ivora = createLiveClient({
    baseUrl: `${BASE}/`,
    apiKey: API_KEY,
    tenantId: "42",
    fetch: api.fetch,
    sleep,
    now: () => t,
  });
  return { ivora, sleep, elapsedMs: () => t, ...api };
}

describe("live Ivora client", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    // Live mode: credentials set, demo not forced.
    process.env.IVORA_API_KEY = API_KEY;
    process.env.IVORA_TENANT_ID = "42";
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    delete process.env.DEMO_MODE;
    resetIvoraForTests();
    vi.stubGlobal("fetch", () => {
      throw new Error("tests must not reach the network");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("reads under the tenant path with the bearer key and no idempotency key", async () => {
    const { ivora, calls } = client([ok({ data: [{ id: 1, name: "A" }] })]);
    expect(await ivora.listStations({ limit: 10 })).toEqual([
      { id: 1, name: "A" },
    ]);
    expect(calls[0].url).toBe(`${BASE}/v1/tenants/42/stations?limit=10`);
    expect(calls[0].init.method).toBe("GET");
    expect(header(calls[0], "authorization")).toBe(`Bearer ${API_KEY}`);
    expect(header(calls[0], "idempotency-key")).toBeNull();
  });

  it("sends the Idempotency-Key on writes and refuses a write without one", async () => {
    const { ivora, calls } = client([ok({ id: 7, ...LOCATION }, 201)]);
    expect((await ivora.createLocation(LOCATION, KEY)).id).toBe(7);
    expect(header(calls[0], "idempotency-key")).toBe(KEY);
    expect(JSON.parse(String(calls[0].init.body))).toEqual(LOCATION);
    await expect(ivora.createLocation(LOCATION, "")).rejects.toThrow(
      /Idempotency-Key/,
    );
    expect(calls).toHaveLength(1);
  });

  it.each([
    [409, "request_in_progress"],
    [503, "outcome_unknown"],
  ])("retries %i %s with the same key and body", async (status, code) => {
    const { ivora, calls, sleep } = client([
      err(status, code),
      err(status, code),
      ok({ id: 7, ...LOCATION }, 201),
    ]);
    expect((await ivora.createLocation(LOCATION, KEY)).id).toBe(7);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => header(c, "idempotency-key"))).toEqual([
      KEY,
      KEY,
      KEY,
    ]);
    expect(new Set(calls.map((c) => c.init.body)).size).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("waits for Retry-After on 429, then retries", async () => {
    const { ivora, calls, sleep } = client([
      err(429, "rate_limited", { "retry-after": "7" }),
      ok({ data: [] }),
    ]);
    expect(await ivora.listLocations()).toEqual([]);
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(calls).toHaveLength(2);
  });

  it("returns a long Retry-After to the caller instead of waiting", async () => {
    const { ivora, calls, sleep } = client([
      err(429, "rate_limited", { "retry-after": "3600" }),
    ]);
    await expect(ivora.listLocations()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 3600,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("caps the total wait per request and returns the rest to the caller", async () => {
    expect(MAX_REQUEST_SECONDS).toBeLessThanOrEqual(20);
    const { ivora, calls, sleep } = client([
      err(429, "rate_limited", { "retry-after": "15" }),
      err(429, "rate_limited", { "retry-after": "15" }),
      ok({ data: [] }),
    ]);
    // 15 s fits the budget; another 15 s would not, so the second 429 comes back.
    await expect(ivora.listStations()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 15,
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it("counts slow tries against the same total, not only the waits", async () => {
    // Each try takes 9 s and fails with a gateway error; backoff is 1 s, then 2 s.
    const { ivora, calls, elapsedMs } = client(
      Array.from({ length: 4 }, () => err(503, "http_503")),
      9_000,
    );
    await expect(ivora.listStations()).rejects.toMatchObject({ status: 503 });
    // 9 + 1 + 9 = 19 s; a 2 s wait and another try would pass 20 s, so it stops.
    expect(calls).toHaveLength(2);
    expect(elapsedMs()).toBeLessThanOrEqual(MAX_REQUEST_SECONDS * 1000);
  });

  it("limits each try's own timeout to the time left", async () => {
    const { ivora, calls } = client([
      err(429, "rate_limited", { "retry-after": "15" }),
      ok({ data: [] }),
    ]);
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    try {
      await ivora.listStations();
    } finally {
      spy.mockRestore();
    }
    expect(calls).toHaveLength(2);
    expect(timeouts).toEqual([10_000, 5_000]);
  });

  it("returns the pages read so far when a long list runs out of time", async () => {
    const { ivora, calls } = client(
      Array.from({ length: MAX_LIST_PAGES }, (_, i) =>
        ok({ data: [{ id: i + 1 }], next_cursor: i + 1 }),
      ),
      9_600,
    );
    const r = await ivora.listAllStations();
    // Two pages take 19.2 s; under a second is left, too little for a third.
    expect(r).toMatchObject({ truncated: true });
    expect(calls).toHaveLength(2);
  });

  it("follows next_cursor across pages", async () => {
    const { ivora, calls } = client([
      ok({ data: [{ id: 1 }, { id: 2 }], next_cursor: 2 }),
      ok({ data: [{ id: 3 }], next_cursor: 3 }),
      ok({ data: [], next_cursor: 0 }),
    ]);
    const r = await ivora.listAllStations();
    expect(r.data.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(r.truncated).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/tenants/42/stations?limit=100`,
      `${BASE}/v1/tenants/42/stations?limit=100&after=2`,
      `${BASE}/v1/tenants/42/stations?limit=100&after=3`,
    ]);
  });

  it("stops on a cursor that does not move and says when it hit the page ceiling", async () => {
    const stuck = client([
      ok({ data: [{ id: 1 }], next_cursor: 5 }),
      ok({ data: [{ id: 2 }], next_cursor: 5 }),
    ]);
    expect((await stuck.ivora.listAllLocations()).data).toHaveLength(2);
    expect(stuck.calls).toHaveLength(2);

    const many = client(
      Array.from({ length: MAX_LIST_PAGES }, (_, i) =>
        ok({ data: [{ id: i + 1 }], next_cursor: i + 1 }),
      ),
    );
    const r = await many.ivora.listAllLocations();
    expect(r).toMatchObject({ truncated: true });
    expect(r.data).toHaveLength(MAX_LIST_PAGES);
  });

  it.each([
    [400, "validation_error"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "station_not_found"],
    [409, "conflict"],
  ])("does not retry %i %s", async (status, code) => {
    const { ivora, calls } = client([err(status, code)]);
    await expect(ivora.getStation(5)).rejects.toMatchObject({ status, code });
    expect(calls).toHaveLength(1);
  });

  it("gives up after the attempt limit, keeping the API's error", async () => {
    const { ivora, calls } = client(
      Array.from({ length: 4 }, () => err(503, "outcome_unknown")),
    );
    await expect(ivora.listStations()).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(calls).toHaveLength(4);
  });

  it("adopts the existing location by external_reference after an uncertain create", async () => {
    const { ivora, calls } = client([
      err(409, "external_reference_taken"),
      ok({ data: [{ id: 9, ...LOCATION }] }),
    ]);
    expect((await ivora.createLocation(LOCATION, KEY)).id).toBe(9);
    expect(calls[1].url).toBe(
      `${BASE}/v1/tenants/42/locations?limit=1&external_reference=cpo-site-1`,
    );
  });

  it("retries a lost connection with the same key", async () => {
    let n = 0;
    const fetch = vi.fn(
      async (_u: string | URL | Request, init?: RequestInit) => {
        if (n++ === 0) throw new TypeError("socket hang up");
        expect(new Headers(init?.headers).get("idempotency-key")).toBe(KEY);
        return Response.json({ id: 7, ...LOCATION }, { status: 201 });
      },
    );
    const ivora = createLiveClient({
      baseUrl: BASE,
      apiKey: API_KEY,
      tenantId: "42",
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    expect((await ivora.createLocation(LOCATION, KEY)).id).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("validates its configuration", () => {
    const o = { baseUrl: BASE, apiKey: API_KEY, tenantId: "42" };
    expect(() => createLiveClient({ ...o, tenantId: "abc" })).toThrow(
      /numeric/,
    );
    expect(() => createLiveClient({ ...o, apiKey: "" })).toThrow(/API_KEY/);
    expect(() =>
      createLiveClient({ ...o, baseUrl: "http://api.example.test" }),
    ).toThrow(/https/);
  });

  it("getIvora returns the live client when credentials are set", () => {
    expect(getIvora().mode).toBe("live");
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseRetryAfter("12", now)).toBe(12);
    expect(parseRetryAfter(new Date(now + 5_000).toUTCString(), now)).toBe(5);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
  });

  it("describes errors with code, request ID and the errors page, never the key", () => {
    const msg = describeError(
      new IvoraError(401, "unauthorized", "Invalid key", "req_9"),
    );
    expect(msg).toContain("unauthorized");
    expect(msg).toContain("req_9");
    expect(msg).toContain("Check the API key");
    expect(msg).toContain(
      "https://ivoracharge.com/developers/guides/reference/errors",
    );
    expect(msg).not.toContain(API_KEY);
  });

  it("derives idempotency keys from record and action", () => {
    expect(idempotencyKey("location", 12, "create")).toBe(
      "cpo-location-12-create",
    );
    expect(() => idempotencyKey("location", "a b", "create")).toThrow();
  });
});
