import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_PERMISSIONS } from "@/lib/hosts";
import {
  DEMO_HOST_A,
  DEMO_HOST_B,
  demoHostSeed,
} from "@/lib/server/hosts/demo";
import type { HostRecord, HostStore } from "@/lib/server/hosts/types";
import { getIvora, resetIvoraForTests } from "@/lib/server/ivora";
import {
  createDemoNetworkStore,
  demoAccountId,
  memoryDemoNetwork,
  planAt,
  setDemoPayout,
} from "@/lib/server/network/demo";
import {
  hostPaymentsAvailable,
  loadHostMoney,
  loadStatement,
  monthRange,
  parseFeeTerms,
  parseMonth,
  payoutGate,
  rowFees,
  saveFeePlan,
  shiftMonth,
  statementFileName,
  statementHost,
  type NetworkDeps,
} from "@/lib/server/network/service";
import { NetworkError } from "@/lib/server/network/types";
import { createDemoReportsStore } from "@/lib/server/reports/demo";
import type { Staff } from "@/lib/server/team/types";
import type { MemberRole } from "@/lib/roles";

// Network mode's money side in demo mode: fee versions, payout status, the payout
// check before a driver pays, row fees and the two sample hosts' statements. All
// offline: the demo stores and the demo Ivora client, nothing sent anywhere.

const OP = "demo-operator";
const NOW = Date.parse("2026-11-16T12:00:00Z");

const staff = (role: MemberRole, hostId?: string): Staff => ({
  userId: "00000000-0000-4000-8000-000000000001",
  email: "someone@example.com",
  role,
  operatorId: OP,
  operatorName: "Sample Operator",
  demo: true,
  host: hostId
    ? {
        id: hostId,
        name: hostId === DEMO_HOST_A ? "Sample Host A" : "Sample Host B",
        siteIds: demoHostSeed()
          .sites.filter((s) => s.hostId === hostId)
          .map((s) => s.locationId),
        permissions: { ...NO_PERMISSIONS },
      }
    : null,
});

function hostsStub(): HostStore {
  const seed = demoHostSeed();
  return {
    mode: "demo",
    list: async () => seed.hosts.map((h) => ({ ...h }) as HostRecord),
    sites: async () => seed.sites.map((s) => ({ ...s })),
    save: vi.fn(),
    archive: vi.fn(),
    assign: vi.fn(),
    faultRecipients: async () => [],
  } as unknown as HostStore;
}

function setup(o: { currency?: string } = {}) {
  const ivora = getIvora();
  const hosts = hostsStub();
  const cookie = memoryDemoNetwork();
  const reports = createDemoReportsStore({
    ivora,
    own: async () => [],
    now: () => NOW,
  });
  const store = createDemoNetworkStore({
    cookie,
    hosts,
    reports,
    stations: async () =>
      (await ivora.listAllStations()).data.map((s) => ({
        id: s.id,
        locationId: typeof s.location_id === "number" ? s.location_id : null,
      })),
    now: () => NOW,
  });
  const d: NetworkDeps = {
    store,
    hosts,
    ivora,
    company: {
      load: async () => ({ timeZone: "UTC", currency: o.currency ?? "USD" }),
    },
    now: () => NOW,
  };
  return { d, cookie, store, reports };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in tests");
    }),
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetIvoraForTests();
});

describe("fee versions", () => {
  it("only owners and managers set a host's fee", async () => {
    const { d } = setup();
    const form = { mode: "percent", percent: "10" };
    for (const role of ["viewer", "technician"] as const)
      await expect(
        saveFeePlan(d, staff(role), DEMO_HOST_A, form),
      ).rejects.toBeInstanceOf(NetworkError);
    await expect(
      saveFeePlan(d, staff("host", DEMO_HOST_A), DEMO_HOST_A, form),
    ).rejects.toMatchObject({ code: "not_allowed" });
    const plan = await saveFeePlan(d, staff("manager"), DEMO_HOST_A, form);
    expect(plan.terms).toMatchObject({ mode: "percent", percentBps: 1000 });
  });

  it("refuses an unknown host and unreadable amounts", async () => {
    const { d } = setup();
    await expect(
      saveFeePlan(d, staff("owner"), "demo-host-nope", {
        mode: "percent",
        percent: "1",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    for (const bad of [
      { mode: "flat" },
      { mode: "percent", percent: "101" },
      { mode: "percent", percent: "abc" },
      { mode: "per_kwh", perKwh: "0.001" },
      { mode: "per_kwh", perKwh: "-1" },
      { mode: "percent", percent: "5", monthly: "1e5" },
    ])
      expect(() => parseFeeTerms(bad, "USD")).toThrow(NetworkError);
  });

  it("types amounts in the company currency", async () => {
    const { d } = setup({ currency: "CAD" });
    const plan = await saveFeePlan(d, staff("owner"), DEMO_HOST_B, {
      mode: "per_kwh",
      perKwh: "0.04",
      monthly: "12.50",
    });
    expect(plan.terms).toEqual({
      mode: "per_kwh",
      percentBps: 0,
      perKwhMinor: 4,
      monthlyChargerFeeMinor: 1250,
      currency: "CAD",
    });
  });

  it("a change applies to sessions started after it", async () => {
    const { d, store } = setup();
    const before = (await store.feePlans(OP)).find(
      (p) => p.hostId === DEMO_HOST_A,
    )!;
    const after = await saveFeePlan(d, staff("owner"), DEMO_HOST_A, {
      mode: "percent",
      percent: "20",
    });
    const plans = await store.feePlans(OP);
    expect(Date.parse(after.effectiveFrom)).toBeGreaterThanOrEqual(NOW);
    expect(planAt(plans, DEMO_HOST_A, NOW - 1)?.id).toBe(before.id);
    expect(planAt(plans, DEMO_HOST_A, NOW + 1)?.id).toBe(after.id);
    const money = await loadHostMoney(d, staff("manager"));
    expect(money.byHost.get(DEMO_HOST_A)?.history.map((h) => h.id)).toEqual([
      after.id,
      before.id,
    ]);
  });
});

describe("payout check before a driver pays", () => {
  it("a site with no host keeps the operator's own account", async () => {
    const { d } = setup();
    expect(await payoutGate(d, "demo", OP, 123456)).toEqual({
      ok: true,
      hostId: null,
    });
    expect(await payoutGate(d, "live", OP, null)).toEqual({
      ok: true,
      hostId: null,
    });
  });

  it("a host's site needs the host's payouts ready", async () => {
    const { d, cookie } = setup();
    expect(await payoutGate(d, "demo", OP, 9001)).toEqual({
      ok: true,
      hostId: DEMO_HOST_A,
    });
    await setDemoPayout(cookie, DEMO_HOST_A, "action_needed");
    expect(await payoutGate(d, "demo", OP, 9001)).toEqual({
      ok: false,
      hostId: DEMO_HOST_A,
      reason: "action_needed",
    });
    await setDemoPayout(cookie, DEMO_HOST_A, "none");
    expect(await payoutGate(d, "demo", OP, 9002)).toMatchObject({
      ok: false,
      reason: "none",
    });
  });

  it("live mode never pays a host's site into the operator's account", async () => {
    const { d } = setup();
    expect(hostPaymentsAvailable("live")).toBe(false);
    expect(await payoutGate(d, "live", OP, 9001)).toEqual({
      ok: false,
      hostId: DEMO_HOST_A,
      reason: "live_unavailable",
    });
  });

  it("the demo snapshot names the host's account and fee version now", async () => {
    const { store, cookie } = setup();
    expect(await store.snapshot(OP, "ck-1", 9003)).toEqual({
      checkoutId: "ck-1",
      hostId: DEMO_HOST_B,
      locationId: 9003,
      payoutAccountId: demoAccountId(DEMO_HOST_B),
      feePlanId: "demo-fee-b1",
    });
    expect(await store.snapshot(OP, "ck-2", 424242)).toBeNull();
    await setDemoPayout(cookie, DEMO_HOST_B, "none");
    expect(
      (await store.snapshot(OP, "ck-3", 9003))?.payoutAccountId,
    ).toBeNull();
  });
});

describe("statements", () => {
  it("months", () => {
    expect(parseMonth("2026-10")).toBe("2026-10");
    for (const bad of ["2026-13", "2026-1", "26-10", "", null, "1999-01"])
      expect(parseMonth(bad)).toBeNull();
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthRange("2026-10", "UTC")).toEqual({
      fromMs: Date.parse("2026-10-01T00:00:00Z"),
      toMs: Date.parse("2026-11-01T00:00:00Z"),
    });
    // In the site's zone: a month starts at local midnight.
    expect(monthRange("2026-10", "America/Toronto").fromMs).toBe(
      Date.parse("2026-10-01T04:00:00Z"),
    );
  });

  it("operator staff read any host's; a host user only their own", async () => {
    const { d } = setup();
    await expect(
      statementHost(d, staff("viewer"), DEMO_HOST_B),
    ).resolves.toMatchObject({ id: DEMO_HOST_B });
    await expect(
      statementHost(d, staff("host", DEMO_HOST_A), undefined),
    ).resolves.toMatchObject({ id: DEMO_HOST_A });
    await expect(
      statementHost(d, staff("host", DEMO_HOST_A), DEMO_HOST_B),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      statementHost(d, staff("viewer"), "demo-host-unknown"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      statementHost(d, staff("viewer"), "<script>"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  for (const [host, label] of [
    [DEMO_HOST_A, "Host A (per kWh, monthly charger fee)"],
    [DEMO_HOST_B, "Host B (percent, CAD site)"],
  ] as const)
    it(`a sample statement for ${label} adds up`, async () => {
      const { d } = setup();
      const v = await loadStatement(d, staff("owner"), host, "2026-10");
      expect(v.month).toBe("2026-10");
      expect(v.statement.rows.length).toBeGreaterThan(10);
      expect(v.statement.totals.length).toBeGreaterThan(0);
      for (const t of v.statement.totals) {
        const rows = v.statement.rows.filter(
          (r) => r.session.currency === t.currency,
        );
        const money = rows.filter((r) => r.kind === "revenue");
        expect(t.sessions).toBe(rows.length);
        expect(t.amountMinor).toBe(
          money.reduce((a, r) => a + r.amountMinor, 0),
        );
        expect(t.netFeeMinor).toBe(
          money.reduce((a, r) => a + r.netFeeMinor, 0),
        );
        expect(t.hostShareMinor).toBe(
          money.reduce((a, r) => a + r.hostShareMinor, 0),
        );
        expect(t.amountMinor - t.refundedMinor).toBe(
          t.netFeeMinor + t.hostShareMinor,
        );
        expect(t.netFeeMinor).toBeGreaterThan(0);
      }
      // Every session is at one of the host's sites.
      const own = demoHostSeed().sites.filter((s) => s.hostId === host);
      expect(own.length).toBeGreaterThan(0);
      if (host === DEMO_HOST_A)
        expect(v.statement.chargerFee).toMatchObject({
          perChargerMinor: 1500,
          currency: "USD",
        });
      else {
        expect(v.statement.chargerFee).toBeNull();
        // Its Waterfront site charges in CAD: a percentage fee applies in any
        // currency, never converted.
        expect(v.statement.totals.map((t) => t.currency)).toContain("CAD");
      }
      expect(statementFileName(v)).toMatch(
        /^statement-sample-host-[ab]-[a-z-]+-2026-10\.csv$/,
      );
    });

  it("each session uses the fee in effect when it started", async () => {
    const { d, cookie } = setup();
    // A second version from mid-October: earlier sessions keep 8%, later ones 50%.
    const s = await cookie.load();
    s.plans.push({
      id: "demo-fee-b2",
      hostId: DEMO_HOST_B,
      terms: { ...s.plans[1].terms, percentBps: 5000 },
      effectiveFrom: "2026-10-15T00:00:00.000Z",
    });
    await cookie.save(s);
    const v = await loadStatement(d, staff("owner"), DEMO_HOST_B, "2026-10");
    const rows = v.statement.rows.filter(
      (r) => r.kind === "revenue" && r.refundedMinor === 0,
    );
    const early = rows.find(
      (r) => r.session.createdAt < "2026-10-15T00:00:00.000Z",
    )!;
    const late = rows.find(
      (r) => r.session.createdAt >= "2026-10-15T00:00:00.000Z",
    )!;
    expect(early.feeMinor).toBe(
      Math.floor((early.amountMinor * 800 + 5000) / 10000),
    );
    expect(late.feeMinor).toBe(
      Math.floor((late.amountMinor * 5000 + 5000) / 10000),
    );
  });
});

describe("session rows", () => {
  it("show the host, fee and share; a host user sees only their own host's", async () => {
    const { d, reports } = setup();
    const rows = await reports.list(
      {
        operatorId: OP,
        fromMs: Date.parse("2026-10-01T00:00:00Z"),
        toMs: Date.parse("2026-11-01T00:00:00Z"),
        stationId: null,
        status: "charged",
      },
      { limit: 500 },
    );
    const all = await rowFees(d, staff("viewer"), rows);
    const hostIds = new Set([...all.values()].map((f) => f.hostId));
    expect(hostIds).toEqual(new Set([DEMO_HOST_A, DEMO_HOST_B]));
    for (const f of all.values())
      if (f.feeMinor !== null) expect(f.hostShareMinor).not.toBeNull();
    const mine = await rowFees(d, staff("host", DEMO_HOST_A), rows);
    expect(mine.size).toBeGreaterThan(0);
    expect([...mine.values()].every((f) => f.hostId === DEMO_HOST_A)).toBe(
      true,
    );
  });
});
