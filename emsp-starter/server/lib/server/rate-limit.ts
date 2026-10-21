import "server-only";

/**
 * A per-client request limit for the public API: at most `limit` requests per client
 * key in any `windowMs`. The counts live in this server process, so each instance counts
 * on its own; put a shared limiter (the hosting platform's firewall, or a store such as
 * Redis) in front for a hard cap across instances. Memory stays bounded: past
 * `maxClients` keys, expired ones are dropped, then the oldest.
 */
export type RateLimit = {
  /** Null when allowed; else seconds until the client may try again. */
  check(client: string, now?: number): number | null;
  reset(): void;
};

export function rateLimit({
  limit,
  windowMs,
  maxClients = 10_000,
}: {
  limit: number;
  windowMs: number;
  maxClients?: number;
}): RateLimit {
  /** Request times per client, oldest first. */
  const hits = new Map<string, number[]>();
  const recent = (times: number[], now: number) =>
    times.filter((t) => now - t < windowMs);

  return {
    check(client, now = Date.now()) {
      const times = recent(hits.get(client) ?? [], now);
      if (times.length >= limit) {
        hits.set(client, times);
        return Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000));
      }
      times.push(now);
      // Re-insert, so the map's order is least recently used first.
      hits.delete(client);
      hits.set(client, times);
      if (hits.size > maxClients) {
        for (const [k, v] of hits) if (!recent(v, now).length) hits.delete(k);
        for (const k of hits.keys()) {
          if (hits.size <= maxClients) break;
          hits.delete(k);
        }
      }
      return null;
    },
    reset() {
      hits.clear();
    },
  };
}

/**
 * The client key for rate limits, from the headers a proxy in front of the server sets:
 * the platform's own client-IP header first (Vercel's x-vercel-forwarded-for and
 * x-real-ip, which a client cannot set), then the right-most X-Forwarded-For entry, the
 * one the nearest proxy added. Entries further left are whatever the client sent.
 * Without a proxy every header can be forged.
 */
export function clientKey(h: Headers): string {
  const ip =
    h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip")?.trim() ||
    h.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return ip ? ip.slice(0, 64) : "unknown";
}
