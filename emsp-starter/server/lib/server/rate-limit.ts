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
 * The client key for rate limits (the public API's, and the admin secret's).
 *
 * - TRUSTED_PROXY_HEADER, when set, names the one header your own proxy or CDN sets to
 *   the client address and callers cannot set themselves (for example
 *   `cf-connecting-ip`, or `x-forwarded-for` from a proxy that appends to it). For a
 *   comma list, the last entry is used: the one your proxy added. No other header is
 *   read, and a request without it counts as "unknown".
 * - Otherwise, the platform's own client-IP header first (Vercel's
 *   x-vercel-forwarded-for and x-real-ip, which a client cannot set there), then the
 *   right-most X-Forwarded-For entry, the one the nearest proxy added. Entries further
 *   left are whatever the client sent. Without a proxy every header can be forged, and
 *   with none of them every client is "unknown" and shares one limit.
 */
export function clientKey(
  h: Headers,
  env: Record<string, string | undefined> = process.env,
): string {
  const trusted = env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  const ip = trusted
    ? h.get(trusted)?.split(",").at(-1)?.trim()
    : h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip")?.trim() ||
      h.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return ip ? ip.slice(0, 64) : "unknown";
}
