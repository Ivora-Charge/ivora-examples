import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atLeast } from "@/lib/roles";
import { SAMPLE_TARIFF_IDS } from "../ivora/demo";
import type { Staff } from "../team/types";
import {
  busy,
  notAllowed,
  notFound,
  notReady,
  PricingError,
  type PricingState,
  type PricingStore,
  type TariffDefinition,
} from "./types";

// Demo pricing: each visitor's tariffs and assignments live in their own cookie (see
// demo-cookie.ts), seeded with two labelled sample tariffs on the sample chargers.
// Nothing is sent anywhere; the demo Ivora client stands in for the API.

const MAX_TARIFFS = 6;
const MAX_VERSIONS = 5;
const MAX_STATIONS = 12;
const DAY = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);
const minor = z.number().int().min(0).max(10_000_000);

const definitionSchema = z.object({
  kind: z.enum(["paid", "free"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timeZone: z.string().max(64),
  energyMinorPerKwh: minor,
  sessionFeeMinor: minor,
  idleMinorPerMinute: minor,
  idleGraceMinutes: z.number().int().min(0).max(240),
  periods: z
    .array(
      z.object({
        days: z.array(DAY).min(1).max(7),
        start: z.string().regex(/^\d\d:\d\d$/),
        end: z.string().regex(/^\d\d:\d\d$/),
        energyMinorPerKwh: minor,
      }),
    )
    .max(4),
  driverText: z.string().max(512).nullable(),
});

const stateSchema = z.object({
  v: z.literal(1),
  tariffs: z
    .array(
      z.object({
        id: z.string().max(40),
        name: z.string().max(60),
        versions: z
          .array(
            z.object({
              version: z.number().int().min(1),
              ivoraTariffId: z.number().int().nullable(),
              definition: definitionSchema.nullable(),
              createdAt: z.string().max(40),
              archivedAt: z.string().max(40).nullable(),
            }),
          )
          .min(1)
          .max(MAX_VERSIONS),
      }),
    )
    .max(MAX_TARIFFS),
  stations: z
    .array(
      z.object({
        stationId: z.number().int(),
        tariffId: z.string().max(40).nullable(),
        private: z.boolean(),
        connectors: z.record(z.string(), z.string().max(40)),
      }),
    )
    .max(MAX_STATIONS),
});
export type DemoPricingState = z.infer<typeof stateSchema>;

const SEEDED_AT = "2026-01-01T00:00:00.000Z";

const STANDARD: TariffDefinition = {
  kind: "paid",
  currency: "USD",
  timeZone: "UTC",
  energyMinorPerKwh: 35,
  sessionFeeMinor: 100,
  idleMinorPerMinute: 40,
  idleGraceMinutes: 10,
  periods: [
    {
      days: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
      start: "16:00",
      end: "21:00",
      energyMinorPerKwh: 45,
    },
  ],
  driverText: null,
};
const FREE: TariffDefinition = {
  ...STANDARD,
  kind: "free",
  energyMinorPerKwh: 0,
  sessionFeeMinor: 0,
  idleMinorPerMinute: 0,
  idleGraceMinutes: 0,
  periods: [],
};

/** Two sample tariffs on the sample chargers; DEMO-MARKET-01 is private and free. */
export function demoPricingSeed(): DemoPricingState {
  return {
    v: 1,
    tariffs: [
      {
        id: "demo-standard",
        name: "Sample: Standard",
        versions: [
          {
            version: 1,
            ivoraTariffId: SAMPLE_TARIFF_IDS[0],
            definition: STANDARD,
            createdAt: SEEDED_AT,
            archivedAt: null,
          },
        ],
      },
      {
        id: "demo-free",
        name: "Sample: Free staff charging",
        versions: [
          {
            version: 1,
            ivoraTariffId: SAMPLE_TARIFF_IDS[1],
            definition: FREE,
            createdAt: SEEDED_AT,
            archivedAt: null,
          },
        ],
      },
    ],
    stations: [
      {
        stationId: 9101,
        tariffId: "demo-standard",
        private: false,
        connectors: {},
      },
      {
        stationId: 9102,
        tariffId: "demo-standard",
        private: false,
        connectors: { "91022": "demo-free" },
      },
      { stationId: 9103, tariffId: "demo-free", private: true, connectors: {} },
    ],
  };
}

export function decodeDemoPricing(raw: string | undefined): DemoPricingState {
  if (!raw) return demoPricingSeed();
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : demoPricingSeed();
  } catch {
    return demoPricingSeed();
  }
}

/**
 * Keeps the cookie small: at most MAX_VERSIONS versions per tariff, and definitions
 * only for the pending and current version (older ones keep their number and Ivora ID).
 */
function compact(s: DemoPricingState): DemoPricingState {
  for (const t of s.tariffs) {
    t.versions = t.versions.slice(0, MAX_VERSIONS);
    const current = t.versions.findIndex((v) => v.ivoraTariffId !== null);
    if (current >= 0)
      for (const v of t.versions.slice(current + 1)) v.definition = null;
  }
  return s;
}

export function encodeDemoPricing(s: DemoPricingState): string {
  return Buffer.from(
    JSON.stringify(stateSchema.parse(compact(s))),
    "utf8",
  ).toString("base64url");
}

export interface DemoPricingCookie {
  load(): Promise<DemoPricingState>;
  save(s: DemoPricingState): Promise<void>;
}

export function memoryDemoPricing(
  initial = demoPricingSeed(),
): DemoPricingCookie & { state: DemoPricingState } {
  const store = {
    state: structuredClone(initial),
    async load() {
      return structuredClone(store.state);
    },
    async save(s: DemoPricingState) {
      store.state = structuredClone(stateSchema.parse(compact(s)));
    },
  };
  return store;
}

/** The demo store: same rules as live (owners and managers only), no network. */
export function createDemoPricingStore(
  cookie: DemoPricingCookie,
): PricingStore {
  const update = async <T>(
    actor: Staff,
    change: (s: DemoPricingState) => T,
  ): Promise<T> => {
    if (!atLeast(actor.role, "manager")) throw notAllowed();
    const s = await cookie.load();
    const r = change(s);
    await cookie.save(s);
    return r;
  };
  const tariff = (s: DemoPricingState, id: string) => {
    const t = s.tariffs.find((x) => x.id === id);
    if (!t) throw notFound();
    return t;
  };
  const now = () => new Date().toISOString();
  return {
    mode: "demo",
    async load(): Promise<PricingState> {
      const s = await cookie.load();
      return { tariffs: s.tariffs, stations: s.stations };
    },
    createTariff(actor, name, definition) {
      return update(actor, (s) => {
        if (s.tariffs.length >= MAX_TARIFFS)
          throw new PricingError(
            "invalid",
            `Demo mode keeps up to ${MAX_TARIFFS} tariffs in your browser. Reset the demo prices to start again.`,
          );
        const id = randomUUID();
        s.tariffs.push({
          id,
          name,
          versions: [
            {
              version: 1,
              ivoraTariffId: null,
              definition,
              createdAt: now(),
              archivedAt: null,
            },
          ],
        });
        return id;
      });
    },
    addVersion(actor, tariffId, name, definition) {
      return update(actor, (s) => {
        const t = tariff(s, tariffId);
        if (t.versions[0]?.ivoraTariffId === null) throw busy();
        const version = (t.versions[0]?.version ?? 0) + 1;
        t.name = name;
        t.versions.unshift({
          version,
          ivoraTariffId: null,
          definition,
          createdAt: now(),
          archivedAt: null,
        });
        return version;
      });
    },
    recordVersion(actor, tariffId, version, ivoraTariffId) {
      return update(actor, (s) => {
        const v = tariff(s, tariffId).versions.find(
          (x) => x.version === version,
        );
        if (!v) throw notFound();
        v.ivoraTariffId ??= ivoraTariffId;
      });
    },
    dropVersion(actor, tariffId, version) {
      return update(actor, (s) => {
        const t = tariff(s, tariffId);
        t.versions = t.versions.filter(
          (v) => v.version !== version || v.ivoraTariffId !== null,
        );
        if (!t.versions.length) s.tariffs = s.tariffs.filter((x) => x !== t);
      });
    },
    recordArchived(actor, tariffId, version) {
      return update(actor, (s) => {
        const v = tariff(s, tariffId).versions.find(
          (x) => x.version === version,
        );
        if (v) v.archivedAt ??= now();
      });
    },
    setStation(actor, stationId, input) {
      return update(actor, (s) => {
        for (const id of [
          input.tariffId,
          ...input.connectors.map((c) => c.tariffId),
        ])
          if (
            id &&
            !tariff(s, id).versions.some((v) => v.ivoraTariffId !== null)
          )
            throw notReady();
        s.stations = s.stations.filter((x) => x.stationId !== stationId);
        if (input.tariffId || input.private || input.connectors.length)
          s.stations.push({
            stationId,
            tariffId: input.tariffId,
            private: input.private,
            connectors: Object.fromEntries(
              input.connectors.map((c) => [String(c.connectorId), c.tariffId]),
            ),
          });
        if (s.stations.length > MAX_STATIONS)
          throw new PricingError(
            "invalid",
            `Demo mode keeps prices for up to ${MAX_STATIONS} chargers in your browser.`,
          );
      });
    },
  };
}
