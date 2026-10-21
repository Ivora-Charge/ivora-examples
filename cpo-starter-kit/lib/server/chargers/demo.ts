import "server-only";
import { randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { atLeast, type Role } from "@/lib/roles";
import {
  ChargerError,
  notAllowed,
  notFound,
  type ChargerRecord,
  type ChargerStore,
} from "./types";

// Demo charger records: each visitor's own, in their own cookie (see demo-cookie.ts),
// so visitors never see each other's changes and nothing is sent anywhere. The
// simulated stations themselves are the demo Ivora client's (lib/server/ivora/demo.ts).

/** Records kept, removed ones included (their sticker codes say "not in service"). */
const MAX_RECORDS = 10;
/** Browsers keep about 4 KB per cookie. */
export const DEMO_COOKIE_MAX = 3_800;

const text = (max: number) => z.string().max(max);
const recordSchema = z.object({
  id: text(40),
  stationId: z.number().int().nullable(),
  name: text(36),
  label: text(80).nullable(),
  locationId: z.number().int().nullable(),
  newSite: z
    .object({
      name: text(80),
      address: text(120),
      city: text(120),
      postalCode: text(20),
      country: text(3),
    })
    .nullable(),
  connectors: z.number().int().min(1).max(8),
  connectionUrl: text(300).nullable(),
  passwordSetAt: text(40).nullable(),
  connectionTest: z
    .object({
      at: text(40),
      online: z.boolean(),
      booted: z.boolean(),
      heartbeat: z.boolean(),
      lastSeen: text(40).nullable(),
      passed: z.boolean(),
    })
    .nullable(),
  remoteTest: z
    .object({
      attempt: z.number().int(),
      phase: z.enum(["starting", "charging", "stopping", "passed", "failed"]),
      connectorNumber: z.number().int(),
      connectorId: z.number().int(),
      requestedAt: text(40),
      transactionId: z.number().int().nullable(),
      operationId: text(80).nullable(),
      energyWh: z.number().int().min(0),
      finishedAt: text(40).nullable(),
      error: text(400).nullable(),
    })
    .nullable(),
  codes: z
    .array(
      z.object({
        code: text(8),
        connectorNumber: z.number().int(),
        connectorId: z.number().int().nullable(),
      }),
    )
    .max(8),
  createdAt: text(40),
  removedAt: text(40).nullable(),
  seq: z.object({
    credentials: z.number().int().min(0),
    test: z.number().int().min(0),
    edit: z.number().int().min(0),
  }),
});
const stateSchema = z.object({
  v: z.literal(1),
  records: z.array(recordSchema).max(MAX_RECORDS),
});
export type DemoChargersState = z.infer<typeof stateSchema>;
type DemoRecord = DemoChargersState["records"][number];

export const emptyDemoChargers = (): DemoChargersState => ({
  v: 1,
  records: [],
});

export function decodeDemoChargers(raw: string | undefined): DemoChargersState {
  if (!raw) return emptyDemoChargers();
  try {
    const json = inflateRawSync(Buffer.from(raw, "base64url"), {
      maxOutputLength: 64 * 1024,
    }).toString("utf8");
    const parsed = stateSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : emptyDemoChargers();
  } catch {
    return emptyDemoChargers();
  }
}

/** Compressed, because test results and codes add up; refuses what a cookie can't hold. */
export function encodeDemoChargers(s: DemoChargersState): string {
  const out = deflateRawSync(
    Buffer.from(JSON.stringify(stateSchema.parse(s)), "utf8"),
  ).toString("base64url");
  if (out.length > DEMO_COOKIE_MAX)
    throw new ChargerError(
      "busy",
      "Demo mode keeps your chargers in a browser cookie, and it is full. Remove a charger or reset the demo.",
    );
  return out;
}

export interface DemoChargersCookie {
  load(): Promise<DemoChargersState>;
  save(s: DemoChargersState): Promise<void>;
}

export function memoryDemoChargers(
  initial = emptyDemoChargers(),
): DemoChargersCookie & { state: DemoChargersState } {
  const store = {
    state: structuredClone(initial),
    async load() {
      return structuredClone(store.state);
    },
    async save(s: DemoChargersState) {
      encodeDemoChargers(s); // the same size limit as the cookie
      store.state = structuredClone(s);
    },
  };
  return store;
}

const toRecord = ({ seq: _seq, ...r }: DemoRecord): ChargerRecord => r;

/** The demo store: the same rules as the database functions, no network. */
export function createDemoChargerStore(
  cookie: DemoChargersCookie,
): ChargerStore {
  const update = async <T>(
    actor: { role: Role },
    change: (s: DemoChargersState) => T,
  ): Promise<T> => {
    if (!atLeast(actor.role, "technician")) throw notAllowed();
    const s = await cookie.load();
    const r = change(s);
    await cookie.save(s);
    return r;
  };
  const live = (s: DemoChargersState, id: string) => {
    const r = s.records.find((x) => x.id === id && !x.removedAt);
    if (!r) throw notFound();
    return r;
  };
  return {
    mode: "demo",
    async list() {
      return (await cookie.load()).records.map(toRecord);
    },
    create(actor, input) {
      return update(actor, (s) => {
        if (
          input.stationId &&
          s.records.some((r) => r.stationId === input.stationId && !r.removedAt)
        )
          throw new ChargerError(
            "exists",
            "This charger is already in the kit.",
          );
        // Make room: forget the oldest removed records first.
        while (s.records.length >= MAX_RECORDS) {
          const i = s.records.findIndex((r) => r.removedAt);
          if (i < 0)
            throw new ChargerError(
              "busy",
              "Demo mode keeps up to 10 chargers. Remove one or reset the demo.",
            );
          s.records.splice(i, 1);
        }
        const id = `demo-${randomBytes(4).toString("hex")}`;
        s.records.push({
          id,
          ...input,
          passwordSetAt: null,
          connectionTest: null,
          remoteTest: null,
          codes: [],
          createdAt: new Date().toISOString(),
          removedAt: null,
          seq: { credentials: 0, test: 0, edit: 0 },
        });
        return id;
      });
    },
    async update(actor, id, changes) {
      await update(actor, (s) => {
        const r = live(s, id);
        if (
          changes.stationId &&
          s.records.some(
            (x) =>
              x.id !== id && x.stationId === changes.stationId && !x.removedAt,
          )
        )
          throw new ChargerError(
            "exists",
            "This charger is already in the kit.",
          );
        if (changes.remoteTest?.error)
          changes = {
            ...changes,
            remoteTest: {
              ...changes.remoteTest,
              error: changes.remoteTest.error.slice(0, 400),
            },
          };
        Object.assign(r, changes);
      });
    },
    nextSeq(actor, id, kind) {
      return update(actor, (s) => {
        const r = live(s, id);
        r.seq[kind] += 1;
        return r.seq[kind];
      });
    },
    async addCodes(actor, id, codes) {
      await update(actor, (s) => {
        const r = live(s, id);
        const taken = new Set(
          s.records.flatMap((x) => x.codes.map((c) => c.code)),
        );
        for (const c of codes) {
          if (taken.has(c.code)) continue;
          if (r.codes.some((x) => x.connectorNumber === c.connectorNumber))
            continue;
          r.codes.push(c);
          taken.add(c.code);
        }
      });
    },
    async remove(actor, id) {
      await update(actor, (s) => {
        const r = live(s, id);
        if (r.stationId && !atLeast(actor.role, "manager")) throw notAllowed();
        r.removedAt = new Date().toISOString();
        // Keep the codes (they now say "not in service"), drop the rest.
        r.connectionTest = null;
        r.remoteTest = null;
      });
    },
    async resolveCode(code) {
      for (const r of (await cookie.load()).records) {
        const c = r.codes.find((x) => x.code === code);
        if (c)
          return {
            code,
            connectorNumber: c.connectorNumber,
            chargerName: r.label ?? r.name,
            inService: !r.removedAt,
            operatorName: null,
          };
      }
      return null;
    },
  };
}
