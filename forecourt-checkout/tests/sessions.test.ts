import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_TARIFF } from "@/lib/demo";
import type {
  CheckoutRequest,
  CheckoutState,
  Hold,
  PaymentGateway,
} from "@/lib/payments";
import { readSettings } from "@/lib/settings";
import type { Quote } from "@/lib/tariff";
import {
  IvoraError,
  type ExternalSession,
  type Station,
} from "@/lib/server/ivora";
import {
  createCheckout,
  reconcile,
  requestStop,
  UserError,
  type ChargingApi,
  type Deps,
} from "@/lib/server/sessions";

// Stateful fakes at the client boundary: no network, no credentials.

const CS = "cs_test_a1B2c3D4e5F6g7H8";
const T0 = Date.parse("2026-10-19T12:00:00Z");

class FakePayments implements PaymentGateway {
  readonly processor = "stripe";
  readonly merchantReference = "acct_site";
  constructor(public chargesApplicationFee = true) {}
  checkouts = new Map<string, CheckoutState>();
  created: CheckoutRequest[] = [];
  captures: { holdId: string; amount: number; fee: number; key: string }[] = [];
  releases: string[] = [];

  async createCheckout(request: CheckoutRequest) {
    this.created.push(request);
    this.checkouts.set(CS, {
      id: CS,
      status: "open",
      url: "https://checkout.example/pay",
      metadata: request.metadata,
      hold: null,
    });
    return { id: CS, url: "https://checkout.example/pay" };
  }
  /** The driver finished hosted checkout: the card is authorized for the hold. */
  authorize(overrides: Partial<Hold> = {}) {
    const c = this.checkouts.get(CS)!;
    c.status = "complete";
    c.url = null;
    c.hold = {
      id: "pi_123",
      status: "requires_capture",
      currency: "usd",
      amountCents: Number(c.metadata.fc_hold),
      capturedCents: 0,
      manualCapture: true,
      applicationFeeCents: 0,
      metadata: { ...c.metadata },
      ...overrides,
    };
  }
  async getCheckout(id: string) {
    const c = this.checkouts.get(id);
    return c ? structuredClone(c) : null;
  }
  async expireCheckout(id: string) {
    this.checkouts.get(id)!.status = "expired";
  }
  async setHoldMetadata(_holdId: string, values: Record<string, string>) {
    const hold = this.checkouts.get(CS)!.hold!;
    for (const [k, v] of Object.entries(values)) {
      if (v === "") delete hold.metadata[k];
      else hold.metadata[k] = v;
    }
  }
  async capture(holdId: string, amount: number, fee: number, key: string) {
    this.captures.push({ holdId, amount, fee, key });
    const hold = this.checkouts.get(CS)!.hold!;
    Object.assign(hold, {
      status: "succeeded",
      capturedCents: amount,
      applicationFeeCents: fee,
    });
    return structuredClone(hold);
  }
  async release(holdId: string) {
    this.releases.push(holdId);
    const hold = this.checkouts.get(CS)!.hold!;
    hold.status = "canceled";
    return structuredClone(hold);
  }
}

const station = (status = "Available", online = true): Station => ({
  id: 7,
  name: "Pump 3",
  online,
  external_reference: "PUMP-3",
  connectors: [
    { id: 71, number: 1, status, tariff_id: 9001, max_power_w: 150000 },
  ],
});

const finalBreakdown: Quote = {
  currency: "USD",
  pricing_version: "elements-v1",
  lines: [
    {
      type: "ENERGY",
      element: 0,
      reservation: false,
      quantity: "36.000000",
      unit: "kWh",
      price_minor: "45",
      exact_minor: "1620.000000",
      amount_minor: 1620,
    },
    {
      type: "TIME",
      element: 0,
      reservation: false,
      quantity: "0.383333",
      unit: "h",
      price_minor: "360",
      exact_minor: "138.000000",
      amount_minor: 138,
    },
    {
      type: "PARKING_TIME",
      element: 0,
      reservation: false,
      quantity: "0.300000",
      unit: "h",
      price_minor: "2400",
      exact_minor: "720.000000",
      amount_minor: 720,
    },
    {
      type: "FLAT",
      element: 0,
      reservation: false,
      quantity: "1",
      unit: "session",
      price_minor: "100",
      exact_minor: "100.000000",
      amount_minor: 100,
    },
  ],
  subtotal_minor: 2578,
  exact_subtotal_minor: "2578.000000",
  adjustments: [],
  total_minor: 2578,
  activity: { charging_seconds: 1380, idle_seconds: 1080 },
};

class FakeIvora implements ChargingApi {
  station = station();
  session: ExternalSession | null = null;
  calls: { action: string; key?: string; body?: unknown }[] = [];
  startStatus: "dispatching" | "rejected" = "dispatching";
  cancelError: IvoraError | null = null;

  async findStationByCode(code: string) {
    return code === "PUMP-3" ? structuredClone(this.station) : null;
  }
  async getStation() {
    return structuredClone(this.station);
  }
  async getTariff() {
    return structuredClone(DEMO_TARIFF);
  }
  async quote(): Promise<Quote> {
    return { ...finalBreakdown, activity: null };
  }
  async createSession(
    body: Parameters<ChargingApi["createSession"]>[0],
    key: string,
  ) {
    this.calls.push({ action: "create", key, body });
    this.session ??= {
      id: "ecs_1",
      application_reference: body.application_reference,
      payment_reference: body.payment_reference,
      created_at: new Date(T0).toISOString(),
      status: "prepared",
      bill: {
        id: "bill_1",
        station_id: 7,
        connector_id: 71,
        status: "open",
        hold_minor: 5000,
        currency: "USD",
        energy_wh: null,
        total_minor: null,
        transaction_id: null,
        cost_breakdown: null,
      },
      usage: null,
      start_operation: null,
      stop_operation: null,
    };
    return structuredClone(this.session);
  }
  async findSession() {
    return this.session ? structuredClone(this.session) : null;
  }
  async getSession() {
    return structuredClone(this.session!);
  }
  async startSession(_id: string, key: string) {
    this.calls.push({ action: "start", key });
    const op = {
      id: "op_start",
      status: this.startStatus,
      result: null,
      created_at: new Date(T0).toISOString(),
    };
    Object.assign(this.session!, { status: "starting", start_operation: op });
    return op;
  }
  async stopSession(_id: string, key: string) {
    this.calls.push({ action: "stop", key });
    const op = {
      id: "op_stop",
      status: "dispatching" as const,
      result: null,
      created_at: new Date(T0).toISOString(),
    };
    Object.assign(this.session!, { status: "stopping", stop_operation: op });
    return op;
  }
  async cancelSession(_id: string, key: string) {
    this.calls.push({ action: "cancel", key });
    if (this.cancelError) throw this.cancelError;
    this.session!.status = "canceled";
    return structuredClone(this.session!);
  }
  async finalizeSession(_id: string, transactionId: number, key: string) {
    this.calls.push({ action: "finalize", key, body: { transactionId } });
    return structuredClone(this.session!.bill);
  }
  async reportSettlement(
    _id: string,
    report: { kind: string; operation_reference: string; amount_minor: number },
  ) {
    this.calls.push({ action: `report:${report.kind}`, body: report });
    return {};
  }
  // Test helpers: what the charger and Ivora report over time.
  charging(energyWh: number, estimated: number, powerW = 120_000) {
    Object.assign(this.session!, {
      status: "charging",
      usage: {
        transaction_id: 21,
        active: true,
        energy_kwh: (energyWh / 1000).toFixed(3),
        energy_wh: energyWh,
        estimated_minor: estimated,
        started_at: new Date(T0).toISOString(),
        ended_at: null,
        power_w: powerW,
      },
    });
  }
  ended(total: number, breakdown: Quote | null = finalBreakdown) {
    Object.assign(this.session!, {
      status: "completed",
      usage: {
        ...this.session!.usage!,
        active: false,
        ended_at: new Date(T0 + 2460_000).toISOString(),
        power_w: 0,
      },
      bill: {
        ...this.session!.bill,
        status: "final",
        total_minor: total,
        transaction_id: 21,
        energy_wh: 36000,
        cost_breakdown: breakdown,
      },
    });
  }
}

let ivora: FakeIvora;
let payments: FakePayments;
let now: number;
let deps: Deps;

function setup(env: Record<string, string> = {}, chargesFee = true) {
  ivora = new FakeIvora();
  payments = new FakePayments(chargesFee);
  now = T0;
  const settings = readSettings({
    IVORA_API_KEY: "k",
    IVORA_TENANT_ID: "1",
    STRIPE_SECRET_KEY: "s",
    SESSION_SECRET: "x",
    OPERATOR_PASSWORD: "p",
    PUBLIC_BASE_URL: "https://charge.example.com",
    ...env,
  });
  deps = { ivora, payments, settings, now: () => now };
}

const keys = (action: string) =>
  ivora.calls.filter((c) => c.action === action).map((c) => c.key);

beforeEach(() => setup());

describe("pay: card hold through hosted checkout", () => {
  it("holds the tariff's authorization amount with a key from the driver's tap", async () => {
    const result = await createCheckout(
      {
        code: "PUMP-3",
        connector: 1,
        requestId: "8a6e0804-2bd0-4672-b79d-d97027f55c9b",
      },
      deps,
    );
    expect(result.url).toBe("https://checkout.example/pay");
    const req = payments.created[0];
    expect(req).toMatchObject({
      idempotencyKey: "forecourt:checkout:8a6e0804-2bd0-4672-b79d-d97027f55c9b",
      holdCents: 5000,
      successUrl: "https://charge.example.com/s/{CHECKOUT_SESSION_ID}",
      cancelUrl: "https://charge.example.com/c/PUMP-3/1",
    });
    expect(req.metadata).toMatchObject({
      fc_station: "7",
      fc_connector: "71",
      fc_tariff: "9001",
      fc_hold: "5000",
    });
    expect(ivora.calls).toEqual([]); // nothing is sent to the charger before payment
  });

  it("falls back to DEFAULT_HOLD_CENTS when the tariff has no usable hold", async () => {
    setup({ DEFAULT_HOLD_CENTS: "3500" });
    ivora.getTariff = async () => ({ ...DEMO_TARIFF, authorization_minor: 0 });
    await createCheckout(
      {
        code: "PUMP-3",
        connector: 1,
        requestId: "8a6e0804-2bd0-4672-b79d-d97027f55c9b",
      },
      deps,
    );
    expect(payments.created[0].holdCents).toBe(3500);
  });

  it("refuses busy, offline or unknown connectors", async () => {
    const req = {
      code: "PUMP-3",
      connector: 1,
      requestId: "8a6e0804-2bd0-4672-b79d-d97027f55c9b",
    };
    ivora.station = station("Charging");
    await expect(createCheckout(req, deps)).rejects.toMatchObject({
      code: "connector_not_ready",
    });
    ivora.station = station("Available", false);
    await expect(createCheckout(req, deps)).rejects.toBeInstanceOf(UserError);
    await expect(
      createCheckout({ ...req, code: "NOPE" }, deps),
    ).rejects.toMatchObject({ code: "charger_not_found" });
    expect(payments.created).toHaveLength(0);
  });
});

async function paidAndStarted() {
  await createCheckout(
    {
      code: "PUMP-3",
      connector: 1,
      requestId: "8a6e0804-2bd0-4672-b79d-d97027f55c9b",
    },
    deps,
  );
  expect((await reconcile(CS, deps)).phase).toBe("payment");
  payments.authorize();
  const view = await reconcile(CS, deps);
  expect(view.phase).toBe("starting");
}

describe("live session from authorization to receipt", () => {
  it("creates the externally funded session, starts it, and reports the authorization", async () => {
    await paidAndStarted();
    expect(ivora.calls.find((c) => c.action === "create")).toMatchObject({
      key: `forecourt:${CS}:create`,
      body: {
        station_id: 7,
        connector_id: 71,
        tariff_id: 9001,
        application_reference: `forecourt:${CS}`,
        processor: "stripe",
        merchant_reference: "acct_site",
        payment_reference: "pi_123",
      },
    });
    expect(keys("start")).toEqual([`forecourt:${CS}:start`]);
    expect(
      ivora.calls.find((c) => c.action === "report:authorization")?.body,
    ).toMatchObject({ amount_minor: 5000, operation_reference: "pi_123" });
    // Running reconcile again never starts twice.
    await reconcile(CS, deps);
    expect(keys("start")).toHaveLength(1);
  });

  it("shows live energy, power and running cost", async () => {
    await paidAndStarted();
    ivora.charging(12_345, 690, 61_234);
    const view = await reconcile(CS, deps);
    expect(view).toMatchObject({
      phase: "charging",
      energyWh: 12_345,
      powerW: 61_234,
      runningCents: 690,
      canStop: true,
    });
  });

  it("shows the move-your-car countdown when the car stops drawing power", async () => {
    await paidAndStarted();
    ivora.charging(36_000, 1858, 0);
    ivora.station = station("SuspendedEV");
    let view = await reconcile(CS, deps);
    expect(view.phase).toBe("finished");
    expect(view.idle).toMatchObject({
      secondsUntilFee: 600,
      accruing: false,
      graceMinutes: 10,
      idleCentsPerHour: 2400,
    });
    expect(payments.checkouts.get(CS)!.hold!.metadata.idle_since).toBe(
      new Date(T0).toISOString(),
    );
    now = T0 + 11 * 60_000; // one minute past the grace period
    view = await reconcile(CS, deps);
    expect(view.idle).toMatchObject({
      secondsUntilFee: 0,
      accruing: true,
      accruedCents: 40,
    });
  });

  it("finalizes, waives the idle grace, captures with the application fee and releases the rest", async () => {
    await paidAndStarted();
    ivora.charging(36_000, 2000);
    await reconcile(CS, deps);
    ivora.ended(2578);
    const view = await reconcile(CS, deps);
    expect(view.phase).toBe("completed");
    // 18 idle minutes billed 720c; first 10 at $24/h waived = 400c.
    expect(view.receipt!.settlement).toMatchObject({
      billTotalCents: 2578,
      graceCreditCents: 400,
      chargedCents: 2178,
      releasedCents: 2822,
      applicationFeeCents: 218,
    });
    expect(payments.captures).toEqual([
      {
        holdId: "pi_123",
        amount: 2178,
        fee: 218,
        key: `forecourt:${CS}:capture`,
      },
    ]);
    expect(
      ivora.calls.find((c) => c.action === "report:capture")?.body,
    ).toMatchObject({ amount_minor: 2178 });
    // Polling the finished session again never captures twice.
    expect((await reconcile(CS, deps)).phase).toBe("completed");
    expect(payments.captures).toHaveLength(1);
  });

  it("finalizes an ended transaction that has no final bill yet", async () => {
    await paidAndStarted();
    ivora.charging(5000, 300);
    ivora.finalizeSession = async (_id, transactionId, key) => {
      ivora.calls.push({ action: "finalize", key, body: { transactionId } });
      return {
        ...ivora.session!.bill,
        status: "final",
        total_minor: 325,
        transaction_id: 21,
        energy_wh: 5000,
        cost_breakdown: null,
      };
    };
    Object.assign(ivora.session!, {
      status: "awaiting_bill",
      usage: { ...ivora.session!.usage!, active: false },
    });
    const view = await reconcile(CS, deps);
    expect(keys("finalize")).toEqual([`forecourt:${CS}:finalize`]);
    expect(view.receipt!.rows).toEqual([
      { label: "Energy", detail: "5.00 kWh × $0.65/kWh", amountCents: 325 },
    ]);
    expect(payments.captures[0]).toMatchObject({ amount: 325, fee: 33 });
  });

  it("takes no application fee when the deployer runs the site", async () => {
    setup({}, false);
    await paidAndStarted();
    ivora.charging(36_000, 2000);
    ivora.ended(2578);
    await reconcile(CS, deps);
    expect(payments.captures[0]).toMatchObject({ amount: 2178, fee: 0 });
  });

  it("uses the configured fee in basis points", async () => {
    setup({ APPLICATION_FEE_BPS: "250" });
    await paidAndStarted();
    ivora.charging(36_000, 2000);
    ivora.ended(2578);
    await reconcile(CS, deps);
    expect(payments.captures[0].fee).toBe(54); // 2178 x 2.5% = 54.45
  });

  it("releases the hold when the bill is under Stripe's minimum", async () => {
    await paidAndStarted();
    ivora.charging(80, 40);
    ivora.ended(49, null);
    const view = await reconcile(CS, deps);
    expect(view.receipt!.settlement).toMatchObject({
      action: "release",
      chargedCents: 0,
      releasedCents: 5000,
    });
    expect(payments.captures).toEqual([]);
    expect(payments.releases).toEqual(["pi_123"]);
    expect(
      ivora.calls.find((c) => c.action === "report:release")?.body,
    ).toMatchObject({ amount_minor: 0 });
  });

  it("caps the capture at the hold and says so", async () => {
    await paidAndStarted();
    ivora.charging(36_000, 4000);
    ivora.ended(5230, null);
    const view = await reconcile(CS, deps);
    expect(payments.captures[0].amount).toBe(5000);
    expect(view.receipt!.settlement).toMatchObject({
      reason: "capped_at_hold",
      uncollectedCents: 230,
    });
  });

  it("stops charging before the running cost reaches the hold", async () => {
    await paidAndStarted();
    ivora.charging(80_000, 4249);
    expect((await reconcile(CS, deps)).phase).toBe("charging");
    expect(keys("stop")).toEqual([]);
    ivora.charging(80_000, 4250); // 85% of $50
    const view = await reconcile(CS, deps);
    expect(keys("stop")).toEqual([`forecourt:${CS}:stop`]);
    expect(view.message).toMatch(/hold/);
  });
});

describe("stop and cancel", () => {
  it("stops an active session from the driver's phone", async () => {
    await paidAndStarted();
    ivora.charging(10_000, 600);
    const view = await requestStop(CS, deps);
    expect(keys("stop")).toEqual([`forecourt:${CS}:stop`]);
    expect(view.canStop).toBe(false);
  });

  it("cancels before payment by expiring the checkout", async () => {
    await createCheckout(
      {
        code: "PUMP-3",
        connector: 1,
        requestId: "8a6e0804-2bd0-4672-b79d-d97027f55c9b",
      },
      deps,
    );
    const view = await requestStop(CS, deps);
    expect(view.phase).toBe("canceled");
    expect(ivora.calls).toEqual([]);
  });

  it("cancels a prepared session and releases the hold", async () => {
    await createCheckout(
      {
        code: "PUMP-3",
        connector: 1,
        requestId: "8a6e0804-2bd0-4672-b79d-d97027f55c9b",
      },
      deps,
    );
    payments.authorize();
    // The webhook created the session but the driver stops before it starts.
    await ivora.createSession(
      {
        station_id: 7,
        connector_id: 71,
        tariff_id: 9001,
        application_reference: `forecourt:${CS}`,
        processor: "stripe",
        merchant_reference: "acct_site",
        payment_reference: "pi_123",
      },
      "k",
    );
    const view = await requestStop(CS, deps);
    expect(view.phase).toBe("canceled");
    expect(keys("start")).toEqual([]);
    expect(keys("cancel")).toEqual([`forecourt:${CS}:cancel`]);
    expect(payments.releases).toEqual(["pi_123"]);
  });

  it("releases the hold when the charger rejects the start", async () => {
    ivora.startStatus = "rejected";
    await paidAndStarted();
    const view = await reconcile(CS, deps);
    expect(view.phase).toBe("canceled");
    expect(payments.releases).toEqual(["pi_123"]);
  });

  it("waits out a reserved start instead of releasing early", async () => {
    await paidAndStarted();
    ivora.cancelError = new IvoraError(
      409,
      "start_reserved",
      "A start may still begin.",
    );
    now = T0 + 5 * 60_000;
    await requestStop(CS, deps);
    const view = await reconcile(CS, deps);
    expect(view.phase).toBe("starting");
    expect(payments.releases).toEqual([]);
  });

  it("releases the hold if charging never starts within 20 minutes", async () => {
    await paidAndStarted();
    now = T0 + 21 * 60_000;
    const view = await reconcile(CS, deps);
    expect(view.phase).toBe("canceled");
    expect(payments.releases).toEqual(["pi_123"]);
  });
});

describe("safety checks", () => {
  it("sends a tampered or mismatched payment to review without starting", async () => {
    await createCheckout(
      {
        code: "PUMP-3",
        connector: 1,
        requestId: "8a6e0804-2bd0-4672-b79d-d97027f55c9b",
      },
      deps,
    );
    payments.authorize({ amountCents: 100 });
    const view = await reconcile(CS, deps);
    expect(view.phase).toBe("review");
    expect(view.error?.code).toBe("payment_mismatch");
    expect(ivora.calls).toEqual([]);
  });

  it("rejects malformed session IDs before any request", async () => {
    await expect(reconcile("../../etc", deps)).rejects.toMatchObject({
      code: "session_not_found",
    });
  });
});
