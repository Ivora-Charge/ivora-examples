import "server-only";
import { randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { atLeast, type Role } from "@/lib/roles";
import {
  COMMAND_ACTIONS,
  commandBusy,
  LiveError,
  notAllowed,
  type LiveCommand,
  type LiveStore,
} from "./types";
import { mergeSeed } from "./transactions";

// Demo commands: each visitor's own, in their own cookie (see demo-cookie.ts), so
// visitors never see each other's and nothing is sent anywhere. The simulated chargers
// are the demo Ivora client's. Demo mode receives no webhooks: the page refreshes
// itself instead.

/** Commands kept (oldest dropped first). */
const MAX_COMMANDS = 8;
/** Browsers keep about 4 KB per cookie. */
export const DEMO_LIVE_COOKIE_MAX = 3_800;

/** Tracked sessions kept in the cookie; ended ones are dropped first. */
const MAX_TRACKED = 12;

const text = (max: number) => z.string().max(max);
const commandSchema = z.object({
  id: text(40),
  requestId: text(40),
  stationId: z.number().int(),
  action: z.enum(COMMAND_ACTIONS),
  connectorId: z.number().int().nullable(),
  transactionId: z.number().int().nullable(),
  mode: z.enum(["soft", "hard"]).nullable(),
  phase: z.enum(["pending", "accepted", "failed", "unknown"]),
  operationId: text(100).nullable(),
  chargerStatus: text(40).nullable(),
  error: text(600).nullable(),
  confirmedSessions: z.array(z.number().int()).max(10),
  requestedBy: text(40).nullable(),
  requestedAt: text(40),
  updatedAt: text(40),
  finishedAt: text(40).nullable(),
});
const stateSchema = z.object({
  v: z.literal(1),
  commands: z.array(commandSchema).max(MAX_COMMANDS),
  staffToken: z
    .object({ idToken: text(20), tokenId: z.number().int().nullable() })
    .optional(),
  freeToken: z
    .object({ idToken: text(20), tokenId: z.number().int().nullable() })
    .optional(),
  /** Tracked sessions (the session tracker's rows; few, see MAX_TRACKED). */
  tracked: z
    .array(
      z.object({
        transactionId: z.number().int(),
        stationId: z.number().int(),
        connectorId: z.number().int().nullable(),
        connectorNumber: z.number().int().nullable(),
        idToken: text(40).nullable(),
        startedAt: text(40).nullable(),
        endedAt: text(40).nullable(),
        energyWh: z.number().nullable(),
        active: z.boolean(),
        checkedAt: text(40),
        changedAt: text(40),
      }),
    )
    .max(MAX_TRACKED)
    .optional(),
  /** The session tracker's marks by station ID. */
  trackerMarks: z
    .record(z.string().max(12), z.number().int().nonnegative())
    .optional(),
  /** When the tracker's scan last reached the end of a station's list. */
  trackerScanned: z.record(z.string().max(12), text(40)).optional(),
  /** Unfinished mark seeding by station ID (see SeedProgress). */
  trackerSeeds: z
    .record(
      z.string().max(12),
      z.object({
        lo: z.number().int().nonnegative(),
        hi: z.number().int().nonnegative().nullable(),
      }),
    )
    .optional(),
  /** Transaction high-water marks by station ID. */
  marks: z
    .record(z.string().max(12), z.number().int().nonnegative())
    .optional(),
});
export type DemoLiveState = z.infer<typeof stateSchema>;

export const emptyDemoLive = (): DemoLiveState => ({ v: 1, commands: [] });

export function decodeDemoLive(raw: string | undefined): DemoLiveState {
  if (!raw) return emptyDemoLive();
  try {
    const json = inflateRawSync(Buffer.from(raw, "base64url"), {
      maxOutputLength: 64 * 1024,
    }).toString("utf8");
    const parsed = stateSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : emptyDemoLive();
  } catch {
    return emptyDemoLive();
  }
}

/** Compressed, because error messages add up; refuses what a cookie can't hold. */
export function encodeDemoLive(s: DemoLiveState): string {
  const out = deflateRawSync(
    Buffer.from(JSON.stringify(stateSchema.parse(s)), "utf8"),
  ).toString("base64url");
  if (out.length > DEMO_LIVE_COOKIE_MAX)
    throw new LiveError(
      "busy",
      "Demo mode keeps your commands in a browser cookie, and it is full. Reset the demo.",
    );
  return out;
}

export interface DemoLiveCookie {
  load(): Promise<DemoLiveState>;
  save(s: DemoLiveState): Promise<void>;
}

export function memoryDemoLive(
  initial = emptyDemoLive(),
): DemoLiveCookie & { state: DemoLiveState } {
  const store = {
    state: structuredClone(initial),
    async load() {
      return structuredClone(store.state);
    },
    async save(s: DemoLiveState) {
      encodeDemoLive(s); // the same size limit as the cookie
      store.state = structuredClone(s);
    },
  };
  return store;
}

/** The demo store: the same rules as the database functions, no network. */
export function createDemoLiveStore(cookie: DemoLiveCookie): LiveStore {
  // One change at a time, like the database's row locks.
  let queue: Promise<unknown> = Promise.resolve();
  const update = <T>(change: (s: DemoLiveState) => T): Promise<T> => {
    const run = queue.then(async () => {
      const s = await cookie.load();
      const r = change(s);
      await cookie.save(s);
      return r;
    });
    queue = run.catch(() => undefined);
    return run;
  };
  const newestFirst = (list: LiveCommand[]) =>
    [...list].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  return {
    mode: "demo",
    async listCommands(_operatorId, o = {}) {
      const all = newestFirst((await cookie.load()).commands);
      return all
        .filter((c) => !o.stationId || c.stationId === o.stationId)
        .slice(0, o.limit ?? 15);
    },
    async getCommand(_operatorId, id) {
      return (await cookie.load()).commands.find((c) => c.id === id) ?? null;
    },
    claim(actor: { role: Role; userId: string }, c) {
      return update((s) => {
        if (!atLeast(actor.role, "technician")) throw notAllowed();
        const same = s.commands.find((x) => x.requestId === c.requestId);
        if (same) {
          if (
            same.stationId !== c.stationId ||
            same.action !== c.action ||
            same.connectorId !== c.connectorId ||
            same.transactionId !== c.transactionId ||
            same.mode !== c.mode
          )
            throw new LiveError("invalid", "Reload the page and try again.");
          return { command: same, created: false };
        }
        const now = new Date().toISOString();
        const stale = Date.now() - 15 * 60_000;
        for (const x of s.commands)
          if (
            x.stationId === c.stationId &&
            x.phase === "pending" &&
            Date.parse(x.requestedAt) < stale
          )
            Object.assign(x, {
              phase: "unknown",
              error:
                "Ivora did not confirm this command within 15 minutes. Check the charger before sending it again.",
              updatedAt: now,
              finishedAt: now,
            });
        if (
          s.commands.some(
            (x) => x.stationId === c.stationId && x.phase === "pending",
          )
        )
          throw commandBusy();
        const command: LiveCommand = {
          id: randomUUID(),
          ...c,
          phase: "pending",
          operationId: null,
          chargerStatus: null,
          error: null,
          requestedBy: actor.userId,
          requestedAt: now,
          updatedAt: now,
          finishedAt: null,
        };
        s.commands.push(command);
        // Make room: drop the oldest finished commands.
        while (s.commands.length > MAX_COMMANDS) {
          const i = s.commands.findIndex((x) => x.phase !== "pending");
          s.commands.splice(i < 0 ? 0 : i, 1);
        }
        return { command, created: true };
      });
    },
    record(_operatorId, id, changes) {
      return update((s) => {
        const c = s.commands.find((x) => x.id === id && x.phase === "pending");
        if (!c) return false;
        const now = new Date().toISOString();
        Object.assign(c, changes, {
          error:
            changes.error === undefined
              ? c.error
              : (changes.error?.slice(0, 600) ?? null),
          updatedAt: now,
          finishedAt: (changes.phase ?? "pending") === "pending" ? null : now,
        });
        return true;
      });
    },
    async findByOperation(operationId) {
      const c = (await cookie.load()).commands.find(
        (x) => x.operationId === operationId && x.phase === "pending",
      );
      return c ? { operatorId: "demo", command: c } : null;
    },
    async getStaffToken() {
      return (await cookie.load()).staffToken ?? null;
    },
    putStaffToken(_operatorId, t, o = {}) {
      return update((s) => {
        if (!s.staffToken || o.replace) s.staffToken = { ...t };
        return { ...s.staffToken };
      });
    },
    async getFreeToken() {
      return (await cookie.load()).freeToken ?? null;
    },
    putFreeToken(_operatorId, t, o = {}) {
      return update((s) => {
        if (!s.freeToken || o.replace) s.freeToken = { ...t };
        return { ...s.freeToken };
      });
    },
    async getTransactionMark(stationId) {
      return (await cookie.load()).marks?.[String(stationId)] ?? null;
    },
    async advanceTransactionMark(stationId, transactionId) {
      await update((s) => {
        const marks = (s.marks ??= {});
        const k = String(stationId);
        marks[k] = Math.max(marks[k] ?? 0, transactionId);
      });
    },
    async listActiveSessions(o = {}) {
      return ((await cookie.load()).tracked ?? [])
        .filter(
          (t) =>
            t.active &&
            (o.stationId === undefined || t.stationId === o.stationId),
        )
        .sort((a, b) => b.transactionId - a.transactionId);
    },
    async listEndedSessions(stationId, o = {}) {
      return ((await cookie.load()).tracked ?? [])
        .filter(
          (t) =>
            !t.active &&
            t.stationId === stationId &&
            (o.before === undefined || t.transactionId < o.before),
        )
        .sort((a, b) => b.transactionId - a.transactionId)
        .slice(0, o.limit ?? 20);
    },
    async getTrackedSession(transactionId) {
      return (
        ((await cookie.load()).tracked ?? []).find(
          (t) => t.transactionId === transactionId,
        ) ?? null
      );
    },
    trackSession(t) {
      return update((s) => {
        const rows = (s.tracked ??= []);
        const i = rows.findIndex((x) => x.transactionId === t.transactionId);
        const old = i >= 0 ? rows[i] : null;
        // An ended session stays ended.
        if (old && !old.active) return;
        const now = new Date().toISOString();
        // What the table can't hold is stored as unknown, as cpo_track_session does.
        const energy =
          t.energyWh !== null && Number.isFinite(t.energyWh) && t.energyWh >= 0
            ? t.energyWh
            : null;
        const energyWh =
          energy === null
            ? (old?.energyWh ?? null)
            : Math.max(energy, old?.energyWh ?? 0);
        const row = {
          ...t,
          connectorId:
            t.connectorId && t.connectorId > 0
              ? t.connectorId
              : (old?.connectorId ?? null),
          idToken:
            t.idToken && t.idToken.length <= 40
              ? t.idToken
              : (old?.idToken ?? null),
          energyWh,
          checkedAt: now,
          changedAt:
            !old || !t.active || energyWh !== old.energyWh
              ? now
              : old.changedAt,
        };
        if (i >= 0) rows[i] = row;
        else rows.push(row);
        // Over the cookie's room: ended sessions go first, oldest first.
        rows.sort(
          (a, b) =>
            Number(b.active) - Number(a.active) ||
            b.transactionId - a.transactionId,
        );
        rows.length = Math.min(rows.length, MAX_TRACKED);
      });
    },
    forgetSession(transactionId) {
      return update((s) => {
        s.tracked = (s.tracked ?? []).filter(
          (t) => t.transactionId !== transactionId,
        );
      });
    },
    forgetRemovedStations(keep) {
      const kept = new Set(keep);
      return update((s) => {
        s.tracked = (s.tracked ?? []).filter((t) => kept.has(t.stationId));
        for (const m of [s.trackerMarks, s.trackerScanned, s.trackerSeeds])
          for (const k of Object.keys(m ?? {}))
            if (!kept.has(Number(k))) delete m![k];
      });
    },
    async getTrackerMark(stationId) {
      return (await cookie.load()).trackerMarks?.[String(stationId)] ?? null;
    },
    async listTrackerMarks() {
      const s = await cookie.load();
      return new Map(
        Object.entries(s.trackerMarks ?? {}).map(([k, mark]) => [
          Number(k),
          { mark, scannedAt: s.trackerScanned?.[k] ?? null },
        ]),
      );
    },
    async advanceTrackerMark(stationId, transactionId, o = {}) {
      await update((s) => {
        const marks = (s.trackerMarks ??= {});
        const k = String(stationId);
        marks[k] = Math.max(marks[k] ?? 0, transactionId);
        if (o.scanned) (s.trackerScanned ??= {})[k] = new Date().toISOString();
      });
    },
    async getTrackerSeed(stationId) {
      return (await cookie.load()).trackerSeeds?.[String(stationId)] ?? null;
    },
    async saveTrackerSeed(stationId, p) {
      await update((s) => {
        (s.trackerSeeds ??= {})[String(stationId)] = mergeSeed(
          s.trackerSeeds?.[String(stationId)] ?? null,
          p,
        );
      });
    },
    // Demo mode accepts no webhooks: nothing to deduplicate.
    async recordEvent() {
      return false;
    },
    async markProcessed() {},
    async version() {
      const s = await cookie.load();
      return (
        s.commands
          .map((c) => c.updatedAt)
          .sort()
          .pop() ?? ""
      );
    },
  };
}
