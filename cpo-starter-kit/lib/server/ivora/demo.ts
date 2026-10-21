import "server-only";
import { z } from "zod";
import { IvoraError } from "./errors";
import type {
  Branding,
  CommandInput,
  Fault,
  IvoraClient,
  Location,
  LocationInput,
  Operation,
  PaymentAccount,
  Station,
  StationInput,
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
    external_reference: "cpo-demo-site-2",
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

function demoTransaction(
  t: DemoFleet["transactions"][number],
  now: number,
): Transaction {
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
    f.transactions
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
    f.transactions
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

/**
 * The demo implementation of the Ivora client. It answers from the sample data above
 * and the visitor's own demo fleet (`fleet`), and never sends a request anywhere: no
 * charger commands, no payments, no email, no network.
 */
export function createDemoClient(
  fleet: DemoFleetStore = memoryDemoFleet(),
  now: () => number = Date.now,
): IvoraClient {
  const update = async <T>(change: (f: DemoFleet) => T): Promise<T> => {
    const f = await fleet.load();
    const r = change(f);
    await fleet.save(f);
    return r;
  };
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
      ...f.transactions.map((x) => demoTransaction(x, t)).reverse(),
      ...copy(SAMPLE_TRANSACTIONS).map((x) => sampleTransaction(x, f)),
    ];
  };
  const station = async (id: number) => {
    const s = (await stations()).find((x) => x.id === id);
    if (!s)
      throw new IvoraError(404, "station_not_found", "Unknown demo station");
    return s;
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
    async findToken(externalReference) {
      const t = (await fleet.load()).tokens?.find(
        (x) => x.external_reference === externalReference,
      );
      return t ? (copy(t) satisfies TokenRecord) : null;
    },
    // Same reference, same token, like the API's idempotent replays.
    async createToken(input) {
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
  };
}
