// Demo mode for pay in store: a simulated forecourt with a cashier console.
// Like src/lib/demo.ts it never calls Ivora or any other service. The state is
// a short list of sales kept in a cookie in the visitor's own browser, so the
// console and the driver's "pay at the counter" screen (opened in the same
// browser) see the same sales, every visitor gets their own forecourt, and any
// server instance can answer. Charging follows the same simulated car as the
// card demo, 30 times faster.

import { z } from "zod";
import {
  DEMO_CHARGERS,
  DEMO_SPEED,
  DEMO_START_DELAY_MS,
  DEMO_TARIFF,
  demoCurve,
  type DemoCharger,
  type DemoConnector,
} from "./demo";
import type { Settings } from "./settings";
import {
  changeReport,
  chargerLabel,
  decodeSaleId,
  encodeSaleId,
  endReports,
  paidReport,
  PLUGGED_STATUSES,
  prepayStop,
  READY_STATUSES,
  saleAmounts,
  saleBill,
  SaleError,
  startReports,
  tileState,
  validateTerms,
  type PaymentMethod,
  type PlannedReport,
  type SaleReport,
  type SaleTerms,
  type SaleView,
  type Tile,
} from "./store";
import { localQuote, priceBreakdown } from "./tariff";

export const DEMO_STORE_COOKIE = "fc_demo_store";
/** Simulated seconds a stop takes to reach the car. */
export const DEMO_STOP_LAG_SIM_SECONDS = 20;
/** "Paid" stays on a tile this long (real time) after the last payment. */
export const DEMO_PAID_DISPLAY_MS = 10 * 60 * 1000;
const MAX_SALES = 24;

const reportSchema = z.object({
  kind: z.enum(["authorization", "capture", "refund", "release"]),
  operation_reference: z.string().max(128),
  outcome: z.enum(["pending", "unknown", "succeeded", "failed"]),
  amount_minor: z.number().int().nonnegative(),
  created_at: z.string().max(40).optional(),
});

const saleSchema = z.object({
  sale: z.string().max(40),
  code: z.string().max(40),
  connector: z.number().int().min(1).max(99),
  start: z.number().int(),
  stop: z.number().int().nullable(),
  unplug: z.number().int().nullable(),
  /** Simulated seconds between a stop and the car stopping; samples use a slow charger. */
  lag: z.number().int().min(0).max(3600).optional(),
  /** What the cashier recorded: payments and change. */
  reports: z.array(reportSchema).max(8),
});
export type DemoSale = z.infer<typeof saleSchema>;

const storeSchema = z.object({
  seeded: z.number().int(),
  sales: z.array(saleSchema).max(MAX_SALES),
});
export type DemoStore = z.infer<typeof storeSchema>;

export function encodeDemoStore(store: DemoStore) {
  return Buffer.from(JSON.stringify(store)).toString("base64url");
}

/** A missing, old or tampered cookie gives a fresh sample forecourt. */
export function decodeDemoStore(
  value: string | undefined,
  now: number,
): { store: DemoStore; fresh: boolean } {
  if (value) {
    try {
      const parsed = storeSchema.safeParse(
        JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
      );
      if (
        parsed.success &&
        parsed.data.sales.every((s) => decodeSaleId(s.sale))
      )
        return { store: parsed.data, fresh: false };
    } catch {
      // fall through to a fresh store
    }
  }
  return { store: seedDemoStore(now), fresh: true };
}

/** Small deterministic hash for demo sale nonces (not for security). */
function nonce(input: string) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return (a.toString(36) + b.toString(36)).padStart(12, "0").slice(-12);
}

const at = (ms: number) => new Date(ms).toISOString();

function place(code: string, connector: number) {
  const charger = DEMO_CHARGERS.find((c) => c.code === code);
  const c = charger?.connectors.find((x) => x.number === connector);
  return charger && c ? { charger, connector: c } : null;
}

/** Sample sales so the console opens with chargers in every state. */
export function seedDemoStore(now: number): DemoStore {
  const charging = (start: number) => start + DEMO_START_DELAY_MS;
  const full150 = demoCurve(150_000, 0).fullAtSim;
  const sim = (seconds: number) => (seconds * 1000) / DEMO_SPEED;
  const sale = (terms: SaleTerms, code: string) =>
    encodeSaleId(terms, nonce(`seed:${code}:${now}`));
  const s6 = now - 180_000;
  const s8 = now - 300_000;
  const store: DemoStore = {
    seeded: now,
    sales: [
      {
        // Prepaid $30 and charging.
        sale: sale(
          { mode: "prepay", prepaidCents: 3000, limitWh: null },
          "DEMO-5",
        ),
        code: "DEMO-5",
        connector: 1,
        start: now - 20_000,
        stop: null,
        unplug: null,
        reports: [],
      },
      {
        // Pay after charging: finished with idle time, waiting at the counter.
        sale: sale(
          { mode: "postpay", prepaidCents: null, limitWh: null },
          "DEMO-6",
        ),
        code: "DEMO-6",
        connector: 1,
        start: s6,
        stop: null,
        unplug: Math.round(charging(s6) + sim(full150 + 15 * 60)),
        reports: [],
      },
      {
        // Prepaid $15 on a charger that was slow to stop: used more than prepaid.
        sale: sale(
          { mode: "prepay", prepaidCents: 1500, limitWh: null },
          "DEMO-7",
        ),
        code: "DEMO-7",
        connector: 1,
        start: now - 240_000,
        stop: null,
        unplug: null,
        lag: 900,
        reports: [],
      },
      {
        // Paid by card on the store's POS.
        sale: sale(
          { mode: "postpay", prepaidCents: null, limitWh: null },
          "DEMO-8",
        ),
        code: "DEMO-8",
        connector: 1,
        start: s8,
        stop: Math.round(charging(s8) + sim(600)),
        unplug: null,
        reports: [],
      },
    ],
  };
  const paid = store.sales[3];
  const view = demoSaleView(paid, now, { idleGraceMinutes: 10 })!;
  paid.reports.push({
    kind: "capture",
    operation_reference: `${paid.sale}:paid:card:POS-1042`,
    outcome: "succeeded",
    amount_minor: view.amounts!.outstandingCents,
    created_at: at(now - 60_000),
  });
  return store;
}

const autoStops = new Map<
  string,
  { simMs: number; reason: "amount" | "energy" } | null
>();

/** When the app would send the prepay stop, in simulated ms after charging starts. */
function autoStop(sale: DemoSale, terms: SaleTerms, c: DemoConnector) {
  if (terms.mode !== "prepay" || !terms.prepaidCents) return null;
  const key = `${sale.sale}|${c.maxPowerW}`;
  if (autoStops.has(key)) return autoStops.get(key)!;
  const b = priceBreakdown(DEMO_TARIFF);
  const fullAt = demoCurve(c.maxPowerW, 0).fullAtSim;
  let found: { simMs: number; reason: "amount" | "energy" } | null = null;
  for (let t = 0; t <= fullAt + 3 * 3600; t += 5) {
    const p = profile(c, t * 1000);
    const d = prepayStop({
      prepaidCents: terms.prepaidCents,
      limitWh: terms.limitWh,
      estimatedCents: p.quote.total_minor,
      energyWh: p.energyWh,
      powerW: p.powerW,
      energyPerKwh: b.energyPerKwh,
      timePerHour: b.timePerHour,
      idlePerHour: b.idlePerHour,
    });
    if (d.stop) {
      found = { simMs: t * 1000, reason: d.reason! };
      break;
    }
  }
  if (autoStops.size > 500) autoStops.clear();
  autoStops.set(key, found);
  return found;
}

/** Energy, power and price after `simMs` of simulated time plugged in and authorised. */
function profile(c: DemoConnector, simMs: number) {
  const fullAtMs = Math.round(demoCurve(c.maxPowerW, 0).fullAtSim * 1000);
  const chargingSim = Math.min(simMs, fullAtMs) / 1000;
  const idleSeconds = Math.round(Math.max(0, simMs - fullAtMs) / 1000);
  const { energyWh, powerW } = demoCurve(c.maxPowerW, chargingSim);
  return {
    energyWh,
    powerW: simMs >= fullAtMs ? 0 : powerW,
    full: simMs >= fullAtMs,
    idleSeconds,
    quote: localQuote(DEMO_TARIFF, {
      energyWh,
      chargingSeconds: Math.round(chargingSim),
      idleSeconds,
    }),
  };
}

const asReport = (r: PlannedReport, created?: string): SaleReport => ({
  kind: r.kind,
  operation_reference: r.operation_reference,
  outcome: "succeeded",
  amount_minor: r.amount_minor,
  created_at: created,
});

/** When the transaction ends: the cashier's stop, the unplug, or the prepay stop plus lag. */
function endOf(sale: DemoSale, terms: SaleTerms, c: DemoConnector) {
  const chargingStart = sale.start + DEMO_START_DELAY_MS;
  const auto = autoStop(sale, terms, c);
  const lag = sale.lag ?? DEMO_STOP_LAG_SIM_SECONDS;
  const autoEnd = auto
    ? Math.round(chargingStart + (auto.simMs + lag * 1000) / DEMO_SPEED)
    : null;
  const ends = [sale.stop, sale.unplug, autoEnd].filter(
    (t): t is number => t !== null,
  );
  return {
    chargingStart,
    auto,
    end: ends.length ? Math.min(...ends) : null,
  };
}

export function demoSaleView(
  sale: DemoSale,
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
): SaleView | null {
  const terms = decodeSaleId(sale.sale);
  const found = place(sale.code, sale.connector);
  if (!terms || !found) return null;
  const { charger, connector } = found;
  const { chargingStart, auto, end } = endOf(sale, terms, connector);
  const simAt = (t: number) =>
    Math.round(Math.max(0, t - chargingStart) * DEMO_SPEED);
  const reports: SaleReport[] = [
    ...startReports(sale.sale, terms).map((r) => asReport(r)),
    ...sale.reports,
  ];
  const view: SaleView = {
    sale: sale.sale,
    demo: true,
    terms,
    charger: {
      code: charger.code,
      label: chargerLabel(charger.code, connector.number, 1),
      name: charger.name,
      connector: connector.number,
    },
    phase: "starting",
    currency: DEMO_TARIFF.currency,
    energyWh: 0,
    powerW: null,
    runningCents: null,
    startedAt: null,
    endedAt: null,
    stopping: false,
    limitReached: null,
    canStop: true,
    bill: null,
    amounts: null,
    speed: DEMO_SPEED,
    message: null,
    error: null,
  };

  if (end !== null && end <= now && end < chargingStart)
    return {
      ...view,
      phase: "canceled",
      canStop: false,
      amounts:
        terms.mode === "prepay"
          ? saleAmounts(sale.sale, terms, 0, reports)
          : null,
      message: "Canceled before charging.",
    };
  if (now < chargingStart) return { ...view, message: "Starting the charger…" };

  const ended = end !== null && end <= now;
  const p = profile(connector, simAt(ended ? end : now));
  const live: SaleView = {
    ...view,
    phase: "charging",
    energyWh: p.energyWh,
    powerW: p.powerW,
    runningCents: p.quote.total_minor,
    startedAt: at(chargingStart),
  };

  if (ended) {
    const bill = saleBill({
      bill: p.quote,
      billTotalCents: p.quote.total_minor,
      idleSeconds: p.idleSeconds,
      graceMinutes: settings.idleGraceMinutes,
    });
    const first = saleAmounts(sale.sale, terms, bill.dueCents, reports);
    const all = [
      ...reports,
      ...endReports(sale.sale, terms, first).map((r) => asReport(r)),
    ];
    return {
      ...live,
      phase: "done",
      powerW: 0,
      endedAt: at(end),
      canStop: false,
      bill,
      amounts: saleAmounts(sale.sale, terms, bill.dueCents, all),
    };
  }
  if (auto && simAt(now) >= auto.simMs)
    return {
      ...live,
      stopping: true,
      canStop: false,
      limitReached: auto.reason,
      message:
        auto.reason === "energy"
          ? "Stopping: the prepaid energy is used."
          : "Stopping: the prepaid amount is nearly used.",
    };
  if (p.full)
    return {
      ...live,
      phase: "finished",
      message: `Charging complete. Idle fees apply after ${settings.idleGraceMinutes} free minutes until the car is unplugged.`,
    };
  return live;
}

const ACTIVE = new Set(["starting", "charging", "finished", "settling"]);

function latestSale(store: DemoStore, code: string, connector: number) {
  return (
    store.sales
      .filter((s) => s.code === code && s.connector === connector)
      .at(-1) ?? null
  );
}

/** The connector's status as the charger would report it. */
function statusOf(
  charger: DemoCharger,
  connector: DemoConnector,
  sale: SaleView | null,
) {
  if (!charger.online) return "Offline";
  if (sale?.phase === "starting") return "Preparing";
  if (sale?.phase === "charging")
    return sale.stopping ? "Finishing" : "Charging";
  if (sale?.phase === "finished") return "SuspendedEV";
  return connector.status;
}

function demoTile(
  store: DemoStore,
  charger: DemoCharger,
  connector: DemoConnector,
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
): Tile {
  const latest = latestSale(store, charger.code, connector.number);
  let sale = latest ? demoSaleView(latest, now, settings) : null;
  if (sale) {
    const settled =
      sale.phase === "canceled"
        ? !sale.amounts || sale.amounts.status === "paid"
        : sale.phase === "done" && sale.amounts?.status === "paid";
    const since = Date.parse(
      sale.amounts?.settledAt ?? sale.endedAt ?? at(latest!.start),
    );
    if (settled && now - since > DEMO_PAID_DISPLAY_MS) sale = null;
  }
  const status = statusOf(charger, connector, sale);
  return {
    key: `${charger.code}/${connector.number}`,
    code: charger.code,
    label: chargerLabel(charger.code, connector.number, 1),
    stationName: charger.name,
    connector: connector.number,
    connectorLabel: `${connector.label} · connector ${connector.number}`,
    status,
    online: charger.online,
    sale,
    ...tileState({
      online: charger.online,
      status,
      sale,
      cardOpen: connector.session === "card",
      foreignOpen: false,
    }),
  };
}

/** The demo console: one tile per connector of chargers 3 to 10, plus 1 and 2. */
export function demoConsole(
  store: DemoStore,
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
) {
  const tiles = DEMO_CHARGERS.flatMap((charger) =>
    charger.connectors.map((c) => demoTile(store, charger, c, now, settings)),
  ).map((t) =>
    // Chargers with two connectors are numbered per connector, like pumps.
    t.code === "DEMO-1" || t.code === "DEMO-2"
      ? { ...t, label: chargerLabel(t.code, t.connector, 2) }
      : t,
  );
  const onTiles = new Set(tiles.map((t) => t.sale?.sale));
  const unpaid = store.sales
    .filter((s) => !onTiles.has(s.sale))
    .map((s) => demoSaleView(s, now, settings))
    .filter(
      (v): v is SaleView =>
        v !== null && (v.amounts?.outstandingCents ?? 0) > 0,
    );
  return {
    demo: true,
    tiles,
    unpaid,
    graceMinutes: settings.idleGraceMinutes,
    pollMs: 1000,
  };
}

export function demoCounter(
  store: DemoStore,
  code: string,
  connector: number,
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
) {
  const found = place(code, connector);
  if (!found)
    throw new SaleError(
      404,
      "charger_not_found",
      "This demo charger does not exist.",
    );
  const tile = demoTile(store, found.charger, found.connector, now, settings);
  return {
    demo: true,
    code,
    label: chargerLabel(code, connector, found.charger.connectors.length),
    name: found.charger.name,
    connector,
    status: tile.status,
    online: tile.online,
    sale: tile.sale,
    graceMinutes: settings.idleGraceMinutes,
    pollMs: 1000,
  };
}

function findDemoSale(store: DemoStore, sale: string) {
  const s = store.sales.find((x) => x.sale === sale);
  if (!s)
    throw new SaleError(404, "sale_not_found", "This sale was not found.");
  return s;
}

function replace(store: DemoStore, sale: DemoSale): DemoStore {
  return {
    ...store,
    sales: store.sales.map((s) => (s.sale === sale.sale ? sale : s)),
  };
}

/** The cashier authorised a demo charger. Repeating the same request returns the same sale. */
export function demoAuthorize(
  store: DemoStore,
  input: {
    code: string;
    connector: number;
    terms: SaleTerms;
    requestId: string;
  },
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
): { store: DemoStore; view: SaleView } {
  const problem = validateTerms(input.terms);
  if (problem) throw new SaleError(400, "invalid_sale", problem);
  const sale = encodeSaleId(input.terms, nonce(`sale:${input.requestId}`));
  const existing = store.sales.find((s) => s.sale === sale);
  if (existing) return { store, view: demoSaleView(existing, now, settings)! };
  const found = place(input.code, input.connector);
  if (!found)
    throw new SaleError(
      404,
      "charger_not_found",
      "This charger does not exist.",
    );
  const tile = demoTile(store, found.charger, found.connector, now, settings);
  const allowed =
    input.terms.mode === "postpay" ? tile.canPostpay : tile.canPrepay;
  if (!allowed)
    throw new SaleError(
      409,
      "connector_not_ready",
      tile.sale && ACTIVE.has(tile.sale.phase)
        ? "This charger already has a sale in progress."
        : !tile.online
          ? "This charger is offline."
          : input.terms.mode === "postpay" &&
              READY_STATUSES.has(tile.status) &&
              !PLUGGED_STATUSES.has(tile.status)
            ? "Pay-after needs the car plugged in first. Ask the driver to plug in."
            : `This charger is ${tile.status.toLowerCase()}.`,
    );
  const next: DemoSale = {
    sale,
    code: input.code,
    connector: input.connector,
    start: now,
    stop: null,
    unplug: null,
    reports: [],
  };
  // Keep the newest sales; older settled ones drop off.
  const sales = [...store.sales, next].slice(-MAX_SALES);
  return {
    store: { ...store, sales },
    view: demoSaleView(next, now, settings)!,
  };
}

function update(
  store: DemoStore,
  sale: string,
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
  change: (s: DemoSale, view: SaleView) => DemoSale,
) {
  const s = findDemoSale(store, sale);
  const next = change(s, demoSaleView(s, now, settings)!);
  return {
    store: replace(store, next),
    view: demoSaleView(next, now, settings)!,
  };
}

/** The cashier pressed stop. Before charging starts this cancels the sale. */
export function demoStop(
  store: DemoStore,
  sale: string,
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
) {
  return update(store, sale, now, settings, (s, view) =>
    ACTIVE.has(view.phase) && !view.stopping ? { ...s, stop: now } : s,
  );
}

/** Demo only: the driver unplugs a finished car, which ends the transaction. */
export function demoUnplug(
  store: DemoStore,
  sale: string,
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
) {
  return update(store, sale, now, settings, (s, view) =>
    ACTIVE.has(view.phase) ? { ...s, unplug: now } : s,
  );
}

export function demoMarkPaid(
  store: DemoStore,
  input: {
    sale: string;
    amountCents: number;
    method: PaymentMethod;
    posReference: string | null;
  },
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
) {
  return update(store, input.sale, now, settings, (s, view) => {
    if (view.phase !== "done" || !view.amounts)
      throw new SaleError(
        409,
        "bill_not_final",
        "The bill isn't final yet. Mark it paid when the charging session has ended.",
      );
    const rule = paidReport(s.sale, view.terms, view.amounts, input);
    if (!rule.ok) throw new SaleError(409, rule.code, rule.message);
    return rule.report
      ? { ...s, reports: [...s.reports, asReport(rule.report, at(now))] }
      : s;
  });
}

export function demoGiveChange(
  store: DemoStore,
  sale: string,
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
) {
  return update(store, sale, now, settings, (s, view) => {
    if ((view.phase !== "done" && view.phase !== "canceled") || !view.amounts)
      throw new SaleError(
        409,
        "bill_not_final",
        "Give change once the charging session has ended.",
      );
    const rule = changeReport(s.sale, view.amounts);
    if (!rule.ok) throw new SaleError(409, rule.code, rule.message);
    return rule.report
      ? { ...s, reports: [...s.reports, asReport(rule.report, at(now))] }
      : s;
  });
}

/** Price of a kWh limit with the demo tariff, as the live quote endpoint would. */
export function demoPrepayQuote(
  energyWh: number,
  settings: Pick<Settings, "typicalSessionKwh" | "typicalSessionMinutes">,
) {
  const minutes = Math.max(
    1,
    Math.ceil(
      (settings.typicalSessionMinutes * energyWh) /
        (settings.typicalSessionKwh * 1000),
    ),
  );
  const quote = localQuote(DEMO_TARIFF, {
    energyWh,
    chargingSeconds: minutes * 60,
    idleSeconds: 0,
  });
  return { totalCents: quote.total_minor, currency: quote.currency };
}

export function demoSaleById(
  store: DemoStore,
  sale: string,
  now: number,
  settings: Pick<Settings, "idleGraceMinutes">,
) {
  const s = findDemoSale(store, sale);
  return demoSaleView(s, now, settings)!;
}
