import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_TARIFF } from "@/lib/demo";
import { readSettings } from "@/lib/settings";
import {
  chargerLabel,
  decodeSaleId,
  driverSale,
  encodeSaleId,
  endReports,
  paidReport,
  parseDollars,
  parseKwh,
  prepayStop,
  saleAmounts,
  saleBill,
  startReports,
  tileState,
  type SaleReport,
  type SaleTerms,
} from "@/lib/store";
import type { Quote } from "@/lib/tariff";
import { meterSampleFromEvent } from "@/lib/webhook";
import {
  IvoraError,
  type ExternalSession,
  type Operation,
  type Station,
} from "@/lib/server/ivora";
import type { SaleDueEvent } from "@/lib/server/sale-events";
import {
  authorizeSale,
  consoleState,
  giveChange,
  markSalePaid,
  PREPARED_TIMEOUT_MS,
  progressSale,
  saleById,
  onMeterSample,
  saleIdFor,
  SESSION_LIST_TTL_MS,
  stopSale,
  type StoreApi,
  type StoreDeps,
} from "@/lib/server/store";

const T0 = Date.parse("2026-10-20T15:00:00Z");
const REQ = "8a6e0804-2bd0-4672-b79d-d97027f55c9b";
const PREPAY: SaleTerms = { mode: "prepay", prepaidCents: 2000, limitWh: null };
const POSTPAY: SaleTerms = {
  mode: "postpay",
  prepaidCents: null,
  limitWh: null,
};

// Demo prices in hundredths of a cent: $0.45/kWh, $3.60/h, $24/h idle.
const PRICES = {
  energyPerKwh: 4500,
  timePerHour: 36_000,
  idlePerHour: 240_000,
};

describe("sale IDs carry their terms", () => {
  it("round-trips prepay and postpay and rejects anything else", () => {
    const pre = encodeSaleId(
      { mode: "prepay", prepaidCents: 2500, limitWh: 20_000 },
      "abc123def456",
    );
    expect(pre).toBe("pre-2500-20000-abc123def456");
    expect(decodeSaleId(pre)).toEqual({
      mode: "prepay",
      prepaidCents: 2500,
      limitWh: 20_000,
    });
    expect(decodeSaleId("post-abc123def456")).toEqual(POSTPAY);
    expect(decodeSaleId("pre-50-0-abc123def456")).toBeNull(); // under the minimum
    expect(decodeSaleId("pre-2500-0-ABC123def456")).toBeNull();
    expect(decodeSaleId("cs_test_123")).toBeNull();
    expect(() =>
      encodeSaleId({ ...PREPAY, prepaidCents: null }, "abc123def456"),
    ).toThrow();
  });

  it("derives the same sale from the same tap, and a new one from a new tap", () => {
    expect(saleIdFor(PREPAY, REQ)).toBe(saleIdFor(PREPAY, REQ));
    expect(saleIdFor(PREPAY, REQ)).not.toBe(
      saleIdFor(PREPAY, "0b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d"),
    );
  });

  it("numbers chargers like fuel pumps", () => {
    expect(chargerLabel("PUMP-3", 1)).toBe("Charger 3");
    expect(chargerLabel("PUMP-03", 2, 2)).toBe("Charger 3-2");
    expect(chargerLabel("NORTH", 1)).toBe("Charger NORTH");
  });

  it("parses the cashier's typed amounts without floats", () => {
    expect(parseDollars("20")).toBe(2000);
    expect(parseDollars("$20.5")).toBe(2050);
    expect(parseDollars("0.07")).toBe(7);
    expect(parseDollars("20.555")).toBeNull();
    expect(parseDollars("-3")).toBeNull();
    expect(parseKwh("12.5")).toBe(12_500);
    expect(parseKwh("abc")).toBeNull();
  });
});

describe("prepay stop headroom", () => {
  const base = {
    prepaidCents: 2000,
    limitWh: null,
    energyWh: 0,
    powerW: 0,
    ...PRICES,
  };

  it("keeps back at least 50 cents or 5% of the prepaid amount", () => {
    // No power: the time/idle minute (40c) is below the 5% floor (100c).
    const d = prepayStop({ ...base, estimatedCents: 1899 });
    expect(d).toMatchObject({
      stop: false,
      headroomCents: 100,
      stopAtCents: 1900,
    });
    expect(prepayStop({ ...base, estimatedCents: 1900 }).stop).toBe(true);
    expect(
      prepayStop({ ...base, prepaidCents: 500, estimatedCents: 0 })
        .headroomCents,
    ).toBe(50);
  });

  it("keeps back the next minute at the recent power and the tariff's prices", () => {
    // 150 kW for 60 s = 2.5 kWh x 45c = 112.5c, plus a minute of idle at $24/h = 40c.
    const d = prepayStop({ ...base, powerW: 150_000, estimatedCents: 1846 });
    expect(d.headroomCents).toBe(153);
    expect(d.stopAtCents).toBe(1847);
    expect(d.stop).toBe(false);
    expect(
      prepayStop({ ...base, powerW: 150_000, estimatedCents: 1847 }),
    ).toMatchObject({
      stop: true,
      reason: "amount",
    });
  });

  it("stops a kWh sale on energy, with money only as a safety cap", () => {
    // 20 kWh quoted at $9.00 + time: the sale is about energy, not the amount.
    const kwhSale = {
      ...base,
      prepaidCents: 1000,
      limitWh: 20_000,
      powerW: 60_000,
    };
    // 60 kW for 30 s = 500 Wh of energy headroom (more than 1% of 20 kWh).
    expect(
      prepayStop({ ...kwhSale, energyWh: 19_499, estimatedCents: 900 }).stop,
    ).toBe(false);
    expect(
      prepayStop({ ...kwhSale, energyWh: 19_500, estimatedCents: 900 }),
    ).toMatchObject({ stop: true, reason: "energy" });
    // The 50c / 5% floor would have stopped it at $9.50, about 2 kWh early;
    // the cap keeps back only the next minute (45c energy + 40c idle = 85c).
    const capped = prepayStop({
      ...kwhSale,
      energyWh: 17_000,
      estimatedCents: 914,
    });
    expect(capped).toMatchObject({ stop: false, headroomCents: 85 });
    expect(
      prepayStop({ ...kwhSale, energyWh: 17_000, estimatedCents: 915 }),
    ).toMatchObject({ stop: true, reason: "amount" });
  });
});

const parking = (minutes: number): Quote["lines"][number] => ({
  type: "PARKING_TIME",
  element: 0,
  reservation: false,
  quantity: (minutes / 60).toFixed(6),
  unit: "h",
  price_minor: "2400",
  exact_minor: `${minutes * 40}.000000`,
  amount_minor: minutes * 40,
});

function quote(energyCents: number, idleMinutes: number): Quote {
  const lines: Quote["lines"] = [
    {
      type: "ENERGY",
      element: 0,
      reservation: false,
      quantity: (energyCents / 45).toFixed(6),
      unit: "kWh",
      price_minor: "45",
      exact_minor: `${energyCents}.000000`,
      amount_minor: energyCents,
    },
  ];
  if (idleMinutes) lines.push(parking(idleMinutes));
  const total = energyCents + idleMinutes * 40;
  return {
    currency: "USD",
    pricing_version: "elements-v1",
    lines,
    subtotal_minor: total,
    exact_subtotal_minor: `${total}.000000`,
    adjustments: [],
    total_minor: total,
    activity: { charging_seconds: 1200, idle_seconds: idleMinutes * 60 },
  };
}

describe("what the counter owes or is owed", () => {
  const sale = "pre-2000-0-abc123def456";

  it("hands back change when the session cost less than the prepaid amount", () => {
    const a = saleAmounts(sale, PREPAY, 1612, []);
    expect(a).toMatchObject({
      coveredCents: 1612,
      changeCents: 388,
      overrunCents: 0,
      outstandingCents: 0,
      status: "change",
      prepaidRecorded: false,
    });
  });

  it("shows an overrun as extra due, never as collected", () => {
    const covered: SaleReport = {
      kind: "capture",
      operation_reference: `${sale}:capture`,
      outcome: "succeeded",
      amount_minor: 2000,
    };
    const a = saleAmounts(sale, PREPAY, 2370, [covered]);
    expect(a).toMatchObject({
      coveredCents: 2000,
      changeCents: 0,
      overrunCents: 370,
      collectedCents: 2000,
      outstandingCents: 370,
      prepaidRecorded: true,
      status: "due",
    });
    const paid = saleAmounts(sale, PREPAY, 2370, [
      covered,
      {
        kind: "capture",
        operation_reference: `${sale}:extra:cash`,
        outcome: "succeeded",
        amount_minor: 370,
      },
    ]);
    expect(paid).toMatchObject({
      outstandingCents: 0,
      collectedCents: 2370,
      status: "paid",
    });
  });

  it("charges postpay the final bill including idle fees after the grace period", () => {
    // 18 idle minutes billed at $0.40/min = 720c; the first 10 are free = 400c.
    const bill = saleBill({
      bill: quote(1620, 18),
      billTotalCents: 2340,
      idleSeconds: 18 * 60,
      graceMinutes: 10,
    });
    expect(bill).toMatchObject({
      billTotalCents: 2340,
      graceCreditCents: 400,
      dueCents: 1940,
    });
    const a = saleAmounts("post-abc123def456", POSTPAY, bill.dueCents, []);
    expect(a).toMatchObject({ outstandingCents: 1940, status: "due" });
  });

  it("waives all idle when the car left inside the grace period, with no card minimum", () => {
    const bill = saleBill({
      bill: quote(30, 1),
      billTotalCents: 70,
      idleSeconds: 40,
      graceMinutes: 10,
    });
    expect(bill.dueCents).toBe(30); // below a card's 50c minimum, still owed in store
  });
});

describe("settlement report sequence rules", () => {
  const pre = "pre-2000-0-abc123def456";
  const post = "post-abc123def456";

  it("records the prepaid amount before the start and what it covered after", () => {
    expect(startReports(pre, PREPAY)).toEqual([
      {
        step: "authorization",
        kind: "authorization",
        operation_reference: pre,
        amount_minor: 2000,
      },
    ]);
    expect(startReports(post, POSTPAY)).toEqual([]);
    const over = saleAmounts(pre, PREPAY, 2370, []);
    expect(endReports(pre, PREPAY, over)).toEqual([
      {
        step: "capture",
        kind: "capture",
        // A distinct operation from the authorization: its own reference.
        operation_reference: `${pre}:capture`,
        amount_minor: 2000,
      },
    ]);
    expect(
      endReports(post, POSTPAY, saleAmounts(post, POSTPAY, 900, [])),
    ).toEqual([]);
  });

  it("only accepts exactly the outstanding amount, and repeats are no-ops", () => {
    const due = saleAmounts(post, POSTPAY, 1940, []);
    expect(
      paidReport(post, POSTPAY, due, {
        amountCents: 1900,
        method: "cash",
        posReference: null,
      }),
    ).toMatchObject({ ok: false, code: "amount_mismatch" });
    expect(
      paidReport(post, POSTPAY, due, {
        amountCents: 1940,
        method: "card",
        posReference: "bad ref!",
      }),
    ).toMatchObject({ ok: false, code: "invalid_pos_reference" });
    const ok = paidReport(post, POSTPAY, due, {
      amountCents: 1940,
      method: "card",
      posReference: "POS-1042",
    });
    expect(ok).toEqual({
      ok: true,
      report: {
        step: "paid",
        kind: "capture",
        operation_reference: `${post}:paid:card:POS-1042`,
        amount_minor: 1940,
      },
    });
    const paid = saleAmounts(post, POSTPAY, 1940, [
      {
        kind: "capture",
        operation_reference: `${post}:paid:card:POS-1042`,
        outcome: "succeeded",
        amount_minor: 1940,
      },
    ]);
    expect(
      paidReport(post, POSTPAY, paid, {
        amountCents: 1940,
        method: "cash",
        posReference: null,
      }),
    ).toEqual({ ok: true, report: null });
    expect(
      paidReport(post, POSTPAY, paid, {
        amountCents: 100,
        method: "cash",
        posReference: null,
      }),
    ).toMatchObject({ ok: false, code: "already_paid" });
  });
});

// --- Live flow against a stateful fake at the client boundary ----------------

const station = (status = "Preparing", online = true): Station => ({
  id: 7,
  name: "Pump 3",
  online,
  external_reference: "PUMP-3",
  connectors: [
    { id: 71, number: 1, status, tariff_id: 9001, max_power_w: 150_000 },
  ],
});

class FakeIvora implements StoreApi {
  station = station();
  sessions = new Map<string, ExternalSession>();
  reports = new Map<string, SaleReport[]>();
  calls: { action: string; key?: string; body?: unknown }[] = [];
  now = () => T0;
  /** Ivora refuses any stop after a rejected one (needs reconciling). */
  refuseRetry = false;
  loseNextStop = false;
  /** Stop operations by idempotency key: a used key replays its record. */
  stops = new Map<string, Operation>();

  async findStationByCode(code: string) {
    return code === "PUMP-3" ? structuredClone(this.station) : null;
  }
  async getStation() {
    return structuredClone(this.station);
  }
  async listStations() {
    return [structuredClone(this.station)];
  }
  async getTariff() {
    return structuredClone(DEMO_TARIFF);
  }
  async quote(): Promise<Quote> {
    return quote(1125, 0);
  }
  async createSession(
    body: Parameters<StoreApi["createSession"]>[0],
    key: string,
  ) {
    this.calls.push({ action: "create", key, body });
    const existing = [...this.sessions.values()].find(
      (s) => s.application_reference === body.application_reference,
    );
    if (existing) return structuredClone(existing);
    const id = `ecs_${this.sessions.size + 1}`;
    const s: ExternalSession = {
      id,
      application_reference: body.application_reference,
      payment_reference: body.payment_reference,
      created_at: new Date(this.now()).toISOString(),
      status: "prepared",
      bill: {
        id: `bill_${id}`,
        station_id: 7,
        connector_id: 71,
        status: "open",
        tariff_id: body.tariff_id,
        hold_minor: 0,
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
    this.sessions.set(id, s);
    return structuredClone(s);
  }
  async findSession(ref: string) {
    const s = [...this.sessions.values()].find(
      (x) => x.application_reference === ref,
    );
    return s ? structuredClone(s) : null;
  }
  async getSession(id: string) {
    return structuredClone(this.sessions.get(id)!);
  }
  async listAllSessions() {
    this.calls.push({ action: "list" });
    return [...this.sessions.values()].map((s) => structuredClone(s));
  }
  async startSession(id: string, key: string) {
    this.calls.push({ action: "start", key });
    const op = {
      id: "op_start",
      status: "dispatching" as const,
      result: null,
      created_at: new Date(this.now()).toISOString(),
    };
    Object.assign(this.sessions.get(id)!, {
      status: "starting",
      start_operation: op,
    });
    return op;
  }
  async stopSession(id: string, key: string) {
    const replay = this.stops.get(key);
    if (replay) return structuredClone(replay);
    if (this.loseNextStop) {
      // Sent, but the answer was lost: the outcome of this key is unknown.
      this.loseNextStop = false;
      throw new IvoraError(503, "outcome_unknown", "Retry with the same key.");
    }
    const session = this.sessions.get(id)!;
    if (this.refuseRetry && session.stop_operation?.status === "rejected")
      throw new IvoraError(409, "stop_needs_reconciliation", "Refused.");
    this.calls.push({ action: "stop", key });
    const op: Operation = {
      id: `op_stop_${this.stops.size + 1}`,
      status: "dispatching",
      result: null,
      created_at: new Date(this.now() + this.stops.size).toISOString(),
    };
    this.stops.set(key, op);
    Object.assign(session, { status: "stopping", stop_operation: op });
    return structuredClone(op);
  }
  async cancelSession(id: string, key: string) {
    this.calls.push({ action: "cancel", key });
    this.sessions.get(id)!.status = "canceled";
    return structuredClone(this.sessions.get(id)!);
  }
  async finalizeSession(id: string, _tx: number, key: string) {
    this.calls.push({ action: "finalize", key });
    return structuredClone(this.sessions.get(id)!.bill);
  }
  async reportSettlement(
    id: string,
    report: {
      kind: "authorization" | "capture" | "release";
      operation_reference: string;
      amount_minor: number;
    },
    key?: string,
  ) {
    this.calls.push({ action: `report:${report.kind}`, key, body: report });
    // As the API documents: deduplicated by operation reference alone. Reuse is
    // only for an outcome update of the same operation; a different kind or
    // amount under an existing reference is refused, never silently merged.
    const list = this.reports.get(id) ?? [];
    const same = list.find(
      (r) => r.operation_reference === report.operation_reference,
    );
    if (same) {
      if (
        same.kind !== report.kind ||
        same.amount_minor !== report.amount_minor
      )
        throw new IvoraError(
          409,
          "settlement_conflict",
          "Terminal results and amounts cannot change.",
        );
      return {};
    }
    const s = this.sessions.get(id)!;
    const captured = list
      .filter((r) => r.kind === "capture")
      .reduce((t, r) => t + r.amount_minor, 0);
    if (
      report.kind === "capture" &&
      (s.bill.status !== "final" ||
        captured + report.amount_minor > (s.bill.total_minor ?? 0))
    )
      throw new IvoraError(
        409,
        "capture_exceeds_bill",
        "Successful captures cannot exceed the final bill.",
      );
    list.push({ ...report, outcome: "succeeded" });
    this.reports.set(id, list);
    return {};
  }
  async listSettlementReports(id: string) {
    return structuredClone(this.reports.get(id) ?? []);
  }
  // Test helpers: what the charger and Ivora report over time.
  only() {
    return [...this.sessions.values()].at(-1)!;
  }
  charging(energyWh: number, estimated: number, powerW = 120_000) {
    Object.assign(this.only(), {
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
  ended(total: number, breakdown: Quote) {
    const s = this.only();
    Object.assign(s, {
      status: "completed",
      usage: {
        ...s.usage!,
        active: false,
        ended_at: new Date(T0 + 1800_000).toISOString(),
        power_w: 0,
      },
      bill: {
        ...s.bill,
        status: "final",
        total_minor: total,
        transaction_id: 21,
        energy_wh: 36_000,
        cost_breakdown: breakdown,
      },
    });
  }
  /** The charger answered the latest stop (Ivora's record of its key changes too). */
  settleStop(status: Operation["status"]) {
    this.only().stop_operation!.status = status;
  }
  keys(action: string) {
    return this.calls.filter((c) => c.action === action).map((c) => c.key);
  }
  reportsOf() {
    return this.reports.get(this.only().id) ?? [];
  }
}

let ivora: FakeIvora;
let now: number;
let events: SaleDueEvent[];
let deps: StoreDeps;

beforeEach(() => {
  ivora = new FakeIvora();
  now = T0;
  ivora.now = () => now;
  events = [];
  deps = {
    ivora,
    settings: readSettings({
      IVORA_API_KEY: "k",
      IVORA_TENANT_ID: "1",
      STRIPE_SECRET_KEY: "s",
      SESSION_SECRET: "x",
      OPERATOR_PASSWORD: "p",
      CASHIER_PASSWORD: "c",
      PUBLIC_BASE_URL: "https://charge.example.com",
    }),
    now: () => now,
    events: { emit: async (e) => void events.push(e) },
  };
});

const authorize = (terms: SaleTerms, requestId = REQ) =>
  authorizeSale({ code: "PUMP-3", connector: 1, terms, requestId }, deps);

describe("prepay: from the POS to change", () => {
  it("creates an in-store session, records the prepaid amount, then starts", async () => {
    const view = await authorize(PREPAY);
    const sale = saleIdFor(PREPAY, REQ);
    expect(view).toMatchObject({ sale, phase: "starting", terms: PREPAY });
    expect(ivora.calls.map((c) => c.action)).toEqual([
      "create",
      "report:authorization",
      "start",
    ]);
    expect(ivora.calls[0]).toMatchObject({
      key: `forecourt:store:${sale}:create`,
      body: {
        application_reference: `forecourt:store:${sale}`,
        processor: "in-store",
        payment_reference: sale,
        station_id: 7,
        connector_id: 71,
        tariff_id: 9001,
      },
    });
    expect(ivora.calls[1]).toMatchObject({
      key: `forecourt:store:${sale}:report:authorization`,
      body: {
        kind: "authorization",
        operation_reference: sale,
        amount_minor: 2000,
      },
    });
    expect(ivora.keys("start")).toEqual([`forecourt:store:${sale}:start`]);
  });

  it("stops itself before the prepaid amount, with the same key every time", async () => {
    await authorize(PREPAY);
    const sale = saleIdFor(PREPAY, REQ);
    ivora.charging(30_000, 1846, 150_000);
    expect((await saleById(sale, deps)).stopping).toBe(false);
    ivora.charging(30_500, 1847, 150_000);
    const view = await saleById(sale, deps);
    expect(view).toMatchObject({
      stopping: true,
      limitReached: "amount",
      canStop: false,
    });
    await saleById(sale, deps);
    await stopSale(sale, deps);
    expect(ivora.keys("stop")).toEqual([`forecourt:store:${sale}:stop`]);
  });

  it("records what the prepaid amount covered, then the change as a release", async () => {
    await authorize(PREPAY);
    const sale = saleIdFor(PREPAY, REQ);
    ivora.charging(30_000, 1500);
    ivora.ended(1612, quote(1612, 0));
    const done = await saleById(sale, deps);
    expect(done.phase).toBe("done");
    expect(done.amounts).toMatchObject({
      dueCents: 1612,
      changeCents: 388,
      status: "change",
    });
    expect(
      ivora
        .reportsOf()
        .map((r) => [r.kind, r.operation_reference, r.amount_minor]),
    ).toEqual([
      ["authorization", sale, 2000],
      ["capture", `${sale}:capture`, 1612],
    ]);
    await saleById(sale, deps); // repeated reads never record twice
    expect(ivora.reportsOf()).toHaveLength(2);
    const after = await giveChange(sale, deps);
    expect(after.amounts).toMatchObject({ changeGiven: true, status: "paid" });
    await giveChange(sale, deps);
    expect(
      ivora
        .reportsOf()
        .map((r) => [r.kind, r.operation_reference, r.amount_minor]),
    ).toEqual([
      ["authorization", sale, 2000],
      ["capture", `${sale}:capture`, 1612],
      ["release", `${sale}:change`, 0],
    ]);
    expect(events).toEqual([]); // nothing to collect
  });

  it("never charges or records an overrun until the cashier marks it paid", async () => {
    await authorize(PREPAY);
    const sale = saleIdFor(PREPAY, REQ);
    ivora.charging(36_000, 1800);
    ivora.ended(2690, quote(1890, 20)); // idle fees took it over the prepaid amount
    const done = await saleById(sale, deps);
    expect(done.amounts).toMatchObject({
      dueCents: 2290, // 20 idle minutes billed, first 10 free
      overrunCents: 290,
      outstandingCents: 290,
      collectedCents: 2000,
      status: "due",
    });
    // Only the prepaid part is recorded; the overrun is not.
    expect(ivora.reportsOf().filter((r) => r.kind === "capture")).toEqual([
      {
        kind: "capture",
        operation_reference: `${sale}:capture`,
        amount_minor: 2000,
        outcome: "succeeded",
      },
    ]);
    expect(events).toMatchObject([
      { id: `${sale}:due`, type: "sale.due", amountDueCents: 290 },
    ]);
    for (let i = 0; i < 3; i++) await saleById(sale, deps);
    expect(ivora.reportsOf().filter((r) => r.kind === "capture")).toHaveLength(
      1,
    );

    const paid = await markSalePaid(
      { sale, amountCents: 290, method: "cash", posReference: null },
      deps,
    );
    expect(paid.amounts).toMatchObject({ outstandingCents: 0, status: "paid" });
    expect(ivora.reportsOf().at(-1)).toMatchObject({
      kind: "capture",
      operation_reference: `${sale}:extra:cash`,
      amount_minor: 290,
    });
    expect(ivora.keys("report:capture").at(-1)).toBe(
      `forecourt:store:${sale}:report:extra`,
    );
  });

  it("owes the whole prepaid amount back when charging never starts", async () => {
    await authorize(PREPAY);
    const sale = saleIdFor(PREPAY, REQ);
    const view = await stopSale(sale, deps);
    expect(view.phase).toBe("canceled");
    expect(ivora.keys("cancel")).toEqual([`forecourt:store:${sale}:cancel`]);
    expect(view.amounts).toMatchObject({ changeCents: 2000, status: "change" });
    expect((await giveChange(sale, deps)).amounts?.status).toBe("paid");
  });
});

describe("postpay: authorise, charge, mark paid", () => {
  it("needs the car plugged in, then bills the final amount with idle fees", async () => {
    ivora.station = station("Available");
    await expect(authorize(POSTPAY)).rejects.toMatchObject({
      code: "connector_not_ready",
    });
    expect(ivora.calls).toEqual([]);
    ivora.station = station("Preparing");
    await authorize(POSTPAY);
    const sale = saleIdFor(POSTPAY, REQ);
    expect(ivora.calls.map((c) => c.action)).toEqual(["create", "start"]); // no money yet
    ivora.charging(36_000, 1800);
    ivora.ended(2340, quote(1620, 18));
    const done = await saleById(sale, deps);
    expect(done.amounts).toMatchObject({
      dueCents: 1940,
      outstandingCents: 1940,
      status: "due",
    });
    expect(ivora.reportsOf()).toEqual([]);
    expect(events).toMatchObject([
      { sale, amountDueCents: 1940, mode: "postpay" },
    ]);
  });

  it("marks paid once, by sale ID, for exactly the amount due", async () => {
    await authorize(POSTPAY);
    const sale = saleIdFor(POSTPAY, REQ);
    await expect(
      markSalePaid(
        { sale, amountCents: 1940, method: "cash", posReference: null },
        deps,
      ),
    ).rejects.toMatchObject({ code: "bill_not_final" });
    ivora.charging(36_000, 1800);
    ivora.ended(2340, quote(1620, 18));
    await expect(
      markSalePaid(
        { sale, amountCents: 2340, method: "cash", posReference: null },
        deps,
      ),
    ).rejects.toMatchObject({ code: "amount_mismatch" });
    const input = {
      sale,
      amountCents: 1940,
      method: "card" as const,
      posReference: "POS-1042",
    };
    const paid = await markSalePaid(input, deps);
    expect(paid.amounts?.payments).toEqual([
      {
        step: "paid",
        method: "card",
        posReference: "POS-1042",
        amountCents: 1940,
      },
    ]);
    await markSalePaid(input, deps); // a repeat (double tap, retry) is a no-op
    await markSalePaid({ ...input, method: "cash", posReference: null }, deps);
    expect(ivora.keys("report:capture")).toEqual([
      `forecourt:store:${sale}:report:paid`,
    ]);
    await expect(
      markSalePaid({ ...input, amountCents: 5 }, deps),
    ).rejects.toMatchObject({ code: "already_paid" });
  });
});

describe("no start without the cashier", () => {
  it("never starts a prepared session from a read; it cancels it after a while", async () => {
    const sale = saleIdFor(POSTPAY, REQ);
    // A session created (say by a lost request) but not started by authorizeSale.
    const s = await ivora.createSession(
      {
        station_id: 7,
        connector_id: 71,
        tariff_id: 9001,
        application_reference: `forecourt:store:${sale}`,
        processor: "in-store",
        merchant_reference: "forecourt-store",
        payment_reference: sale,
      },
      "k",
    );
    const charger = {
      code: "PUMP-3",
      label: "Charger 3",
      name: "Pump 3",
      connector: 1,
      connectorId: 71,
      connectorLabel: "connector 1",
      tariffId: 9001,
      status: "Preparing",
      online: true,
      maxPowerW: null,
    };
    await progressSale(s, charger, deps);
    await consoleState(deps);
    expect(ivora.keys("start")).toEqual([]);
    now = T0 + PREPARED_TIMEOUT_MS + 1;
    const view = await progressSale(
      await ivora.getSession(s.id),
      charger,
      deps,
    );
    expect(view.phase).toBe("canceled");
    expect(ivora.keys("start")).toEqual([]);
  });

  it("refuses a prepay with no amount, and an offline charger", async () => {
    await expect(
      authorize({ ...PREPAY, prepaidCents: null }),
    ).rejects.toMatchObject({ code: "invalid_sale" });
    await expect(
      authorize({ ...PREPAY, prepaidCents: 99 }),
    ).rejects.toMatchObject({ code: "invalid_sale" });
    ivora.station = station("Available", false);
    await expect(authorize(PREPAY)).rejects.toMatchObject({
      code: "charger_offline",
    });
    expect(ivora.calls).toEqual([]);
  });

  it("repeating the same authorisation creates and starts once", async () => {
    await authorize(PREPAY);
    await authorize(PREPAY);
    ivora.station = station("Charging"); // the car has started meanwhile
    await authorize(PREPAY);
    expect(ivora.keys("start")).toHaveLength(1);
    expect(new Set(ivora.keys("create")).size).toBe(1);
    expect(ivora.sessions.size).toBe(1);
  });

  it("warns about a charger charging without a console sale", async () => {
    ivora.station = station("Charging");
    const state = await consoleState(deps);
    expect(state.tiles[0]).toMatchObject({
      label: "Charger 3",
      state: "charging",
      canPrepay: false,
    });
    expect(state.tiles[0].warning).toMatch(/requires authorisation/);
    expect(
      tileState({
        online: true,
        status: "Preparing",
        sale: null,
        cardOpen: false,
        foreignOpen: false,
      }),
    ).toMatchObject({
      state: "plugged_in",
      warning: null,
      canPostpay: true,
      canPrepay: true,
    });
    expect(
      tileState({
        online: true,
        status: "Charging",
        sale: null,
        cardOpen: true,
        foreignOpen: false,
      }),
    ).toMatchObject({ state: "card", warning: null, canPrepay: false });
  });
});

describe("console tiles", () => {
  it("follows a sale from plugged in to done unpaid to paid", async () => {
    expect((await consoleState(deps)).tiles[0].state).toBe("plugged_in");
    await authorize(POSTPAY);
    const sale = saleIdFor(POSTPAY, REQ);
    expect((await consoleState(deps)).tiles[0].state).toBe("starting");
    ivora.charging(10_000, 600);
    ivora.station = station("Charging");
    expect((await consoleState(deps)).tiles[0]).toMatchObject({
      state: "charging",
      warning: null,
    });
    ivora.ended(900, quote(900, 0));
    ivora.station = station("Finishing");
    expect((await consoleState(deps)).tiles[0].state).toBe("done_unpaid");
    await markSalePaid(
      { sale, amountCents: 900, method: "cash", posReference: null },
      deps,
    );
    expect((await consoleState(deps)).tiles[0].state).toBe("paid");
  });
});

describe("prepaid stop with no console or driver screen open", () => {
  it("stops when meter samples cross the limit", async () => {
    await authorize(PREPAY);
    const sale = saleIdFor(PREPAY, REQ);
    const sample = { transactionId: 21, stationId: 7 };
    ivora.charging(20_000, 1200, 150_000);
    expect(await onMeterSample(sample, deps)).toMatchObject([
      { sale, stopping: false },
    ]);
    expect(ivora.keys("stop")).toEqual([]);
    // Samples for another transaction or station don't touch this sale.
    ivora.charging(30_500, 1847, 150_000);
    expect(
      await onMeterSample({ transactionId: 99, stationId: 7 }, deps),
    ).toEqual([]);
    expect(
      await onMeterSample({ transactionId: 21, stationId: 8 }, deps),
    ).toEqual([]);
    expect(ivora.keys("stop")).toEqual([]);
    // Only the webhook runs here: no saleById, consoleState or counterState.
    const [view] = await onMeterSample(sample, deps);
    expect(view).toMatchObject({ stopping: true, limitReached: "amount" });
    expect(ivora.keys("stop")).toEqual([`forecourt:store:${sale}:stop`]);
    await onMeterSample(sample, deps);
    expect(ivora.keys("stop")).toHaveLength(1);
  });

  it("leaves pay-after sales alone and reuses the session list briefly", async () => {
    await authorize(POSTPAY);
    ivora.charging(30_500, 5000, 150_000);
    expect(
      await onMeterSample({ transactionId: 21, stationId: 7 }, deps),
    ).toEqual([]);
    await onMeterSample({ transactionId: 21, stationId: 7 }, deps);
    expect(ivora.keys("list")).toHaveLength(1);
    now += SESSION_LIST_TTL_MS;
    await onMeterSample({ transactionId: 21, stationId: 7 }, deps);
    expect(ivora.keys("list")).toHaveLength(2);
    expect(ivora.keys("stop")).toEqual([]);
  });
});

describe("a stop that doesn't take", () => {
  async function overLimit() {
    await authorize(PREPAY);
    const sale = saleIdFor(PREPAY, REQ);
    ivora.charging(30_500, 1847, 150_000);
    expect(await saleById(sale, deps)).toMatchObject({ stopping: true });
    return sale;
  }

  it("retries a rejected stop with a new key, then shows the cashier it failed", async () => {
    const sale = await overLimit();
    const key = (n: string) => `forecourt:store:${sale}:${n}`;
    ivora.settleStop("rejected");
    expect(await saleById(sale, deps)).toMatchObject({
      stopping: true,
      stopProblem: null,
    });
    expect(ivora.keys("stop")).toEqual([key("stop"), key("stop-2")]);
    ivora.settleStop("rejected");
    await saleById(sale, deps);
    expect(ivora.keys("stop")).toEqual([
      key("stop"),
      key("stop-2"),
      key("stop-3"),
    ]);
    // The $20 sale keeps charging past its limit: never "Stopping…" now.
    ivora.settleStop("rejected");
    ivora.charging(41_000, 2600, 150_000);
    const failed = await saleById(sale, deps);
    expect(failed).toMatchObject({
      phase: "charging",
      stopping: false,
      stopProblem: "failed",
      canStop: true,
      message: "Stop failed: stop it at the charger.",
    });
    // Bounded: reads and the cashier's stop button send nothing more.
    await saleById(sale, deps);
    await stopSale(sale, deps);
    expect(ivora.keys("stop")).toHaveLength(3);
    const tile = (await consoleState(deps)).tiles[0];
    expect(tile.sale?.stopProblem).toBe("failed");
    expect(driverSale(failed).message).toBe("Please see the cashier.");
  });

  it("never resends a stop with an unknown outcome under a new key", async () => {
    const sale = await overLimit();
    ivora.settleStop("unknown");
    expect(await saleById(sale, deps)).toMatchObject({
      stopping: false,
      stopProblem: "unconfirmed",
    });
    await stopSale(sale, deps);
    expect(ivora.keys("stop")).toEqual([`forecourt:store:${sale}:stop`]);
  });

  it("retries a lost answer with the same key, not the next one", async () => {
    const sale = await overLimit();
    ivora.settleStop("rejected");
    ivora.loseNextStop = true;
    await expect(saleById(sale, deps)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    await saleById(sale, deps);
    expect(ivora.keys("stop")).toEqual([
      `forecourt:store:${sale}:stop`,
      `forecourt:store:${sale}:stop-2`,
    ]);
  });

  it("shows a failed stop when Ivora refuses another attempt", async () => {
    const sale = await overLimit();
    ivora.refuseRetry = true;
    ivora.settleStop("rejected");
    expect(await saleById(sale, deps)).toMatchObject({
      stopProblem: "failed",
    });
    expect(ivora.keys("stop")).toHaveLength(1);
  });
});

describe("settlement references", () => {
  it("gives the prepay capture its own reference; the API refuses a reused one", async () => {
    await authorize(PREPAY);
    const sale = saleIdFor(PREPAY, REQ);
    ivora.charging(30_000, 1500);
    ivora.ended(1612, quote(1612, 0));
    const id = ivora.only().id;
    // What the earlier version sent: a capture under the authorization's reference.
    await expect(
      ivora.reportSettlement(id, {
        kind: "capture",
        operation_reference: sale,
        amount_minor: 1612,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const done = await saleById(sale, deps);
    expect(done.amounts).toMatchObject({
      prepaidRecorded: true,
      changeCents: 388,
    });
    expect(
      ivora.reportsOf().map((r) => [r.kind, r.operation_reference]),
    ).toEqual([
      ["authorization", sale],
      ["capture", `${sale}:capture`],
    ]);
  });
});

describe("the driver's screen", () => {
  it("gets status and amounts, never payments or POS references", async () => {
    await authorize(POSTPAY);
    const sale = saleIdFor(POSTPAY, REQ);
    ivora.charging(36_000, 1800);
    ivora.ended(2340, quote(1620, 18));
    const paid = await markSalePaid(
      { sale, amountCents: 1940, method: "card", posReference: "POS-1042" },
      deps,
    );
    const driver = driverSale(paid);
    expect(driver).toMatchObject({
      phase: "done",
      energyWh: 36_000,
      amounts: { dueCents: 1940, outstandingCents: 0, status: "paid" },
    });
    const text = JSON.stringify(driver);
    expect(text).not.toContain("POS-1042");
    expect(text).not.toContain("payments");
    expect(text).not.toContain(sale);
  });
});

describe("webhook meter samples", () => {
  it("reads the transaction and station of a meter.sampled event only", () => {
    expect(
      meterSampleFromEvent({
        type: "meter.sampled",
        resource_id: "31",
        station_id: 7,
        data: { transaction_id: 31, energy_wh: 6941 },
      }),
    ).toEqual({ transactionId: 31, stationId: 7 });
    expect(meterSampleFromEvent({ type: "meter.sampled", data: {} })).toEqual({
      transactionId: null,
      stationId: null,
    });
    expect(
      meterSampleFromEvent({ type: "bill.finalized", data: {} }),
    ).toBeNull();
  });
});
