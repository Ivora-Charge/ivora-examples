import "server-only";
import { randomUUID } from "node:crypto";
import { config, isDemo } from "./config";
import { getDepot, withLock, type Depot } from "./depot";
import {
  advanceDemoTo,
  dayStart,
  demoState,
  nightEndOf,
  nightStartOf,
  seedDemo,
  snap,
} from "./demo";
import { MemoryStore } from "./store";

/**
 * Demo mode: each visitor gets their own night. The clock lives in a cookie
 * (an anchor), not in the server, so any serverless instance can rebuild the
 * same board: seed the night, then replay it step by step up to
 * simAt + (now - realAt) x speed.
 */
export const DEMO_COOKIE = "depot_demo";
export const SPEEDS = [0, 1, 60, 300] as const;
export type Speed = (typeof SPEEDS)[number];

export interface Anchor {
  /** Random per visitor (and per Reset), so visitors never share a depot. */
  id: string;
  /** UTC midnight of the demo day, epoch ms. */
  base: number;
  /** Simulated time at `realAt`, epoch ms. */
  simAt: number;
  /** Real time the anchor was written, epoch ms. */
  realAt: number;
  speed: Speed;
}

const DAY = 86400_000;

/** A new night, paused at 16:30 depot time today. */
export function freshAnchor(now: number): Anchor {
  const base = dayStart(now);
  return {
    id: randomUUID(),
    base,
    simAt: nightStartOf(base),
    realAt: now,
    speed: 0,
  };
}

/** Simulated time for this anchor at real time `now`, within the night. */
export function simTime(a: Anchor, now: number): number {
  const t = a.simAt + Math.max(0, now - a.realAt) * a.speed;
  return Math.min(Math.max(t, nightStartOf(a.base)), nightEndOf(a.base));
}

export const nightOver = (a: Anchor, now: number) =>
  simTime(a, now) >= nightEndOf(a.base);

/** The anchor the cookie carries, or undefined when it is missing or not one we wrote. */
export function readAnchor(
  cookieHeader: string | null,
  now: number,
): Anchor | undefined {
  const raw = cookieHeader
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${DEMO_COOKIE}=`))
    ?.slice(DEMO_COOKIE.length + 1);
  if (!raw) return undefined;
  try {
    const a = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const ok =
      typeof a?.id === "string" &&
      /^[0-9a-f-]{36}$/.test(a.id) &&
      Number.isSafeInteger(a.base) &&
      a.base === dayStart(a.base) &&
      Math.abs(now - a.base) < 7 * DAY &&
      Number.isFinite(a.simAt) &&
      a.simAt >= nightStartOf(a.base) &&
      a.simAt <= nightEndOf(a.base) &&
      Number.isFinite(a.realAt) &&
      a.realAt <= now + 60_000 &&
      SPEEDS.includes(a.speed);
    return ok
      ? {
          id: a.id,
          base: a.base,
          simAt: a.simAt,
          realAt: a.realAt,
          speed: a.speed,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Set-Cookie value for an anchor. It only holds demo clock values. */
export function anchorCookie(a: Anchor): string {
  const v = Buffer.from(JSON.stringify(a), "utf8").toString("base64url");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${DEMO_COOKIE}=${v}; Path=/; Max-Age=${2 * 86400}; HttpOnly; SameSite=Lax${secure}`;
}

/** Depots this instance holds, most recently used last. */
const MAX_DEPOTS = 64;
const g = globalThis as unknown as { __demoDepots?: Map<string, Depot> };
const depots = (g.__demoDepots ??= new Map());

function newDepot(): Depot {
  return {
    demo: true,
    store: new MemoryStore(),
    settings: {
      siteCapKw: config.siteCapKw,
      centsPerKwh: config.centsPerKwh,
      currency: config.currency,
      // Demo never sends charger commands.
      baselineProfile: false,
    },
    clock: null,
  };
}

/**
 * The visitor's depot at real time `now`: kept from an earlier request on this
 * instance and caught up, or seeded and replayed. Call inside withLock.
 */
export async function depotFor(a: Anchor, now: number): Promise<Depot> {
  const target = snap(simTime(a, now));
  let d = depots.get(a.id);
  if (
    !d ||
    demoState(d)?.base !== a.base ||
    (d.clock?.getTime() ?? Infinity) > target
  ) {
    d = newDepot();
    await seedDemo(d, a.base);
  }
  depots.delete(a.id);
  depots.set(a.id, d);
  while (depots.size > MAX_DEPOTS)
    depots.delete(depots.keys().next().value as string);
  await advanceDemoTo(d, target);
  return d;
}

/** Forget every depot (tests: a fresh instance). */
export function dropDemoDepots() {
  depots.clear();
}

export interface Visit {
  d: Depot;
  /** Demo only: the visitor's clock, and whether this request started it. */
  anchor?: Anchor;
  fresh?: boolean;
}

/** The depot a request works on: the shared one in live mode, the visitor's own in demo mode. */
export async function depotOf(req: Request): Promise<Visit> {
  if (!isDemo()) return { d: await getDepot() };
  const now = Date.now();
  const found = readAnchor(req.headers.get("cookie"), now);
  const anchor = found ?? freshAnchor(now);
  const d = await withLock(() => depotFor(anchor, now));
  return { d, anchor, fresh: !found };
}

/** Hand a visitor without a cookie the night this request started. */
export function keepAnchor(res: Response, v: Visit): Response {
  if (v.anchor && v.fresh)
    res.headers.append("set-cookie", anchorCookie(v.anchor));
  return res;
}
