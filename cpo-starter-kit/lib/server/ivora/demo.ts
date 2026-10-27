import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DEFAULT_CURRENCY } from "../../money";
import {
  demoOcpiEvseIds,
  demoOcpiRecord,
  demoPutOcpi,
  memoryDemoOcpi,
  type DemoOcpiStore,
} from "./demo-ocpi";
import {
  demoCards,
  demoCreateCard,
  demoImportCards,
  demoUpdateCard,
  memoryDemoCards,
  type DemoCardsStore,
} from "./demo-cards";
import { demoHistory, demoStats } from "./demo-history";
import { demoSimulate } from "./demo-pricing";
import { IvoraError } from "./errors";
import type {
  Bill,
  BillProgress,
  Branding,
  CommandInput,
  Fault,
  IvoraClient,
  Location,
  LocationInput,
  Operation,
  Payment,
  PaymentAccount,
  SessionProfile,
  Station,
  StationInput,
  Tariff,
  TariffDefinitionInput,
  TokenRecord,
  Transaction,
} from "./types";

// Sample data for demo mode. Every name says "Sample" or starts with DEMO- so it cannot
// be mistaken for a real site, charger or person.

const SAMPLE_LOCATIONS: Location[] = [
  {
    id: 9001,
    name: "Sample Site: Harbour Car Park",
    address: "1 Example Quay",
    city: "Sampleton",
    postal_code: "00001",
    country: "USA",
    // Open ocean off West Africa (0°N 0°E is "Null Island"): never a real site.
    latitude: 0.012,
    longitude: 0.004,
    time_zone: "America/New_York",
    external_reference: "cpo-demo-site-1",
  },
  {
    id: 9002,
    name: "Sample Site: Market Street",
    address: "20 Example Street",
    city: "Sampleton",
    postal_code: "00002",
    country: "USA",
    latitude: 0.006,
    longitude: 0.021,
    time_zone: "America/New_York",
    external_reference: "cpo-demo-site-2",
  },
  {
    id: 9003,
    name: "Sample Site: Waterfront (CAD)",
    address: "3 Example Wharf",
    city: "Sampleton",
    postal_code: "A0A 0A0",
    country: "CAN",
    latitude: 0.018,
    longitude: 0.012,
    time_zone: "America/Toronto",
    external_reference: "cpo-demo-site-3",
  },
];

/** Clearly not a real OCPP endpoint: demo chargers never connect anywhere. */
const demoConnectionUrl = (name: string) =>
  `wss://ocpp.demo.example/${encodeURIComponent(name)}`;

const connectors = (stationId: number, n: number, maxPowerW: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: stationId * 10 + i + 1,
    number: i + 1,
    status: "Available",
    max_power_w: maxPowerW,
  }));

const SAMPLE_STATIONS: Station[] = [
  {
    id: 9101,
    name: "DEMO-HARBOUR-01",
    connection_url: demoConnectionUrl("DEMO-HARBOUR-01"),
    username: "DEMO-HARBOUR-01",
    online: true,
    location_id: 9001,
    protocol: "ocpp1.6",
    vendor: "Sample Vendor",
    model: "Sample AC 22",
    last_seen: "2026-01-01T00:00:00Z",
    connectors: connectors(9101, 2, 22_000),
  },
  {
    id: 9102,
    name: "DEMO-HARBOUR-02",
    connection_url: demoConnectionUrl("DEMO-HARBOUR-02"),
    username: "DEMO-HARBOUR-02",
    online: true,
    location_id: 9001,
    protocol: "ocpp1.6",
    vendor: "Sample Vendor",
    model: "Sample AC 22",
    last_seen: "2026-01-01T00:00:00Z",
    connectors: connectors(9102, 2, 22_000).map((c, i) => ({
      ...c,
      status: i === 0 ? "Charging" : "Faulted",
    })),
  },
  {
    id: 9103,
    name: "DEMO-MARKET-01",
    connection_url: demoConnectionUrl("DEMO-MARKET-01"),
    username: "DEMO-MARKET-01",
    online: false,
    location_id: 9002,
    protocol: "ocpp2.0.1",
    vendor: "Sample Vendor",
    model: "Sample DC 60",
    last_seen: "2026-01-01T00:00:00Z",
    connectors: connectors(9103, 1, 60_000).map((c) => ({
      ...c,
      status: "Unavailable",
    })),
  },
];

/** Clearly a sample too: a second, Canadian site whose prices are in CAD. */
SAMPLE_STATIONS.push({
  id: 9104,
  name: "DEMO-WATERFRONT-01",
  connection_url: demoConnectionUrl("DEMO-WATERFRONT-01"),
  username: "DEMO-WATERFRONT-01",
  online: true,
  location_id: 9003,
  protocol: "ocpp1.6",
  vendor: "Sample Vendor",
  model: "Sample AC 22",
  last_seen: "2026-01-01T00:00:00Z",
  connectors: connectors(9104, 2, 22_000),
});

/** Sample faults: one open on DEMO-HARBOUR-02 connector 2, one cleared at the market. */
const SAMPLE_FAULTS: Fault[] = [
  {
    id: "demo-fault-1",
    station_id: 9102,
    connector_id: 91022,
    open: true,
    error_code: "GroundFailure",
    info: "Sample fault: residual current detected",
    vendor_error_code: null,
    ocpp_status: "Faulted",
    opened_at: "2026-01-01T07:45:00Z",
    cleared_at: null,
  },
  {
    id: "demo-fault-2",
    station_id: 9103,
    connector_id: 91031,
    open: false,
    error_code: "HighTemperature",
    info: null,
    vendor_error_code: null,
    ocpp_status: "Faulted",
    opened_at: "2025-12-31T14:02:00Z",
    cleared_at: "2025-12-31T14:20:00Z",
  },
];

/**
 * Ivora tariff IDs of the demo's sample tariffs (lib/server/pricing/demo.ts). Tariffs a
 * visitor saves get IDs from 9411 up, kept in their cookie.
 */
export const SAMPLE_TARIFF_IDS = [9401, 9402, 9403] as const;
/** Sample tariffs that are not in USD (the CAD sample site's). */
const SAMPLE_TARIFF_CURRENCY: Record<number, string> = { 9403: "CAD" };
const MAX_TARIFFS = 12;

const SAMPLE_TRANSACTIONS: Transaction[] = [
  {
    id: 9201,
    station_id: 9102,
    connector_id: 91021,
    id_token: "****B2C3",
    active: true,
    started_at: "2026-01-01T08:00:00Z",
    ended_at: null,
    energy_wh: 7_450,
  },
  {
    id: 9202,
    station_id: 9101,
    connector_id: 91011,
    id_token: "****9F04",
    active: false,
    started_at: "2025-12-31T17:10:00Z",
    ended_at: "2025-12-31T19:40:00Z",
    energy_wh: 31_200,
  },
];

/**
 * Every Stripe account state the kit shows, for demo mode's "simulate" switch. The
 * account ID is visibly fake; no Stripe or Ivora request is ever made.
 */
export const DEMO_STRIPE_STATES = [
  "none",
  "pending",
  "pending_review",
  "ready",
  "ready_requirements",
] as const;
export type DemoStripeState = (typeof DEMO_STRIPE_STATES)[number];

const DEMO_ACCOUNT_ID = "acct_DEMO000000000000";

export function demoPaymentAccount(state: DemoStripeState): PaymentAccount {
  switch (state) {
    case "none":
      return { status: "none", charges_enabled: false, requirements_due: [] };
    case "pending":
      return {
        status: "active",
        stripe_account_id: DEMO_ACCOUNT_ID,
        charges_enabled: false,
        details_submitted: false,
        disabled_reason: "requirements.past_due",
        requirements_due: [
          "external_account",
          "individual.verification.document",
        ],
        livemode: false,
      };
    case "pending_review":
      return {
        status: "pending_review",
        stripe_account_id: DEMO_ACCOUNT_ID,
        charges_enabled: true,
        details_submitted: true,
        requirements_due: [],
        livemode: false,
      };
    case "ready":
      return {
        status: "active",
        stripe_account_id: DEMO_ACCOUNT_ID,
        charges_enabled: true,
        details_submitted: true,
        requirements_due: [],
        livemode: false,
      };
    case "ready_requirements":
      return {
        status: "active",
        stripe_account_id: DEMO_ACCOUNT_ID,
        charges_enabled: true,
        details_submitted: true,
        requirements_due: ["company.tax_id"],
        livemode: false,
      };
  }
}

const copy = <T>(v: T): T => structuredClone(v);

// ---- The visitor's own demo fleet ----
//
// Sites and chargers a visitor adds in demo mode, and the test sessions they run, are
// kept per visitor (in their own cookie, see demo-cookie.ts), so visitors never see each
// other's changes and serverless instances need not share memory. Charger behaviour is
// simulated from timestamps: a charger "connects" two seconds after its password is
// set, "boots" a moment later, and sends a heartbeat on every read.

/** Most chargers and sites a visitor can add in demo mode (they live in a cookie). */
export const DEMO_MAX_STATIONS = 4;
const MAX_LOCATIONS = 4;
const MAX_TRANSACTIONS = 6;
export const DEMO_CONNECT_MS = 2_000;
const DEMO_BOOT_MS = 1_500;
/** Simulated charging power of a demo test session, W. */
const DEMO_POWER_W = 7_400;
/** A reset charger is offline this long, then reconnects with its faults cleared. */
export const DEMO_RESET_MS = 4_000;
/** After a paid start, the simulated driver plugs in and charging begins this much later. */
export const DEMO_PLUG_IN_MS = 3_000;
/** Bills the visitor's cookie keeps (the newest ones). */
const MAX_BILLS = 3;
/** The demo tariffs' card hold: $25.00, as the kit's paid tariffs set it. */
export const DEMO_HOLD_MINOR = 2500;

const fleetSchema = z.object({
  v: z.literal(1),
  locations: z
    .array(
      z.object({
        id: z.number().int(),
        name: z.string().max(90),
        address: z.string().max(120).optional(),
        city: z.string().max(120).optional(),
        postal_code: z.string().max(20).optional(),
        country: z.string().max(3).optional(),
        external_reference: z.string().max(128),
      }),
    )
    .max(MAX_LOCATIONS),
  stations: z
    .array(
      z.object({
        id: z.number().int(),
        name: z.string().max(36),
        location_id: z.number().int(),
        connectors: z.number().int().min(1).max(8),
        external_reference: z.string().max(128),
        /** When the simulated charger connects (ms), once its password is set. */
        connect_at: z.number().nullable(),
      }),
    )
    .max(DEMO_MAX_STATIONS),
  /** Sample stations moved to another site: station ID to location ID. */
  moved: z.record(z.string(), z.number().int()),
  /** Sample stations the visitor deleted. */
  deleted: z.array(z.number().int()).max(8),
  /** Sample sessions the visitor stopped: transaction ID to when (ms). */
  ended: z.record(z.string(), z.number()).optional(),
  /** Stations the visitor reset: station ID to when (ms). */
  resets: z.record(z.string(), z.number()).optional(),
  /** Tokens the visitor's kit registered (the Live view's staff token). */
  tokens: z
    .array(
      z.object({
        id: z.number().int(),
        id_token: z.string().max(20),
        type: z.string().max(20),
        status: z.string().max(20),
        label: z.string().max(60),
        external_reference: z.string().max(128),
      }),
    )
    .max(2)
    .optional(),
  /** Tariffs the visitor's kit created or archived (only what the kit reads back). */
  tariffs: z
    .array(
      z.object({
        id: z.number().int(),
        external_reference: z.string().max(128).nullable(),
        currency: z.string().max(3),
        archived: z.boolean(),
      }),
    )
    .max(MAX_TARIFFS)
    .optional(),
  transactions: z
    .array(
      z.object({
        id: z.number().int(),
        station_id: z.number().int(),
        connector_id: z.number().int(),
        connector_number: z.number().int(),
        /** Masked like the API's (****TEST); missing in older demo cookies. */
        id_token: z.string().max(12).nullable().optional(),
        started_at: z.number(),
        ended_at: z.number().nullable(),
      }),
    )
    .max(MAX_TRANSACTIONS),
  /**
   * Bills and their simulated Ivora Checkout payments (driver checkout). No card is
   * ever charged: the "payment" is a click on the kit's own demo checkout page.
   */
  bills: z
    .array(
      z.object({
        id: z.string().regex(/^bill_[0-9a-f]{32}$/),
        /** The create's Idempotency-Key: the same key answers with the same bill. */
        key: z.string().max(128),
        station_id: z.number().int(),
        connector_id: z.number().int(),
        connector_number: z.number().int(),
        tariff_id: z.number().int(),
        hold_minor: z.number().int(),
        currency: z.string().max(3),
        created_at: z.number(),
        payment: z
          .object({
            id: z.string().max(40),
            key: z.string().max(128),
            return_reference: z.string().max(128),
            authorized_at: z.number().nullable(),
            /** Released (canceled) or captured, and when; null while open. */
            ended: z.enum(["released", "captured"]).nullable().optional(),
            captured_minor: z.number().int().nullable().optional(),
          })
          .nullable(),
        /** The finalized bill, once final. */
        final: z
          .object({ total_minor: z.number().int(), at: z.number() })
          .nullable()
          .optional(),
        /** When the start was dispatched; the session's transaction ID then. */
        start_at: z.number().nullable(),
        transaction_id: z.number().int().nullable(),
      }),
    )
    .max(MAX_BILLS)
    .optional(),
});
export type DemoFleet = z.infer<typeof fleetSchema>;

export const emptyDemoFleet = (): DemoFleet => ({
  v: 1,
  locations: [],
  stations: [],
  moved: {},
  deleted: [],
  transactions: [],
});

export function decodeDemoFleet(raw: string | undefined): DemoFleet {
  if (!raw) return emptyDemoFleet();
  try {
    const parsed = fleetSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : emptyDemoFleet();
  } catch {
    return emptyDemoFleet();
  }
}

export function encodeDemoFleet(f: DemoFleet): string {
  return Buffer.from(JSON.stringify(fleetSchema.parse(f)), "utf8").toString(
    "base64url",
  );
}

/** Where a visitor's demo fleet is kept: their cookie, or memory in tests. */
export interface DemoFleetStore {
  load(): Promise<DemoFleet>;
  save(f: DemoFleet): Promise<void>;
}

export function memoryDemoFleet(
  initial = emptyDemoFleet(),
): DemoFleetStore & { state: DemoFleet } {
  const store = {
    state: copy(initial),
    async load() {
      return copy(store.state);
    },
    async save(f: DemoFleet) {
      store.state = copy(fleetSchema.parse(f));
    },
  };
  return store;
}

const ISO = (ms: number) => new Date(ms).toISOString();

/** The API shows only an ID token's last 4 characters. */
export const maskToken = (token: string) => `****${token.slice(-4)}`;

type DemoTx = DemoFleet["transactions"][number];

/**
 * The visitor's own sessions: remote starts, and paid driver sessions, which begin
 * DEMO_PLUG_IN_MS after their bill's start (the driver plugs in) and end when stopped.
 */
function ownTransactions(f: DemoFleet, now: number): DemoTx[] {
  const paid = (f.bills ?? []).flatMap((b): DemoTx[] =>
    b.start_at !== null &&
    b.transaction_id !== null &&
    now >= b.start_at + DEMO_PLUG_IN_MS
      ? [
          {
            id: b.transaction_id,
            station_id: b.station_id,
            connector_id: b.connector_id,
            connector_number: b.connector_number,
            id_token: maskToken(billToken(b.id)),
            started_at: b.start_at + DEMO_PLUG_IN_MS,
            ended_at: f.ended?.[String(b.transaction_id)] ?? null,
          },
        ]
      : [],
  );
  return [...f.transactions, ...paid].sort(
    (a, b) => a.started_at - b.started_at,
  );
}

/** A demo bill's charging token, as the API would show it masked: never a real one. */
const billToken = (billId: string) => `DRV${billId.slice(-6).toUpperCase()}`;

function demoTransaction(t: DemoTx, now: number): Transaction {
  const end = t.ended_at ?? now;
  return {
    id: t.id,
    station_id: t.station_id,
    connector_id: t.connector_id,
    connector_number: t.connector_number,
    id_token: t.id_token ?? null,
    active: t.ended_at === null,
    started_at: ISO(t.started_at),
    ended_at: t.ended_at === null ? null : ISO(t.ended_at),
    // Simulated energy at a steady 7.4 kW, in Wh like the API's energy_wh.
    energy_wh: Math.round(
      (DEMO_POWER_W * Math.max(0, end - t.started_at)) / 3_600_000,
    ),
  };
}

function ownStation(
  s: DemoFleet["stations"][number],
  f: DemoFleet,
  now: number,
): Station {
  const online = s.connect_at !== null && now >= s.connect_at;
  const booted = online && now >= s.connect_at! + DEMO_BOOT_MS;
  const charging = new Set(
    ownTransactions(f, now)
      .filter((t) => t.station_id === s.id && t.ended_at === null)
      .map((t) => t.connector_id),
  );
  return {
    id: s.id,
    name: s.name,
    online,
    location_id: s.location_id,
    protocol: online ? "ocpp1.6" : null,
    vendor: booted ? "Sample Vendor" : null,
    model: booted ? "Sample AC 11" : null,
    last_seen: online ? ISO(now) : null,
    external_reference: s.external_reference,
    connection_url: demoConnectionUrl(s.name),
    username: s.name,
    connectors: connectors(s.id, s.connectors, 11_000).map((c) => ({
      ...c,
      status: !online
        ? "Unavailable"
        : charging.has(c.id)
          ? "Charging"
          : "Available",
    })),
  };
}

/** A sample session the visitor stopped (or ended by a reset or unlock). */
function sampleTransaction(x: Transaction, f: DemoFleet): Transaction {
  const ended = f.ended?.[String(x.id)];
  if (!x.active || ended === undefined) return x;
  return { ...x, active: false, ended_at: ISO(ended) };
}

/** Sample faults, cleared by a reset of their station after they opened. */
function sampleFaults(f: DemoFleet): Fault[] {
  return copy(SAMPLE_FAULTS).map((x) => {
    const reset = f.resets?.[String(x.station_id)];
    if (!x.open || reset === undefined || reset < Date.parse(x.opened_at))
      return x;
    return { ...x, open: false, cleared_at: ISO(reset + DEMO_RESET_MS) };
  });
}

/** Offline while a reset runs; reconnects afterwards. */
function resetting(s: Station, f: DemoFleet, now: number): Station {
  const at = f.resets?.[String(s.id)];
  if (at === undefined) return s;
  // Back after the restart, it sends messages again.
  if (now >= at + DEMO_RESET_MS) return { ...s, last_seen: ISO(now) };
  return {
    ...s,
    online: false,
    connectors: s.connectors.map((c) => ({ ...c, status: "Unavailable" })),
  };
}

function sampleStation(s: Station, f: DemoFleet, now: number): Station {
  const faults = sampleFaults(f).filter((x) => x.station_id === s.id);
  const openOn = new Set(
    faults.filter((x) => x.open).map((x) => x.connector_id),
  );
  const ended = new Set(
    SAMPLE_TRANSACTIONS.filter(
      (x) => x.active && f.ended?.[String(x.id)] !== undefined,
    ).map((x) => x.connector_id),
  );
  const charging = new Set(
    ownTransactions(f, now)
      .filter((x) => x.station_id === s.id && x.ended_at === null)
      .map((x) => x.connector_id),
  );
  return resetting(
    {
      ...s,
      location_id: f.moved[s.id] ?? s.location_id,
      open_faults: faults.filter((x) => x.open),
      connectors: s.connectors.map((c) => ({
        ...c,
        status: !s.online
          ? c.status
          : charging.has(c.id)
            ? "Charging"
            : openOn.has(c.id)
              ? "Faulted"
              : ended.has(c.id) || c.status === "Faulted"
                ? "Available"
                : c.status,
      })),
    },
    f,
    now,
  );
}

const op = (
  id: string,
  result: Record<string, unknown> | null = null,
): Operation => ({ id: `demo-op-${id}`, status: "succeeded", result });

/** The visitor's other demo stores; each defaults to an in-memory one. */
export interface DemoClientStores {
  /** Roaming (OCPI publishing) settings. */
  ocpi?: DemoOcpiStore;
  /** RFID cards (the optional Cards module). */
  cards?: DemoCardsStore;
}

const hex = (s: string, n: number) =>
  createHash("sha256").update(s).digest("hex").slice(0, n);

/** The demo's own checkout page stands in for Stripe's: nothing is ever charged. */
export const demoCheckoutPath = (paymentId: string) =>
  `/demo/checkout/${encodeURIComponent(paymentId)}`;

/**
 * A demo tariff's definition by its Ivora ID, for quotes and bill estimates (the demo
 * keeps tariffs in the pricing cookie, not here). Null when unknown.
 */
export type DemoTariffLookup = (
  tariffId: number,
) => Promise<TariffDefinitionInput | null>;

type DemoBill = NonNullable<DemoFleet["bills"]>[number];

/** Can a paid start go ahead now? Like the API: an online charger, a free connector. */
function startRefusal(
  s: Station,
  connectorId: number,
  txs: Transaction[],
): IvoraError | null {
  if (!s.online)
    return new IvoraError(409, "station_offline", "The station is offline");
  const c = s.connectors.find((x) => x.id === connectorId);
  if (!c)
    return new IvoraError(404, "connector_not_found", "Unknown connector");
  if (txs.some((t) => t.connector_id === connectorId && t.active))
    return new IvoraError(
      409,
      "connector_occupied",
      "A session is running on this connector",
    );
  return null;
}

/**
 * Demo mode only: what the simulated Stripe checkout does when the visitor "pays"
 * (`/demo/checkout/<payment>`). The hold is authorized and, like Ivora's driver page
 * reading the bill on the driver's return, the charger starts once if it is online and
 * the connector is free; otherwise the bill stays `authorized` for the kit to start.
 * Nothing is charged and nothing leaves the visitor's cookie.
 */
export async function authorizeDemoPayment(
  fleet: DemoFleetStore,
  paymentId: string,
  now: () => number = Date.now,
): Promise<{ returnReference: string } | null> {
  const client = createDemoClient(fleet, now);
  const f = await fleet.load();
  const b = (f.bills ?? []).find((x) => x.payment?.id === paymentId);
  if (!b?.payment) return null;
  const t = now();
  // A released payment (the payment window passed) can't be paid any more.
  if (b.payment.authorized_at === null && !b.payment.ended) {
    b.payment.authorized_at = t;
    const s = await client.getStation(b.station_id).catch(() => null);
    const txs = await client.listTransactions({ station_id: b.station_id });
    if (s && !startRefusal(s, b.connector_id, txs)) dispatchStart(f, b, t);
    await fleet.save(f);
  }
  return { returnReference: b.payment.return_reference };
}

function dispatchStart(f: DemoFleet, b: DemoBill, t: number) {
  b.start_at = t;
  b.transaction_id =
    Math.max(9800, ...(f.bills ?? []).map((x) => x.transaction_id ?? 0)) + 1;
}

/** Demo mode only: what the simulated Stripe checkout page shows. */
export async function demoPayment(fleet: DemoFleetStore, paymentId: string) {
  const b = (await fleet.load()).bills?.find(
    (x) => x.payment?.id === paymentId,
  );
  if (!b?.payment) return null;
  return {
    holdMinor: b.hold_minor,
    currency: b.currency,
    returnReference: b.payment.return_reference,
    authorized: b.payment.authorized_at !== null,
    released: b.payment.ended === "released",
  };
}

/**
 * The demo implementation of the Ivora client. It answers from the sample data above
 * and the visitor's own demo fleet (`fleet`) and roaming settings (`stores.ocpi`), and
 * never sends a request anywhere: no charger commands, no payments, no email, no network.
 * `tariffs` looks up a demo tariff's definition (the demo keeps tariffs in the pricing
 * cookie) for quotes and bills.
 */
export function createDemoClient(
  fleet: DemoFleetStore = memoryDemoFleet(),
  now: () => number = Date.now,
  tariffs: DemoTariffLookup = async () => null,
  { ocpi = memoryDemoOcpi(), cards = memoryDemoCards() }: DemoClientStores = {},
): IvoraClient {
  const update = async <T>(change: (f: DemoFleet) => T): Promise<T> => {
    const f = await fleet.load();
    const r = change(f);
    await fleet.save(f);
    return r;
  };
  // The sample cards and the visitor's, then the kit's own staff and free tokens.
  const tokens = async (): Promise<TokenRecord[]> => [
    ...demoCards(await cards.load()),
    ...((await fleet.load()).tokens ?? []).map((t) => ({
      ...copy(t),
      expires_at: null,
    })),
  ];
  const locations = async () => [
    ...copy(SAMPLE_LOCATIONS),
    ...(await fleet.load()).locations,
  ];
  const stations = async () => {
    const f = await fleet.load();
    const t = now();
    const samples = copy(SAMPLE_STATIONS)
      .filter((s) => !f.deleted.includes(s.id))
      .map((s) => sampleStation(s, f, t));
    return [
      ...samples,
      ...f.stations.map((s) => resetting(ownStation(s, f, t), f, t)),
    ];
  };
  const transactions = async () => {
    const f = await fleet.load();
    const t = now();
    return [
      ...ownTransactions(f, t)
        .map((x) => demoTransaction(x, t))
        .reverse(),
      ...copy(SAMPLE_TRANSACTIONS).map((x) => sampleTransaction(x, f)),
    ];
  };
  const station = async (id: number) => {
    const s = (await stations()).find((x) => x.id === id);
    if (!s)
      throw new IvoraError(404, "station_not_found", "Unknown demo station");
    return s;
  };
  /** Prices a session under a demo tariff, offline, like `POST /tariffs/{id}/quote`. */
  const quote = async (tariffId: number, session: SessionProfile) => {
    const def = await tariffs(tariffId);
    if (!def)
      throw new IvoraError(404, "tariff_not_found", "Unknown demo tariff");
    return demoSimulate(def, session);
  };
  const billView = async (b: DemoBill, f: DemoFleet): Promise<Bill> => {
    const t = now();
    const tx =
      b.transaction_id === null
        ? undefined
        : ownTransactions(f, t).find((x) => x.id === b.transaction_id);
    const usage = tx ? demoTransaction(tx, t) : null;
    const progress: BillProgress =
      b.final || (usage && !usage.active)
        ? "ended"
        : b.payment?.ended === "released" && !usage
          ? "canceled"
          : !b.payment?.authorized_at
            ? "awaiting_payment"
            : b.start_at === null
              ? "authorized"
              : !usage
                ? "waiting_for_vehicle"
                : "charging";
    let estimated: number | null = null;
    if (usage?.started_at) {
      const def = await tariffs(b.tariff_id);
      const end = usage.ended_at ? Date.parse(usage.ended_at) : t;
      const start = Date.parse(usage.started_at);
      if (def)
        estimated = demoSimulate(def, {
          start_at: usage.started_at,
          time_zone: def.time_zone,
          duration_minutes: Math.max(0, (end - start) / 60_000),
          energy_kwh: (usage.energy_wh ?? 0) / 1000,
          idle_minutes: 0,
        }).total_minor;
    }
    return {
      id: b.id,
      station_id: b.station_id,
      connector_id: b.connector_id,
      tariff_id: b.tariff_id,
      hold_minor: b.hold_minor,
      currency: b.currency,
      status: b.final ? "final" : "open",
      total_minor: b.final?.total_minor ?? null,
      transaction_id: usage?.id ?? null,
      created_at: ISO(b.created_at),
      finalized_at: b.final ? ISO(b.final.at) : null,
      usage: usage && {
        transaction_id: usage.id,
        active: usage.active === true,
        energy_wh: usage.energy_wh ?? 0,
        estimated_minor: b.final?.total_minor ?? estimated,
        started_at: usage.started_at,
        ended_at: usage.ended_at,
      },
      start_operation:
        b.start_at === null
          ? null
          : {
              ...op(`${b.id}-start`, { charger_status: "Accepted" }),
              created_at: ISO(b.start_at),
            },
      progress,
    };
  };
  const paymentView = (b: DemoBill): Payment => {
    const p = b.payment!;
    return {
      id: p.id,
      bill_id: b.id,
      status:
        p.ended === "released"
          ? "canceled"
          : p.ended === "captured"
            ? "captured"
            : p.authorized_at === null
              ? "pending"
              : "authorized",
      hold_minor: b.hold_minor,
      captured_minor: p.captured_minor ?? 0,
      currency: b.currency,
      payment_mode: "test",
      authorized_at: p.authorized_at === null ? null : ISO(p.authorized_at),
      next_action:
        p.authorized_at === null && !p.ended
          ? {
              type: "redirect_to_url",
              redirect_to_url: { url: demoCheckoutPath(p.id) },
            }
          : null,
    };
  };
  const byPayment = async (paymentId: string) => {
    const f = await fleet.load();
    const b = f.bills?.find((x) => x.payment?.id === paymentId);
    if (!b?.payment)
      throw new IvoraError(404, "payment_not_found", "Unknown demo payment");
    return { f, b };
  };
  const bill = async (billId: string) => {
    const f = await fleet.load();
    const b = f.bills?.find((x) => x.id === billId);
    if (!b) throw new IvoraError(404, "bill_not_found", "Unknown demo bill");
    return { f, b };
  };

  const byReference = <T extends { external_reference?: string | null }>(
    list: T[],
    ref?: string,
  ) => list.filter((x) => !ref || x.external_reference === ref);

  return {
    mode: "demo",
    async listLocations(o = {}) {
      return byReference(await locations(), o.external_reference).slice(
        0,
        o.limit ?? 100,
      );
    },
    async listAllLocations() {
      return { data: await locations(), truncated: false };
    },
    async listAllStations() {
      return { data: await stations(), truncated: false };
    },
    // Same reference, same record, like the API's idempotent replays.
    async createLocation(input: LocationInput) {
      const seen = byReference(await locations(), input.external_reference)[0];
      if (seen) return seen;
      return update((f) => {
        if (f.locations.length >= MAX_LOCATIONS)
          throw new IvoraError(
            409,
            "demo_limit",
            `Demo mode keeps up to ${MAX_LOCATIONS} new sites in your browser. Reset the demo to start again`,
          );
        const created = {
          id: 9011 + f.locations.length,
          ...input,
          name: input.name.startsWith("Sample")
            ? input.name
            : `Sample Site: ${input.name}`.slice(0, 90),
        };
        f.locations.push(created);
        return copy(created);
      });
    },
    async listStations(o = {}) {
      return byReference(await stations(), o.external_reference).slice(
        0,
        o.limit ?? 100,
      );
    },
    getStation: station,
    async createStation(input: StationInput) {
      const all = await stations();
      const seen = byReference(all, input.external_reference)[0];
      if (seen) return seen;
      if (all.some((s) => s.name.toLowerCase() === input.name.toLowerCase()))
        throw new IvoraError(
          409,
          "station_name_taken",
          "Another station already uses this connection name",
        );
      if (!(await locations()).some((l) => l.id === input.location_id))
        throw new IvoraError(404, "location_not_found", "Unknown demo site");
      await update((f) => {
        if (f.stations.length >= DEMO_MAX_STATIONS)
          throw new IvoraError(
            409,
            "demo_limit",
            `Demo mode keeps up to ${DEMO_MAX_STATIONS} added chargers in your browser. Remove one or reset the demo`,
          );
        f.stations.push({
          id: Math.max(9500, ...f.stations.map((s) => s.id)) + 1,
          name: input.name,
          location_id: input.location_id,
          connectors: input.connectors,
          external_reference: input.external_reference,
          connect_at: null,
        });
      });
      return byReference(await stations(), input.external_reference)[0];
    },
    async updateStation(stationId, input, key) {
      await station(stationId);
      if (
        input.location_id !== undefined &&
        !(await locations()).some((l) => l.id === input.location_id)
      )
        throw new IvoraError(404, "location_not_found", "Unknown demo site");
      await update((f) => {
        const own = f.stations.find((s) => s.id === stationId);
        if (input.location_id === undefined) return;
        if (own) own.location_id = input.location_id;
        else f.moved[String(stationId)] = input.location_id;
      });
      return op(key);
    },
    async deleteStation(stationId) {
      await station(stationId);
      const txs = await transactions();
      if (txs.some((t) => t.station_id === stationId && t.active))
        throw new IvoraError(
          409,
          "transaction_active",
          "A session is running on this station",
        );
      if (txs.some((t) => t.station_id === stationId))
        throw new IvoraError(
          409,
          "station_has_history",
          "The station has charging history and stays in inventory",
        );
      await update((f) => {
        const before = f.stations.length;
        f.stations = f.stations.filter((s) => s.id !== stationId);
        if (f.stations.length === before) f.deleted.push(stationId);
      });
    },
    async setCredentials(stationId, _password, key) {
      // The password is not kept anywhere in demo mode.
      const s = await station(stationId);
      if (s.online && s.protocol === "ocpp1.6")
        throw new IvoraError(
          409,
          "station_online",
          "The station is connected over OCPP 1.6, so its password can't be pushed",
        );
      await update((f) => {
        const own = f.stations.find((x) => x.id === stationId);
        if (own) own.connect_at = now() + DEMO_CONNECT_MS;
      });
      return op(key, { applied: "stored" });
    },
    async sendCommand(stationId, command: CommandInput, key) {
      const s = await station(stationId);
      if (!s.online)
        throw new IvoraError(409, "station_offline", "The station is offline");
      const txs = await transactions();
      // Ends a running session, sample or the visitor's own.
      const end = (f: DemoFleet, id: number) => {
        const own = f.transactions.find((x) => x.id === id);
        if (own) own.ended_at ??= now();
        else (f.ended ??= {})[String(id)] = now();
      };
      if (command.action === "reset") {
        // The charger restarts: its sessions end, it drops off for a few seconds and
        // comes back with its faults cleared.
        await update((f) => {
          for (const t of txs)
            if (t.station_id === stationId && t.active) end(f, t.id);
          (f.resets ??= {})[String(stationId)] = now();
        });
        return op(key, { charger_status: "Accepted" });
      }
      if (command.action === "unlock") {
        const c = s.connectors.find((x) => x.id === command.connector_id);
        if (!c)
          throw new IvoraError(404, "connector_not_found", "Unknown connector");
        // Unlocking a connector in use ends its session (OCPP 1.6 behaviour).
        await update((f) => {
          for (const t of txs)
            if (t.connector_id === c.id && t.active) end(f, t.id);
        });
        return op(key, { charger_status: "Unlocked" });
      }
      if (command.action === "start") {
        const c = s.connectors.find((x) => x.id === command.connector_id);
        if (!c)
          throw new IvoraError(404, "connector_not_found", "Unknown connector");
        if (txs.some((t) => t.connector_id === c.id && t.active))
          return op(key, { charger_status: "Rejected" });
        await update((f) => {
          f.transactions.push({
            id: Math.max(9300, ...f.transactions.map((t) => t.id)) + 1,
            station_id: stationId,
            connector_id: c.id,
            connector_number: c.number ?? 1,
            id_token: maskToken(command.token),
            started_at: now(),
            ended_at: null,
          });
          f.transactions = f.transactions.slice(-MAX_TRANSACTIONS);
        });
        return op(key, { charger_status: "Accepted" });
      }
      const ok = await update((f) => {
        const t = txs.find(
          (x) => x.id === command.transaction_id && x.station_id === stationId,
        );
        if (!t?.active) return false;
        end(f, t.id);
        return true;
      });
      if (!ok)
        throw new IvoraError(
          409,
          "transaction_ended",
          "That session has already ended",
        );
      return op(key, { charger_status: "Accepted" });
    },
    async getOperation(operationId) {
      return { id: operationId, status: "succeeded", result: null };
    },
    async listTransactions(o = {}) {
      return (await transactions())
        .filter(
          (t) => o.station_id === undefined || t.station_id === o.station_id,
        )
        .slice(0, o.limit ?? 50);
    },
    // Like the API: oldest first by ID, after the cursor, and items without the ID
    // token or connector (GET /transactions/{id} has those).
    async listTransactionsAfter(o) {
      const limit = o.limit ?? 100;
      const rows = (await transactions())
        .filter((t) => t.station_id === o.station_id && t.id > o.after)
        .sort((a, b) => a.id - b.id);
      const data = rows.slice(0, limit).map((t) => ({
        id: t.id,
        station_id: t.station_id,
        active: t.active,
        started_at: t.started_at,
        ended_at: t.ended_at,
      }));
      return {
        data,
        next_cursor: rows.length > limit ? data[data.length - 1].id : null,
      };
    },
    async findToken(externalReference) {
      const t = (await fleet.load()).tokens?.find(
        (x) => x.external_reference === externalReference,
      );
      return t ? (copy(t) satisfies TokenRecord) : null;
    },
    // Same reference, same token, like the API's idempotent replays.
    async createToken(input) {
      if (input.type !== "Central") {
        const state = await cards.load();
        const replay = demoCards(state).find(
          (c) => c.external_reference === input.external_reference,
        );
        if (replay) return replay;
        const kit = ((await fleet.load()).tokens ?? []).map((t) => t.id_token);
        const created = demoCreateCard(state, input, kit, now());
        await cards.save(state);
        return created;
      }
      return update((f) => {
        const tokens = (f.tokens ??= []);
        const seen = tokens.find(
          (x) => x.external_reference === input.external_reference,
        );
        if (seen) return copy(seen);
        const created = {
          id: Math.max(9700, ...tokens.map((x) => x.id)) + 1,
          ...input,
          label: input.label.slice(0, 60),
        };
        tokens.push(created);
        f.tokens = tokens.slice(-2);
        return copy(created);
      });
    },
    async listAllTokens() {
      return { data: await tokens(), truncated: false };
    },
    async getToken(tokenId) {
      const t = (await tokens()).find((x) => x.id === tokenId);
      if (!t) throw new IvoraError(404, "token_not_found", "Unknown token");
      return t;
    },
    async updateToken(tokenId, input) {
      const state = await cards.load();
      const t = demoUpdateCard(state, tokenId, input, now());
      await cards.save(state);
      return t;
    },
    async importTokens(rows, o) {
      const state = await cards.load();
      const r = demoImportCards(state, rows, o.dryRun, now());
      if (!o.dryRun) await cards.save(state);
      return r;
    },
    async listFaults(stationId, o = {}) {
      await station(stationId);
      return sampleFaults(await fleet.load())
        .filter((x) => x.station_id === stationId && (!o.open || x.open))
        .slice(0, o.limit ?? 20);
    },
    async getTransaction(transactionId) {
      const t = (await transactions()).find((x) => x.id === transactionId);
      if (!t)
        throw new IvoraError(
          404,
          "transaction_not_found",
          "Unknown demo session",
        );
      return t;
    },
    // Branding answers like the API but is kept nowhere: each visitor's demo brand
    // lives in their own cookie (lib/server/onboarding/demo.ts).
    async putBranding(input) {
      return {
        ...input,
        logo_url: null,
        is_default: false,
        updated_at: new Date().toISOString(),
      } satisfies Branding;
    },
    async putBrandingLogo() {
      // Nothing is uploaded or stored, so there is no logo URL to show.
      throw new IvoraError(
        409,
        "demo_logo_not_stored",
        "Demo mode checks the logo but does not upload or keep it",
      );
    },
    async getPaymentAccount() {
      return demoPaymentAccount("none");
    },
    // Same reference, same tariff, like the API's idempotent replays.
    async createTariff(input) {
      demoSimulate(input, {
        start_at: new Date(now()).toISOString(),
        time_zone: input.time_zone,
        duration_minutes: 0,
        energy_kwh: 0,
        idle_minutes: 0,
      });
      return update((f) => {
        const tariffs = (f.tariffs ??= []);
        const seen = tariffs.find(
          (x) => x.external_reference === input.external_reference,
        );
        const record = (x: (typeof tariffs)[number]): Tariff => ({
          id: x.id,
          currency: x.currency,
          rate_minor_per_kwh: 0,
          authorization_minor: input.authorization_minor,
          archived: x.archived,
          external_reference: x.external_reference,
          is_complex: true,
          pricing_summary: input.tariff_alt_text[0]?.text ?? null,
        });
        if (seen) return record(seen);
        const created = {
          id: Math.max(9410, ...tariffs.map((x) => x.id)) + 1,
          external_reference: input.external_reference,
          currency: input.currency,
          archived: false,
        };
        tariffs.push(created);
        // Archived ones go first when the cookie is full; bills never need them here.
        while (tariffs.length > MAX_TARIFFS)
          tariffs.splice(
            Math.max(
              0,
              tariffs.findIndex((x) => x.archived),
            ),
            1,
          );
        return record(created);
      });
    },
    async findTariff(externalReference) {
      const x = (await fleet.load()).tariffs?.find(
        (t) => t.external_reference === externalReference,
      );
      return x
        ? {
            id: x.id,
            currency: x.currency,
            rate_minor_per_kwh: 0,
            authorization_minor: 0,
            archived: x.archived,
            external_reference: x.external_reference,
            is_complex: true,
          }
        : null;
    },
    async archiveTariff(tariffId, replacementTariffId) {
      return update((f) => {
        const tariffs = (f.tariffs ??= []);
        const known = (id: number) =>
          (SAMPLE_TARIFF_IDS as readonly number[]).includes(id) ||
          tariffs.some((x) => x.id === id);
        if (!known(tariffId))
          throw new IvoraError(404, "tariff_not_found", "Unknown demo tariff");
        if (
          replacementTariffId !== null &&
          (!known(replacementTariffId) ||
            tariffs.find((x) => x.id === replacementTariffId)?.archived)
        )
          throw new IvoraError(
            404,
            "tariff_not_found",
            "Unknown demo replacement tariff",
          );
        const own = tariffs.find((x) => x.id === tariffId);
        if (own?.archived)
          throw new IvoraError(409, "tariff_archived", "Already archived");
        if (own) own.archived = true;
        else
          tariffs.push({
            id: tariffId,
            external_reference: null,
            currency: SAMPLE_TARIFF_CURRENCY[tariffId] ?? DEFAULT_CURRENCY,
            archived: true,
          });
        while (tariffs.length > MAX_TARIFFS)
          tariffs.splice(
            Math.max(
              0,
              tariffs.findIndex((x) => x.archived),
            ),
            1,
          );
        return {
          id: tariffId,
          archived: true as const,
          replacement_tariff_id: replacementTariffId,
          // Demo connectors carry no Ivora tariff, so nothing moves.
          reassigned_connectors: [],
        };
      });
    },
    async simulateTariff(tariff, session) {
      return demoSimulate(tariff, session);
    },
    async getOcpiSettings() {
      return demoOcpiRecord(await ocpi.load());
    },
    async putOcpiSettings(input) {
      const next = demoPutOcpi(await ocpi.load(), input, now());
      await ocpi.save(next);
      return demoOcpiRecord(next);
    },
    async getOcpiEvseIds() {
      return demoOcpiEvseIds(await ocpi.load());
    },
    quoteTariff: quote,
    // Same key, same bill, like the API's idempotent replays.
    async createBill(input, key) {
      const s = await station(input.station_id);
      const c = s.connectors.find((x) => x.id === input.connector_id);
      if (!c)
        throw new IvoraError(404, "connector_not_found", "Unknown connector");
      const def = await tariffs(input.tariff_id);
      if (!def)
        throw new IvoraError(404, "tariff_not_found", "Unknown demo tariff");
      const id = await update((f) => {
        const bills = (f.bills ??= []);
        const seen = bills.find((x) => x.key === key);
        if (seen) return seen.id;
        const created: DemoBill = {
          id: `bill_${hex(`${key}|${now()}`, 32)}`,
          key,
          station_id: s.id,
          connector_id: c.id,
          connector_number: c.number ?? 1,
          tariff_id: input.tariff_id,
          hold_minor: DEMO_HOLD_MINOR,
          currency: def.currency,
          created_at: now(),
          payment: null,
          start_at: null,
          transaction_id: null,
        };
        bills.push(created);
        f.bills = bills.slice(-MAX_BILLS);
        return created.id;
      });
      const { f, b } = await bill(id);
      return billView(b, f);
    },
    async getBill(billId) {
      const { f, b } = await bill(billId);
      return billView(b, f);
    },
    async startBill(billId) {
      const { b } = await bill(billId);
      if (!b.payment?.authorized_at)
        throw new IvoraError(
          409,
          "payment_not_authorized",
          "The bill's payment is not authorized",
        );
      if (b.payment.ended)
        throw new IvoraError(
          409,
          "payment_not_authorized",
          "The bill's payment was released",
        );
      if (b.start_at === null) {
        const refusal = startRefusal(
          await station(b.station_id),
          b.connector_id,
          await transactions(),
        );
        if (refusal) throw refusal;
        await update((f) => {
          const own = f.bills?.find((x) => x.id === billId);
          if (own && own.start_at === null) dispatchStart(f, own, now());
        });
      }
      // The bill's one start operation, whatever the key (like the API).
      return op(`${billId}-start`, { charger_status: "Accepted" });
    },
    // One payment per bill: the same key (or a later one) answers with the same payment.
    async createPayment(input, key) {
      const p = await update((f) => {
        const b = f.bills?.find((x) => x.id === input.bill_id);
        if (!b)
          throw new IvoraError(404, "bill_not_found", "Unknown demo bill");
        b.payment ??= {
          id: `pay_demo_${hex(key, 16)}`,
          key,
          return_reference: input.return_reference,
          authorized_at: null,
        };
        return b;
      });
      return paymentView(p);
    },
    async getTariff(tariffId) {
      const def = await tariffs(tariffId);
      if (!def)
        throw new IvoraError(404, "tariff_not_found", "Unknown demo tariff");
      const free = def.elements.every((e) =>
        e.price_components.every((c) => Number(c.price) === 0),
      );
      return {
        id: tariffId,
        currency: def.currency,
        rate_minor_per_kwh: 0,
        authorization_minor: free ? 0 : DEMO_HOLD_MINOR,
        archived: false,
        is_complex: true,
      };
    },
    // Like the API: usage from the (simulated) charger, never from the caller.
    async finalizeBill(billId, transactionId) {
      const { f, b } = await bill(billId);
      if (!b.final) {
        const view = await billView(b, f);
        if (view.usage?.transaction_id !== transactionId)
          throw new IvoraError(
            409,
            "transaction_mismatch",
            "Not this bill's transaction",
          );
        if (view.usage.active)
          throw new IvoraError(
            409,
            "transaction_active",
            "The transaction has not ended",
          );
        const total = view.usage.estimated_minor ?? 0;
        await update((g) => {
          const own = g.bills?.find((x) => x.id === billId);
          if (own && !own.final) own.final = { total_minor: total, at: now() };
        });
      }
      const after = await bill(billId);
      return billView(after.b, after.f);
    },
    async getPayment(paymentId) {
      return paymentView((await byPayment(paymentId)).b);
    },
    // Exactly the final bill; under 50 cents (or zero) the hold is released instead.
    async capturePayment(paymentId) {
      const { b } = await byPayment(paymentId);
      if (!b.final)
        throw new IvoraError(409, "bill_not_final", "The bill is not final");
      if (b.final.total_minor > b.hold_minor)
        throw new IvoraError(
          409,
          "bill_exceeds_hold",
          "The final bill is above the hold",
        );
      const g = await update((x) => {
        const own = x.bills!.find((y) => y.id === b.id)!;
        const p = own.payment!;
        if (!p.ended) {
          const total = own.final!.total_minor;
          p.ended = total < 50 ? "released" : "captured";
          p.captured_minor = total < 50 ? 0 : total;
        }
        return own;
      });
      return paymentView(g);
    },
    async releasePayment(paymentId) {
      const { f, b } = await byPayment(paymentId);
      if (b.payment!.ended === "captured")
        throw new IvoraError(
          409,
          "payment_captured",
          "The payment was captured",
        );
      if ((await billView(b, f)).usage)
        throw new IvoraError(
          409,
          "start_reserved",
          "A session matched this bill",
        );
      const g = await update((x) => {
        const own = x.bills!.find((y) => y.id === b.id)!;
        own.payment!.ended ??= "released";
        own.payment!.captured_minor ??= 0;
        return own;
      });
      return paymentView(g);
    },
    async recordHoldStop(billId) {
      await bill(billId);
    },
    // Reports: the sample history (demo-history.ts) plus the visitor's own sessions
    // and bills.
    async getStats(q) {
      const { transactions: txs, bills } = await reportData();
      return demoStats(q, txs, bills, await stations(), now());
    },
  };

  /** The visitor's sessions and bills, then the sample history's. */
  async function reportData() {
    const f = await fleet.load();
    const own = await Promise.all((f.bills ?? []).map((b) => billView(b, f)));
    const history = demoHistory(now());
    return {
      transactions: [...(await transactions()), ...history.transactions],
      bills: [...own, ...history.bills],
    };
  }
}
