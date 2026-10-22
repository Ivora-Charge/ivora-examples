/**
 * Live data of a running session, as the server sends it. OCPI has no state of charge,
 * so it comes only from a CPO whose live-data adapter knows it; every field may be
 * missing, and the app shows only the ones it gets. Each value comes with the time the
 * charger measured it.
 */
export type LiveData = {
  socPercent?: number;
  socMeasuredAt?: string;
  powerKw?: number;
  powerMeasuredAt?: string;
};

export type SessionLive = {
  sessionId: string;
  status: string;
  kwh: number;
  live: LiveData;
  /** The adapter that answered, or null when there is nothing extra. */
  source: string | null;
};

/** What a running session shows beside its kWh. */
export type LiveReadout = {
  /** 0 to 100, whole percent; undefined hides the battery. */
  socPercent?: number;
  /** For example "last seen 6 min ago" when the SoC is not current; undefined otherwise. */
  socAge?: string;
  /** For example "48.5 kW"; undefined hides it. */
  power?: string;
};

/**
 * The server drops older readings too; the app checks again, because a screen may
 * keep showing an answer for a while. A suspended or offline charger stops reporting
 * while its session stays active, so an old power would show charging that is not.
 */
export const POWER_MAX_AGE_MS = 3 * 60 * 1000;
export const SOC_MAX_AGE_MS = 15 * 60 * 1000;
/** A SoC older than this says how old it is. */
export const SOC_CURRENT_MS = 2 * 60 * 1000;
const MAX_SKEW_MS = 60_000;

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** How old a reading is in ms, or undefined when its time is missing, invalid, ahead or older than `maxAge`. */
function age(at: unknown, now: number, maxAge: number): number | undefined {
  if (typeof at !== "string") return undefined;
  const t = Date.parse(at);
  if (!Number.isFinite(t) || t > now + MAX_SKEW_MS || now - t > maxAge)
    return undefined;
  return Math.max(0, now - t);
}

/**
 * The SoC and power to show, or nothing. A value that is missing, out of range or too
 * old is hidden rather than shown wrong.
 */
export function liveReadout(
  live: LiveData | null | undefined,
  now = Date.now(),
): LiveReadout {
  const out: LiveReadout = {};
  if (!live) return out;
  const socAge = age(live.socMeasuredAt, now, SOC_MAX_AGE_MS);
  if (
    finite(live.socPercent) &&
    live.socPercent >= 0 &&
    live.socPercent <= 100 &&
    socAge !== undefined
  ) {
    out.socPercent = Math.round(live.socPercent);
    if (socAge > SOC_CURRENT_MS)
      out.socAge = `last seen ${Math.floor(socAge / 60_000)} min ago`;
  }
  if (
    finite(live.powerKw) &&
    live.powerKw > 0 &&
    age(live.powerMeasuredAt, now, POWER_MAX_AGE_MS) !== undefined
  )
    out.power = `${live.powerKw >= 100 ? Math.round(live.powerKw) : Math.round(live.powerKw * 10) / 10} kW`;
  return out;
}
