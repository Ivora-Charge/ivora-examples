import { beforeEach, describe, expect, it } from "vitest";
import {
  createIvora,
  describeError,
  ERRORS_URL,
  IvoraError,
} from "@/lib/ivora";
import { config } from "@/lib/config";
import { fakeFetch, liveEnv } from "./support/fake-api";

const sleeps: number[] = [];
const client = (f: typeof fetch) =>
  createIvora({
    baseUrl: config.apiBase,
    apiKey: config.apiKey,
    tenantId: config.tenantId,
    fetch: f,
    sleep: async (ms) => void sleeps.push(ms),
  });

beforeEach(() => {
  liveEnv();
  sleeps.length = 0;
});

describe("config", () => {
  it("treats empty variables as unset and defaults to the public API host", () => {
    expect(config.apiBase).toBe("https://api.ivoracharge.com");
    process.env.IVORA_API_BASE_URL = "https://sandbox.example.com/";
    expect(config.apiBase).toBe("https://sandbox.example.com");
  });
});

describe("Ivora client", () => {
  it("uses tenant paths, a bearer key, no tenant header, and an Idempotency-Key on writes", async () => {
    const f = fakeFetch(() => ({
      status: 201,
      json: { id: 5, id_token: "AB12CD34", status: "Accepted" },
    }));
    const t = await client(f.fetch).createToken(
      { id_token: "AB12CD34", external_reference: "fd-driver-1" },
      "fd-token-create-1",
    );
    expect(t.id).toBe(5);
    const c = f.calls[0];
    expect(c.method).toBe("POST");
    expect(c.url).toBe("https://api.ivoracharge.com/v1/tenants/7/tokens");
    expect(c.headers.authorization).toBe("Bearer iv_test_not_a_real_key");
    expect(c.headers["idempotency-key"]).toBe("fd-token-create-1");
    expect(Object.keys(c.headers).some((h) => h.includes("tenant"))).toBe(
      false,
    );
    expect(JSON.parse(c.body!)).toEqual({
      type: "ISO14443",
      status: "Accepted",
      id_token: "AB12CD34",
      external_reference: "fd-driver-1",
    });
  });

  it("calls the documented smart charging, token and transaction paths", async () => {
    const f = fakeFetch(() => ({
      json: { id: "op_1", status: "succeeded", result: {} },
    }));
    const api = client(f.fetch);
    await api.updateToken(5, { status: "Blocked" }, "fd-token-block-5");
    await api.importTokens("id_token\nAB12", "fd-import-abcdef12");
    await api.setChargingProfile(
      12,
      { purpose: "session", unit: "W", periods: [] },
      "fd-profile-x-1",
    );
    await api.compositeSchedule(
      12,
      { duration_seconds: 3600 },
      "fd-composite-x-1",
    );
    await api.getTransaction(31);
    expect(
      f.calls.map((c) => `${c.method} ${c.url.replace(config.apiBase, "")}`),
    ).toEqual([
      "PATCH /v1/tenants/7/tokens/5",
      "POST /v1/tenants/7/tokens/import",
      "POST /v1/tenants/7/stations/12/charging-profiles",
      "POST /v1/tenants/7/stations/12/composite-schedule",
      "GET /v1/tenants/7/transactions/31",
    ]);
    expect(f.calls[1].headers["content-type"]).toBe("text/csv");
    expect(f.calls[4].headers["idempotency-key"]).toBeUndefined();
  });

  it("refuses a write without an idempotency key", async () => {
    const f = fakeFetch(() => ({ json: {} }));
    await expect(
      client(f.fetch).updateToken(5, { status: "Blocked" }, ""),
    ).rejects.toThrow(/Idempotency-Key/);
    expect(f.calls).toHaveLength(0);
  });

  it("retries 429 after Retry-After and 409 request_in_progress with the same key", async () => {
    let n = 0;
    const f = fakeFetch(() => {
      n++;
      if (n === 1)
        return {
          status: 429,
          json: {
            error: { code: "rate_limited", message: "slow down" },
            request_id: "r1",
          },
          headers: { "retry-after": "3" },
        };
      if (n === 2)
        return {
          status: 409,
          json: {
            error: { code: "request_in_progress", message: "busy" },
            request_id: "r2",
          },
        };
      return { json: { id: "op_1", status: "succeeded", result: {} } };
    });
    await client(f.fetch).setChargingProfile(
      12,
      { purpose: "session", unit: "W", periods: [] },
      "fd-profile-s-1",
    );
    expect(f.calls).toHaveLength(3);
    expect(new Set(f.calls.map((c) => c.headers["idempotency-key"]))).toEqual(
      new Set(["fd-profile-s-1"]),
    );
    expect(new Set(f.calls.map((c) => c.body)).size).toBe(1);
    expect(sleeps[0]).toBe(3000);
  });

  it("does not retry other 4xx and reports the code with the errors page", async () => {
    const f = fakeFetch(() => ({
      status: 422,
      json: {
        error: {
          code: "charging_profile_unsupported",
          message: "unit",
          details: { field: "unit" },
        },
        request_id: "req_9",
      },
    }));
    const err = await client(f.fetch)
      .setChargingProfile(
        12,
        { purpose: "session", unit: "W", periods: [] },
        "fd-profile-s-2",
      )
      .catch((e) => e);
    expect(f.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(IvoraError);
    expect(err.code).toBe("charging_profile_unsupported");
    const msg = describeError(err);
    expect(msg).toContain("charging_profile_unsupported");
    expect(msg).toContain("req_9");
    expect(msg).toContain(ERRORS_URL);
    expect(msg).not.toContain("iv_test_not_a_real_key");
    expect(ERRORS_URL).toBe(
      "https://ivoracharge.com/developers/guides/reference/errors",
    );
  });

  it("does not retry an import after 503 outcome_unknown (the guide asks for a new key)", async () => {
    const f = fakeFetch(() => ({
      status: 503,
      json: {
        error: { code: "outcome_unknown", message: "?" },
        request_id: "r",
      },
    }));
    await expect(
      client(f.fetch).importTokens("id_token\nAB12", "fd-import-0123456789"),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });

  it("never calls the API in demo mode", async () => {
    process.env.DEMO_MODE = "true";
    const f = fakeFetch(() => ({ json: {} }));
    await expect(client(f.fetch).getTransaction(1)).rejects.toThrow(
      /Demo mode/,
    );
    expect(f.calls).toHaveLength(0);
  });
});
