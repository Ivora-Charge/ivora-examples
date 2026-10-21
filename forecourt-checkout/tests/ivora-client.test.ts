import { describe, expect, it, vi } from "vitest";
import { IVORA_VERSION, IvoraClient, IvoraError } from "@/lib/server/ivora";

type Call = { url: string; init: RequestInit };

function client(responses: Response[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
  const c = new IvoraClient({
    apiUrl: "https://api.example.test",
    apiKey: "iv_test_key",
    tenantId: "42",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { c, calls };
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const operation = {
  id: "op_1",
  status: "dispatching",
  result: null,
  created_at: "2026-10-19T12:00:00Z",
};
const header = (call: Call, name: string) =>
  new Headers(call.init.headers).get(name);

describe("Ivora client", () => {
  it("scopes requests to the tenant and pins the API version", async () => {
    const { c, calls } = client([json({ data: [] })]);
    expect(await c.findStationByCode("PUMP 3")).toBeNull();
    expect(calls[0].url).toBe(
      "https://api.example.test/v1/tenants/42/stations?external_reference=PUMP%203&limit=1",
    );
    expect(header(calls[0], "authorization")).toBe("Bearer iv_test_key");
    expect(header(calls[0], "ivora-version")).toBe(IVORA_VERSION);
    expect(header(calls[0], "idempotency-key")).toBeNull();
  });

  it("sends the caller's idempotency key on writes", async () => {
    const { c, calls } = client([json(operation)]);
    await c.startSession("ecs_1", "forecourt:cs_test_1:start");
    expect(calls[0].url).toBe(
      "https://api.example.test/v1/tenants/42/charging-sessions/ecs_1/start",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(header(calls[0], "idempotency-key")).toBe(
      "forecourt:cs_test_1:start",
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      funding_confirmed: true,
    });
  });

  it("refuses a write without a key, but quotes (read-only) need none", async () => {
    const { c } = client([]);
    await expect(
      c.request(
        "POST",
        "charging-sessions/ecs_1/stop",
        (await import("zod")).z.unknown(),
      ),
    ).rejects.toThrow(/idempotency/);
    const quote = {
      currency: "USD",
      pricing_version: "energy-v1",
      lines: [],
      subtotal_minor: 0,
      exact_subtotal_minor: "0",
      adjustments: [],
      total_minor: 0,
    };
    const q = client([json(quote)]);
    await q.c.quote(9, {
      start_at: "2026-10-19T12:00:00Z",
      duration_minutes: 25,
      energy_kwh: 30,
    });
    expect(header(q.calls[0], "idempotency-key")).toBeNull();
  });

  it("waits out a short Retry-After once, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { c, calls } = client([
        json({}, 429, { "retry-after": "1" }),
        json({ data: [] }),
      ]);
      const pending = c.listStations();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual([]);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces long rate limits instead of blocking the request", async () => {
    const { c, calls } = client([
      json(
        {
          error: { code: "rate_limited", message: "Slow down" },
          request_id: "req_1",
        },
        429,
        { "retry-after": "30" },
      ),
    ]);
    await expect(c.listStations()).rejects.toMatchObject({
      code: "rate_limited",
      requestId: "req_1",
    });
    expect(calls).toHaveLength(1);
  });

  it("keeps the API's error code and request ID", async () => {
    const { c } = client([
      json(
        {
          error: { code: "station_offline", message: "Station is offline." },
          request_id: "req_9",
        },
        409,
      ),
    ]);
    const error = await c.stopSession("ecs_1", "k").catch((e) => e);
    expect(error).toBeInstanceOf(IvoraError);
    expect(error).toMatchObject({
      status: 409,
      code: "station_offline",
      requestId: "req_9",
    });
  });

  it("refuses insecure URLs and malformed tenants", () => {
    expect(
      () =>
        new IvoraClient({
          apiUrl: "http://api.example.test",
          apiKey: "k",
          tenantId: "1",
        }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new IvoraClient({
          apiUrl: "https://api.example.test",
          apiKey: "k",
          tenantId: "1/../2",
        }),
    ).toThrow();
  });

  it("pages through every session, since cursors aren't time-ordered", async () => {
    const session = (id: string) => ({
      id,
      application_reference: `forecourt:${id}`,
      payment_reference: id,
      created_at: "2026-10-19T12:00:00Z",
      status: "charging",
      bill: {
        id: `bill_${id}`,
        station_id: 7,
        connector_id: 71,
        status: "open",
        hold_minor: 0,
        currency: "USD",
        total_minor: null,
        transaction_id: null,
      },
      usage: null,
      start_operation: null,
      stop_operation: null,
    });
    const { c, calls } = client([
      json({ data: [session("ecs_b")], next_cursor: "ecs_b" }),
      json({ data: [session("ecs_a")], next_cursor: null }),
    ]);
    const all = await c.listAllSessions();
    expect(all.map((s) => s.id)).toEqual(["ecs_b", "ecs_a"]);
    expect(calls.map((x) => new URL(x.url).search)).toEqual([
      "?limit=100",
      "?limit=100&after=ecs_b",
    ]);
  });
});
