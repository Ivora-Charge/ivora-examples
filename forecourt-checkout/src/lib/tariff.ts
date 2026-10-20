import { formatCents, formatMinorRate, roundHalfUp } from "./money";

// Shapes follow the published OpenAPI (TariffRecord, TariffElement, QuoteRecord).

export type DimensionType = "ENERGY" | "TIME" | "PARKING_TIME" | "FLAT";

export type PriceComponent = {
  type: DimensionType;
  /** Major units excluding tax, at most 4 decimals: 0.35 is $0.35 per kWh. */
  price: number;
  /** ENERGY in Wh, TIME and PARKING_TIME in seconds. */
  step_size?: number;
};

export type TariffElement = {
  price_components: PriceComponent[];
  restrictions?: Record<string, unknown> | null;
};

export type Tariff = {
  id: number;
  currency: string;
  rate_minor_per_kwh: number;
  authorization_minor: number;
  elements?: TariffElement[] | null;
  is_complex?: boolean;
  pricing_summary?: string | null;
  archived?: boolean;
};

export type QuoteLine = {
  type: DimensionType;
  element: number;
  reservation: boolean;
  quantity: string;
  unit: "kWh" | "h" | "session";
  price_minor: string;
  exact_minor: string;
  amount_minor: number;
};

export type QuoteAdjustment = {
  kind: "group_discount" | "merchant_validation" | "max_session_cost";
  rule: string;
  exact_minor: string;
  amount_minor: number;
};

export type Quote = {
  currency: string;
  pricing_version: "energy-v1" | "elements-v1";
  lines: QuoteLine[];
  subtotal_minor: number;
  exact_subtotal_minor: string;
  adjustments: QuoteAdjustment[];
  total_minor: number;
  activity?: { idle_seconds: number; charging_seconds: number } | null;
};

/** Prices in hundredths of a cent, so 4-decimal major prices stay integers. */
export type PriceBreakdown = {
  currency: string;
  energyPerKwh: number;
  timePerHour: number;
  idlePerHour: number;
  sessionFee: number;
  timeStepSeconds: number;
  idleStepSeconds: number;
  /** Some elements only apply at certain times, powers or energies. */
  conditional: boolean;
};

/** Major units (<= 4 decimals) to hundredths of a cent. */
export function majorToHundredths(price: number): number {
  return Math.round(price * 10_000);
}

function unrestricted(element: TariffElement) {
  const r = element.restrictions;
  return !r || Object.values(r).every((v) => v === null || v === undefined);
}

function elementsOf(tariff: Tariff): TariffElement[] {
  if (tariff.elements?.length) return tariff.elements;
  // A simple tariff is one ENERGY block at rate_minor_per_kwh.
  return [
    {
      price_components: [
        { type: "ENERGY", price: tariff.rate_minor_per_kwh / 100 },
      ],
    },
  ];
}

/** First unrestricted price for each dimension, as Ivora applies it by default. */
function firstPrices(elements: TariffElement[]) {
  const found = new Map<DimensionType, PriceComponent>();
  for (const element of elements)
    if (unrestricted(element))
      for (const c of element.price_components)
        if (!found.has(c.type)) found.set(c.type, c);
  return found;
}

export function priceBreakdown(tariff: Tariff): PriceBreakdown {
  const elements = elementsOf(tariff);
  const prices = firstPrices(elements);
  const at = (type: DimensionType) =>
    majorToHundredths(prices.get(type)?.price ?? 0);
  return {
    currency: tariff.currency,
    energyPerKwh: at("ENERGY"),
    timePerHour: at("TIME"),
    idlePerHour: at("PARKING_TIME"),
    sessionFee: at("FLAT"),
    timeStepSeconds: prices.get("TIME")?.step_size ?? 1,
    idleStepSeconds: prices.get("PARKING_TIME")?.step_size ?? 1,
    conditional: elements.some((e) => !unrestricted(e)),
  };
}

/** Driver-facing price lines for the charger page. */
export function priceLines(b: PriceBreakdown) {
  const rate = (hundredths: number) =>
    formatMinorRate((hundredths / 100).toFixed(2), b.currency);
  const lines = [{ label: "Energy", value: `${rate(b.energyPerKwh)} per kWh` }];
  if (b.timePerHour)
    lines.push({
      label: "Charging time",
      value: `${rate(Math.round(b.timePerHour / 60))} per minute`,
    });
  if (b.idlePerHour)
    lines.push({
      label: "Idle fee",
      value: `${rate(Math.round(b.idlePerHour / 60))} per minute`,
    });
  if (b.sessionFee)
    lines.push({ label: "Session fee", value: rate(b.sessionFee) });
  return lines;
}

/** Operator price form, in whole cents. */
export type PriceForm = {
  energyCentsPerKwh: number;
  timeCentsPerMinute: number;
  idleCentsPerMinute: number;
  sessionFeeCents: number;
  holdCents: number;
};

const MAX_MAJOR_PRICE = 10_000;

/** One unrestricted element; time and idle bill per started minute. */
export function elementsFromPrices(form: PriceForm): TariffElement[] {
  for (const [name, value] of Object.entries(form))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`${name} must be a non-negative whole number of cents.`);
  const components: PriceComponent[] = [
    { type: "ENERGY", price: form.energyCentsPerKwh / 100, step_size: 1 },
  ];
  if (form.timeCentsPerMinute)
    components.push({
      type: "TIME",
      price: (form.timeCentsPerMinute * 60) / 100,
      step_size: 60,
    });
  if (form.idleCentsPerMinute)
    components.push({
      type: "PARKING_TIME",
      price: (form.idleCentsPerMinute * 60) / 100,
      step_size: 60,
    });
  if (form.sessionFeeCents)
    components.push({ type: "FLAT", price: form.sessionFeeCents / 100 });
  if (components.some((c) => c.price > MAX_MAJOR_PRICE))
    throw new Error("A price is above the API's maximum of 10000.00.");
  return [{ price_components: components }];
}

/** Current prices as form values, or null when the tariff can't round-trip through the form. */
export function formFromTariff(tariff: Tariff): PriceForm | null {
  const b = priceBreakdown(tariff);
  const elements = elementsOf(tariff);
  const cents = (hundredths: number) =>
    hundredths % 100 === 0 ? hundredths / 100 : NaN;
  const form = {
    energyCentsPerKwh: cents(b.energyPerKwh),
    timeCentsPerMinute: cents(b.timePerHour / 60),
    idleCentsPerMinute: cents(b.idlePerHour / 60),
    sessionFeeCents: cents(b.sessionFee),
    holdCents: tariff.authorization_minor,
  };
  if (b.conditional || elements.length > 1) return null;
  if (Object.values(form).some((v) => !Number.isSafeInteger(v))) return null;
  return form;
}

export type SessionProfile = {
  energyWh: number;
  chargingSeconds: number;
  idleSeconds: number;
};

const D = 100n * 1000n * 3600n; // hundredths-of-cent x Wh x seconds

function stepUp(quantity: number, step: number) {
  const s = Math.max(1, Math.floor(step));
  return Math.ceil(quantity / s) * s;
}

/**
 * Demo-only pricer for unrestricted elements, following the documented rules:
 * each dimension rounds up to its step, amounts stay exact, and the total is
 * rounded half up once. Live mode always uses the tariff quote endpoint.
 */
export function localQuote(tariff: Tariff, profile: SessionProfile): Quote {
  const prices = firstPrices(elementsOf(tariff));
  const noEnergy = profile.energyWh < 1; // under 1 Wh bills no time
  const lines: QuoteLine[] = [];
  let exactTotal = 0n;
  const push = (
    type: DimensionType,
    numerator: bigint,
    quantity: string,
    unit: QuoteLine["unit"],
    price: number,
  ) => {
    exactTotal += numerator;
    const micro = roundHalfUp(numerator * 1_000_000n, D);
    lines.push({
      type,
      element: 0,
      reservation: false,
      quantity,
      unit,
      price_minor: (majorToHundredths(price) / 100).toFixed(2),
      exact_minor: `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, "0")}`,
      amount_minor: Number(roundHalfUp(numerator, D)),
    });
  };
  const energy = prices.get("ENERGY");
  if (energy) {
    const wh = stepUp(profile.energyWh, energy.step_size ?? 1);
    push(
      "ENERGY",
      BigInt(majorToHundredths(energy.price)) * BigInt(wh) * 3600n,
      (wh / 1000).toFixed(3),
      "kWh",
      energy.price,
    );
  }
  for (const [type, seconds] of [
    ["TIME", profile.chargingSeconds],
    ["PARKING_TIME", profile.idleSeconds],
  ] as const) {
    const c = prices.get(type);
    if (!c || noEnergy || seconds <= 0) continue;
    const billed = stepUp(seconds, c.step_size ?? 1);
    push(
      type,
      BigInt(majorToHundredths(c.price)) * BigInt(billed) * 1000n,
      (billed / 3600).toFixed(6),
      "h",
      c.price,
    );
  }
  const flat = prices.get("FLAT");
  if (flat)
    push(
      "FLAT",
      BigInt(majorToHundredths(flat.price)) * 1000n * 3600n,
      "1",
      "session",
      flat.price,
    );
  const total = Number(roundHalfUp(exactTotal, D));
  const microTotal = roundHalfUp(exactTotal * 1_000_000n, D);
  return {
    currency: tariff.currency,
    pricing_version: "elements-v1",
    lines,
    subtotal_minor: total,
    exact_subtotal_minor: `${microTotal / 1_000_000n}.${String(microTotal % 1_000_000n).padStart(6, "0")}`,
    adjustments: [],
    total_minor: total,
    activity: {
      charging_seconds: profile.chargingSeconds,
      idle_seconds: profile.idleSeconds,
    },
  };
}

const LABELS: Record<DimensionType, string> = {
  ENERGY: "Energy",
  TIME: "Charging time",
  PARKING_TIME: "Idle fee",
  FLAT: "Session fee",
};

export type QuoteRow = { label: string; detail: string; amountCents: number };

/** Quote or bill breakdown as display rows, in the API's own rounded amounts. */
export function quoteRows(quote: Quote): QuoteRow[] {
  const rows: QuoteRow[] = quote.lines.map((line) => {
    const label = line.reservation ? "Reservation" : LABELS[line.type];
    const rate = formatMinorRate(line.price_minor, quote.currency);
    let detail: string;
    if (line.unit === "kWh")
      detail = `${Number(line.quantity).toFixed(2)} kWh × ${rate}/kWh`;
    else if (line.unit === "h")
      detail = `${Math.round(Number(line.quantity) * 60)} min × ${rate}/h`;
    else detail = "per session";
    return { label, detail, amountCents: line.amount_minor };
  });
  for (const a of quote.adjustments)
    rows.push({
      label:
        a.kind === "max_session_cost"
          ? "Session price cap"
          : a.kind === "merchant_validation"
            ? "Merchant validation"
            : "Discount",
      detail: a.rule,
      amountCents: a.amount_minor,
    });
  return rows;
}

/** Idle-fee lines of a bill, for the grace credit. */
export function parkingLines(quote: Quote | null | undefined) {
  return (quote?.lines ?? [])
    .filter((l) => l.type === "PARKING_TIME" && !l.reservation)
    .map((l) => ({
      exactMinor: l.exact_minor,
      priceMinorPerHour: l.price_minor,
    }));
}

export function formatQuoteTotal(quote: Quote) {
  return formatCents(quote.total_minor, quote.currency);
}
