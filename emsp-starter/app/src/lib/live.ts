/**
 * Live data of a running session, as the server sends it. OCPI has no state of charge,
 * so it comes only from a CPO whose live-data adapter knows it; every field may be
 * missing, and the app shows only the ones it gets.
 */
export type LiveData = {
  socPercent?: number;
  powerKw?: number;
  measuredAt?: string;
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
  /** For example "48.5 kW"; undefined hides it. */
  power?: string;
};

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * The SoC and power to show, or nothing. A value that is missing or out of range is
 * hidden rather than shown wrong.
 */
export function liveReadout(live: LiveData | null | undefined): LiveReadout {
  const out: LiveReadout = {};
  if (!live) return out;
  if (finite(live.socPercent) && live.socPercent >= 0 && live.socPercent <= 100)
    out.socPercent = Math.round(live.socPercent);
  if (finite(live.powerKw) && live.powerKw > 0)
    out.power = `${live.powerKw >= 100 ? Math.round(live.powerKw) : Math.round(live.powerKw * 10) / 10} kW`;
  return out;
}
