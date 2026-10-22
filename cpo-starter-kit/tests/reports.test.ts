import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getIvora,
  IvoraError,
  resetIvoraForTests,
  type Bill,
  type IvoraClient,
  type TransactionRecord,
} from "@/lib/server/ivora";
import { createLiveClient } from "@/lib/server/ivora/live";
import {
  DEMO_HISTORY_TOKENS,
  demoHistory,
} from "@/lib/server/ivora/demo-history";
import {
  csvField,
  csvHeader,
  csvLine,
  CSV_COLUMNS,
  getReports,
  loadReportsContext,
  loadSessions,
  loadStats,
  parseReportQuery,
  payoutsUrl,
  reportSearch,
  reportTimeZone,
  scanContext,
  scanSessions,
  sessionsCsv,
  summarize,
  type ReportQuery,
  type ScanContext,
  type SessionRow,
} from "@/lib/server/reports";
import {
  bucketFloor,
  bucketNext,
  countBuckets,
  isoInZone,
  MAX_BUCKETS,
} from "@/lib/server/reports/time";
import { resetDemoLiveForTests } from "@/lib/server/live/demo-cookie";
import type { Staff } from "@/lib/server/team/types";
import { whToKwhText } from "@/lib/units";

// The Ivora API is replaced at the HTTP boundary (a fake fetch) or the client
// boundary (a fake IvoraClient): no network, no real credentials.

const NOW = Date.parse("2026-10-21T15:30:00Z");
const NY = "America/New_York";

const params = (o: Record<string, string>) => ({
  get: (k: string) => o[k] ?? null,
});

const viewer: Staff = {
  userId: "00000000-0000-4000-8000-0000000000v1",
  email: "viewer@example.com",
  role: "viewer",
  operatorId: "op-1",
  operatorName: "Sample Operator",
  demo: false,
};

describe("report periods", () => {
  it("finds local bucket boundaries, across a change of clocks", () => {
    // 2026-03-08 is 23 hours long in New York (clocks spring forward).
    const day = bucketFloor(Date.parse("2026-03-08T12:00:00Z"), "day", NY);
    expect(new Date(day).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(bucketNext(day, "day", NY) - day).toBe(23 * 3_600_000);
    const month = bucketFloor(Date.parse("2026-11-15T12:00:00Z"), "month", NY);
    expect(isoInZone(month, NY)).toBe("2026-11-01T00:00:00-04:00");
    expect(isoInZone(bucketNext(month, "month", NY), NY)).toBe(
      "2026-12-01T00:00:00-05:00",
    );
    // Hours start at :30 UTC where the offset has half an hour.
    const hour = bucketFloor(
      Date.parse("2026-10-21T10:10:00Z"),
      "hour",
      "Asia/Kolkata",
    );
    expect(new Date(hour).toISOString()).toBe("2026-10-21T09:30:00.000Z");
    expect(isoInZone(Date.parse("2026-10-21T10:00:00Z"), "UTC")).toBe(
      "2026-10-21T10:00:00+00:00",
    );
  });

  it("keeps every preset within Ivora's bucket limits", () => {
    for (const period of ["24h", "7d", "30d", "90d", "12m"]) {
      for (const zone of ["UTC", NY, "Australia/Lord_Howe", "Asia/Kolkata"]) {
        const { query, error } = parseReportQuery(
          params({ period }),
          zone,
          NOW,
        );
        expect(error).toBeNull();
        const n = countBuckets(query.fromMs, query.toMs, query.bucket, zone);
        expect(n).toBeLessThanOrEqual(MAX_BUCKETS[query.bucket]);
        expect(n).toBeGreaterThan(0);
        // Already whole buckets: what the table reads is what /stats counts.
        expect(bucketFloor(query.fromMs, query.bucket, zone)).toBe(
          query.fromMs,
        );
      }
    }
    const { query } = parseReportQuery(params({ period: "7d" }), NY, NOW);
    expect(query).toMatchObject({
      bucket: "day",
      fromDate: "2026-10-15",
      toDate: "2026-10-21",
    });
    expect(new Date(query.toMs).toISOString()).toBe("2026-10-22T04:00:00.000Z");
  });

  it("reads custom dates in the time zone and falls back with a message", () => {
    const custom = parseReportQuery(
      params({
        period: "custom",
        from: "2026-01-10",
        to: "2026-03-05",
        bucket: "month",
        station: "9101",
        status: "billed",
      }),
      NY,
      NOW,
    );
    expect(custom.error).toBeNull();
    expect(custom.query).toMatchObject({
      preset: "custom",
      bucket: "month",
      fromDate: "2026-01-01",
      toDate: "2026-03-31",
      stationId: 9101,
      status: "billed",
    });
    expect(reportSearch(custom.query)).toBe(
      "period=custom&from=2026-01-01&to=2026-03-31&bucket=month&station=9101&status=billed",
    );
    for (const bad of <Record<string, string>[]>[
      { period: "custom", from: "2026-02-30", to: "2026-03-01" },
      { period: "custom", from: "2026-03-02", to: "2026-03-01" },
      { period: "forever" },
    ]) {
      const r = parseReportQuery(params(bad), NY, NOW);
      expect(r.error).toMatch(/last 30 days/);
      expect(r.query.preset).toBe("30d");
    }
    const odd = parseReportQuery(
      params({ station: "1 OR 1", status: "drop" }),
      "UTC",
      NOW,
    );
    expect(odd.query.stationId).toBeNull();
    expect(odd.query.status).toBe("all");
  });

  it("uses the company's time zone, else the sites' shared one, else UTC", () => {
    expect(reportTimeZone("Europe/Berlin", [])).toEqual({
      zone: "Europe/Berlin",
      source: "company",
    });
    const sites = [
      { id: 1, name: "A", time_zone: NY },
      { id: 2, name: "B", time_zone: NY },
      { id: 3, name: "C" },
    ];
    expect(reportTimeZone(null, sites).zone).toBe(NY);
    expect(reportTimeZone("Not/AZone", sites).source).toBe("sites");
    expect(
      reportTimeZone(null, [...sites, { id: 4, name: "D", time_zone: "UTC" }]),
    ).toEqual({ zone: "UTC", source: "utc" });
  });

  it("writes Wh as exact kWh text", () => {
    expect(whToKwhText(28_941)).toBe("28.941");
    expect(whToKwhText(22_000)).toBe("22");
    expect(whToKwhText(5)).toBe("0.005");
    expect(whToKwhText(0)).toBe("0");
    expect(() => whToKwhText(1.5)).toThrow();
  });

  it("links to the Stripe dashboard's payouts, in test mode for a test account", () => {
    expect(payoutsUrl(true)).toBe("https://dashboard.stripe.com/payouts");
    expect(payoutsUrl(null)).toBe("https://dashboard.stripe.com/payouts");
    expect(payoutsUrl(false)).toBe("https://dashboard.stripe.com/test/payouts");
  });
});

describe("live client: stats, transactions and bills", () => {
  const saved = { ...process.env };
  beforeEach(() => {
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

  function client(bodies: unknown[]) {
    const urls: string[] = [];
    const headers: Headers[] = [];
    const ivora = createLiveClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key-not-real",
      tenantId: "42",
      fetch: (async (url: string, init?: RequestInit) => {
        urls.push(String(url));
        headers.push(new Headers(init?.headers));
        const body = bodies.shift();
        return body instanceof Response ? body : Response.json(body);
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    return { ivora, urls, headers };
  }

  it("reads GET /stats with the period, bucket, zone and top, without a key", async () => {
    const { ivora, urls, headers } = client([{ bucket: "day" }]);
    await ivora.getStats({
      from: "2026-10-01T04:00:00.000Z",
      to: "2026-10-22T04:00:00.000Z",
      bucket: "day",
      time_zone: NY,
      top: 5,
    });
    const u = new URL(urls[0]);
    expect(u.pathname).toBe("/v1/tenants/42/stats");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      from: "2026-10-01T04:00:00.000Z",
      to: "2026-10-22T04:00:00.000Z",
      bucket: "day",
      time_zone: NY,
      top: "5",
    });
    expect(headers[0].get("idempotency-key")).toBeNull();
  });

  it("pages transactions and bills with their cursors", async () => {
    const { ivora, urls } = client([
      { data: [], next_cursor: null },
      { data: [], next_cursor: null },
    ]);
    await ivora.listTransactionPage({ after: 900, station_id: 7 });
    await ivora.listBillPage({ after: "b_9", status: "final" });
    expect(urls[0]).toBe(
      "https://api.example.test/v1/tenants/42/transactions?limit=100&after=900&station_id=7",
    );
    expect(urls[1]).toBe(
      "https://api.example.test/v1/tenants/42/bills?limit=100&after=b_9&status=final",
    );
  });

  it("shows stats_range_too_large as such, with the limits and what to pick", async () => {
    const { ivora } = client([
      Response.json(
        {
          error: {
            code: "stats_range_too_large",
            message: "too many buckets",
            details: { max_buckets: 92 },
          },
          request_id: "req_7",
        },
        { status: 422 },
      ),
    ]);
    const { query } = parseReportQuery(
      params({ period: "custom", from: "2026-01-01", to: "2026-06-30" }),
      "UTC",
      NOW,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loadStats(ivora, query);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.tooLarge).toBe(true);
    expect(r.error).toContain("stats_range_too_large");
    expect(r.error).toContain("at most 92 day buckets");
    expect(r.error).toContain("show it by month");
    expect(r.error).toContain("Request req_7");
  });

  it("reports other stats errors with their code", async () => {
    const { ivora } = client([
      Response.json(
        { error: { code: "forbidden", message: "no" }, request_id: "r" },
        { status: 403 },
      ),
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loadStats(
      ivora,
      parseReportQuery(params({}), "UTC", NOW).query,
    );
    expect(r).toMatchObject({ ok: false, tooLarge: false });
    if (!r.ok) expect(r.error).toMatch(/forbidden.*permissions/);
  });
});

// ---- Session scans against a fake client ----

const STAFF = "STAFFABCDEFGHJKLMNP";
const FREE = "FREEQRSTUVWXYZ2345";

function tx(
  id: number,
  startedAt: string,
  o: Partial<TransactionRecord> = {},
): TransactionRecord {
  const start = Date.parse(startedAt);
  return {
    id,
    station_id: 7,
    connector_id: 71,
    connector_number: 1,
    active: false,
    id_token: "****C3D4",
    started_at: startedAt,
    ended_at: new Date(start + 3_600_000).toISOString(),
    energy_wh: 10_500,
    ...o,
  };
}

const finalBill = (id: string, total: number) => ({
  id,
  status: "final" as const,
  currency: "USD",
  total_minor: total,
  finalized_at: null,
});

function fakeClient(
  pages: TransactionRecord[][],
  bills: Bill[][] = [],
): IvoraClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    mode: "live",
    calls,
    async listTransactionPage(o: { after?: number }) {
      calls.push(`tx:${o.after ?? 0}`);
      const i = o.after ?? 0;
      return {
        data: pages[i] ?? [],
        next_cursor: i + 1 < pages.length ? i + 1 : null,
      };
    },
    async listBillPage(o: { after?: string }) {
      calls.push(`bills:${o.after ?? ""}`);
      const i = Number(o.after ?? 0);
      return {
        data: bills[i] ?? [],
        next_cursor: i + 1 < bills.length ? String(i + 1) : null,
      };
    },
  } as unknown as IvoraClient & { calls: string[] };
}

const ctx: ScanContext = scanContext(
  [{ id: 7, name: "CP-07", online: true, location_id: 3, connectors: [] }],
  [{ id: 3, name: "Main Street", time_zone: "America/Chicago" }],
  { staff: [STAFF], free: [FREE] },
  NY,
);

const october = (o: Record<string, string> = {}): ReportQuery =>
  parseReportQuery(
    params({
      period: "custom",
      from: "2026-10-01",
      to: "2026-10-21",
      ...o,
    }),
    NY,
    NOW,
  ).query;

async function collect(
  ivora: IvoraClient,
  q: ReportQuery,
  limits = { maxPages: 10, seconds: 20 },
) {
  const rows: SessionRow[] = [];
  const scan = scanSessions({ ivora, now: () => NOW }, q, ctx, limits);
  let step = await scan.next();
  while (!step.done) {
    rows.push(...step.value);
    step = await scan.next();
  }
  return { rows, truncated: step.value.truncated };
}

describe("sessions table", () => {
  it("labels staff/test and free sessions and keeps them out of driver revenue", async () => {
    const ivora = fakeClient([
      [
        tx(5, "2026-10-20T14:00:00Z", { bill: finalBill("bill_a", 1250) }),
        tx(4, "2026-10-19T14:00:00Z", {
          id_token: `****${STAFF.slice(-4)}`,
          bill: null,
        }),
        tx(3, "2026-10-18T14:00:00Z", {
          id_token: `****${FREE.slice(-4)}`,
          bill: null,
        }),
        // Even with a bill, a staff-token session is never driver revenue.
        tx(2, "2026-10-17T14:00:00Z", {
          id_token: `****${STAFF.slice(-4)}`,
          bill: finalBill("bill_b", 900),
        }),
        tx(1, "2026-10-16T14:00:00Z", { bill: null }),
      ],
    ]);
    const { rows } = await collect(ivora, october());
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      [5, "driver"],
      [4, "staff"],
      [3, "free"],
      [2, "staff"],
      [1, "other"],
    ]);
    const s = summarize(rows);
    expect(s.byKind).toEqual({ driver: 1, free: 1, staff: 2, other: 1 });
    expect(s.driverRevenue).toEqual([
      { currency: "USD", amountMinor: 1250, bills: 1 },
    ]);
    expect(s.energyWh).toBe(5 * 10_500);
    expect(rows[0]).toMatchObject({
      stationName: "CP-07",
      siteName: "Main Street",
      timeZone: "America/Chicago",
      durationSeconds: 3600,
      amountMinor: 1250,
      currency: "USD",
      billStatus: "final",
      status: "ended",
    });
  });

  it("keeps the period and filters by status and charger", async () => {
    const page = [
      tx(9, "2026-10-22T04:30:00Z"), // after the period (Oct 21 ends 04:00 UTC)
      tx(8, "2026-10-20T10:00:00Z", {
        active: true,
        ended_at: null,
        bill: { ...finalBill("bill_o", 0), status: "open", total_minor: null },
      }),
      tx(7, "2026-10-19T10:00:00Z", { bill: finalBill("bill_c", 500) }),
      tx(6, "2026-10-18T10:00:00Z", { bill: null, station_id: 8 }),
      tx(5, "2026-10-01T03:59:00Z", { bill: null }), // Sep 30 in New York
    ];
    const ids = async (o: Record<string, string>) =>
      (await collect(fakeClient([page]), october(o))).rows.map((r) => r.id);
    expect(await ids({})).toEqual([8, 7, 6]);
    expect(await ids({ status: "charging" })).toEqual([8]);
    expect(await ids({ status: "ended" })).toEqual([7, 6]);
    expect(await ids({ status: "billed" })).toEqual([7]);
    expect(await ids({ status: "unbilled" })).toEqual([6]);
    expect(await ids({ station: "7" })).toEqual([8, 7]);
  });

  it("stops at the first newest-first page that ends before the period", async () => {
    const ivora = fakeClient([
      [tx(30, "2026-10-20T10:00:00Z", { bill: null })],
      [tx(20, "2026-09-20T10:00:00Z", { bill: null })],
      [tx(10, "2026-08-20T10:00:00Z", { bill: null })],
    ]);
    const r = await collect(ivora, october());
    expect(r.rows.map((x) => x.id)).toEqual([30]);
    expect(r.truncated).toBe(false);
    expect(ivora.calls).toEqual(["tx:0", "tx:1"]);
  });

  it("says when it stopped at its page limit", async () => {
    const pages = Array.from({ length: 5 }, (_, i) => [
      tx(100 - i, `2026-10-${String(20 - i).padStart(2, "0")}T10:00:00Z`, {
        bill: null,
      }),
    ]);
    const r = await collect(fakeClient(pages), october(), {
      maxPages: 3,
      seconds: 20,
    });
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it("reads GET /bills when the list carries no bill, and joins them", async () => {
    const bill = (o: Partial<Bill>): Bill => ({
      id: "bill_x",
      station_id: 7,
      connector_id: 71,
      tariff_id: 1,
      hold_minor: 2500,
      currency: "USD",
      status: "final",
      total_minor: 830,
      transaction_id: 2,
      created_at: "2026-10-18T09:59:00Z",
      finalized_at: "2026-10-18T11:05:00Z",
      ...o,
    });
    const t1 = tx(1, "2026-10-19T10:00:00Z", { active: true, ended_at: null });
    const t2 = tx(2, "2026-10-18T10:00:00Z");
    delete t1.bill;
    delete t2.bill;
    const ivora = fakeClient(
      [[t1, t2]],
      [
        [
          bill({}),
          // The open bill on the same connector, made just before t1 started.
          bill({
            id: "bill_open",
            status: "open",
            total_minor: null,
            transaction_id: null,
            created_at: "2026-10-19T09:58:00Z",
            finalized_at: null,
          }),
        ],
      ],
    );
    const { rows } = await collect(ivora, october());
    expect(ivora.calls).toEqual(["tx:0", "bills:"]);
    expect(rows.map((r) => [r.id, r.kind, r.billId, r.amountMinor])).toEqual([
      [1, "driver", "bill_open", null],
      [2, "driver", "bill_x", 830],
    ]);
  });

  it("sorts the page newest first and reports errors with their code", async () => {
    const ivora = fakeClient([
      [
        tx(1, "2026-10-02T10:00:00Z", { bill: null }),
        tx(2, "2026-10-05T10:00:00Z", { bill: null }),
      ],
    ]);
    const r = await loadSessions({ ivora, now: () => NOW }, october(), ctx);
    expect(r.ok && r.rows.map((x) => x.id)).toEqual([2, 1]);
    const failing = {
      mode: "live",
      async listTransactionPage() {
        throw new IvoraError(403, "forbidden", "Missing billing:read");
      },
    } as unknown as IvoraClient;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = await loadSessions(
      { ivora: failing, now: () => NOW },
      october(),
      ctx,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("forbidden");
  });
});

describe("CSV export", () => {
  it("has stable, documented columns", () => {
    expect(csvHeader()).toBe(
      "session_id,started_at_utc,ended_at_utc,time_zone,started_at_local,ended_at_local,duration_seconds,site,station_id,station,connector_id,connector_number,energy_wh,energy_kwh,session_type,status,stop_reason,bill_id,bill_status,amount_minor,currency\r\n",
    );
  });

  it("writes UTC and local times, exact kWh and integer minor units", () => {
    const row: SessionRow = {
      id: 31,
      stationId: 7,
      stationName: "CP-07",
      siteName: 'Main St, "North"',
      timeZone: "America/Chicago",
      connectorId: 71,
      connectorNumber: 1,
      startedAt: "2026-10-01T15:00:00.000Z",
      endedAt: "2026-10-01T16:30:00.000Z",
      durationSeconds: 5400,
      energyWh: 6941,
      kind: "staff",
      status: "ended",
      stopReason: "=HYPERLINK(1)",
      billId: null,
      billStatus: null,
      amountMinor: null,
      currency: null,
    };
    const line = csvLine(row);
    expect(line.endsWith("\r\n")).toBe(true);
    expect(line.trimEnd()).toBe(
      [
        "31",
        "2026-10-01T15:00:00.000Z",
        "2026-10-01T16:30:00.000Z",
        "America/Chicago",
        "2026-10-01T10:00:00-05:00",
        "2026-10-01T11:30:00-05:00",
        "5400",
        '"Main St, ""North"""',
        "7",
        "CP-07",
        "71",
        "1",
        "6941",
        "6.941",
        "staff_test",
        "ended",
        "'=HYPERLINK(1)",
        "",
        "",
        "",
        "",
      ].join(","),
    );
    expect(line.split(",").length).toBeGreaterThanOrEqual(CSV_COLUMNS.length);
    expect(csvField("-1+1")).toBe("'-1+1");
    expect(csvField("@SUM")).toBe("'@SUM");
    expect(csvField(-5)).toBe("-5");
    expect(csvField("a\nb")).toBe('"a\nb"');
  });

  it("streams page by page, and fails before the response on a first-page error", async () => {
    const ivora = fakeClient([
      [tx(3, "2026-10-20T10:00:00Z", { bill: finalBill("bill_a", 700) })],
      [tx(2, "2026-10-19T10:00:00Z", { bill: null })],
    ]);
    const stream = await sessionsCsv({ ivora, now: () => NOW }, october(), ctx);
    // The first page is read before the response starts; the second only when pulled.
    expect(ivora.calls).toEqual(["tx:0"]);
    const csv = await new Response(stream).text();
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["3", "2"]);
    expect(lines[1].endsWith(",bill_a,final,700,USD")).toBe(true);

    const failing = {
      mode: "live",
      async listTransactionPage() {
        throw new IvoraError(503, "outcome_unknown", "busy");
      },
    } as unknown as IvoraClient;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sessionsCsv({ ivora: failing, now: () => NOW }, october(), ctx),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  it("errors the stream (never a file that looks complete) when a later page fails", async () => {
    let n = 0;
    const ivora = {
      mode: "live",
      async listTransactionPage() {
        if (n++ === 0)
          return {
            data: [tx(3, "2026-10-20T10:00:00Z", { bill: null })],
            next_cursor: 1,
          };
        throw new IvoraError(429, "rate_limited", "slow down");
      },
    } as unknown as IvoraClient;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = await sessionsCsv({ ivora, now: () => NOW }, october(), ctx);
    await expect(new Response(stream).text()).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});

describe("reports in demo mode", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    for (const k of [
      "IVORA_API_KEY",
      "IVORA_TENANT_ID",
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ])
      delete process.env[k];
    resetIvoraForTests();
    resetDemoLiveForTests();
    fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("runs stats, the sessions table and the CSV export on sample data, offline", async () => {
    const d = getReports();
    expect(d.ivora.mode).toBe("demo");
    const r = await loadReportsContext(d, viewer, params({ period: "90d" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.context;
    // The sample sites' time zone (no company time zone is set in the demo).
    expect(c.query.timeZone).toBe(NY);
    expect(c.timeZoneSource).toBe("sites");
    expect(c.stations.every((s) => s.name.startsWith("DEMO-"))).toBe(true);

    const stats = await loadStats(d.ivora, c.query);
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;
    expect(stats.stats.series).toHaveLength(90);
    expect(stats.stats.totals.sessions).toBeGreaterThan(200);
    expect(stats.stats.revenue?.currencies[0].currency).toBe("USD");
    expect(stats.stats.top_stations[0].name).toMatch(/^DEMO-/);

    const sessions = await loadSessions(d, c.query, c.scan);
    expect(sessions.ok).toBe(true);
    if (!sessions.ok) return;
    const s = sessions.summary;
    expect(s.byKind.staff).toBeGreaterThan(0);
    expect(s.byKind.free).toBeGreaterThan(0);
    expect(s.byKind.driver).toBeGreaterThan(0);
    // Driver revenue is exactly the final bills of driver sessions.
    const history = demoHistory(Date.now());
    const driverBills = new Set(
      history.transactions
        .filter(
          (t) =>
            t.bill &&
            Date.parse(t.started_at!) >= c.query.fromMs &&
            Date.parse(t.started_at!) < c.query.toMs,
        )
        .map((t) => t.bill!.id),
    );
    expect(s.driverRevenue[0].bills).toBe(driverBills.size);
    expect(
      history.transactions.some((t) =>
        t.id_token?.endsWith(DEMO_HISTORY_TOKENS.staff.slice(-4)),
      ),
    ).toBe(true);

    const csv = await new Response(
      await sessionsCsv(d, c.query, c.scan),
    ).text();
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines.length - 1).toBe(s.sessions);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers a period that is too long like Ivora: stats_range_too_large", async () => {
    const d = getReports();
    const r = await loadReportsContext(
      d,
      viewer,
      params({
        period: "custom",
        from: "2026-01-01",
        to: "2026-06-30",
        bucket: "day",
      }),
    );
    if (!r.ok) throw new Error(r.error);
    const stats = await loadStats(d.ivora, r.context.query);
    expect(stats).toMatchObject({ ok: false, tooLarge: true });
    if (!stats.ok) expect(stats.error).toContain("stats_range_too_large");
    // The same months by month are fine.
    const months = await loadReportsContext(
      d,
      viewer,
      params({
        period: "custom",
        from: "2026-01-01",
        to: "2026-06-30",
        bucket: "month",
      }),
    );
    if (!months.ok) throw new Error(months.error);
    expect((await loadStats(d.ivora, months.context.query)).ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves the demo client's report methods only from sample data", async () => {
    const ivora = getIvora();
    const page = await ivora.listTransactionPage({ limit: 5 });
    expect(page.data).toHaveLength(5);
    expect(page.next_cursor).toBe(5);
    const bills = await ivora.listBillPage({ status: "final", limit: 3 });
    expect(bills.data.every((b) => b.status === "final")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
