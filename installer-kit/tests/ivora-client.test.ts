import { describe, expect, it, vi } from "vitest";
import { IvoraError } from "@/lib/server/errors";
import { IvoraClient, liveBackend } from "@/lib/server/ivora";
import { liveConfig } from "@/lib/server/config";

type Call = { method: string; url: string; headers: Headers; body: unknown };
type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** A fake Ivora API: answers queued replies and records every request. */
function fakeApi(replies: Reply[] | ((call: Call) => Reply)) {
  const calls: Call[] = [];
  const queue = Array.isArray(replies) ? [...replies] : null;
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = queue ? queue.shift() : (replies as (c: Call) => Reply)(call);
    if (!r) throw new Error(`Unexpected request ${call.method} ${call.url}`);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json", ...r.headers },
    });
  });
  const sleep = vi.fn(async () => {});
  const client = new IvoraClient({
    apiKey: "test-key",
    tenantId: "42",
    origin: "https://api.ivoracharge.com",
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep,
  });
  return { calls, client, sleep, backend: liveBackend(client) };
}

const station = {
  id: 7,
  name: "ik-depot-1",
  online: false,
  protocol: null,
  vendor: null,
  model: null,
  last_seen: null,
  connection_url: "wss://ocpp.ivoracharge.com/ik-depot-1",
  username: "ik-depot-1",
  connectors: [{ id: 701, number: 1 }],
};
const op = (status: string, result: object | null = {}) => ({
  id: "op_1",
  tenant_id: 42,
  status,
  result,
  created_at: "",
  updated_at: "",
});
const apiError = (code: string) => ({
  error: { code, message: `${code} message` },
  request_id: "req_1",
});

describe("live configuration", () => {
  it("defaults to the public API and requires a numeric tenant", () => {
    expect(
      liveConfig({ IVORA_API_KEY: "k", IVORA_TENANT_ID: "42" }).origin,
    ).toBe("https://api.ivoracharge.com");
    expect(() =>
      liveConfig({ IVORA_API_KEY: "k", IVORA_TENANT_ID: "abc" }),
    ).toThrow();
    expect(() =>
      liveConfig({
        IVORA_API_KEY: "k",
        IVORA_TENANT_ID: "1",
        IVORA_API_URL: "http://x",
      }),
    ).toThrow(/https/);
  });
});

describe("Ivora client", () => {
  it("uses tenant paths, bearer auth and no tenant header", async () => {
    const { calls, backend } = fakeApi([{ status: 201, body: station }]);
    const result = await backend.createStation({
      key: "c1:station",
      reference: "installer-kit:charger:c1",
      name: "ik-depot-1",
      locationId: "5",
      connectors: 1,
    });
    expect(result).toEqual({
      stationId: "7",
      connectionUrl: station.connection_url,
      username: "ik-depot-1",
    });
    const [call] = calls;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.ivoracharge.com/v1/tenants/42/stations");
    expect(call.headers.get("authorization")).toBe("Bearer test-key");
    expect(call.headers.get("idempotency-key")).toBe("c1:station");
    expect(call.headers.get("x-tenant-id")).toBeNull();
    expect(call.body).toEqual({
      name: "ik-depot-1",
      location_id: 5,
      connectors: 1,
      external_reference: "installer-kit:charger:c1",
    });
  });

  it("reuses the same idempotency key across 429 and 5xx retries", async () => {
    const { calls, sleep, backend } = fakeApi([
      {
        status: 429,
        body: apiError("rate_limited"),
        headers: { "Retry-After": "3" },
      },
      { status: 503, body: apiError("outcome_unknown") },
      { status: 409, body: apiError("request_in_progress") },
      { status: 201, body: station },
    ]);
    await backend.createStation({
      key: "c1:station",
      reference: "r",
      name: "ik-depot-1",
      locationId: "5",
      connectors: 1,
    });
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => c.headers.get("idempotency-key")))).toEqual(
      new Set(["c1:station"]),
    );
    expect(sleep).toHaveBeenNthCalledWith(1, 3000);
  });

  it("retries a lost response with the same key", async () => {
    let n = 0;
    const { calls, backend } = fakeApi(() => {
      n += 1;
      if (n === 1) throw new TypeError("socket hang up");
      return { status: 202, body: op("succeeded", { applied: "stored" }) };
    });
    await backend.setPassword("7", "A".repeat(24), "c1:credentials:1");
    expect(calls.map((c) => c.headers.get("idempotency-key"))).toEqual([
      "c1:credentials:1",
      "c1:credentials:1",
    ]);
  });

  it("does not retry other client errors and surfaces the API code", async () => {
    const { calls, backend } = fakeApi([
      { status: 409, body: apiError("station_name_taken") },
      { status: 200, body: { data: [] } },
    ]);
    const err = await backend
      .createStation({
        key: "k",
        reference: "r",
        name: "taken",
        locationId: "5",
        connectors: 1,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(IvoraError);
    expect(err).toMatchObject({
      status: 409,
      code: "station_name_taken",
      requestId: "req_1",
    });
    expect(calls).toHaveLength(1);
  });

  it("does not wait out long Retry-After values", async () => {
    const { calls, sleep, backend } = fakeApi([
      {
        status: 429,
        body: apiError("credentials_rate_limited"),
        headers: { "Retry-After": "1800" },
      },
    ]);
    await expect(
      backend.setPassword("7", "A".repeat(24), "k"),
    ).rejects.toMatchObject({
      code: "credentials_rate_limited",
    });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("adopts a station created by an earlier attempt via external_reference", async () => {
    const { calls, backend } = fakeApi([
      { status: 409, body: apiError("external_reference_taken") },
      { status: 200, body: { data: [station] } },
    ]);
    const result = await backend.createStation({
      key: "k",
      reference: "installer-kit:charger:c1",
      name: "ik-depot-1",
      locationId: "5",
      connectors: 1,
    });
    expect(result.stationId).toBe("7");
    expect(calls[1].url).toBe(
      "https://api.ivoracharge.com/v1/tenants/42/stations?external_reference=installer-kit%3Acharger%3Ac1&limit=1",
    );
  });

  it("sets credentials with PUT and waits for a dispatching operation", async () => {
    const { calls, backend } = fakeApi([
      { status: 202, body: op("dispatching", null) },
      { status: 200, body: op("succeeded", { applied: "stored" }) },
    ]);
    await backend.setPassword(
      "7",
      "Secret1234567890abcdEFGH",
      "c1:credentials:1",
    );
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "https://api.ivoracharge.com/v1/tenants/42/stations/7/credentials",
      body: { password: "Secret1234567890abcdEFGH" },
    });
    expect(calls[1]).toMatchObject({
      method: "GET",
      url: "https://api.ivoracharge.com/v1/tenants/42/operations/op_1",
    });
  });

  it("turns a rejected operation into its error code", async () => {
    const { backend } = fakeApi([
      {
        status: 202,
        body: op("rejected", {
          error: { code: "station_online", message: "m" },
        }),
      },
    ]);
    await expect(
      backend.setPassword("7", "A".repeat(24), "k"),
    ).rejects.toMatchObject({
      code: "station_online",
    });
  });

  it("reports an unconfirmed password instead of retrying it", async () => {
    const { calls, backend } = fakeApi([
      { status: 502, body: apiError("password_unconfirmed") },
    ]);
    await expect(
      backend.setPassword("7", "A".repeat(24), "k"),
    ).rejects.toMatchObject({
      code: "password_unconfirmed",
    });
    expect(calls).toHaveLength(1);
  });

  it("maps the station record to connection state and connectors", async () => {
    const { backend } = fakeApi([
      {
        status: 200,
        body: {
          ...station,
          online: true,
          protocol: "ocpp1.6",
          vendor: "Acme",
          model: "AC-7",
        },
      },
    ]);
    expect(await backend.getStation("7")).toEqual({
      state: "booted",
      boot: { vendor: "Acme", model: "AC-7", firmware: null },
      connectors: [{ resourceId: "701", number: 1 }],
    });
  });

  it("starts and stops with station commands", async () => {
    const { calls, backend } = fakeApi([
      { status: 202, body: op("succeeded", { charger_status: "Accepted" }) },
      { status: 202, body: op("succeeded", { charger_status: "Accepted" }) },
    ]);
    await backend.startCharging("7", "701", "c1:test:1:start");
    await backend.stopCharging("7", "9001", "c1:test:1:stop");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.ivoracharge.com/v1/tenants/42/stations/7/commands",
      body: {
        action: "start",
        connector_id: 701,
        token: "INSTALLER-TEST",
        token_type: "Central",
      },
    });
    expect(calls[0].headers.get("idempotency-key")).toBe("c1:test:1:start");
    expect(calls[1].body).toEqual({ action: "stop", transaction_id: 9001 });
    expect(calls[1].headers.get("idempotency-key")).toBe("c1:test:1:stop");
  });

  it("reports a start the charger did not accept", async () => {
    const { backend } = fakeApi([
      { status: 202, body: op("succeeded", { charger_status: "Rejected" }) },
    ]);
    await expect(backend.startCharging("7", "701", "k")).rejects.toMatchObject({
      code: "start_not_accepted",
    });
  });

  it("reads transactions with energy in Wh", async () => {
    const tx = {
      id: 9001,
      connector_id: 701,
      active: false,
      started_at: "2026-10-19T12:00:00Z",
      ended_at: "2026-10-19T12:01:00Z",
      energy_kwh: "0.425",
    };
    const { calls, backend } = fakeApi([
      { status: 200, body: { data: [{ ...tx, connector_id: 999 }, tx] } },
      { status: 200, body: tx },
    ]);
    const found = await backend.findTransaction(
      "7",
      "701",
      "2026-10-19T12:00:10Z",
    );
    expect(found).toMatchObject({
      transactionId: "9001",
      energyWh: 425,
      active: false,
    });
    expect(calls[0].url).toContain("/v1/tenants/42/transactions?station_id=7");
    expect((await backend.getTransaction("9001")).energyWh).toBe(425);
  });

  it("refreshes, then reads configuration back", async () => {
    const { calls, backend } = fakeApi((call) => {
      if (call.url.endsWith("/configuration/refresh"))
        return {
          status: 202,
          body: op("succeeded", { charger_status: "Accepted" }),
        };
      const key = new URL(call.url).searchParams.get("key");
      return {
        status: 200,
        body: {
          station_id: 7,
          data: [{ key, value: key === "HeartbeatInterval" ? "300" : "60" }],
          next_cursor: 0,
        },
      };
    });
    const values = await backend.readConfiguration(
      "7",
      ["HeartbeatInterval", "MeterValueSampleInterval"],
      "c1:config-read:1",
    );
    expect(values).toEqual({
      HeartbeatInterval: "300",
      MeterValueSampleInterval: "60",
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.ivoracharge.com/v1/tenants/42/stations/7/configuration/refresh",
    });
    expect(calls[0].headers.get("idempotency-key")).toBe("c1:config-read:1");
    expect(calls[1].url).toBe(
      "https://api.ivoracharge.com/v1/tenants/42/stations/7/configuration?key=HeartbeatInterval",
    );
  });

  it("changes one standard key and returns the charger's answer", async () => {
    const { calls, backend } = fakeApi([
      { status: 202, body: op("succeeded", { charger_status: "Accepted" }) },
    ]);
    expect(
      await backend.changeConfiguration(
        "7",
        "HeartbeatInterval",
        "120",
        "c1:config-change:1",
      ),
    ).toBe("Accepted");
    expect(calls[0].body).toEqual({ key: "HeartbeatInterval", value: "120" });
  });

  it("refuses writes without an idempotency key", async () => {
    const { client } = fakeApi([]);
    await expect(
      client.request(
        "POST",
        "locations",
        { parse: (x: unknown) => x } as never,
        { body: {} },
      ),
    ).rejects.toThrow(/idempotency/);
  });
});
