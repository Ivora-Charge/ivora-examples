import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIvoraForTests } from "@/lib/server/ivora";
import { createLiveClient } from "@/lib/server/ivora/live";
import type { Bill, SessionListItem } from "@/lib/server/ivora/types";
import {
  cleanCursor,
  IVORA_PAGE_ROWS,
  loadIvoraBills,
  loadIvoraSessions,
  parseReportQuery,
  stationContext,
} from "@/lib/server/reports";

// The filtered session and bill lists (Ivora IVP-436 / IVP-437) against API-shaped
// fakes: no network, no credentials.

const BASE = "https://api.example.test";

const saved = { ...process.env };
beforeEach(() => {
  // Live mode: credentials set, demo not forced.
  process.env.IVORA_API_KEY = "test-key-not-real";
  process.env.IVORA_TENANT_ID = "42";
  process.env.SUPABASE_URL = "https://supabase.example.test";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  delete process.env.DEMO_MODE;
  resetIvoraForTests();
});
afterEach(() => {
  process.env = { ...saved };
});

const item = (
  id: number,
  o: Partial<SessionListItem> = {},
): SessionListItem => ({
  id,
  station_id: 70,
  connector_id: 701,
  connector_number: 1,
  active: false,
  id_token: "****ABCD",
  started_at: "2026-10-20T10:00:00Z",
  ended_at: "2026-10-20T11:00:00Z",
  energy_wh: 12_000,
  station_name: "DEPOT-01",
  stop_reason: "EVDisconnected",
  bill_id: null,
  ...o,
});

function client(respond: (url: URL) => unknown) {
  const urls: URL[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    return Response.json(respond(url));
  });
  const ivora = createLiveClient({
    baseUrl: BASE,
    apiKey: "test-key-not-real",
    tenantId: "42",
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  });
  return { ivora, urls };
}

describe("live client: the filtered session list", () => {
  it("sends the filters, newest first, and returns the opaque cursor while pages are full", async () => {
    const c = client(() => ({
      data: [item(3), item(2)],
      next_cursor: null,
      next_page_cursor: "opaque-2",
    }));
    const page = await c.ivora.listSessions({
      active: true,
      started_from: "2026-10-01T00:00:00.000Z",
      started_to: "2026-11-01T00:00:00.000Z",
      station_id: 70,
      cursor: "opaque-1",
      limit: 2,
    });
    const u = c.urls[0];
    expect(u.pathname).toBe("/v1/tenants/42/transactions");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      order: "desc",
      active: "true",
      started_from: "2026-10-01T00:00:00.000Z",
      started_to: "2026-11-01T00:00:00.000Z",
      station_id: "70",
      cursor: "opaque-1",
      limit: "2",
    });
    expect(page.data.map((t) => t.id)).toEqual([3, 2]);
    expect(page.next_cursor).toBe("opaque-2");
  });

  it("treats a short page as the last, although Ivora still returns a cursor", async () => {
    const c = client(() => ({
      data: [item(3)],
      next_cursor: null,
      next_page_cursor: "opaque-3",
    }));
    const page = await c.ivora.listSessions({ limit: 50 });
    expect(page.next_cursor).toBeNull();
    // No filter, no cursor: only the order and the limit are sent.
    expect(Object.fromEntries(c.urls[0].searchParams)).toEqual({
      order: "desc",
      limit: "50",
    });
  });

  it("sends active=false for ended sessions", async () => {
    const c = client(() => ({
      data: [],
      next_cursor: null,
      next_page_cursor: "x",
    }));
    await c.ivora.listSessions({ active: false });
    expect(c.urls[0].searchParams.get("active")).toBe("false");
  });
});

describe("live client: the filtered bill list", () => {
  it("sends created_from / created_to and the (created_at, id) cursor as `after`", async () => {
    const bill = { id: "bill_1" } as Bill;
    const c = client(() => ({ data: [bill, bill], next_cursor: "c2" }));
    const page = await c.ivora.listBills({
      created_from: "2026-10-01T00:00:00.000Z",
      created_to: "2026-11-01T00:00:00.000Z",
      cursor: "c1",
      limit: 2,
    });
    expect(c.urls[0].pathname).toBe("/v1/tenants/42/bills");
    expect(Object.fromEntries(c.urls[0].searchParams)).toEqual({
      order: "desc",
      created_from: "2026-10-01T00:00:00.000Z",
      created_to: "2026-11-01T00:00:00.000Z",
      after: "c1",
      limit: "2",
    });
    expect(page.next_cursor).toBe("c2");
  });

  it("ends on a short page", async () => {
    const c = client(() => ({ data: [{ id: "bill_1" }], next_cursor: "c2" }));
    expect((await c.ivora.listBills({ limit: 5 })).next_cursor).toBeNull();
  });
});

describe("reports: sessions and bills of the period from Ivora", () => {
  const { query } = parseReportQuery(
    { get: (k) => (k === "period" ? "7d" : null) },
    "UTC",
    Date.parse("2026-10-22T10:00:00Z"),
  );
  const ctx = stationContext(
    [
      {
        id: 70,
        name: "DEPOT-01",
        online: true,
        location_id: 5,
        connectors: [],
      },
    ],
    [
      {
        id: 5,
        name: "Depot",
        time_zone: "America/Toronto",
        latitude: null,
        longitude: null,
      } as never,
    ],
    "UTC",
  );

  it("asks for the report's period and station, lists sessions started outside the kit", async () => {
    const listSessions = vi.fn(async () => ({
      data: [
        item(9, { id_token: "****RFID", bill_id: null }),
        item(8, { active: true, ended_at: null, bill_id: "bill_8" }),
      ],
      next_cursor: "next",
    }));
    const r = await loadIvoraSessions(
      { ivora: { listSessions } as never },
      { ...query, stationId: 70 },
      ctx,
      "cur",
    );
    expect(listSessions).toHaveBeenCalledWith({
      started_from: new Date(query.fromMs).toISOString(),
      started_to: new Date(query.toMs).toISOString(),
      station_id: 70,
      cursor: "cur",
      limit: IVORA_PAGE_ROWS,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.next).toBe("next");
    expect(r.rows.map((x) => [x.id, x.idToken, x.active, x.endedAt])).toEqual([
      [9, "****RFID", false, "2026-10-20T11:00:00Z"],
      [8, "****ABCD", true, null],
    ]);
    expect(r.rows[0]).toMatchObject({
      stationName: "DEPOT-01",
      siteName: "Depot",
      timeZone: "America/Toronto",
      energyWh: 12_000,
    });
  });

  it("lists the period's bills with the same range and a cursor", async () => {
    const listBills = vi.fn(async () => ({
      data: [{ id: "bill_1" } as Bill],
      next_cursor: null,
    }));
    const r = await loadIvoraBills(
      { ivora: { listBills } as never },
      query,
      null,
    );
    expect(listBills).toHaveBeenCalledWith({
      created_from: new Date(query.fromMs).toISOString(),
      created_to: new Date(query.toMs).toISOString(),
      station_id: undefined,
      cursor: null,
      limit: IVORA_PAGE_ROWS,
    });
    expect(r.ok && r.bills.map((b) => b.id)).toEqual(["bill_1"]);
  });

  it("reports an Ivora failure instead of throwing, and does not block the other list", async () => {
    const listSessions = vi.fn(async () => {
      throw new Error("down");
    });
    const r = await loadIvoraSessions(
      { ivora: { listSessions } as never },
      query,
      ctx,
      null,
    );
    expect(r.ok).toBe(false);
  });

  it("accepts only a cursor-shaped URL parameter", () => {
    expect(cleanCursor("2026-10-20T10:00:00Z|000000000009")).not.toBeNull();
    expect(cleanCursor("abc_DEF-123=")).toBe("abc_DEF-123=");
    expect(cleanCursor("a".repeat(201))).toBeNull();
    expect(cleanCursor("<script>")).toBeNull();
    expect(cleanCursor(null)).toBeNull();
  });
});
