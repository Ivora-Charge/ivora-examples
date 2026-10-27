// Demo mode: a simulated forecourt from scan to receipt. Everything here is a
// pure function of the session ID and the clock. It never calls Ivora, Stripe
// or any other service, and the state lives in the ID so any server instance
// can answer.

import { idleFeeTiming } from "./idle";
import type { Settings } from "./settings";
import { localQuote, priceBreakdown, type Tariff } from "./tariff";
import { buildReceipt, type SessionView } from "./view";

/** Demo time runs 30x faster so a full session takes about a minute. */
export const DEMO_SPEED = 30;
/** Real milliseconds between "payment authorized" and the charger starting. */
export const DEMO_START_DELAY_MS = 3000;
/** The simulated car's battery takes this much energy before it is full. */
export const DEMO_BATTERY_WH = 36_000;

export const DEMO_TARIFF: Tariff = {
  id: 9001,
  currency: "USD",
  rate_minor_per_kwh: 45,
  authorization_minor: 5000,
  is_complex: true,
  pricing_summary:
    "Demo prices: $0.45/kWh, $0.06/min charging, $0.40/min idle, $1.00 per session",
  elements: [
    {
      price_components: [
        { type: "ENERGY", price: 0.45, step_size: 1 },
        { type: "TIME", price: 3.6, step_size: 60 },
        { type: "PARKING_TIME", price: 24, step_size: 60 },
        { type: "FLAT", price: 1 },
      ],
    },
  ],
};

/** The CAD sample: a Canadian site priced in CA$, shown next to the USD one. */
export const DEMO_TARIFF_CAD: Tariff = {
  id: 9002,
  currency: "CAD",
  rate_minor_per_kwh: 52,
  authorization_minor: 5000,
  is_complex: true,
  pricing_summary:
    "Demo prices: CA$0.52/kWh, CA$0.07/min charging, CA$0.50/min idle, CA$1.50 per session",
  elements: [
    {
      price_components: [
        { type: "ENERGY", price: 0.52, step_size: 1 },
        { type: "TIME", price: 4.2, step_size: 60 },
        { type: "PARKING_TIME", price: 30, step_size: 60 },
        { type: "FLAT", price: 1.5 },
      ],
    },
  ],
};

export const DEMO_TARIFFS: Tariff[] = [DEMO_TARIFF, DEMO_TARIFF_CAD];

export type DemoConnector = {
  number: number;
  label: string;
  maxPowerW: number;
  status: string;
  /** A sample session that isn't an in-store sale: paid by card, or started outside the console. */
  session?: "card" | "outside";
};

export type DemoCharger = {
  code: string;
  name: string;
  online: boolean;
  connectors: DemoConnector[];
  /** Defaults to the USD sample tariff. */
  tariff?: Tariff;
};

export const DEMO_SITE_NAME = "Sample Forecourt (demo data)";

const ccs = (status: string, maxPowerW = 150_000): DemoConnector[] => [
  { number: 1, label: "CCS", maxPowerW, status },
];

// Chargers 1 and 2 show pay at the charger; 3 to 10 put the cashier console in
// every state (the in-store samples themselves are in src/lib/demo-store.ts).
export const DEMO_CHARGERS: DemoCharger[] = [
  {
    code: "DEMO-1",
    name: "Demo charger 1",
    online: true,
    connectors: [
      { number: 1, label: "CCS", maxPowerW: 150_000, status: "Available" },
      { number: 2, label: "CHAdeMO", maxPowerW: 50_000, status: "Available" },
    ],
  },
  {
    code: "DEMO-2",
    name: "Demo charger 2",
    online: true,
    connectors: [
      {
        number: 1,
        label: "CCS",
        maxPowerW: 150_000,
        status: "Charging",
        session: "card",
      },
      { number: 2, label: "CCS", maxPowerW: 150_000, status: "Faulted" },
    ],
  },
  // Car plugged in, waiting for the cashier.
  {
    code: "DEMO-3",
    name: "Demo charger 3",
    online: true,
    connectors: ccs("Preparing"),
  },
  {
    code: "DEMO-4",
    name: "Demo charger 4",
    online: true,
    connectors: ccs("Preparing"),
  },
  // Sample in-store sales: prepaid and charging, done unpaid, prepaid overrun, paid.
  {
    code: "DEMO-5",
    name: "Demo charger 5",
    online: true,
    connectors: ccs("Available", 50_000),
  },
  {
    code: "DEMO-6",
    name: "Demo charger 6",
    online: true,
    connectors: ccs("Available"),
  },
  {
    code: "DEMO-7",
    name: "Demo charger 7",
    online: true,
    connectors: ccs("Available"),
  },
  {
    code: "DEMO-8",
    name: "Demo charger 8",
    online: true,
    connectors: ccs("Available"),
  },
  {
    code: "DEMO-9",
    name: "Demo charger 9",
    online: false,
    connectors: ccs("Unavailable"),
  },
  {
    code: "DEMO-10",
    name: "Demo charger 10",
    online: true,
    connectors: [
      {
        number: 1,
        label: "CCS",
        maxPowerW: 150_000,
        status: "Charging",
        session: "outside",
      },
    ],
  },
  // The CAD sample: pay at the charger only, like chargers 1 and 2.
  {
    code: "DEMO-11",
    name: "Demo charger 11 (Toronto, CAD)",
    online: true,
    connectors: ccs("Available"),
    tariff: DEMO_TARIFF_CAD,
  },
];

/** The sample tariff a demo charger is priced on. */
export function demoTariff(charger: Pick<DemoCharger, "tariff">): Tariff {
  return charger.tariff ?? DEMO_TARIFF;
}

/** Connector states a driver can start from: free, or plugged in and waiting. */
export const DEMO_READY = new Set(["Available", "Preparing"]);

export function demoCharger(code: string) {
  return DEMO_CHARGERS.find((c) => c.code === code) ?? null;
}

type DemoId = {
  code: string;
  connector: number;
  start: number;
  stop: number | null;
  unplug: number | null;
};

const ID =
  /^demo\.([A-Za-z0-9-]{1,40})\.(\d{1,2})\.([0-9a-z]{1,12})(?:\.s([0-9a-z]{1,12}))?(?:\.u([0-9a-z]{1,12}))?$/;

export function isDemoId(id: string) {
  return id.startsWith("demo.");
}

export function encodeDemoId(d: DemoId): string {
  let id = `demo.${d.code}.${d.connector}.${d.start.toString(36)}`;
  if (d.stop !== null) id += `.s${d.stop.toString(36)}`;
  if (d.unplug !== null) id += `.u${d.unplug.toString(36)}`;
  return id;
}

export function decodeDemoId(id: string): DemoId | null {
  const m = ID.exec(id);
  if (!m) return null;
  const n = (v: string | undefined) => (v ? parseInt(v, 36) : null);
  return {
    code: m[1],
    connector: Number(m[2]),
    start: parseInt(m[3], 36),
    stop: n(m[4]),
    unplug: n(m[5]),
  };
}

export function startDemoSession(code: string, connector: number, now: number) {
  const charger = demoCharger(code);
  const c = charger?.connectors.find((x) => x.number === connector);
  if (!charger || !c) throw new Error("Unknown demo charger.");
  if (!charger.online) throw new Error("This charger is offline.");
  if (!DEMO_READY.has(c.status))
    throw new Error(`This connector is ${c.status.toLowerCase()}.`);
  return encodeDemoId({
    code,
    connector,
    start: now,
    stop: null,
    unplug: null,
  });
}

/** The driver pressed stop: the charging transaction ends now. */
export function stopDemoSession(id: string, now: number) {
  const d = decodeDemoId(id);
  if (!d) throw new Error("Unknown demo session.");
  if (d.stop !== null || d.unplug !== null) return id;
  return encodeDemoId({ ...d, stop: now });
}

/** The driver unplugged after charging finished: the transaction ends now. */
export function unplugDemoSession(id: string, now: number) {
  const d = decodeDemoId(id);
  if (!d) throw new Error("Unknown demo session.");
  if (d.stop !== null || d.unplug !== null) return id;
  return encodeDemoId({ ...d, unplug: now });
}

/**
 * The simulated car charges at full power to 70%, then at a third of it until
 * full. Returns energy (Wh) and power (W) after `simSeconds` of charging.
 */
export function demoCurve(maxPowerW: number, simSeconds: number) {
  const fastWh = DEMO_BATTERY_WH * 0.7;
  const slowW = maxPowerW / 3;
  const fastEnd = (fastWh / maxPowerW) * 3600;
  const fullAt = fastEnd + ((DEMO_BATTERY_WH - fastWh) / slowW) * 3600;
  const t = Math.max(0, simSeconds);
  if (t <= fastEnd)
    return {
      energyWh: Math.floor((maxPowerW * t) / 3600),
      powerW: maxPowerW,
      fullAtSim: fullAt,
    };
  if (t < fullAt)
    return {
      energyWh: Math.floor(fastWh + (slowW * (t - fastEnd)) / 3600),
      powerW: Math.round(slowW),
      fullAtSim: fullAt,
    };
  return { energyWh: DEMO_BATTERY_WH, powerW: 0, fullAtSim: fullAt };
}

export function demoView(
  id: string,
  now: number,
  settings: Pick<Settings, "idleGraceMinutes" | "applicationFeeBps">,
): SessionView | null {
  const d = decodeDemoId(id);
  const charger = d && demoCharger(d.code);
  const connector = charger?.connectors.find((c) => c.number === d?.connector);
  if (!d || !charger || !connector) return null;
  const tariff = demoTariff(charger);
  const prices = priceBreakdown(tariff);
  const chargingStart = d.start + DEMO_START_DELAY_MS;
  const ended = d.stop ?? d.unplug;
  // Simulated time in whole milliseconds, so countdowns don't drift on float error.
  const at = ended !== null ? Math.min(ended, now) : now;
  const simAtMs = Math.round(Math.max(0, at - chargingStart) * DEMO_SPEED);
  const fullAtMs = Math.round(
    demoCurve(connector.maxPowerW, 0).fullAtSim * 1000,
  );
  const chargingSim = Math.min(simAtMs, fullAtMs) / 1000;
  const idleSim = Math.max(0, simAtMs - fullAtMs) / 1000;
  const { energyWh, powerW } = demoCurve(connector.maxPowerW, chargingSim);
  const base: SessionView = {
    id,
    demo: true,
    phase: "starting",
    charger: {
      code: charger.code,
      name: charger.name,
      connector: connector.number,
    },
    currency: tariff.currency,
    holdCents: tariff.authorization_minor,
    checkoutUrl: null,
    energyWh: 0,
    powerW: null,
    runningCents: null,
    startedAt: null,
    endedAt: null,
    idle: null,
    speed: DEMO_SPEED,
    canStop: true,
    receipt: null,
    message: null,
    error: null,
  };
  const startedAt = new Date(chargingStart).toISOString();

  if (ended !== null && ended < chargingStart)
    return {
      ...base,
      phase: "canceled",
      canStop: false,
      message: "Stopped before charging started. The demo hold was released.",
    };
  if (ended === null && now < chargingStart) return base;

  const profile = {
    energyWh,
    chargingSeconds: Math.round(chargingSim),
    idleSeconds: Math.round(idleSim),
  };
  const quote = localQuote(tariff, profile);

  if (ended !== null) {
    return {
      ...base,
      phase: "completed",
      canStop: false,
      energyWh,
      powerW: 0,
      runningCents: quote.total_minor,
      startedAt,
      endedAt: new Date(ended).toISOString(),
      message:
        d.stop !== null
          ? "Charging stopped. Please move your car so the next driver can charge."
          : null,
      receipt: buildReceipt({
        bill: quote,
        billTotalCents: quote.total_minor,
        holdCents: tariff.authorization_minor,
        idleSeconds: profile.idleSeconds,
        graceMinutes: settings.idleGraceMinutes,
        applicationFeeBps: settings.applicationFeeBps,
        chargeApplicationFee: true,
        energyWh,
        startedAt,
        endedAt: new Date(ended).toISOString(),
      }),
    };
  }

  if (simAtMs < fullAtMs)
    return {
      ...base,
      phase: "charging",
      energyWh,
      powerW,
      runningCents: quote.total_minor,
      startedAt,
    };

  // Car is full and still plugged in. Countdown runs on simulated time.
  // Only the relative figures (seconds left, amount so far) are shown in demo.
  const idle = idleFeeTiming({
    idleSince: new Date(fullAtMs).toISOString(),
    graceMinutes: settings.idleGraceMinutes,
    idleCentsPerHour: prices.idlePerHour / 100,
    stepSeconds: prices.idleStepSeconds,
    now: simAtMs,
  });
  return {
    ...base,
    phase: "finished",
    energyWh,
    powerW: 0,
    runningCents: quote.total_minor,
    startedAt,
    idle: {
      ...idle,
      idleCentsPerHour: prices.idlePerHour / 100,
      graceMinutes: settings.idleGraceMinutes,
    },
    message: "Charging complete. Please move your car.",
  };
}
