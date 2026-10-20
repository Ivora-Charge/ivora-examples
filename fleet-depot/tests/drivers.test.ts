import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/store";
import type { Depot } from "@/lib/depot";
import {
  blockDriver,
  cardRef,
  createDriver,
  importDrivers,
} from "@/lib/drivers";
import { createIvora } from "@/lib/ivora";
import { fakeFetch, liveEnv, type Call } from "./support/fake-api";

const depot = (): Depot => ({
  demo: false,
  store: new MemoryStore(),
  settings: { siteCapKw: 60, centsPerKwh: 28, currency: "EUR" },
  clock: null,
});
const client = (handler: (c: Call) => { status?: number; json?: unknown }) => {
  const f = fakeFetch(handler);
  return {
    calls: f.calls,
    api: createIvora({
      baseUrl: "https://api.ivoracharge.com",
      apiKey: "iv_test_not_a_real_key",
      tenantId: "7",
      fetch: f.fetch,
      sleep: async () => {},
    }),
  };
};

beforeEach(liveEnv);

describe("RFID cards through the tokens API", () => {
  it("registers a card with our external_reference and a key derived from the driver", async () => {
    const d = depot();
    const { api, calls } = client(() => ({
      status: 201,
      json: { id: 41, id_token: "AB12CD34", status: "Accepted" },
    }));
    const drv = await createDriver(
      d,
      { name: "Test Driver", idTag: "AB12CD34" },
      api,
    );
    expect(drv.tokenId).toBe(41);
    expect(JSON.parse(calls[0].body!).external_reference).toBe(cardRef(drv.id));
    expect(calls[0].headers["idempotency-key"]).toBe(
      `fd-token-create-${drv.id}`,
    );
  });

  it("adopts an existing token on 409 token_exists", async () => {
    const d = depot();
    const { api } = client(() => ({
      status: 409,
      json: {
        error: {
          code: "token_exists",
          message: "exists",
          details: { token_id: 77 },
        },
        request_id: "r",
      },
    }));
    expect(
      (await createDriver(d, { name: "A", idTag: "AB12CD35" }, api)).tokenId,
    ).toBe(77);
  });

  it("imports as CSV, maps token IDs back, and reports the API's row errors", async () => {
    const d = depot();
    const { api, calls } = client(() => ({
      json: {
        dry_run: false,
        counts: { create: 1, error: 1 },
        rows: [
          { row: 1, id_token: "CARD0001", action: "create", token_id: 501 },
          {
            row: 2,
            id_token: "CARD0002",
            action: "error",
            code: "token_reserved",
            message: "reserved",
          },
        ],
      },
    }));
    const out = await importDrivers(
      d,
      "idTag,driverName,email\nCARD0001,One,one@example.com\nCARD0002,Two\n,Missing",
      api,
    );
    expect(out.imported).toBe(1);
    expect(out.errors).toEqual([
      { line: 4, message: 'invalid idTag ""' },
      { row: 2, code: "token_reserved", message: "CARD0002: reserved" },
    ]);
    const c = calls[0];
    expect(c.url).toBe(
      "https://api.ivoracharge.com/v1/tenants/7/tokens/import",
    );
    expect(c.headers["content-type"]).toBe("text/csv");
    const lines = c.body!.split("\n");
    expect(lines[0]).toBe("id_token,external_reference");
    expect(lines).toHaveLength(3);
    // Names and emails stay in this app.
    expect(c.body).not.toContain("one@example.com");
    expect(c.body).not.toContain("One");
    const drivers = await d.store.list("drivers");
    expect(drivers.find((x) => x.idTag === "CARD0001")?.tokenId).toBe(501);
    expect(drivers.find((x) => x.idTag === "CARD0002")?.cardError).toBe(
      "token_reserved",
    );

    // The same file again: same key, and no duplicate drivers.
    await importDrivers(
      d,
      "idTag,driverName,email\nCARD0001,One,one@example.com\nCARD0002,Two",
      api,
    );
    expect(calls[1].headers["idempotency-key"]).toBe(
      calls[0].headers["idempotency-key"],
    );
    expect(await d.store.list("drivers")).toHaveLength(2);
  });

  it("blocks by token ID, looking it up by our reference when unknown", async () => {
    const d = depot();
    await d.store.put("drivers", "x1", {
      id: "x1",
      name: "Leaver",
      idTag: "CARD0009",
      cardBlocked: false,
    });
    const { api, calls } = client((c) =>
      c.method === "GET"
        ? {
            json: {
              data: [{ id: 909, id_token: "CARD0009", status: "Accepted" }],
              next_cursor: 909,
            },
          }
        : { json: { id: 909, id_token: "CARD0009", status: "Blocked" } },
    );
    const drv = await blockDriver(d, "x1", api);
    expect(drv.cardBlocked).toBe(true);
    expect(calls[0].url).toContain(
      `/tokens?external_reference=${encodeURIComponent(cardRef("x1"))}`,
    );
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].url).toBe(
      "https://api.ivoracharge.com/v1/tenants/7/tokens/909",
    );
    expect(JSON.parse(calls[1].body!)).toEqual({ status: "Blocked" });
    expect(calls[1].headers["idempotency-key"]).toMatch(
      /^fd-token-block-909-[0-9a-f]{8}$/,
    );
  });

  it("uses one key per block action: a retry reuses it, a later block gets a new one", async () => {
    const d = depot();
    await d.store.put("drivers", "x2", {
      id: "x2",
      name: "Leaver",
      idTag: "CARD0010",
      tokenId: 910,
      cardBlocked: false,
    });
    let down = true;
    const { api, calls } = client(() =>
      down
        ? { status: 503, json: { error: { code: "http_503", message: "" } } }
        : { json: { id: 910, id_token: "CARD0010", status: "Blocked" } },
    );
    await expect(blockDriver(d, "x2", api)).rejects.toThrow();
    const failedKey = calls.at(-1)!.headers["idempotency-key"];
    down = false;
    await blockDriver(d, "x2", api);
    expect(calls.at(-1)!.headers["idempotency-key"]).toBe(failedKey);
    // Unblocked elsewhere (token.updated), then blocked again: a new request.
    const drv = (await d.store.list("drivers"))[0];
    await d.store.put("drivers", "x2", { ...drv, cardBlocked: false });
    await blockDriver(d, "x2", api);
    expect(calls.at(-1)!.headers["idempotency-key"]).not.toBe(failedKey);
  });

  it("re-runs an import with a new key after 503 outcome_unknown", async () => {
    const d = depot();
    let unknown = true;
    const { api, calls } = client(() =>
      unknown
        ? {
            status: 503,
            json: { error: { code: "outcome_unknown", message: "?" } },
          }
        : {
            json: {
              dry_run: false,
              counts: { create: 1 },
              rows: [{ row: 1, id_token: "CARD0001", action: "create" }],
            },
          },
    );
    const csv = "idTag,driverName\nCARD0001,One";
    await expect(importDrivers(d, csv, api)).rejects.toThrow();
    // Not retried with the same key inside the call.
    expect(calls).toHaveLength(1);
    unknown = false;
    await importDrivers(d, csv, api);
    const [first, second] = calls.map((c) => c.headers["idempotency-key"]);
    expect(first).toMatch(/^fd-import-[0-9a-f]{40}-1$/);
    expect(second).toBe(first.replace(/-1$/, "-2"));
    // A plain retry of the same file after success keeps the key.
    await importDrivers(d, csv, api);
    expect(calls[2].headers["idempotency-key"]).toBe(second);
  });
});
