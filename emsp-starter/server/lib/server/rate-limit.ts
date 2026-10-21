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
 * The caller's address for per-client limits, or null when no trusted header says it.
 * Same rule as the CPO Starter Kit's `sourceOf`.
 *
 * - TRUSTED_PROXY_HEADER names a header that your own proxy or CDN sets to the client
 *   address and that callers cannot set themselves (for example `cf-connecting-ip`,
 *   `x-real-ip`, or `x-forwarded-for` from a proxy that appends to it). For a comma
 *   list, the last entry is used: the one your proxy added. No other header is read.
 * - On Vercel (VERCEL=1), without it, Vercel's own `x-vercel-forwarded-for`.
 * - Otherwise null: no per-client key. A raw `x-forwarded-for` or `x-real-ip` is never
 *   used, because a caller can send any value and get a fresh quota each time.
 */
export function clientAddress(
  h: Headers,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const name = env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  let ip: string | undefined;
  if (name) ip = h.get(name)?.split(",").at(-1)?.trim();
  else if (env.VERCEL === "1")
    ip = h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  return ip ? ip.slice(0, 64) : null;
}

/**
 * The key for the public API's per-client limit: the client address, or one shared key
 * without a trusted address, so a forged header never gets a fresh quota.
 */
export function clientKey(
  h: Headers,
  env: Record<string, string | undefined> = process.env,
): string {
  return clientAddress(h, env) ?? "unknown";
}
