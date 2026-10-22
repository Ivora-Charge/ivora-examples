import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCode } from "@/lib/server/chargers/types";
import {
  CHECKOUT_LIMITS,
  CHECKOUT_REUSE_MINUTES,
  checkoutUrl,
  driverSessions,
  loadChargePage,
  payAndCharge,
  startPaidSession,
  type CheckoutDeps,
} from "@/lib/server/checkout/service";
import {
  createDemoCheckoutStore,
  memoryDemoCheckout,
  withDemoSimulation,
  type DemoCheckoutSimulation,
} from "@/lib/server/checkout/demo";
import { resetDemoCheckoutForTests } from "@/lib/server/checkout/demo-cookie";
import { CheckoutError } from "@/lib/server/checkout/types";
import { getIvora, resetIvoraForTests } from "@/lib/server/ivora";
import {
  authorizeDemoPayment,
  DEMO_PLUG_IN_MS,
  findDemoBill,
} from "@/lib/server/ivora/demo";
import { cookieDemoFleet } from "@/lib/server/ivora/demo-cookie";
import { IvoraError } from "@/lib/server/ivora/errors";
import { createLiveClient } from "@/lib/server/ivora/live";
import type {
  Bill,
  BillInput,
  IvoraClient,
  Payment,
  PaymentAccount,
  PaymentInput,
  Quote,
  Station,
} from "@/lib/server/ivora/types";
import {
  createDemoPricingStore,
  memoryDemoPricing,
} from "@/lib/server/pricing/demo";
import type {
  PricingState,
  TariffDefinition,
} from "@/lib/server/pricing/types";
import { createMemoryLimiter } from "@/lib/server/rate-limit";

// Driver checkout runs against a fake Ivora client at the client boundary (mode
// "live", so the live branches are covered), the live client over a fake fetch, and
// the demo client offline. No network, no credentials, nothing charged.

const OP = "10000000-0000-4000-8000-0000000000aa";
const CODE = "ABCD2345";
const BILL = `bill_${"c".repeat(32)}`;
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_sample";
const OPERATOR = "Sample Charging Co";

const PAID: TariffDefinition = {
  kind: "paid",
  currency: "USD",
  timeZone: "UTC",
  energyMinorPerKwh: 35,
  sessionFeeMinor: 100,
  idleMinorPerMinute: 0,
  idleGraceMinutes: 0,
  periods: [],
  driverText: null,
};

const version = (ivoraTariffId: number, definition: TariffDefinition) => ({
  version: 1,
  ivoraTariffId,
  attempt: 1,
  attemptedAt: "2026-01-01T00:00:00Z",
  definition,
  createdAt: "2026-01-01T00:00:00Z",
  archivedAt: null,
});

/** Station 9101 is paid, 9102 private, 9103 free, 9104 has no tariff. */
const PRICING: PricingState = {
  tariffs: [
    {
      id: "paid",
      name: "Standard",
      revision: 1,
      versions: [version(777, PAID)],
    },
    {
      id: "free",
      name: "Free",
      revision: 1,
      versions: [version(778, { ...PAID, kind: "free", energyMinorPerKwh: 0 })],
    },
  ],
  stations: [
    {
      stationId: 9101,
      tariffId: "paid",
      private: false,
      connectors: {},
      revision: 1,
    },
    {
      stationId: 9102,
      tariffId: "paid",
      private: true,
      connectors: {},
      revision: 1,
    },
    {
      stationId: 9103,
      tariffId: "free",
      private: false,
      connectors: {},
      revision: 1,
    },
  ],
};

const CODES: Record<string, [number, number] | "removed"> = {
  [CODE]: [9101, 91011],
  PRVT2345: [9102, 91021],
  FREE2345: [9103, 91031],
  NPRC2345: [9104, 91041],
  GHST2345: "removed",
};

function resolveCode(code: string): ResolvedCode | null {
  const c = CODES[code];
  if (!c) return null;
  return {
    code,
    operatorId: OP,
    stationId: c === "removed" ? 9105 : c[0],
    connectorId: c === "removed" ? 91051 : c[1],
    connectorNumber: 1,
    chargerName: "Sample Bay 1",
    inService: c !== "removed",
    operatorName: OPERATOR,
  };
}

const QUOTE: Quote = {
  tariff_id: 777,
  currency: "USD",
  pricing_version: "elements-v1",
  lines: [
    {
      type: "ENERGY",
      element: 0,
      reservation: false,
      quantity: "20.000000",
      unit: "kWh",
      price_minor: "35",
      exact_minor: "700.000000",
      amount_minor: 700,
    },
    {
      type: "FLAT",
      element: 0,
      reservation: false,
      quantity: "1.000000",
      unit: "session",
      price_minor: "100",
      exact_minor: "100.000000",
      amount_minor: 100,
    },
  ],
  subtotal_minor: 800,
  exact_subtotal_minor: "800.000000",
  adjustments: [],
  total_minor: 800,
};

function fakeIvora() {
  const station: Station = {
    id: 9101,
    name: "CP-1",
    online: true,
    connectors: [
      { id: 91011, number: 1, status: "Available", max_power_w: 22_000 },
    ],
  };
  const bill = (progress: Bill["progress"] = "awaiting_payment"): Bill => ({
    id: BILL,
    station_id: 9101,
    connector_id: 91011,
    tariff_id: 777,
    hold_minor: 2500,
    currency: "USD",
    status: "open",
    total_minor: null,
    transaction_id: null,
    created_at: "2026-10-22T10:00:00Z",
    finalized_at: null,
    usage: null,
    progress,
  });
  const api = {
    mode: "live" as const,
    getStation: vi.fn(async (_id: number) => structuredClone(station)),
    getPaymentAccount: vi.fn(async (): Promise<PaymentAccount> => ({
      status: "active",
      charges_enabled: true,
    })),
    quoteTariff: vi.fn(async () => structuredClone(QUOTE)),
    createBill: vi.fn(async (_input: BillInput, _key: string): Promise<Bill> =>
      bill(),
    ),
    createPayment: vi.fn(
      async (input: PaymentInput, _key: string): Promise<Payment> => ({
        id: "pay_sample_1",
        bill_id: input.bill_id,
        status: "pending",
        hold_minor: 2500,
        payment_mode: "test",
        next_action: {
          type: "redirect_to_url",
          redirect_to_url: { url: CHECKOUT_URL },
        },
      }),
    ),
    getBill: vi.fn(async (_id: string) => bill()),
    startBill: vi.fn(async (_id: string, _key: string) => ({
      id: "op_1",
      status: "dispatching" as const,
      result: null,
    })),
  };
  return { api, station, bill, client: api as unknown as IvoraClient };
}

function deps(o: { now?: () => number } = {}) {
  const ivora = fakeIvora();
  const cookie = memoryDemoCheckout();
  const d: CheckoutDeps = {
    store: createDemoCheckoutStore(cookie),
    ivora: ivora.client,
    chargers: { resolveCode: async (c) => resolveCode(c) },
    pricing: { load: async () => structuredClone(PRICING) },
    limiter: createMemoryLimiter(o.now),
    secret: "test-secret",
    cache: new Map(),
    now: o.now,
  };
  return { d, cookie, ...ivora };
}

let n = 0;
const req = () => `30000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const pay = (d: CheckoutDeps, requestId = req(), code = CODE, source = "s1") =>
  payAndCharge(d, { code, requestId, source }, "Default Co");

const ivoraError = (status: number, code: string) =>
  new IvoraError(status, code, `Sample ${code}`, "req_sample");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkout URL", () => {
  it("takes only an https page from next_action, in Stripe's shape or a plain url", () => {
    const of = (next_action: Record<string, unknown> | null) => ({
      next_action,
    });
    expect(
      checkoutUrl(of({ redirect_to_url: { url: CHECKOUT_URL } }), "live"),
    ).toBe(CHECKOUT_URL);
    expect(checkoutUrl(of({ url: CHECKOUT_URL }), "live")).toBe(CHECKOUT_URL);
    for (const bad of [
      "http://checkout.example.com/x",
      "javascript:alert(1)",
      "https://user:pass@checkout.example.com/x",
      "/demo/checkout/pay_1",
      "not a url",
    ])
      expect(checkoutUrl(of({ url: bad }), "live")).toBeNull();
    expect(checkoutUrl(of(null), "live")).toBeNull();
    // The demo's own page only in demo mode, and only that path.
    expect(checkoutUrl(of({ url: "/demo/checkout/pay_1" }), "demo")).toBe(
      "/demo/checkout/pay_1",
    );
    expect(checkoutUrl(of({ url: CHECKOUT_URL }), "demo")).toBeNull();
    expect(checkoutUrl(of({ url: "//evil.example/x" }), "demo")).toBeNull();
  });
});

describe("pay and charge", () => {
  it("creates a bill and a driver-return payment with keys from its own record", async () => {
    const { d, api, cookie } = deps();
    const requestId = req();
    const r = await pay(d, requestId);
    expect(r.url).toBe(CHECKOUT_URL);
    const id = r.id;
    expect(api.createBill).toHaveBeenCalledWith(
      { station_id: 9101, connector_id: 91011, tariff_id: 777 },
      `cpo-checkout-${id}-bill`,
    );
    expect(api.createPayment).toHaveBeenCalledWith(
      { bill_id: BILL, return_surface: "driver", return_reference: id },
      `cpo-checkout-${id}-payment`,
    );
    expect(cookie.state.records[0]).toMatchObject({
      id,
      phase: "checkout",
      billId: BILL,
      paymentId: "pay_sample_1",
      checkoutUrl: CHECKOUT_URL,
      holdMinor: 2500,
      currency: "USD",
    });
    // A double tap: the same checkout, nothing sent again.
    expect(await pay(d, requestId)).toEqual(r);
    expect(api.createBill).toHaveBeenCalledTimes(1);
    expect(api.createPayment).toHaveBeenCalledTimes(1);
  });

  it("repeats an uncertain bill or payment with the same key, never a second one", async () => {
    const { d, api } = deps();
    const requestId = req();
    api.createBill.mockRejectedValueOnce(ivoraError(503, "outcome_unknown"));
    await expect(pay(d, requestId)).rejects.toMatchObject({
      code: "unconfirmed",
      apiCode: "outcome_unknown",
    });
    api.createPayment.mockRejectedValueOnce(ivoraError(0, "network_error"));
    await expect(pay(d, requestId)).rejects.toMatchObject({
      code: "unconfirmed",
    });
    const r = await pay(d, requestId);
    expect(r.url).toBe(CHECKOUT_URL);
    const keys = (m: typeof api.createBill | typeof api.createPayment) =>
      new Set(m.mock.calls.map((c) => c[1]));
    expect(keys(api.createBill)).toEqual(
      new Set([`cpo-checkout-${r.id}-bill`]),
    );
    // The bill was confirmed on the second try: it is not asked for again.
    expect(api.createBill).toHaveBeenCalledTimes(2);
    expect(keys(api.createPayment)).toEqual(
      new Set([`cpo-checkout-${r.id}-payment`]),
    );
    expect(api.createPayment).toHaveBeenCalledTimes(2);
  });

  it("refuses an offline charger, a connector in use or out of order, before any bill", async () => {
    const { d, api, station, cookie } = deps();
    station.online = false;
    const requestId = req();
    await expect(pay(d, requestId)).rejects.toMatchObject({ code: "offline" });
    expect(cookie.state.records[0].phase).toBe("failed");
    // That checkout is closed; the page starts a new one.
    await expect(pay(d, requestId)).rejects.toThrow(/Reload the page/);
    station.online = true;
    for (const [status, code] of [
      ["Charging", "in_use"],
      ["SuspendedEV", "in_use"],
      ["Finishing", "in_use"],
      ["Faulted", "out_of_order"],
      ["Unavailable", "out_of_order"],
    ]) {
      station.connectors[0].status = status;
      await expect(pay(d)).rejects.toMatchObject({ code });
    }
    expect(api.createBill).not.toHaveBeenCalled();
    // A driver who has plugged in (Preparing) can pay.
    station.connectors[0].status = "Preparing";
    expect((await pay(d)).url).toBe(CHECKOUT_URL);
  });

  it("refuses when the operator's Stripe account isn't ready, before or at the payment", async () => {
    const { d, api } = deps();
    for (const account of [
      { status: "none" },
      { status: "pending_review", charges_enabled: true },
      { status: "active", charges_enabled: false },
    ]) {
      api.getPaymentAccount.mockResolvedValueOnce(account);
      await expect(pay(d)).rejects.toMatchObject({
        code: "stripe_not_ready",
        message: expect.stringMatching(/Sample Charging Co can't take card/),
      });
    }
    expect(api.createBill).not.toHaveBeenCalled();
    // Ivora's own answer counts too: the checkout fails, nothing is charged.
    api.createPayment.mockRejectedValueOnce(
      ivoraError(409, "payment_account_not_ready"),
    );
    await expect(pay(d)).rejects.toMatchObject({
      code: "stripe_not_ready",
      apiCode: "payment_account_not_ready",
    });
  });

  it("closes private, free and unpriced connectors and unknown stickers without asking Ivora", async () => {
    const { d, api } = deps();
    await expect(pay(d, req(), "PRVT2345")).rejects.toMatchObject({
      code: "private",
    });
    await expect(pay(d, req(), "FREE2345")).rejects.toMatchObject({
      code: "free",
    });
    await expect(pay(d, req(), "NPRC2345")).rejects.toMatchObject({
      code: "no_price",
    });
    await expect(pay(d, req(), "GHST2345")).rejects.toMatchObject({
      code: "not_in_service",
    });
    await expect(pay(d, req(), "ZZZZ2345")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(pay(d, "not-a-uuid")).rejects.toMatchObject({
      code: "invalid",
    });
    for (const m of Object.values(api))
      if (typeof m === "function") expect(m).not.toHaveBeenCalled();
  });

  it("fails a refused checkout, and never redirects to anything but an https page", async () => {
    const { d, api } = deps();
    api.createBill.mockRejectedValueOnce(ivoraError(409, "tariff_archived"));
    await expect(pay(d)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringMatching(/price of this charger changed/),
    });
    api.createPayment.mockResolvedValueOnce({
      id: "pay_x",
      bill_id: BILL,
      status: "pending",
      hold_minor: 2500,
      payment_mode: "test",
      next_action: { url: "javascript:alert(1)" },
    });
    await expect(pay(d)).rejects.toMatchObject({ code: "unconfirmed" });
    api.createPayment.mockResolvedValueOnce({
      id: "pay_y",
      bill_id: BILL,
      status: "canceled",
      hold_minor: 2500,
      payment_mode: "test",
      next_action: null,
    });
    await expect(pay(d)).rejects.toMatchObject({ code: "expired" });
  });

  it("sends a returning tap to the same checkout page for 55 minutes only", async () => {
    let t = Date.parse("2026-10-22T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t);
    try {
      const { d } = deps({ now: () => t });
      const requestId = req();
      const r = await pay(d, requestId);
      t += (CHECKOUT_REUSE_MINUTES - 1) * 60_000;
      expect((await pay(d, requestId)).url).toBe(r.url);
      t += 2 * 60_000;
      await expect(pay(d, requestId)).rejects.toMatchObject({
        code: "expired",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits checkouts per source, per connector and per operator", async () => {
    const { d, api } = deps();
    for (let i = 0; i < CHECKOUT_LIMITS.source.quota; i++) await pay(d);
    await expect(pay(d)).rejects.toMatchObject({ code: "rate_limited" });
    // Other sources still can, until the connector's own cap (a refused attempt
    // does not count against it).
    const left = CHECKOUT_LIMITS.connector.quota - CHECKOUT_LIMITS.source.quota;
    for (let i = 0; i < left; i++) await pay(d, req(), CODE, `other-${i}`);
    // Without a trusted client address only the connector and operator caps apply.
    await expect(pay(d, req(), CODE, null as never)).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(api.createBill).toHaveBeenCalledTimes(
      CHECKOUT_LIMITS.connector.quota,
    );
  });
});

describe("the sticker page", () => {
  it("shows the price with Ivora's quote of an example session, and the status", async () => {
    const { d, api } = deps();
    const page = await loadChargePage(d, "abcd2345", OPERATOR);
    expect(page).toMatchObject({
      state: "open",
      code: CODE,
      operatorName: OPERATOR,
      chargerName: "Sample Bay 1",
      tariffName: "Standard",
      hold: "$25.00",
      closed: null,
      connector: { status: "Available", blocked: null, maxPowerKw: 22 },
      example: {
        lines: [
          { label: "Energy, 20 kWh", amount: "$7.00" },
          { label: "Session fee", amount: "$1.00" },
        ],
        total: "$8.00",
      },
    });
    expect(page.priceText).toMatch(/\$0\.35 per kWh/);
    expect(api.quoteTariff).toHaveBeenCalledWith(
      777,
      expect.objectContaining({
        energy_kwh: 20,
        duration_minutes: 60,
        idle_minutes: 0,
        time_zone: "UTC",
      }),
    );
    // Page views share short-lived reads: opening it often can't spend the API limit.
    await loadChargePage(d, CODE, OPERATOR);
    expect(api.getStation).toHaveBeenCalledTimes(1);
    expect(api.getPaymentAccount).toHaveBeenCalledTimes(1);
    expect(api.quoteTariff).toHaveBeenCalledTimes(1);
  });

  it("says why paying is off, and still shows the price when a read fails", async () => {
    const { d, api, station } = deps();
    station.online = false;
    expect((await loadChargePage(d, CODE, OPERATOR)).closed).toMatchObject({
      code: "offline",
    });
    const fresh = deps();
    fresh.api.getPaymentAccount.mockResolvedValueOnce({ status: "none" });
    fresh.api.getStation.mockRejectedValueOnce(ivoraError(503, "unavailable"));
    const page = await loadChargePage(fresh.d, CODE, OPERATOR);
    expect(page.closed?.code).toBe("stripe_not_ready");
    expect(page.readError).toMatch(/status can't be read/);
    expect(page.example?.total).toBe("$8.00");
    expect(
      (await loadChargePage(d, "PRVT2345", OPERATOR)).closed,
    ).toMatchObject({
      code: "private",
      message: expect.stringMatching(/private charger/),
    });
    expect((await loadChargePage(d, "GHST2345", OPERATOR)).state).toBe(
      "not_in_service",
    );
    expect((await loadChargePage(d, "nope", OPERATOR)).state).toBe("unknown");
    expect(api.createBill).not.toHaveBeenCalled();
  });
});

describe("a returning driver", () => {
  it("sees their own session, and starts it only when Ivora's automatic start was refused", async () => {
    const { d, api, bill } = deps();
    const { id } = await pay(d);
    const other = (await pay(d, req(), CODE, "s2")).id;
    // Only the checkouts in this browser's cookie, at this sticker.
    expect(await driverSessions(d, CODE, [])).toEqual([]);
    expect(await driverSessions(d, "PRVT2345", [id])).toEqual([]);
    api.getBill.mockResolvedValueOnce({
      ...bill("charging"),
      usage: {
        transaction_id: 5,
        active: true,
        energy_wh: 7_450,
        estimated_minor: 361,
        started_at: "2026-10-22T10:01:00Z",
        ended_at: null,
      },
    });
    expect(await driverSessions(d, CODE, [id])).toMatchObject([
      {
        id,
        label: "Charging",
        energyKwh: "7.45",
        estimate: "$3.61",
        canStart: false,
      },
    ]);
    await expect(
      startPaidSession(d, { code: CODE, id: other, ids: [id] }, OPERATOR),
    ).rejects.toMatchObject({ code: "not_found" });
    api.getBill.mockResolvedValue(bill("charging"));
    await expect(
      startPaidSession(d, { code: CODE, id, ids: [id] }, OPERATOR),
    ).rejects.toThrow(/already started/);
    api.getBill.mockResolvedValue(bill("authorized"));
    expect((await driverSessions(d, CODE, [id]))[0]).toMatchObject({
      label: "Paid, not started",
      canStart: true,
    });
    api.startBill.mockRejectedValueOnce(ivoraError(409, "station_offline"));
    await expect(
      startPaidSession(d, { code: CODE, id, ids: [id] }, OPERATOR),
    ).rejects.toMatchObject({ code: "offline" });
    await startPaidSession(d, { code: CODE, id, ids: [id] }, OPERATOR);
    // One key per checkout: Ivora answers any repeat with the bill's one start.
    expect(new Set(api.startBill.mock.calls.map((c) => c[1]))).toEqual(
      new Set([`cpo-checkout-${id}-start`]),
    );
    expect(api.startBill).toHaveBeenCalledWith(
      BILL,
      `cpo-checkout-${id}-start`,
    );
  });
});

// ---- The live client over a fake fetch ----

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (() => Response)[]) {
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
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const header = (c: Call, name: string) =>
  new Headers(c.init.headers as Record<string, string>).get(name);

describe("live client bills and payments", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.IVORA_API_KEY = "test-key-not-real";
    process.env.IVORA_TENANT_ID = "42";
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    delete process.env.DEMO_MODE;
    vi.stubGlobal("fetch", () => {
      throw new Error("tests must not reach the network");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });
  const client = (api: ReturnType<typeof fakeFetch>) =>
    createLiveClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key-not-real",
      tenantId: "42",
      fetch: api.fetch,
      sleep: async () => {},
    });

  it("sends the bill, the hosted payment and the start with our keys, repeating the same key", async () => {
    const api = fakeFetch([
      json(503, { error: { code: "outcome_unknown", message: "?" } }),
      json(201, { id: BILL }),
      json(201, { id: "pay_1", next_action: null }),
      json(200, { id: BILL, progress: "authorized" }),
      json(202, { id: "op_1", status: "dispatching", result: null }),
      json(200, QUOTE),
    ]);
    const c = client(api);
    await c.createBill(
      { station_id: 9101, connector_id: 91011, tariff_id: 777 },
      "cpo-checkout-x1-bill",
    );
    await c.createPayment(
      { bill_id: BILL, return_surface: "driver", return_reference: "x1" },
      "cpo-checkout-x1-payment",
    );
    await c.getBill(BILL);
    await c.startBill(BILL, "cpo-checkout-x1-start");
    await c.quoteTariff(777, {
      start_at: "2026-10-22T10:00:00Z",
      time_zone: "UTC",
      duration_minutes: 60,
      energy_kwh: 20,
      idle_minutes: 0,
    });
    const [b1, b2, p, g, s, q] = api.calls;
    for (const b of [b1, b2]) {
      expect(b.url).toBe("https://api.example.test/v1/tenants/42/bills");
      expect(header(b, "idempotency-key")).toBe("cpo-checkout-x1-bill");
      expect(JSON.parse(String(b.init.body))).toEqual({
        station_id: 9101,
        connector_id: 91011,
        tariff_id: 777,
        source: "csms",
      });
    }
    expect(p.url).toBe(
      "https://api.example.test/payment/stripe/v1/tenants/42/payments",
    );
    expect(header(p, "idempotency-key")).toBe("cpo-checkout-x1-payment");
    expect(JSON.parse(String(p.init.body))).toEqual({
      bill_id: BILL,
      return_surface: "driver",
      return_reference: "x1",
    });
    expect(g.url).toBe(`https://api.example.test/v1/tenants/42/bills/${BILL}`);
    expect(g.init.method).toBe("GET");
    expect(s.url).toBe(
      `https://api.example.test/v1/tenants/42/bills/${BILL}/start`,
    );
    expect(header(s, "idempotency-key")).toBe("cpo-checkout-x1-start");
    expect(q.url).toBe(
      "https://api.example.test/v1/tenants/42/tariffs/777/quote",
    );
    // A quote stores nothing: no key.
    expect(header(q, "idempotency-key")).toBeNull();
    // Never the Stripe keys: the kit has none. Only the Ivora key is sent.
    for (const c of api.calls)
      expect(header(c, "authorization")).toBe("Bearer test-key-not-real");
  });

  it("refuses a bill or payment without a key", async () => {
    const api = fakeFetch([]);
    await expect(
      client(api).createBill(
        { station_id: 1, connector_id: 1, tariff_id: 1 },
        "",
      ),
    ).rejects.toThrow(/Idempotency-Key/);
    await expect(
      client(api).createPayment(
        { bill_id: BILL, return_surface: "driver", return_reference: "x" },
        "",
      ),
    ).rejects.toThrow(/Idempotency-Key/);
    expect(api.calls).toHaveLength(0);
  });
});

// ---- Demo mode, end to end ----

describe("demo checkout", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    for (const k of ["IVORA_API_KEY", "IVORA_TENANT_ID", "DEMO_MODE"])
      delete process.env[k];
    resetIvoraForTests();
    resetDemoCheckoutForTests();
    fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  function demoDeps(simulate: DemoCheckoutSimulation = "none") {
    const cookie = memoryDemoCheckout({ v: 1, simulate, records: [] });
    const d: CheckoutDeps = {
      store: createDemoCheckoutStore(cookie),
      ivora: withDemoSimulation(
        getIvora(),
        async () => (await cookie.load()).simulate,
      ),
      chargers: {
        resolveCode: async (c) =>
          c === CODE
            ? {
                code: c,
                operatorId: "demo-operator",
                stationId: 9101,
                connectorId: 91011,
                connectorNumber: 1,
                chargerName: "DEMO-HARBOUR-01",
                inService: true,
                operatorName: null,
              }
            : null,
      },
      pricing: createDemoPricingStore(memoryDemoPricing()),
      limiter: createMemoryLimiter(),
      secret: "demo-mode",
      cache: new Map(),
    };
    return { d, cookie };
  }

  it("simulates the whole flow, with a receipt, and charges nothing", async () => {
    let t = Date.parse("2026-10-20T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t);
    const { d } = demoDeps();
    const page = await loadChargePage(d, CODE, "Sample Co");
    expect(page.closed).toBeNull();
    expect(page.example?.total).toBeTruthy();
    const { id, url } = await pay(d);
    expect(url).toMatch(/^\/demo\/checkout\/pay_demo_[0-9a-f]+$/);
    expect((await driverSessions(d, CODE, [id]))[0].label).toBe(
      "Waiting for payment",
    );
    // "Pay with demo card": the hold is authorized and the charger starts.
    const payment = decodeURIComponent(url.split("/").pop()!);
    expect(await authorizeDemoPayment(cookieDemoFleet(), payment)).toEqual({
      returnReference: id,
    });
    const billId = (await findDemoBill(cookieDemoFleet(), id))!;
    expect((await getIvora().getBill(billId)).progress).toBe(
      "waiting_for_vehicle",
    );
    t += DEMO_PLUG_IN_MS + 30 * 60_000;
    vi.setSystemTime(t);
    const charging = await getIvora().getBill(billId);
    expect(charging.progress).toBe("charging");
    expect(charging.usage?.energy_wh).toBe(3_700);
    // 3.7 kWh at $0.35 plus the $1.00 session fee, priced offline.
    expect(charging.usage?.estimated_minor).toBe(230);
    // The connector is in use for everyone else now.
    await expect(pay(d)).rejects.toMatchObject({ code: "in_use" });
    await getIvora().sendCommand(
      9101,
      { action: "stop", transaction_id: charging.usage!.transaction_id! },
      `cpo-demo-${billId}-stop`,
    );
    const ended = await getIvora().getBill(billId);
    expect(ended.progress).toBe("ended");
    expect(ended.usage?.estimated_minor).toBe(230);
    expect((await driverSessions(d, CODE, [id]))[0].label).toBe("Finished");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("simulates an offline charger, a connector in use and a Stripe account that isn't ready", async () => {
    for (const [sim, code] of [
      ["offline", "offline"],
      ["in_use", "in_use"],
      ["stripe_not_ready", "stripe_not_ready"],
    ] as const) {
      const { d } = demoDeps(sim);
      expect((await loadChargePage(d, CODE, "Sample Co")).closed?.code).toBe(
        code,
      );
      await expect(pay(d)).rejects.toBeInstanceOf(CheckoutError);
      await expect(pay(d)).rejects.toMatchObject({ code });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
