import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getIvora,
  IvoraError,
  resetIvoraForTests,
  type IvoraClient,
  type TransactionDetail,
} from "@/lib/server/ivora";
import { createLiveClient } from "@/lib/server/ivora/live";
import { demoHistory } from "@/lib/server/ivora/demo-history";
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
  refreshReportRecords,
  reportFilter,
  reportSearch,
  reportTimeZone,
  sessionDetails,
  sessionsCsv,
  stationContext,
  toRow,
  type ReportCheckout,
  type ReportFilter,
  type ReportsStore,
  type SessionDetails,
} from "@/lib/server/reports";
import {
  matchesFilter,
  newestFirst,
  totalsOf,
} from "@/lib/server/reports/records";
import { resetDemoCheckoutForTests } from "@/lib/server/checkout/demo-cookie";
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
        status: "refunded",
        page: "3",
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
      status: "refunded",
      page: 3,
    });
    // The CSV link has no page; the table's links do.
    expect(reportSearch(custom.query)).toBe(
      "period=custom&from=2026-01-01&to=2026-03-31&bucket=month&station=9101&status=refunded",
    );
    expect(reportSearch(custom.query, 2)).toMatch(/&page=2$/);
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
      params({ station: "1 OR 1", status: "drop", page: "-1" }),
      "UTC",
      NOW,
    );
    expect(odd.query.stationId).toBeNull();
    expect(odd.query.status).toBe("all");
    expect(odd.query.page).toBe(1);
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

describe("live client: stats, transaction detail and payments", () => {
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

  it("reads one transaction's detail and one payment, without a key", async () => {
    const { ivora, urls, headers } = client([
      { id: 812, active: false },
      { id: "pay_1", status: "captured", refunded_minor: 0 },
    ]);
    await ivora.getTransaction(812);
    await ivora.getPayment("pay_1");
    expect(urls[0]).toBe(
      "https://api.example.test/v1/tenants/42/transactions/812",
    );
    expect(urls[1]).toMatch(/\/payments\/pay_1$/);
    expect(headers.every((h) => h.get("idempotency-key") === null)).toBe(true);
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

// ---- The kit's own records ----

let n = 0;
/** A checkout as the reports store returns it: a settled $12.40 paid session. */
function checkout(o: Partial<ReportCheckout> = {}): ReportCheckout {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    reference: `ck_${String(n).padStart(32, "0")}`,
    kind: "paid",
    stationId: 7,
    connectorId: 71,
    phase: "settled",
    alert: null,
    createdAt: "2026-10-10T14:00:00.000Z",
    settledAt: "2026-10-10T15:05:00.000Z",
    transactionId: 500 + n,
    billId: `bill_${"a".repeat(32)}`,
    holdMinor: 2500,
    currency: "USD",
    finalMinor: 1240,
    capturedMinor: 1240,
    refundedMinor: 0,
    refundCheckedAt: "2026-10-10T16:00:00.000Z",
    meterWh: 28_100,
    sessionStartedAt: "2026-10-10T14:01:30.000Z",
    sessionEndedAt: "2026-10-10T15:00:00.000Z",
    energyWh: 28_941,
    connectorNumber: 1,
    stopReason: "EVDisconnected",
    detailAt: "2026-10-10T15:06:00.000Z",
    ...o,
  };
}

const places = stationContext(
  [{ id: 7, name: "CP-07", online: true, location_id: 3, connectors: [] }],
  [{ id: 3, name: "Main Street", time_zone: "America/Chicago" }],
  NY,
);

const october = (o: Partial<ReportFilter> = {}): ReportFilter => ({
  operatorId: "op-1",
  fromMs: Date.parse("2026-10-01T04:00:00Z"),
  toMs: Date.parse("2026-10-22T04:00:00Z"),
  stationId: null,
  status: "all",
  ...o,
});

/** A reports store over an array, with the same rules as the database. */
function memoryStore(rows: ReportCheckout[]): ReportsStore & {
  details: [string, SessionDetails][];
  refunds: [string, number][];
} {
  const details: [string, SessionDetails][] = [];
  const refunds: [string, number][] = [];
  return {
    mode: "live",
    details,
    refunds,
    async list(f, page) {
      let all = rows.filter((c) => matchesFilter(c, f)).sort(newestFirst);
      if (page.after) {
        const at = Date.parse(page.after.createdAt);
        const id = page.after.id;
        all = all.filter((c) => {
          const t = Date.parse(c.createdAt);
          return t < at || (t === at && c.id < id);
        });
      }
      const from = page.offset ?? 0;
      return all.slice(from, from + page.limit);
    },
    async totals(f) {
      return totalsOf(rows.filter((c) => matchesFilter(c, f)));
    },
    async detailsDue() {
      return [];
    },
    async recordDetails(_op, id, d) {
      details.push([id, d]);
      return true;
    },
    async refundsDue() {
      return [];
    },
    async recordRefund(_op, id, minor) {
      refunds.push([id, minor]);
      return true;
    },
  };
}

describe("driver revenue: captured minus refunded, never the bill", () => {
  it("counts a $0.30 bill released under Stripe's minimum as nothing collected", () => {
    const r = toRow(
      checkout({ finalMinor: 30, capturedMinor: 0, refundCheckedAt: null }),
      places,
    );
    expect(r).toMatchObject({
      status: "no_charge",
      billedMinor: 30,
      capturedMinor: 0,
      netMinor: 0,
    });
  });

  it("leaves a $27.40 bill above the $25 hold to the operator: billed, not collected", () => {
    const c = checkout({
      phase: "attention",
      finalMinor: 2740,
      capturedMinor: null,
      refundedMinor: null,
      refundCheckedAt: null,
    });
    expect(toRow(c, places)).toMatchObject({
      status: "attention",
      billedMinor: 2740,
      capturedMinor: null,
      netMinor: null,
    });
    const t = totalsOf([c]);
    expect(t.currencies).toEqual([
      {
        currency: "USD",
        charged: 0,
        billedMinor: 2740,
        capturedMinor: 0,
        refundedMinor: 0,
      },
    ]);
    expect(t.byStatus.attention).toBe(1);
  });

  it("takes refunds off, and keeps free sessions out of the money", () => {
    const rows = [
      checkout(),
      checkout({ refundedMinor: 1240 }),
      checkout({ finalMinor: 830, capturedMinor: 830, refundedMinor: 300 }),
      checkout({
        kind: "free",
        holdMinor: 0,
        billId: null,
        finalMinor: null,
        capturedMinor: null,
        refundedMinor: null,
        refundCheckedAt: null,
      }),
      checkout({ currency: "EUR", finalMinor: 500, capturedMinor: 500 }),
    ];
    const t = totalsOf(rows);
    const usd = t.currencies.find((l) => l.currency === "USD")!;
    expect(usd).toEqual({
      currency: "USD",
      charged: 3,
      billedMinor: 1240 + 1240 + 830,
      capturedMinor: 1240 + 1240 + 830,
      refundedMinor: 1240 + 300,
    });
    expect(usd.capturedMinor - usd.refundedMinor).toBe(1240 + 530);
    expect(t.currencies.map((l) => l.currency)).toEqual(["EUR", "USD"]);
    expect(t).toMatchObject({ paid: 4, free: 1, checkouts: 5 });
    expect(t.byStatus).toEqual({
      in_progress: 0,
      charged: 4,
      no_charge: 1,
      attention: 0,
    });
    const free = toRow(rows[3], places);
    expect(free).toMatchObject({
      kind: "free",
      holdMinor: null,
      billedMinor: null,
      capturedMinor: null,
      netMinor: null,
    });
    expect(toRow(rows[2], places).netMinor).toBe(530);
  });

  it("shows a running session's energy so far, and pending details as pending", () => {
    const running = toRow(
      checkout({
        phase: "open",
        finalMinor: null,
        capturedMinor: null,
        refundedMinor: null,
        refundCheckedAt: null,
        transactionId: null,
        sessionStartedAt: null,
        sessionEndedAt: null,
        energyWh: null,
        detailAt: null,
      }),
      places,
    );
    expect(running).toMatchObject({
      status: "in_progress",
      energyWh: null,
      energySoFarWh: 28_100,
      detailsPending: false,
    });
    const pending = toRow(
      checkout({ detailAt: null, energyWh: null, sessionEndedAt: null }),
      places,
    );
    expect(pending).toMatchObject({ detailsPending: true, energyWh: null });
    const t = totalsOf([checkout({ detailAt: null }), checkout()]);
    expect(t.detailsPending).toBe(1);
    // Only recorded energy counts.
    expect(t.energyWh).toBe(28_941);
  });

  it("puts a session in the period it was tapped in, and filters by charger and status", () => {
    const rows = [
      checkout({ createdAt: "2026-10-01T03:59:59.000Z" }),
      checkout({ createdAt: "2026-10-01T04:00:00.000Z" }),
      checkout({ createdAt: "2026-10-22T03:59:59.999Z", stationId: 8 }),
      checkout({ createdAt: "2026-10-22T04:00:00.000Z" }),
      checkout({ refundedMinor: 100 }),
    ];
    expect(rows.filter((c) => matchesFilter(c, october()))).toHaveLength(3);
    expect(
      rows.filter((c) => matchesFilter(c, october({ stationId: 8 }))),
    ).toHaveLength(1);
    expect(
      rows.filter((c) => matchesFilter(c, october({ status: "refunded" }))),
    ).toEqual([rows[4]]);
  });

  it("labels sessions from the kit's own record, never from a token", () => {
    // Ivora masks id_token; the kind is the checkout's (paid or free). Staff/test
    // sessions have no checkout, so they are never in this table or its money.
    const free = checkout({ kind: "free" });
    expect(toRow(free, places).kind).toBe("free");
    expect(totalsOf([free]).currencies).toEqual([]);
  });
});

describe("sessions table", () => {
  it("pages newest first, with totals of every matching session", async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      checkout({
        createdAt: new Date(
          Date.parse("2026-10-05T00:00:00Z") + i * 3_600_000,
        ).toISOString(),
      }),
    );
    const store = memoryStore(rows);
    const first = await loadSessions({ store }, october(), 1, places);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first).toMatchObject({ page: 1, pages: 3 });
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0].createdAt).toBe(rows[119].createdAt);
    expect(first.totals.checkouts).toBe(120);
    // A page past the end shows the last one.
    const last = await loadSessions({ store }, october(), 9, places);
    if (!last.ok) throw new Error("expected rows");
    expect(last).toMatchObject({ page: 3, pages: 3 });
    expect(last.rows).toHaveLength(20);
    expect(last.rows.at(-1)!.createdAt).toBe(rows[0].createdAt);
  });

  it("writes UTC and the site's local time, and the charger and site", () => {
    const r = toRow(checkout(), places);
    expect(r).toMatchObject({
      stationName: "CP-07",
      siteName: "Main Street",
      timeZone: "America/Chicago",
      startedAt: "2026-10-10T14:01:30.000Z",
      durationSeconds: 3510,
    });
    expect(toRow(checkout({ stationId: 99 }), places)).toMatchObject({
      stationName: "Charger 99",
      timeZone: NY,
    });
  });

  it("reports a store error with its message", async () => {
    const store = memoryStore([]);
    store.totals = async () => {
      throw new IvoraError(0, "timeout", "slow");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loadSessions({ store }, october(), 1, places);
    expect(r.ok).toBe(false);
  });
});

describe("CSV export", () => {
  it("has stable, documented columns", async () => {
    expect(csvHeader()).toBe(`${CSV_COLUMNS.join(",")}\r\n`);
    const readme = (await import("node:fs")).readFileSync("README.md", "utf8");
    for (const c of CSV_COLUMNS) expect(readme).toContain(`\`${c}\``);
  });

  it("writes UTC and local times, exact kWh and integer minor units", () => {
    const line = csvLine(
      toRow(
        checkout({ refundedMinor: 240, reference: `ck_${"b".repeat(32)}` }),
        places,
      ),
    );
    const f = line.trimEnd().split(",");
    const at = (c: (typeof CSV_COLUMNS)[number]) => f[CSV_COLUMNS.indexOf(c)];
    expect(at("session_ref")).toBe(`ck_${"b".repeat(32)}`);
    expect(at("session_type")).toBe("paid");
    expect(at("status")).toBe("charged");
    expect(at("started_at_utc")).toBe("2026-10-10T14:01:30.000Z");
    expect(at("started_at_local")).toBe("2026-10-10T09:01:30-05:00");
    expect(at("time_zone")).toBe("America/Chicago");
    expect(at("energy_wh")).toBe("28941");
    expect(at("energy_kwh")).toBe("28.941");
    expect(at("billed_minor")).toBe("1240");
    expect(at("captured_minor")).toBe("1240");
    expect(at("refunded_minor")).toBe("240");
    expect(at("net_minor")).toBe("1000");
    expect(at("currency")).toBe("USD");
    expect(at("details")).toBe("recorded");
    expect(line.endsWith("\r\n")).toBe(true);
    const free = csvLine(toRow(checkout({ kind: "free" }), places));
    const g = free.trimEnd().split(",");
    expect(g[CSV_COLUMNS.indexOf("currency")]).toBe("");
    expect(g[CSV_COLUMNS.indexOf("captured_minor")]).toBe("");
  });

  it("quotes and defuses text a spreadsheet would run as a formula", () => {
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-2")).toBe("'-2");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("\tx")).toBe("'\tx");
    expect(csvField(" =1+1")).toBe("' =1+1");
    expect(csvField("＝1+1")).toBe("'＝1+1");
    expect(csvField("＋1")).toBe("'＋1");
    expect(csvField('Bay "A", north')).toBe('"Bay ""A"", north"');
    expect(csvField("\r\n=1")).toBe('"\'\r\n=1"');
    expect(csvField(-5)).toBe("-5");
    expect(csvField(null)).toBe("");
    expect(csvField("Main Street")).toBe("Main Street");
  });

  const csvDeps = (store: ReportsStore, clock = { t: NOW }) => ({
    store,
    now: () => clock.t,
  });

  it("streams every matching row in pages that new checkouts can't shift", async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      checkout({
        createdAt: new Date(
          Date.parse("2026-10-05T00:00:00Z") + i * 60_000,
        ).toISOString(),
      }),
    );
    const store = memoryStore(rows);
    const list = vi.spyOn(store, "list");
    const r = await sessionsCsv(csvDeps(store), october(), places, {
      maxRows: 100,
      seconds: 45,
      pageRows: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await reader.read()).value); // header
    text += dec.decode((await reader.read()).value); // first page
    // A checkout made while the file streams: by offset it would repeat a row.
    rows.push(checkout({ createdAt: "2026-10-06T00:00:00.000Z" }));
    for (let s = await reader.read(); !s.done; s = await reader.read())
      text += dec.decode(s.value);
    const lines = text.trimEnd().split("\r\n");
    expect(lines).toHaveLength(8);
    expect(new Set(lines.slice(1)).size).toBe(7);
    expect(list.mock.calls.map((c) => c[1].after?.createdAt ?? null)).toEqual([
      null,
      rows[4].createdAt,
      rows[1].createdAt,
    ]);
  });

  it("refuses more rows than one file holds before sending anything", async () => {
    const store = memoryStore([checkout(), checkout(), checkout()]);
    const r = await sessionsCsv(csvDeps(store), october(), places, {
      maxRows: 2,
      seconds: 45,
      pageRows: 500,
    });
    expect(r).toMatchObject({ ok: false, status: 422 });
    if (!r.ok) expect(r.error).toMatch(/3 sessions match.*up to 2/);
  });

  it("answers an error status when the count can't be read", async () => {
    const store = memoryStore([]);
    store.totals = async () => {
      throw new Error("db down");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sessionsCsv(csvDeps(store), october(), places)).toMatchObject({
      ok: false,
      status: 502,
    });
  });

  it("fails the download (never a clean partial file) when a later page fails", async () => {
    const store = memoryStore(
      Array.from({ length: 5 }, (_, i) =>
        checkout({ createdAt: `2026-10-05T00:0${i}:00.000Z` }),
      ),
    );
    const real = store.list.bind(store);
    let calls = 0;
    store.list = async (f, p) => {
      if (++calls === 2) throw new Error("connection reset");
      return real(f, p);
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await sessionsCsv(csvDeps(store), october(), places, {
      maxRows: 100,
      seconds: 45,
      pageRows: 2,
    });
    if (!r.ok) throw new Error("expected a stream");
    await expect(new Response(r.body).text()).rejects.toThrow();
  });

  it("fails the download when it runs out of time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = { t: NOW };
    const slow = memoryStore(
      Array.from({ length: 4 }, (_, i) =>
        checkout({ createdAt: `2026-10-05T00:0${i}:00.000Z` }),
      ),
    );
    const real = slow.list.bind(slow);
    slow.list = async (f, p) => {
      clock.t += 30_000;
      return real(f, p);
    };
    const t = await sessionsCsv(csvDeps(slow, clock), october(), places, {
      maxRows: 100,
      seconds: 45,
      pageRows: 1,
    });
    if (!t.ok) throw new Error("expected a stream");
    await expect(new Response(t.body).text()).rejects.toThrow(/45 seconds/);
  });
});

describe("the sweep: session details and refunds", () => {
  /** GET /transactions/{id} as the published API returns it. */
  const detail = (o: Partial<TransactionDetail> = {}): TransactionDetail =>
    ({
      id: 812,
      transaction_id: "1234",
      station_id: 7,
      station_name: "CP-07",
      evse_number: 1,
      connector_id: 71,
      connector_number: 2,
      id_token: "****C3D4",
      id_token_type: "Central",
      active: false,
      charging_state: null,
      started_at: "2026-10-10T14:01:30Z",
      ended_at: "2026-10-10T15:00:00Z",
      duration_seconds: 3510,
      stop_reason: "EVDisconnected",
      energy_kwh: "28.941",
      energy_wh: 28_941,
      meter_start_kwh: "100.000",
      meter_start_wh: 100_000,
      billing: null,
      bill: null,
      ...o,
    }) as TransactionDetail;

  it("reads an ended session's start, end, energy, connector and stop reason", () => {
    expect(sessionDetails(detail())).toEqual({
      startedAt: "2026-10-10T14:01:30Z",
      endedAt: "2026-10-10T15:00:00Z",
      energyWh: 28_941,
      connectorNumber: 2,
      stopReason: "EVDisconnected",
    });
    // Still charging: nothing to keep yet (duration_seconds counts to now).
    expect(
      sessionDetails(detail({ active: true, ended_at: null })).endedAt,
    ).toBeNull();
    expect(sessionDetails(detail({ energy_wh: -5 })).energyWh).toBeNull();
  });

  function sweepClient(
    tx: Record<number, TransactionDetail | Error>,
    pay: Record<string, { refunded_minor?: number } | Error>,
  ) {
    const calls: string[] = [];
    const ivora = {
      mode: "live",
      async getTransaction(id: number) {
        calls.push(`tx:${id}`);
        const t = tx[id];
        if (t instanceof Error) throw t;
        return t;
      },
      async getPayment(id: string) {
        calls.push(`pay:${id}`);
        const p = pay[id];
        if (p instanceof Error) throw p;
        return { id, status: "captured", ...p };
      },
    } as unknown as IvoraClient;
    return { ivora, calls };
  }

  it("copies ended sessions, notes running and missing ones, and records refunds", async () => {
    const store = memoryStore([]);
    store.detailsDue = async () => [
      { operatorId: "op-1", id: "a", transactionId: 1 },
      { operatorId: "op-1", id: "b", transactionId: 2 },
      { operatorId: "op-1", id: "c", transactionId: 3 },
    ];
    store.refundsDue = async () => [
      { operatorId: "op-1", id: "d", paymentId: "pay_d" },
      { operatorId: "op-1", id: "e", paymentId: "pay_e" },
      { operatorId: "op-1", id: "f", paymentId: "pay_f" },
    ];
    const { ivora, calls } = sweepClient(
      {
        1: detail(),
        2: detail({ active: true, ended_at: null }),
        3: new IvoraError(404, "transaction_not_found", "gone"),
      },
      {
        pay_d: { refunded_minor: 1240 },
        pay_e: {},
        pay_f: new IvoraError(429, "rate_limited", "slow down"),
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await refreshReportRecords(
      { ivora, store, now: () => NOW },
      { details: 10, refunds: 10 },
    );
    expect(r).toEqual({ details: 1, refunds: 2 });
    expect(calls).toEqual([
      "tx:1",
      "tx:2",
      "tx:3",
      "pay:pay_d",
      "pay:pay_e",
      "pay:pay_f",
    ]);
    // Every detail check is noted (so others get their turn); only ended ones keep data.
    expect(store.details.map(([id, d]) => [id, d.endedAt])).toEqual([
      ["a", "2026-10-10T15:00:00Z"],
      ["b", null],
      ["c", null],
    ]);
    // A payment that couldn't be read is not recorded: it is read again later.
    expect(store.refunds).toEqual([
      ["d", 1240],
      ["e", 0],
    ]);
  });

  it("never writes to Ivora: it only reads transactions and payments", async () => {
    const store = memoryStore([]);
    store.detailsDue = async () => [
      { operatorId: "op-1", id: "a", transactionId: 1 },
    ];
    store.refundsDue = async () => [
      { operatorId: "op-1", id: "d", paymentId: "pay_d" },
    ];
    const used = new Set<string>();
    const ivora = new Proxy(sweepClient({ 1: detail() }, { pay_d: {} }).ivora, {
      get(target, prop, recv) {
        used.add(String(prop));
        return Reflect.get(target, prop, recv);
      },
    });
    await refreshReportRecords({ ivora, store, now: () => NOW });
    expect([...used].sort()).toEqual(["getPayment", "getTransaction"]);
  });
});

// ---- Demo mode ----

describe("reports in demo mode", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetIvoraForTests();
    resetDemoLiveForTests();
    resetDemoCheckoutForTests();
    vi.stubGlobal("fetch", () => {
      throw new Error("demo mode must not call fetch");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  const demoStaff: Staff = { ...viewer, operatorId: "demo", demo: true };

  it("runs stats, the sessions table and the CSV export on sample data, offline", async () => {
    const d = getReports();
    expect(d.store.mode).toBe("demo");
    const r = await loadReportsContext(d, demoStaff, params({ period: "90d" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.context.query;
    const stats = await loadStats(d.ivora, q);
    expect(stats.ok).toBe(true);
    const sessions = await loadSessions(
      d,
      reportFilter(demoStaff, q),
      1,
      r.context.places,
    );
    if (!sessions.ok) throw new Error(sessions.error);
    const t = sessions.totals;
    expect(t.withSession).toBeGreaterThan(100);
    expect(t.free).toBeGreaterThan(0);
    // Ivora's figures count more: staff/test and RFID sessions are not the kit's.
    if (stats.ok)
      expect(stats.stats.totals.sessions).toBeGreaterThan(t.withSession);
    const usd = t.currencies.find((l) => l.currency === "USD")!;
    expect(usd.refundedMinor).toBeGreaterThan(0);
    expect(usd.capturedMinor).toBeLessThan(usd.billedMinor);
    const csv = await sessionsCsv(
      d,
      reportFilter(demoStaff, q),
      r.context.places,
    );
    if (!csv.ok) throw new Error(csv.error);
    const lines = (await new Response(csv.body).text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(t.checkouts + 1);
  });

  it("includes every outcome: charged, refunded, released and above the hold", () => {
    const { checkouts } = demoHistory(NOW);
    const t = totalsOf(checkouts);
    expect(t.byStatus.charged).toBeGreaterThan(0);
    expect(t.byStatus.no_charge).toBeGreaterThan(0);
    expect(t.byStatus.attention).toBeGreaterThan(0);
    expect(checkouts.some((c) => (c.refundedMinor ?? 0) > 0)).toBe(true);
    // Every sample is made up: sample chargers, made-up references.
    expect(
      checkouts.every((c) => [9101, 9102, 9103].includes(c.stationId)),
    ).toBe(true);
  });

  it("answers a period that is too long like Ivora: stats_range_too_large", async () => {
    const d = getReports();
    const { query } = parseReportQuery(
      params({
        period: "custom",
        from: "2026-01-01",
        to: "2026-10-20",
        bucket: "hour",
      }),
      "UTC",
      NOW,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loadStats(d.ivora, query);
    expect(r).toMatchObject({ ok: false, tooLarge: true });
    // The sessions table still works for the same period.
    const s = await loadSessions(d, reportFilter(demoStaff, query), 1, places);
    expect(s.ok).toBe(true);
  });

  it("has no Ivora client methods that scan the transaction or bill lists", () => {
    const ivora = getIvora() as unknown as Record<string, unknown>;
    expect(ivora.listTransactionPage).toBeUndefined();
    expect(ivora.listBillPage).toBeUndefined();
  });
});
