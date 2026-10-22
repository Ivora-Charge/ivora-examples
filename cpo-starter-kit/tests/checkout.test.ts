import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCode } from "@/lib/server/chargers/types";
import {
  CHECKOUT_LIMITS,
  checkoutAlerts,
  checkoutUrl,
  CREATING_STALE_MINUTES,
  driverSessions,
  FREE_START_WAIT_MINUTES,
  HOLD_STOP_PERCENT,
  HOLD_STOP_RETRY_MINUTES,
  loadChargePage,
  nearHold,
  PAYMENT_WINDOW_MINUTES,
  payAndCharge,
  settleCheckout,
  settleOpenCheckouts,
  STALLED_HOURS,
  START_RESERVED_MINUTES,
  startFreeSession,
  startPaidSession,
  stopDriverSession,
  UNSTARTED_RELEASE_MINUTES,
  type CheckoutDeps,
} from "@/lib/server/checkout/service";
import {
  createDemoCheckoutStore,
  memoryDemoCheckout,
  withDemoSimulation,
  type DemoCheckoutSimulation,
} from "@/lib/server/checkout/demo";
import { resetDemoCheckoutForTests } from "@/lib/server/checkout/demo-cookie";
import { cronAuthorized } from "@/lib/server/checkout/cron-auth";
import { CheckoutError } from "@/lib/server/checkout/types";
import { getIvora, resetIvoraForTests } from "@/lib/server/ivora";
import { authorizeDemoPayment, DEMO_PLUG_IN_MS } from "@/lib/server/ivora/demo";
import { cookieDemoFleet } from "@/lib/server/ivora/demo-cookie";
import { IvoraError } from "@/lib/server/ivora/errors";
import { createLiveClient } from "@/lib/server/ivora/live";
import type {
  Bill,
  BillInput,
  BillUsage,
  CommandInput,
  IvoraClient,
  Operation,
  Payment,
  PaymentAccount,
  PaymentInput,
  Quote,
  Station,
  Tariff,
  TokenInput,
  TokenRecord,
  Transaction,
} from "@/lib/server/ivora/types";
import { createDemoLiveStore, memoryDemoLive } from "@/lib/server/live/demo";
import {
  FREE_TOKEN_LABEL,
  freeTokenReference,
  isFreeSession,
  isStaffSession,
} from "@/lib/server/live/service";
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
const T0 = Date.parse("2026-10-22T10:00:00Z");

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
const FREE: TariffDefinition = { ...PAID, kind: "free", energyMinorPerKwh: 0 };

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
const pricing = (free: TariffDefinition = FREE): PricingState => ({
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
      versions: [version(778, free)],
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
});

const CODES: Record<string, [number, number] | "removed"> = {
  [CODE]: [9101, 91011],
  PRVT2345: [9102, 91021],
  FREE2345: [9103, 91031],
  FRE22345: [9103, 91032],
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

const usage = (o: Partial<BillUsage> = {}): BillUsage => ({
  transaction_id: 5,
  active: true,
  energy_wh: 7_450,
  estimated_minor: 361,
  started_at: "2026-10-22T10:01:00Z",
  ended_at: null,
  ...o,
});

/**
 * A fake Ivora at the client boundary. `bill` is what the next bill read answers (its
 * progress and usage), `payment` the payment's state; captures and releases change it
 * like the API: capture takes exactly the final bill (or releases a bill under 50
 * cents), and a bill above its hold is refused.
 */
function fakeIvora() {
  const station: Station = {
    id: 9101,
    name: "CP-1",
    online: true,
    connectors: [
      { id: 91011, number: 1, status: "Available", max_power_w: 22_000 },
    ],
  };
  const freeStation: Station = {
    id: 9103,
    name: "CP-3",
    online: true,
    connectors: [
      { id: 91031, number: 1, status: "Available" },
      { id: 91032, number: 2, status: "Available" },
    ],
  };
  const state = {
    progress: "awaiting_payment" as NonNullable<Bill["progress"]>,
    usage: null as BillUsage | null,
    final: null as number | null,
    payment: "pending" as Payment["status"],
    /** The bill's hold, as Ivora set it (the tariff's unless changed in Ivora). */
    hold: 2500,
    paymentKey: "",
    captured: 0,
    startCreatedAt: null as string | null,
    tokens: [] as TokenRecord[],
    transactions: [] as Transaction[],
    /** Older sessions at the stations (other drivers, other tokens). */
    history: [] as Transaction[],
  };
  const bill = (): Bill => ({
    id: BILL,
    station_id: 9101,
    connector_id: 91011,
    tariff_id: 777,
    hold_minor: state.hold,
    currency: "USD",
    status: state.final === null ? "open" : "final",
    total_minor: state.final,
    transaction_id: state.usage?.transaction_id ?? null,
    created_at: "2026-10-22T10:00:00Z",
    finalized_at: null,
    usage: state.usage && { ...state.usage },
    start_operation: state.startCreatedAt
      ? {
          id: "op_start",
          status: "succeeded",
          result: null,
          created_at: state.startCreatedAt,
        }
      : null,
    progress: state.final === null ? state.progress : "ended",
  });
  const payment = (): Payment => ({
    id: "pay_sample_1",
    bill_id: BILL,
    status: state.payment,
    hold_minor: state.hold,
    captured_minor: state.captured,
    payment_mode: "test",
    next_action:
      state.payment === "pending"
        ? { type: "redirect_to_url", redirect_to_url: { url: CHECKOUT_URL } }
        : null,
  });
  const api = {
    mode: "live" as const,
    getStation: vi.fn(async (id: number) =>
      structuredClone(id === 9103 ? freeStation : station),
    ),
    getPaymentAccount: vi.fn(async (): Promise<PaymentAccount> => ({
      status: "active",
      charges_enabled: true,
    })),
    getTariff: vi.fn(async (id: number): Promise<Tariff> => ({
      id,
      currency: "USD",
      rate_minor_per_kwh: 35,
      authorization_minor: id === 778 ? 0 : 2500,
    })),
    quoteTariff: vi.fn(async () => structuredClone(QUOTE)),
    createBill: vi.fn(async (_input: BillInput, _key: string) => bill()),
    // One payment per bill (key): a new checkout's payment starts pending.
    createPayment: vi.fn(async (_input: PaymentInput, key: string) => {
      if (key !== state.paymentKey) {
        state.paymentKey = key;
        state.payment = "pending";
        state.captured = 0;
      }
      return payment();
    }),
    getBill: vi.fn(async (_id: string) => bill()),
    startBill: vi.fn(async (_id: string, _key: string): Promise<Operation> => ({
      id: "op_1",
      status: "dispatching",
      result: null,
    })),
    finalizeBill: vi.fn(async (_id: string, _tx: number, _key: string) => {
      state.final ??= state.usage?.estimated_minor ?? 0;
      return bill();
    }),
    getPayment: vi.fn(async (_id: string) => payment()),
    capturePayment: vi.fn(async (_id: string, _key: string) => {
      if (state.final === null)
        throw new IvoraError(409, "bill_not_final", "Not final");
      if (state.final > state.hold)
        throw new IvoraError(409, "bill_exceeds_hold", "Above the hold");
      if (state.payment === "authorized") {
        state.payment = state.final < 50 ? "canceled" : "captured";
        state.captured = state.final < 50 ? 0 : state.final;
      }
      return payment();
    }),
    releasePayment: vi.fn(async (_id: string, _key: string) => {
      if (state.usage)
        throw new IvoraError(409, "start_reserved", "A session matched");
      if (state.payment === "captured")
        throw new IvoraError(409, "payment_captured", "Captured");
      state.payment = "canceled";
      return payment();
    }),
    recordHoldStop: vi.fn(async (_id: string, _key: string) => {}),
    sendCommand: vi.fn(
      async (
        _station: number,
        _c: CommandInput,
        key: string,
      ): Promise<Operation> => ({
        id: `op_${key}`,
        status: "succeeded",
        result: { charger_status: "Accepted" },
      }),
    ),
    getOperation: vi.fn(async (id: string): Promise<Operation> => ({
      id,
      status: "succeeded",
      result: { charger_status: "Accepted" },
    })),
    // Like Ivora's GET /transactions: oldest first by ID, paged with `after`, and items
    // without the ID token or connector (only GET /transactions/{id} has those).
    listTransactions: vi.fn(
      async (o: { limit?: number; station_id?: number } = {}) =>
        listed(o.station_id, 0, o.limit ?? 50).data as Transaction[],
    ),
    listTransactionsAfter: vi.fn(
      async (o: { station_id: number; after: number; limit?: number }) =>
        listed(o.station_id, o.after, o.limit ?? 100),
    ),
    getTransaction: vi.fn(async (id: number) => {
      const t = [...state.history, ...state.transactions].find(
        (x) => x.id === id,
      );
      if (!t) throw new IvoraError(404, "transaction_not_found", "Unknown");
      return structuredClone(t);
    }),
    findToken: vi.fn(
      async (ref: string) =>
        state.tokens.find((t) => t.external_reference === ref) ?? null,
    ),
    createToken: vi.fn(async (input: TokenInput, _key: string) => {
      const seen = state.tokens.find(
        (t) => t.external_reference === input.external_reference,
      );
      if (seen) return seen;
      const t = { id: 501, ...input };
      state.tokens.push(t);
      return t;
    }),
  };
  function listed(stationId: number | undefined, after: number, limit: number) {
    const rows = [...state.history, ...state.transactions]
      .filter(
        (t) =>
          (stationId === undefined || t.station_id === stationId) &&
          t.id > after,
      )
      .sort((a, b) => a.id - b.id);
    const data = rows.slice(0, Math.min(limit, 100)).map((t) => ({
      id: t.id,
      station_id: t.station_id,
      active: t.active,
      started_at: t.started_at,
      ended_at: t.ended_at,
    }));
    return {
      data,
      next_cursor: rows.length > data.length ? data[data.length - 1].id : null,
    };
  }
  /** The driver paid: Ivora's bill read then starts the charger. */
  const paid = (progress: NonNullable<Bill["progress"]> = "authorized") => {
    state.payment = "authorized";
    state.progress = progress;
  };
  return {
    api,
    station,
    freeStation,
    state,
    bill,
    paid,
    client: api as unknown as IvoraClient,
  };
}

function deps(o: { now?: () => number; pricing?: () => PricingState } = {}) {
  const ivora = fakeIvora();
  const cookie = memoryDemoCheckout();
  const live = createDemoLiveStore(memoryDemoLive());
  const d: CheckoutDeps = {
    store: createDemoCheckoutStore(cookie, o.now),
    ivora: ivora.client,
    chargers: { resolveCode: async (c) => resolveCode(c) },
    pricing: { load: async () => structuredClone((o.pricing ?? pricing)()) },
    tokens: live,
    limiter: createMemoryLimiter(o.now),
    secret: "test-secret",
    cache: new Map(),
    now: o.now,
  };
  return { d, cookie, live, ...ivora };
}

/** A clock the test moves. */
function clock() {
  const c = {
    t: T0,
    now: () => c.t,
    add: (min: number) => (c.t += min * 60_000),
  };
  return c;
}

let n = 0;
const req = () => `30000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const pay = (d: CheckoutDeps, requestId = req(), code = CODE, source = "s1") =>
  payAndCharge(d, { code, requestId, source }, "Default Co");
const startFree = (
  d: CheckoutDeps,
  requestId = req(),
  code = "FREE2345",
  source = "s1",
) => startFreeSession(d, { code, requestId, source }, "Default Co");

const ivoraError = (status: number, code: string) =>
  new IvoraError(status, code, `Sample ${code}`, "req_sample");

/** The one record a test made. */
const only = (cookie: ReturnType<typeof memoryDemoCheckout>) => {
  expect(cookie.state.records).toHaveLength(1);
  return cookie.state.records[0];
};
const settle = async (
  d: CheckoutDeps,
  cookie: ReturnType<typeof memoryDemoCheckout>,
) => {
  await settleCheckout(d, (await d.store.get(OP, only(cookie).id))!);
  return only(cookie);
};

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
    expect(r).toEqual({ requestId, url: CHECKOUT_URL });
    const rec = only(cookie);
    expect(api.createBill).toHaveBeenCalledWith(
      { station_id: 9101, connector_id: 91011, tariff_id: 777 },
      `cpo-checkout-${rec.id}-bill`,
    );
    // The return_reference is its own random value: not the record ID (the keys) and
    // not the request ID (the browser's capability).
    expect(rec.reference).toMatch(/^ck_[0-9a-f]{32}$/);
    expect(api.createPayment).toHaveBeenCalledWith(
      {
        bill_id: BILL,
        return_surface: "driver",
        return_reference: rec.reference,
      },
      `cpo-checkout-${rec.id}-payment`,
    );
    expect(JSON.stringify(api.createPayment.mock.calls)).not.toContain(
      requestId,
    );
    expect(rec).toMatchObject({
      phase: "open",
      billId: BILL,
      paymentId: "pay_sample_1",
      checkoutUrl: CHECKOUT_URL,
      // From the Ivora tariff's authorization_minor.
      holdMinor: 2500,
      currency: "USD",
    });
    expect(api.getTariff).toHaveBeenCalledWith(777);
    // A double tap: the same checkout, nothing sent again.
    expect(await pay(d, requestId)).toEqual(r);
    expect(api.createBill).toHaveBeenCalledTimes(1);
    expect(api.createPayment).toHaveBeenCalledTimes(1);
  });

  it("repeats an uncertain bill or payment with the same key, never a second one", async () => {
    const { d, api, cookie } = deps();
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
    const id = only(cookie).id;
    const keys = (m: typeof api.createBill | typeof api.createPayment) =>
      new Set(m.mock.calls.map((c) => c[1]));
    expect(keys(api.createBill)).toEqual(new Set([`cpo-checkout-${id}-bill`]));
    // The bill was confirmed on the second try: it is not asked for again.
    expect(api.createBill).toHaveBeenCalledTimes(2);
    expect(keys(api.createPayment)).toEqual(
      new Set([`cpo-checkout-${id}-payment`]),
    );
    expect(api.createPayment).toHaveBeenCalledTimes(2);
  });

  it("refuses an offline charger, a connector in use or out of order, before any bill", async () => {
    const { d, api, station, cookie } = deps();
    station.online = false;
    const requestId = req();
    await expect(pay(d, requestId)).rejects.toMatchObject({ code: "offline" });
    expect(only(cookie).phase).toBe("failed");
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
      await expect(pay(d, req(), CODE, `src-${status}`)).rejects.toMatchObject({
        code,
      });
    }
    expect(api.createBill).not.toHaveBeenCalled();
    // A driver who has plugged in (Preparing) can pay.
    station.connectors[0].status = "Preparing";
    expect((await pay(d, req(), CODE, "src-ok")).url).toBe(CHECKOUT_URL);
  });

  it("refuses when the operator's Stripe account isn't ready, before or at the payment", async () => {
    const { d, api } = deps();
    for (const account of [
      { status: "none" },
      { status: "pending_review", charges_enabled: true },
      { status: "active", charges_enabled: false },
    ]) {
      api.getPaymentAccount.mockResolvedValueOnce(account);
      await expect(pay(d, req(), CODE, account.status)).rejects.toMatchObject({
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

  it("closes private and unpriced connectors and unknown stickers without asking Ivora", async () => {
    const { d, api } = deps();
    await expect(pay(d, req(), "PRVT2345")).rejects.toMatchObject({
      code: "private",
    });
    // A free tariff never takes a card: it has its own "Start free session".
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

  it("takes the hold from the Ivora tariff, and refuses one Ivora Checkout can't hold", async () => {
    const { d, api, cookie, state } = deps();
    state.hold = 4000;
    api.getTariff.mockResolvedValueOnce({
      id: 777,
      currency: "USD",
      rate_minor_per_kwh: 35,
      authorization_minor: 4000,
    });
    await pay(d);
    expect(only(cookie).holdMinor).toBe(4000);
    const other = deps();
    other.api.getTariff.mockResolvedValue({
      id: 777,
      currency: "USD",
      rate_minor_per_kwh: 35,
      authorization_minor: 20,
    });
    await expect(pay(other.d)).rejects.toMatchObject({ code: "no_price" });
    expect(other.api.createBill).not.toHaveBeenCalled();
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
  });

  it("reopens the same payment page only within the payment window", async () => {
    const c = clock();
    const { d } = deps({ now: c.now });
    const requestId = req();
    const r = await pay(d, requestId);
    c.add(PAYMENT_WINDOW_MINUTES - 1);
    expect((await pay(d, requestId)).url).toBe(r.url);
    c.add(2);
    await expect(pay(d, requestId)).rejects.toMatchObject({
      code: "expired",
    });
  });

  it("limits checkouts per source, per source and connector, and per operator", async () => {
    const { d, api, station } = deps();
    // Each attempt is refused (offline), so the connector stays free: only limits count.
    station.online = false;
    const attempt = (source: string | null) =>
      pay(d, req(), CODE, source as string).catch((e: CheckoutError) => e.code);
    for (let i = 0; i < CHECKOUT_LIMITS.sourceConnector.quota; i++)
      expect(await attempt("s1")).toBe("offline");
    // One person can't keep a connector busy: their own cap on it runs out first.
    expect(await attempt("s1")).toBe("rate_limited");
    // Others still can.
    expect(await attempt("s2")).toBe("offline");
    // Without a trusted client address, a per-connector cap stands in.
    for (let i = 0; i < CHECKOUT_LIMITS.connector.quota; i++)
      expect(await attempt(null)).toBe("offline");
    expect(await attempt(null)).toBe("rate_limited");
    expect(api.createBill).not.toHaveBeenCalled();
  });

  it("lets one source that never pays hold a connector for at most half an hour", async () => {
    const c = clock();
    const { d, api } = deps({ now: c.now });
    // Tap, never pay; the payment window passes and frees the connector; tap again.
    await pay(d, req(), CODE, "s1");
    c.add(PAYMENT_WINDOW_MINUTES + 1);
    await pay(d, req(), CODE, "s1");
    c.add(PAYMENT_WINDOW_MINUTES + 1);
    await expect(pay(d, req(), CODE, "s1")).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(api.createBill).toHaveBeenCalledTimes(2);
    // Someone else gets the connector.
    await pay(d, req(), CODE, "s2");
    expect(
      CHECKOUT_LIMITS.sourceConnector.quota * PAYMENT_WINDOW_MINUTES,
    ).toBeLessThanOrEqual(30);
    expect(CHECKOUT_LIMITS.sourceConnector.periodSeconds).toBe(3600);
  });
});

describe("one driver per connector", () => {
  it("tells a second driver the connector is in use before any hold, and frees it when the first is done", async () => {
    const c = clock();
    const { d, api, cookie } = deps({ now: c.now });
    const first = req();
    await pay(d, first);
    // Someone else, while the first driver is on the payment page.
    await expect(pay(d, req(), CODE, "s2")).rejects.toMatchObject({
      code: "in_use",
    });
    expect(api.createBill).toHaveBeenCalledTimes(1);
    expect(api.createPayment).toHaveBeenCalledTimes(1);
    // The page says so too, to everyone but the first driver.
    expect((await loadChargePage(d, CODE, OPERATOR)).closed?.code).toBe(
      "in_use",
    );
    expect(await loadChargePage(d, CODE, OPERATOR, [first])).toMatchObject({
      mine: true,
      closed: { code: "in_use", message: expect.stringMatching(/You already/) },
    });
    // The first driver never pays: after the payment window the hold is released and
    // the next driver's tap claims the connector.
    c.add(PAYMENT_WINDOW_MINUTES + 1);
    await pay(d, req(), CODE, "s3");
    expect(cookie.state.records.map((r) => r.phase)).toEqual([
      "released",
      "open",
    ]);
    expect(api.releasePayment).toHaveBeenCalledTimes(1);
  });
});

describe("settlement", () => {
  /** A paid, charging session: pay, then the driver's payment and the start. */
  async function charging(o: { now?: () => number } = {}) {
    const x = deps(o);
    await pay(x.d);
    x.paid("charging");
    x.state.usage = usage();
    return x;
  }

  it("finalizes an ended session and captures exactly the final bill", async () => {
    const { d, api, state, cookie } = await charging();
    // While charging, nothing is finalized or captured.
    await settle(d, cookie);
    expect(api.finalizeBill).not.toHaveBeenCalled();
    state.usage = usage({ active: false, ended_at: "2026-10-22T10:40:00Z" });
    state.progress = "ended";
    const rec = await settle(d, cookie);
    expect(api.finalizeBill).toHaveBeenCalledWith(
      BILL,
      5,
      `cpo-checkout-${rec.id}-finalize`,
    );
    expect(api.capturePayment).toHaveBeenCalledWith(
      "pay_sample_1",
      `cpo-checkout-${rec.id}-capture`,
    );
    // 7.45 kWh at $0.35 plus the $1.00 session fee: $3.61 of the $25.00 hold.
    expect(rec).toMatchObject({
      phase: "settled",
      transactionId: 5,
      finalMinor: 361,
      capturedMinor: 361,
    });
    expect(state.captured).toBe(361);
    const [s] = await driverSessions(d, CODE, [rec.requestId]);
    expect(s).toMatchObject({
      label: "Finished",
      receipt: { charged: "$3.61", released: "$21.39", hold: "$25.00" },
      canStop: false,
    });
    // Settled once: later runs send nothing.
    await settleOpenCheckouts(d);
    expect(api.capturePayment).toHaveBeenCalledTimes(1);
  });

  it("releases the hold of a session with no energy (a zero or sub-50-cent bill)", async () => {
    for (const [energy_wh, estimated_minor] of [
      [0, 0],
      [100, 30],
    ]) {
      const { d, state, cookie } = await charging();
      state.usage = usage({ active: false, energy_wh, estimated_minor });
      state.progress = "ended";
      const rec = await settle(d, cookie);
      expect(rec).toMatchObject({
        phase: "settled",
        finalMinor: estimated_minor,
        capturedMinor: 0,
      });
      expect(state.payment).toBe("canceled");
      const [s] = await driverSessions(d, CODE, [rec.requestId]);
      expect(s.receipt).toMatchObject({ charged: "$0.00", released: "$25.00" });
    }
  });

  it("stops the session before its cost reaches the hold: 80 kWh at $0.35 never exceeds $25", async () => {
    const { d, api, state, cookie } = await charging();
    // 60 kWh: $21.00 + $1.00 = $22.00, under 90% of $25.00. Charging goes on.
    state.usage = usage({ energy_wh: 60_000, estimated_minor: 2200 });
    await settle(d, cookie);
    expect(api.sendCommand).not.toHaveBeenCalled();
    // 62 kWh: $22.70, past 90% ($22.50). The kit stops it and records the hold stop.
    state.usage = usage({ energy_wh: 62_000, estimated_minor: 2270 });
    const rec = await settle(d, cookie);
    expect(api.sendCommand).toHaveBeenCalledWith(
      9101,
      { action: "stop", transaction_id: 5 },
      `cpo-checkout-${rec.id}-stop`,
    );
    expect(api.recordHoldStop).toHaveBeenCalledWith(
      BILL,
      `cpo-checkout-${rec.id}-hold-stop`,
    );
    expect(rec.stopRequestedAt).not.toBeNull();
    // Once: the next run does not stop it again.
    await settle(d, cookie);
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
    // The session ends a little later at $22.98 and is captured under the hold, where
    // 80 kWh would have cost $29.00.
    state.usage = usage({
      active: false,
      energy_wh: 62_800,
      estimated_minor: 2298,
    });
    state.progress = "ended";
    expect(await settle(d, cookie)).toMatchObject({
      phase: "settled",
      capturedMinor: 2298,
    });
    expect(nearHold(80 * 35 + 100, 2500)).toBe(true);
    expect(nearHold(2249, 2500)).toBe(false);
    expect(HOLD_STOP_PERCENT).toBeLessThan(100);
  });

  it("retries an uncertain stop, finalize or capture with the same key", async () => {
    const { d, api, state, cookie } = await charging();
    state.usage = usage({ estimated_minor: 2400 });
    api.sendCommand.mockRejectedValueOnce(ivoraError(503, "outcome_unknown"));
    await settle(d, cookie);
    expect(only(cookie).stopRequestedAt).toBeNull();
    await settle(d, cookie);
    expect(new Set(api.sendCommand.mock.calls.map((c) => c[2]))).toEqual(
      new Set([`cpo-checkout-${only(cookie).id}-stop`]),
    );
    expect(only(cookie).stopRequestedAt).not.toBeNull();
    state.usage = usage({ active: false, estimated_minor: 2410 });
    state.progress = "ended";
    api.finalizeBill.mockRejectedValueOnce(ivoraError(0, "network_error"));
    expect((await settle(d, cookie)).phase).toBe("settling");
    api.capturePayment.mockRejectedValueOnce(
      ivoraError(503, "outcome_unknown"),
    );
    expect((await settle(d, cookie)).phase).toBe("settling");
    const rec = await settle(d, cookie);
    expect(rec).toMatchObject({ phase: "settled", capturedMinor: 2410 });
    expect(new Set(api.finalizeBill.mock.calls.map((c) => c[2]))).toEqual(
      new Set([`cpo-checkout-${rec.id}-finalize`]),
    );
    expect(new Set(api.capturePayment.mock.calls.map((c) => c[1]))).toEqual(
      new Set([`cpo-checkout-${rec.id}-capture`]),
    );
  });

  it("hands a bill above its hold to the operator instead of undercharging silently", async () => {
    const { d, state, cookie } = await charging();
    state.usage = usage({ active: false, estimated_minor: 2650 });
    state.progress = "ended";
    const rec = await settle(d, cookie);
    expect(rec).toMatchObject({ phase: "attention", finalMinor: 2650 });
    expect(rec.error).toMatch(/above the card hold \(\$25\.00\)/);
    const [s] = await driverSessions(d, CODE, [rec.requestId]);
    expect(s.detail).toMatch(
      /never charged more than your card hold of \$25\.00/,
    );
  });

  it("releases unused holds at once: canceled, never started, refused start, failed start", async () => {
    // Canceled (the checkout expired): nothing to release, nothing charged.
    {
      const { d, api, state, cookie } = deps();
      await pay(d);
      state.progress = "canceled";
      state.payment = "canceled";
      expect((await settle(d, cookie)).phase).toBe("released");
      expect(api.releasePayment).not.toHaveBeenCalled();
    }
    // Paid but never started: released after UNSTARTED_RELEASE_MINUTES.
    {
      const c = clock();
      const { d, api, paid, cookie } = deps({ now: c.now });
      await pay(d);
      paid("authorized");
      c.add(UNSTARTED_RELEASE_MINUTES - 1);
      expect((await settle(d, cookie)).phase).toBe("open");
      c.add(2);
      const rec = await settle(d, cookie);
      expect(rec).toMatchObject({ phase: "released", capturedMinor: 0 });
      expect(api.releasePayment).toHaveBeenCalledWith(
        "pay_sample_1",
        `cpo-checkout-${rec.id}-release`,
      );
    }
    // The start failed and no session matched: released; while Ivora still reserves
    // the start, the kit keeps trying with the same key.
    {
      const { d, api, state, paid, cookie } = deps();
      await pay(d);
      paid("start_failed");
      api.releasePayment.mockRejectedValueOnce(
        ivoraError(409, "start_reserved"),
      );
      expect((await settle(d, cookie)).phase).toBe("releasing");
      expect((await settle(d, cookie)).phase).toBe("released");
      expect(state.payment).toBe("canceled");
      expect(new Set(api.releasePayment.mock.calls.map((c) => c[1])).size).toBe(
        1,
      );
    }
    // A start reached the charger, but no car was plugged in.
    {
      const c = clock();
      const { d, state, paid, cookie } = deps({ now: c.now });
      await pay(d);
      paid("waiting_for_vehicle");
      state.startCreatedAt = new Date(c.t).toISOString();
      c.add(START_RESERVED_MINUTES - 1);
      expect((await settle(d, cookie)).phase).toBe("open");
      c.add(2);
      expect((await settle(d, cookie)).phase).toBe("released");
    }
    // A tap whose payment page was never handed out holds nothing: closed.
    {
      const c = clock();
      const { d, api, cookie } = deps({ now: c.now });
      api.createBill.mockRejectedValueOnce(ivoraError(503, "outcome_unknown"));
      await pay(d).catch(() => {});
      c.add(CREATING_STALE_MINUTES + 1);
      expect((await settle(d, cookie)).phase).toBe("released");
      expect(api.releasePayment).not.toHaveBeenCalled();
    }
  });

  it("settles from a webhook cue at one station, and the sweep needs its secret", async () => {
    const { d, api, state, cookie } = await charging();
    state.usage = usage({ active: false });
    state.progress = "ended";
    expect(await settleOpenCheckouts(d, { stationId: 9999 })).toBe(0);
    expect(await settleOpenCheckouts(d, { stationId: 9101 })).toBe(1);
    expect(only(cookie).phase).toBe("settled");
    expect(api.capturePayment).toHaveBeenCalledTimes(1);
    const secret = "s".repeat(32);
    expect(cronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    expect(cronAuthorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(cronAuthorized(secret, secret)).toBe(false);
    expect(cronAuthorized(null, secret)).toBe(false);
    // Too short a secret turns the sweep off.
    expect(cronAuthorized("Bearer short", "short")).toBe(false);
  });

  it("settles against the bill's hold when Ivora's differs from the tariff's", async () => {
    // The tariff says $25.00; the bill Ivora made holds $40.00 (raised in Ivora).
    const { d, api, state, paid, cookie } = deps();
    state.hold = 4000;
    await pay(d);
    expect(only(cookie).holdMinor).toBe(4000);
    paid("charging");
    // $30.00 is past 90% of the tariff's hold but well under the bill's: no stop.
    state.usage = usage({ energy_wh: 82_800, estimated_minor: 3000 });
    await settle(d, cookie);
    expect(api.sendCommand).not.toHaveBeenCalled();
    state.usage = usage({
      active: false,
      energy_wh: 82_800,
      estimated_minor: 3000,
    });
    state.progress = "ended";
    const rec = await settle(d, cookie);
    expect(rec).toMatchObject({
      phase: "settled",
      holdMinor: 4000,
      finalMinor: 3000,
      capturedMinor: 3000,
    });
    const [s] = await driverSessions(d, CODE, [rec.requestId]);
    expect(s.receipt).toEqual({
      charged: "$30.00",
      released: "$10.00",
      hold: "$40.00",
    });
  });

  it("follows a hold Ivora changed after the checkout was recorded", async () => {
    const { d, state, paid, cookie } = deps();
    await pay(d);
    expect(only(cookie).holdMinor).toBe(2500);
    // Ivora answers with a $40.00 hold from now on (the bill is the truth).
    state.hold = 4000;
    paid("charging");
    state.usage = usage({
      active: false,
      energy_wh: 82_800,
      estimated_minor: 3000,
    });
    state.progress = "ended";
    expect(await settle(d, cookie)).toMatchObject({
      phase: "settled",
      holdMinor: 4000,
      capturedMinor: 3000,
    });
  });

  it("sends the hold stop once more when the charger ignores it, then alerts the operator in Live", async () => {
    const c = clock();
    const { d, api, state, paid, cookie } = deps({ now: c.now });
    await pay(d);
    paid("charging");
    state.usage = usage({ energy_wh: 62_000, estimated_minor: 2270 });
    const id = (await settle(d, cookie)).id;
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
    // Still charging, but not long enough to retry.
    c.add(HOLD_STOP_RETRY_MINUTES - 1);
    state.usage = usage({ energy_wh: 62_400, estimated_minor: 2284 });
    await settle(d, cookie);
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
    c.add(2);
    expect((await settle(d, cookie)).stopRetriedAt).not.toBeNull();
    expect(api.sendCommand).toHaveBeenLastCalledWith(
      9101,
      { action: "stop", transaction_id: 5 },
      `cpo-checkout-${id}-hold-stop-retry`,
    );
    expect(await checkoutAlerts(d, OP)).toEqual([]);
    // It keeps charging after the retry: the operator is told, and no third stop.
    c.add(HOLD_STOP_RETRY_MINUTES);
    state.usage = usage({ energy_wh: 63_000, estimated_minor: 2305 });
    expect((await settle(d, cookie)).alert).toBe("hold_stop_ignored");
    await settle(d, cookie);
    expect(api.sendCommand).toHaveBeenCalledTimes(2);
    expect(await checkoutAlerts(d, OP)).toMatchObject([
      {
        title: "Still charging after the hold stop",
        stationId: 9101,
        billId: BILL,
      },
    ]);
    // Once it ends and is captured, the alert leaves Live.
    state.usage = usage({
      active: false,
      energy_wh: 63_000,
      estimated_minor: 2305,
    });
    state.progress = "ended";
    expect((await settle(d, cookie)).phase).toBe("settled");
    expect(await checkoutAlerts(d, OP)).toEqual([]);
  });

  it("stops a session the charger never ends, settles its bill and frees the connector", async () => {
    const c = clock();
    const { d, api, state, paid, cookie } = deps({ now: c.now });
    const mine = req();
    await pay(d, mine);
    paid("charging");
    state.usage = usage({ energy_wh: 40_000, estimated_minor: 1500 });
    await settle(d, cookie);
    // Energy that still moves is a session that runs, however long.
    c.add(11 * 60);
    state.usage = usage({ energy_wh: 41_000, estimated_minor: 1535 });
    expect((await settle(d, cookie)).phase).toBe("open");
    c.add(STALLED_HOURS * 60 - 1);
    expect((await settle(d, cookie)).phase).toBe("open");
    expect(api.sendCommand).not.toHaveBeenCalled();
    // Nothing reported for STALLED_HOURS while Ivora still sees it running (a lost
    // StopTransaction). Ivora can't finalize a running transaction yet.
    c.add(2);
    api.finalizeBill.mockRejectedValue(ivoraError(409, "transaction_active"));
    const rec = await settle(d, cookie);
    expect(rec).toMatchObject({ phase: "settling", alert: "stalled" });
    expect(api.sendCommand).toHaveBeenCalledWith(
      9101,
      { action: "stop", transaction_id: 5 },
      `cpo-checkout-${rec.id}-stall-stop`,
    );
    expect(api.finalizeBill).toHaveBeenCalledWith(
      BILL,
      5,
      `cpo-checkout-${rec.id}-finalize`,
    );
    // The stop is tried once; settlement keeps trying the same finalize.
    await settle(d, cookie);
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
    expect(api.finalizeBill).toHaveBeenCalledTimes(2);
    // The operator sees it in Live, and the driver is told.
    expect(await checkoutAlerts(d, OP)).toMatchObject([
      {
        title: "The charger never ended a session",
        detail: expect.stringMatching(/freed the connector/),
      },
    ]);
    expect((await driverSessions(d, CODE, [mine]))[0]).toMatchObject({
      label: "Stopped",
      detail: expect.stringMatching(
        /never charged more than your card hold of \$25\.00/,
      ),
      canStop: false,
    });
    // The connector is free for the next driver.
    expect((await loadChargePage(d, CODE, OPERATOR)).closed).toBeNull();
    // The session ends in Ivora: finalized and captured as the bill says, $15.35.
    api.finalizeBill.mockRestore();
    api.finalizeBill.mockImplementation(async () => {
      state.final ??= 1535;
      return {
        ...(await api.getBill(BILL)),
        status: "final" as const,
        total_minor: 1535,
      };
    });
    state.usage = usage({
      active: false,
      energy_wh: 41_000,
      estimated_minor: 1535,
    });
    expect(await settle(d, cookie)).toMatchObject({
      phase: "settled",
      capturedMinor: 1535,
    });
    expect(await checkoutAlerts(d, OP)).toEqual([]);
  });

  it("hands a stalled session that never ends in Ivora to the operator", async () => {
    const c = clock();
    const { d, api, state, paid, cookie } = deps({ now: c.now });
    await pay(d);
    paid("charging");
    state.usage = usage();
    await settle(d, cookie);
    api.finalizeBill.mockRejectedValue(ivoraError(409, "transaction_active"));
    c.add(STALLED_HOURS * 60 + 1);
    expect((await settle(d, cookie)).phase).toBe("settling");
    // A day after the checkout it still can't be finalized: attention, still in Live.
    c.add(12 * 60);
    expect((await settle(d, cookie)).phase).toBe("attention");
    expect(api.capturePayment).not.toHaveBeenCalled();
    expect(await checkoutAlerts(d, OP)).toMatchObject([
      {
        title: "The charger never ended a session",
        detail: expect.stringMatching(/before the \$25\.00 hold lapses/),
      },
    ]);
  });
});

describe("a returning driver", () => {
  it("sees their own session, and starts it only when Ivora's automatic start was refused", async () => {
    const { d, api, state, paid, station } = deps();
    const mine = req();
    await pay(d, mine);
    // Only the taps in this browser's cookie, at this sticker.
    expect(await driverSessions(d, CODE, [])).toEqual([]);
    expect(await driverSessions(d, "PRVT2345", [mine])).toEqual([]);
    paid("charging");
    state.usage = usage();
    expect(await driverSessions(d, CODE, [mine])).toMatchObject([
      {
        requestId: mine,
        label: "Charging",
        energyKwh: "7.45",
        estimate: "$3.61",
        canStart: false,
        canStop: true,
        note: expect.stringMatching(/stops by itself at about \$22\.50/),
      },
    ]);
    // Someone else's request ID is not a capability for this one.
    await expect(
      startPaidSession(
        d,
        { code: CODE, requestId: req(), requestIds: [mine] },
        OPERATOR,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      startPaidSession(
        d,
        { code: CODE, requestId: mine, requestIds: [mine] },
        OPERATOR,
      ),
    ).rejects.toThrow(/already started/);
    state.usage = null;
    state.progress = "authorized";
    expect((await driverSessions(d, CODE, [mine]))[0]).toMatchObject({
      label: "Paid, not started",
      canStart: true,
    });
    // Only to an Available connector: a car plugged in (Preparing) could be anyone's.
    station.connectors[0].status = "Preparing";
    await expect(
      startPaidSession(
        d,
        { code: CODE, requestId: mine, requestIds: [mine] },
        OPERATOR,
      ),
    ).rejects.toMatchObject({
      code: "in_use",
      message: expect.stringMatching(/hold stays in place/),
    });
    station.connectors[0].status = "Available";
    await startPaidSession(
      d,
      { code: CODE, requestId: mine, requestIds: [mine] },
      OPERATOR,
    );
    expect(api.startBill).toHaveBeenCalledTimes(1);
    expect(api.startBill.mock.calls[0][1]).toMatch(/^cpo-checkout-.+-start$/);
  });

  it("releases the hold at once when the start is refused, and says so", async () => {
    const { d, api, paid, cookie } = deps();
    const mine = req();
    await pay(d, mine);
    paid("authorized");
    api.startBill.mockRejectedValueOnce(ivoraError(409, "station_offline"));
    const e = await startPaidSession(
      d,
      { code: CODE, requestId: mine, requestIds: [mine] },
      OPERATOR,
    ).then(
      () => null,
      (x: CheckoutError) => x,
    );
    expect(e).toMatchObject({ code: "refused", apiCode: "station_offline" });
    if (!e) throw new Error("expected a refusal");
    expect(e.message).toMatch(/hold was released/);
    expect(e.message).not.toMatch(/Nothing was charged/);
    expect(only(cookie)).toMatchObject({ phase: "released", capturedMinor: 0 });
    expect(api.releasePayment).toHaveBeenCalledTimes(1);
    expect((await driverSessions(d, CODE, [mine]))[0].label).toBe(
      "Not charged",
    );
  });

  it("says the hold is being released while Ivora still holds the release back", async () => {
    const { d, api, paid, cookie } = deps();
    const mine = req();
    await pay(d, mine);
    paid("authorized");
    api.startBill.mockRejectedValueOnce(ivoraError(409, "station_offline"));
    // Ivora keeps answering start_reserved until the start can't produce a session.
    api.releasePayment.mockRejectedValue(ivoraError(409, "start_reserved"));
    const e = await startPaidSession(
      d,
      { code: CODE, requestId: mine, requestIds: [mine] },
      OPERATOR,
    ).then(
      () => null,
      (x: CheckoutError) => x,
    );
    expect(e?.message).toMatch(/hold is being released/);
    expect(e?.message).not.toMatch(/was released/);
    expect(only(cookie).phase).toBe("releasing");
    const [s] = await driverSessions(d, CODE, [mine]);
    expect(s.detail).toMatch(
      /^The charger did not start\. .*is being released/,
    );
    expect(s.detail).not.toMatch(/was released/);
    // Once Ivora lets it go: released, for the same reason.
    api.releasePayment.mockRestore();
    const [after] = await driverSessions(d, CODE, [mine]);
    expect(after.label).toBe("Not charged");
    expect(after.detail).toMatch(/^The charger did not start\. .*was released/);
  });

  it("stops their own session, and settles it", async () => {
    const { d, api, state, paid, cookie } = deps();
    const mine = req();
    await pay(d, mine);
    paid("charging");
    state.usage = usage();
    await expect(
      stopDriverSession(d, { code: CODE, requestId: mine, requestIds: [] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await stopDriverSession(d, {
      code: CODE,
      requestId: mine,
      requestIds: [mine],
    });
    expect(api.sendCommand).toHaveBeenCalledWith(
      9101,
      { action: "stop", transaction_id: 5 },
      `cpo-checkout-${only(cookie).id}-stop`,
    );
  });
});

describe("free sessions", () => {
  it("starts with the operator's free charging token, registered once and labelled", async () => {
    const { d, api, live, cookie, state } = deps();
    const page = await loadChargePage(d, "FREE2345", OPERATOR);
    expect(page).toMatchObject({ kind: "free", closed: null, hold: null });
    // No payment of any kind for a free session.
    expect(api.getPaymentAccount).not.toHaveBeenCalled();
    const mine = req();
    await startFree(d, mine);
    expect(api.createToken).toHaveBeenCalledWith(
      {
        id_token: expect.stringMatching(/^FREE[A-Z0-9]{16}$/),
        type: "Central",
        status: "Accepted",
        label: FREE_TOKEN_LABEL,
        external_reference: freeTokenReference(OP),
      },
      `cpo-free-token-${OP}-create`,
    );
    const token = (await live.getFreeToken(OP))!.idToken;
    const rec = only(cookie);
    expect(api.sendCommand).toHaveBeenCalledWith(
      9103,
      {
        action: "start",
        connector_id: 91031,
        token,
        token_type: "Central",
      },
      `cpo-checkout-${rec.id}-start`,
    );
    expect(rec).toMatchObject({ kind: "free", phase: "open", holdMinor: 0 });
    expect(api.createBill).not.toHaveBeenCalled();
    expect(api.createPayment).not.toHaveBeenCalled();
    // A second free start adopts the token in Ivora: no second one.
    await startFree(d, req(), "FREE2345", "s2").catch(() => {});
    expect(api.createToken).toHaveBeenCalledTimes(1);
    // The session shows as free, never as a staff/test session.
    const tx: Transaction = {
      id: 77,
      station_id: 9103,
      connector_id: 91031,
      active: true,
      id_token: `****${token.slice(-4)}`,
      started_at: new Date().toISOString(),
      ended_at: null,
    };
    state.transactions = [tx];
    expect(isFreeSession(tx, token)).toBe(true);
    expect(isStaffSession(tx, "STAFFAAAAAAAAAAAAAAA")).toBe(false);
  });

  it("never uses the free token for a paid tariff, even one that turns paid while the page is open", async () => {
    const { d, api } = deps();
    await expect(startFree(d, req(), CODE)).rejects.toMatchObject({
      code: "not_free",
    });
    // Free when the page opened and when the tap was checked, paid a moment later.
    let reads = 0;
    const flipping = deps({
      pricing: () => pricing(++reads <= 1 ? FREE : PAID),
    });
    await expect(startFree(flipping.d)).rejects.toMatchObject({
      code: "not_free",
    });
    expect(flipping.cookie.state.records[0]).toMatchObject({ phase: "failed" });
    for (const x of [api, flipping.api]) {
      expect(x.sendCommand).not.toHaveBeenCalled();
      expect(x.createBill).not.toHaveBeenCalled();
    }
  });

  it("starts only on an Available connector, and not while the token is blocked", async () => {
    const { d, api, freeStation, state } = deps();
    freeStation.connectors[0].status = "Preparing";
    await expect(startFree(d)).rejects.toMatchObject({ code: "in_use" });
    freeStation.connectors[0].status = "Available";
    // The operator blocked the token in Ivora: free starts are off at once.
    state.tokens.splice(0, state.tokens.length, {
      id: 9,
      id_token: "FREEBLOCKEDTOKEN0000",
      status: "Blocked",
      external_reference: freeTokenReference(OP),
    });
    await expect(startFree(d, req(), "FREE2345", "s2")).rejects.toMatchObject({
      code: "free_not_ready",
    });
    expect(api.sendCommand).not.toHaveBeenCalled();
  });

  it("claims the connector like a paid one, is rate limited, and keeps an uncertain start stoppable", async () => {
    const c = clock();
    const { d, api, cookie, state, live } = deps({ now: c.now });
    api.sendCommand.mockRejectedValueOnce(ivoraError(503, "outcome_unknown"));
    const mine = req();
    await expect(startFree(d, mine)).rejects.toMatchObject({
      code: "unconfirmed",
    });
    expect(only(cookie).phase).toBe("open");
    // Another driver: in use, nothing sent.
    await expect(startFree(d, req(), "FREE2345", "s2")).rejects.toMatchObject({
      code: "in_use",
    });
    // The same tap within a minute repeats the start with the same key.
    await startFree(d, mine);
    expect(new Set(api.sendCommand.mock.calls.map((x) => x[2]))).toEqual(
      new Set([`cpo-checkout-${only(cookie).id}-start`]),
    );
    // Uncertain or not, the driver can stop a session that shows up.
    const token = (await live.getFreeToken(OP))!.idToken;
    state.transactions = [
      {
        id: 88,
        station_id: 9103,
        connector_id: 91031,
        active: true,
        id_token: `****${token.slice(-4)}`,
        started_at: new Date(c.t).toISOString(),
        ended_at: null,
      },
    ];
    expect((await driverSessions(d, "FREE2345", [mine]))[0]).toMatchObject({
      label: "Charging (free)",
      canStop: true,
    });
    await stopDriverSession(d, {
      code: "FREE2345",
      requestId: mine,
      requestIds: [mine],
    });
    expect(api.sendCommand).toHaveBeenLastCalledWith(
      9103,
      { action: "stop", transaction_id: 88 },
      `cpo-checkout-${only(cookie).id}-stop`,
    );
    state.transactions[0] = {
      ...state.transactions[0],
      active: false,
      ended_at: new Date(c.t).toISOString(),
    };
    expect((await settle(d, cookie)).phase).toBe("settled");
    // Spam from one source runs into its limits.
    const attempts: string[] = [];
    for (let i = 0; i < 12; i++)
      attempts.push(
        await startFree(d, req(), "FREE2345", "spam").then(
          () => "ok",
          (e: CheckoutError) => e.code,
        ),
      );
    expect(attempts).toContain("rate_limited");
  });

  it("applies the rate limits before reading the free token or writing anything", async () => {
    const { d, api, cookie } = deps();
    const codes: string[] = [];
    for (let i = 0; i < 40; i++)
      codes.push(
        await startFree(d, req(), "FREE2345", "spam").then(
          () => "ok",
          (e: CheckoutError) => e.code,
        ),
      );
    expect(codes.filter((x) => x === "rate_limited").length).toBe(
      40 - CHECKOUT_LIMITS.sourceConnector.quota,
    );
    // One Ivora token read per tap the limits let through, and one record.
    expect(api.findToken).toHaveBeenCalledTimes(
      CHECKOUT_LIMITS.sourceConnector.quota,
    );
    expect(cookie.state.records).toHaveLength(1);
  });

  it("stops a free session the charger never ends and frees the connector", async () => {
    const c = clock();
    const { d, api, cookie, state, live } = deps({ now: c.now });
    await startFree(d);
    const token = (await live.getFreeToken(OP))!.idToken;
    state.transactions = [
      {
        id: 89,
        station_id: 9103,
        connector_id: 91031,
        active: true,
        id_token: `****${token.slice(-4)}`,
        started_at: new Date(c.t).toISOString(),
        ended_at: null,
        energy_wh: 9_000,
      },
    ];
    await settle(d, cookie);
    c.add(STALLED_HOURS * 60 + 1);
    const rec = await settle(d, cookie);
    expect(rec).toMatchObject({ phase: "attention", alert: "stalled" });
    expect(api.sendCommand).toHaveBeenLastCalledWith(
      9103,
      { action: "stop", transaction_id: 89 },
      `cpo-checkout-${rec.id}-stall-stop`,
    );
    const stops = api.sendCommand.mock.calls.length;
    await settleOpenCheckouts(d);
    expect(api.sendCommand).toHaveBeenCalledTimes(stops);
    expect(await checkoutAlerts(d, OP)).toMatchObject([
      { kind: "free", title: "The charger never ended a session" },
    ]);
    const [s] = await driverSessions(d, "FREE2345", [rec.requestId]);
    expect(s).toMatchObject({ label: "Stopped" });
    expect(s.detail).toMatch(/Nothing was charged/);
    // The connector is free again.
    expect((await loadChargePage(d, "FREE2345", OPERATOR)).closed).toBeNull();
  });

  it("finds a live free session behind more than 1,000 older ones, and labels it", async () => {
    const c = clock();
    const { d, api, cookie, state, live } = deps({ now: c.now });
    // 1,200 earlier sessions at this charger, other drivers, oldest first in the list.
    state.history = Array.from({ length: 1200 }, (_, i) => ({
      id: i + 1,
      station_id: 9103,
      connector_id: 91031,
      active: false,
      id_token: "****OTHR",
      started_at: "2025-06-01T08:00:00Z",
      ended_at: "2025-06-01T09:00:00Z",
      energy_wh: 10_000,
    }));
    const mine = req();
    await startFree(d, mine);
    // The free start itself reads no transactions list.
    expect(api.listTransactions).not.toHaveBeenCalled();
    expect(api.listTransactionsAfter).not.toHaveBeenCalled();
    const token = (await live.getFreeToken(OP))!.idToken;
    c.add(1);
    state.transactions = [
      {
        id: 1201,
        station_id: 9103,
        connector_id: 91031,
        active: true,
        id_token: `****${token.slice(-4)}`,
        started_at: new Date(c.t).toISOString(),
        ended_at: null,
        energy_wh: 1_200,
      },
    ];
    expect((await driverSessions(d, "FREE2345", [mine]))[0]).toMatchObject({
      label: "Charging (free)",
      canStop: true,
    });
    expect(only(cookie)).toMatchObject({
      kind: "free",
      phase: "open",
      transactionId: 1201,
    });
    // Only the new session was read in full; the old ones were paged past.
    expect(
      api.getTransaction.mock.calls.filter(([id]) => id !== 1201),
    ).toHaveLength(0);
    expect(await live.getTransactionMark(9103)).toBe(1200);
    // Found by ID from now on: no more list pages.
    const pages = api.listTransactionsAfter.mock.calls.length;
    c.add(30);
    state.transactions[0] = {
      ...state.transactions[0],
      active: false,
      ended_at: new Date(c.t).toISOString(),
    };
    expect((await settle(d, cookie)).phase).toBe("settled");
    expect(api.listTransactionsAfter).toHaveBeenCalledTimes(pages);
  });

  it("finds two free sessions at one station, whichever checkout looks first", async () => {
    const c = clock();
    const { d, cookie, state, live } = deps({ now: c.now });
    const a = req();
    await startFree(d, a, "FREE2345", "s1");
    c.add(2);
    const b = req();
    await startFree(d, b, "FRE22345", "s2");
    const token = (await live.getFreeToken(OP))!.idToken;
    const session = (id: number, connector: number) => ({
      id,
      station_id: 9103,
      connector_id: connector,
      active: true,
      id_token: `****${token.slice(-4)}`,
      started_at: new Date(c.t).toISOString(),
      ended_at: null,
    });
    state.transactions = [session(41, 91031), session(42, 91032)];
    // B's page looks first; the scan gives A its session too.
    expect((await driverSessions(d, "FRE22345", [b]))[0]).toMatchObject({
      label: "Charging (free)",
    });
    const byRequest = (r: string) =>
      cookie.state.records.find((x) => x.requestId === r)!;
    expect(byRequest(a).transactionId).toBe(41);
    expect(byRequest(b).transactionId).toBe(42);
    // Long after, with the mark past both, each is still read by its own ID.
    c.add(60);
    expect((await driverSessions(d, "FREE2345", [a]))[0]).toMatchObject({
      label: "Charging (free)",
    });
  });

  it("takes a webhook's transaction ID as a hint, read from the API first", async () => {
    const { d, api, cookie, state, live } = deps();
    await startFree(d);
    const token = (await live.getFreeToken(OP))!.idToken;
    state.transactions = [
      {
        id: 77,
        station_id: 9103,
        connector_id: 91031,
        active: true,
        id_token: `****${token.slice(-4)}`,
        started_at: new Date().toISOString(),
        ended_at: null,
      },
    ];
    await settleOpenCheckouts(d, { stationId: 9103, transactionId: 77 });
    expect(only(cookie).transactionId).toBe(77);
    expect(api.listTransactionsAfter).not.toHaveBeenCalled();
    // Someone else's session in the event is not taken.
    const other = deps();
    await startFree(other.d);
    other.state.transactions = [
      { ...state.transactions[0], id: 78, id_token: "****OTHR" },
    ];
    await settleOpenCheckouts(other.d, { stationId: 9103, transactionId: 78 });
    expect(only(other.cookie).transactionId).toBeNull();
  });

  it("stops starting new checkouts once the sweep's time budget is spent", async () => {
    const { d } = deps();
    await startFree(d, req(), "FREE2345", "s1");
    await startFree(d, req(), "FRE22345", "s2");
    expect(await settleOpenCheckouts(d, { budgetMs: -1 })).toBe(1);
    expect(await settleOpenCheckouts(d)).toBe(2);
  });

  it("frees the connector when no session starts", async () => {
    const c = clock();
    const { d, cookie } = deps({ now: c.now });
    await startFree(d);
    c.add(FREE_START_WAIT_MINUTES + 1);
    expect((await settle(d, cookie)).phase).toBe("released");
  });
});

describe("the sticker page", () => {
  it("shows the price with Ivora's quote of an example session, the hold and the status", async () => {
    const { d, api } = deps();
    const page = await loadChargePage(d, "abcd2345", OPERATOR);
    expect(page).toMatchObject({
      state: "open",
      kind: "paid",
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
    expect(api.getTariff).toHaveBeenCalledTimes(1);
    // The hold shown is the tariff's own.
    const other = deps();
    other.api.getTariff.mockResolvedValue({
      id: 777,
      currency: "USD",
      rate_minor_per_kwh: 35,
      authorization_minor: 5000,
    });
    expect((await loadChargePage(other.d, CODE, OPERATOR)).hold).toBe("$50.00");
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

  it("settles through the published endpoints: finalize, capture, release, hold stop", async () => {
    const api = fakeFetch([
      json(200, { id: 777, authorization_minor: 2500 }),
      json(200, { id: BILL, status: "final", total_minor: 361 }),
      json(200, { id: "pay_1", status: "captured", captured_minor: 361 }),
      json(200, { id: "pay_1", status: "canceled" }),
      json(200, { id: "pay_1", status: "authorized" }),
      json(201, { id: "alert_1", kind: "hold_stop" }),
    ]);
    const c = client(api);
    expect((await c.getTariff(777)).authorization_minor).toBe(2500);
    await c.finalizeBill(BILL, 5, "cpo-checkout-x1-finalize");
    await c.capturePayment("pay_1", "cpo-checkout-x1-capture");
    await c.releasePayment("pay_1", "cpo-checkout-x1-release");
    await c.getPayment("pay_1");
    await c.recordHoldStop(BILL, "cpo-checkout-x1-hold-stop");
    const [t, f, cap, rel, g, alert] = api.calls;
    expect(t.url).toBe("https://api.example.test/v1/tenants/42/tariffs/777");
    expect(f.url).toBe(
      `https://api.example.test/v1/tenants/42/bills/${BILL}/finalize`,
    );
    // Usage is never sent: Ivora reads it from the charging core.
    expect(JSON.parse(String(f.init.body))).toEqual({ transaction_id: 5 });
    expect(header(f, "idempotency-key")).toBe("cpo-checkout-x1-finalize");
    expect(cap.url).toBe(
      "https://api.example.test/payment/stripe/v1/tenants/42/payments/pay_1/capture",
    );
    // No amount: Ivora captures exactly the final bill.
    expect(cap.init.body).toBeUndefined();
    expect(header(cap, "idempotency-key")).toBe("cpo-checkout-x1-capture");
    expect(rel.url).toBe(
      "https://api.example.test/payment/stripe/v1/tenants/42/payments/pay_1/release",
    );
    expect(header(rel, "idempotency-key")).toBe("cpo-checkout-x1-release");
    expect(g.init.method).toBe("GET");
    expect(alert.url).toBe(
      `https://api.example.test/v1/billing/bills/${BILL}/alerts`,
    );
    expect(JSON.parse(String(alert.init.body))).toEqual({ kind: "hold_stop" });
    expect(header(alert, "idempotency-key")).toBe("cpo-checkout-x1-hold-stop");
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
    for (const write of [
      () => client(api).capturePayment("pay_1", ""),
      () => client(api).releasePayment("pay_1", ""),
      () => client(api).finalizeBill(BILL, 5, ""),
    ])
      await expect(write()).rejects.toThrow(/Idempotency-Key/);
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
    const cookie = memoryDemoCheckout({ v: 3, simulate, records: [] });
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
      tokens: createDemoLiveStore(memoryDemoLive()),
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
    const { d, cookie } = demoDeps();
    const page = await loadChargePage(d, CODE, "Sample Co");
    expect(page).toMatchObject({ closed: null, hold: "$25.00" });
    expect(page.example?.total).toBeTruthy();
    const mine = req();
    const { url } = await pay(d, mine);
    expect(url).toMatch(/^\/demo\/checkout\/pay_demo_[0-9a-f]+$/);
    expect((await driverSessions(d, CODE, [mine]))[0].label).toBe(
      "Waiting for payment",
    );
    // "Pay with demo card": the hold is authorized and the charger starts.
    const payment = decodeURIComponent(url.split("/").pop()!);
    expect(await authorizeDemoPayment(cookieDemoFleet(), payment)).toEqual({
      returnReference: only(cookie).reference,
    });
    expect((await driverSessions(d, CODE, [mine]))[0].label).toBe(
      "Plug in your car",
    );
    t += DEMO_PLUG_IN_MS + 30 * 60_000;
    vi.setSystemTime(t);
    // 3.7 kWh at $0.35 plus the $1.00 session fee, priced offline.
    expect((await driverSessions(d, CODE, [mine]))[0]).toMatchObject({
      label: "Charging",
      energyKwh: "3.70",
      estimate: "$2.30",
      canStop: true,
    });
    // The connector is in use for everyone else now.
    await expect(pay(d, req(), CODE, "s2")).rejects.toMatchObject({
      code: "in_use",
    });
    await stopDriverSession(d, {
      code: CODE,
      requestId: mine,
      requestIds: [mine],
    });
    // Settled: the demo "captures" exactly the bill and releases the rest.
    expect(only(cookie)).toMatchObject({
      phase: "settled",
      finalMinor: 230,
      capturedMinor: 230,
    });
    expect((await driverSessions(d, CODE, [mine]))[0]).toMatchObject({
      label: "Finished",
      receipt: { charged: "$2.30", released: "$22.70", hold: "$25.00" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("releases a demo payment that was never made", async () => {
    let t = Date.parse("2026-10-20T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t);
    const { d, cookie } = demoDeps();
    const mine = req();
    const { url } = await pay(d, mine);
    t += (PAYMENT_WINDOW_MINUTES + 1) * 60_000;
    vi.setSystemTime(t);
    expect((await driverSessions(d, CODE, [mine]))[0].label).toBe(
      "Not charged",
    );
    expect(only(cookie).phase).toBe("released");
    // The demo checkout can't be paid any more.
    const payment = decodeURIComponent(url.split("/").pop()!);
    await authorizeDemoPayment(cookieDemoFleet(), payment);
    expect((await getIvora().getPayment(payment)).status).toBe("canceled");
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
