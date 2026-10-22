import "server-only";
import type { SessionStatus } from "@/lib/ocpi/session-objects";

/**
 * Live data OCPI 2.2.1 does not carry. A Session has energy, cost and status, but no
 * state of charge and no current power, so each CPO peer may have a live-data adapter
 * that reads them from somewhere else, usually the CPO's own API. Every field is
 * optional: an adapter returns what the CPO knows, and the app shows only what it gets.
 */
export type LiveData = {
  /** The vehicle's state of charge, 0 to 100, as the charger reports it. */
  socPercent?: number;
  /** Power flowing to the vehicle now, in kW. */
  powerKw?: number;
  /** When the newest of these values was measured, ISO 8601 UTC. */
  measuredAt?: string;
};

/**
 * One of our sessions at a CPO, as an adapter sees it: the OCPI fields it may use to
 * find the CPO's own record of it. Never the driver.
 */
export type LiveSessionRef = {
  peerId: string;
  /** The CPO party's country code and party ID, and its OCPI session ID. */
  countryCode: string;
  partyId: string;
  sessionId: string;
  status: SessionStatus;
  startDateTime: string;
  locationId: string;
  evseUid: string;
  connectorId: string;
  /** The token the session runs on (cdr_token.uid): one we issued. */
  tokenUid: string;
};

/**
 * Reads live data for a session. Adapters are read-only: they never send a command or
 * change anything at the CPO. They return `{}` when they have nothing (an unknown
 * session, one they cannot match safely, a charger that reports no SoC), and throw a
 * LiveDataError when the CPO's API fails; the caller then shows nothing extra.
 */
export interface LiveDataAdapter {
  /** Names the adapter in logs and in the app's `source`, for example "ivora". */
  readonly kind: string;
  getLive(ref: LiveSessionRef, signal?: AbortSignal): Promise<LiveData>;
}

/** The default: OCPI only, nothing extra. */
export const nullAdapter: LiveDataAdapter = {
  kind: "none",
  getLive: async () => ({}),
};

/** An adapter's request failed. `code` is safe to log: never a key, URL or body. */
export class LiveDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LiveDataError";
  }
}

const MAX_POWER_KW = 2000;

const round = (n: number, places: number) =>
  Math.round(n * 10 ** places) / 10 ** places;

/**
 * What an adapter returned, kept only where it makes sense: a SoC from 0 to 100, a
 * power from 0 to 2,000 kW and a valid time, no later than a minute from `now`.
 * Anything else is dropped, so a bad reading is hidden rather than shown.
 */
export function cleanLive(raw: unknown, now = Date.now()): LiveData {
  const out: LiveData = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const soc = num(r.socPercent);
  if (soc !== undefined && soc >= 0 && soc <= 100)
    out.socPercent = round(soc, 1);
  const power = num(r.powerKw);
  if (power !== undefined && power >= 0 && power <= MAX_POWER_KW)
    out.powerKw = round(power, 2);
  if (typeof r.measuredAt === "string") {
    const at = Date.parse(r.measuredAt);
    if (Number.isFinite(at) && at <= now + 60_000)
      out.measuredAt = new Date(at).toISOString();
  }
  if (out.socPercent === undefined && out.powerKw === undefined) return {};
  return out;
}
