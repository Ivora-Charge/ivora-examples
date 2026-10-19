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
 */
export function splitPower(
  capKw: number,
  sessions: PowerSession[],
): Map<string, number> {
  const out = new Map<string, number>();
  let left = Math.max(0, capKw);
  const ordered = [...sessions].sort(
    (a, b) => a.departureMs - b.departureMs || a.id.localeCompare(b.id),
  );
  for (const s of ordered) {
    const kw = Math.max(0, Math.min(s.wantedKw, left));
    out.set(s.id, round3(kw));
    left -= kw;
  }
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
