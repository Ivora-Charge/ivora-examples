import { wholeW } from "./units";

export interface PowerSession {
  id: string;
  /** Departure time, epoch ms. Earlier departures get power first. */
  departureMs: number;
  /** What the vehicle wants right now, in kW (connector limit or schedule need). */
  wantedKw: number;
}

/**
 * Split the depot cap across active sessions. Sessions are served in order of
 * departure (earliest first); each gets up to what it wants from what is left.
 * Anything left over after the first pass is not redistributed because every
 * session already has what it wants.
 *
 * The split is done in whole watts, rounded down, so the allocations (kW = W / 1000)
 * add up to at most the cap with no rounding overshoot.
 */
export function splitPower(
  capKw: number,
  sessions: PowerSession[],
): Map<string, number> {
  const out = new Map<string, number>();
  let leftW = wholeW(Math.max(0, capKw));
  const ordered = [...sessions].sort(
    (a, b) => a.departureMs - b.departureMs || a.id.localeCompare(b.id),
  );
  for (const s of ordered) {
    const w = Math.max(0, Math.min(wholeW(s.wantedKw), leftW));
    out.set(s.id, w / 1000);
    leftW -= w;
  }
  return out;
}
