import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { clientKey } from "./rate-limit";

/**
 * TEMPORARY admin gate, until admin sign-in lands (part 7): every admin action asks
 * for ADMIN_SECRET. Without an ADMIN_SECRET of at least 32 characters, admin actions
 * are disabled. The comparison takes the same time whatever the input.
 *
 * Wrong secrets are rate limited: 5 per client and 50 in total per 15 minutes. While
 * limited, the secret is not even compared. The counts live in this server process, so
 * each instance counts on its own; part 7 replaces all of this.
 */
export function adminEnabled(): boolean {
  return config.adminSecret !== undefined;
}

export function isAdminSecret(input: unknown): boolean {
  const secret = config.adminSecret;
  if (!secret || typeof input !== "string" || !input) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(input), digest(secret));
}

export const ADMIN_LIMIT = {
  windowMs: 15 * 60 * 1000,
  perClient: 5,
  total: 50,
} as const;

const ALL = "*";
/** Times of recent wrong secrets, by client and in total. At most `total` entries. */
const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const kept = (failures.get(key) ?? []).filter(
    (t) => now - t < ADMIN_LIMIT.windowMs,
  );
  if (kept.length) failures.set(key, kept);
  else failures.delete(key);
  return kept;
}

/**
 * Checks an admin secret for `client` (an IP address, or "unknown"), counting wrong
 * ones. "limited" means too many wrong secrets lately: try again later.
 */
export function checkAdminSecret(
  input: unknown,
  client: string,
  now = Date.now(),
): "ok" | "wrong" | "limited" {
  const key = `client:${client}`;
  if (failures.size > 4 * ADMIN_LIMIT.total)
    for (const k of [...failures.keys()]) recent(k, now);
  if (
    recent(key, now).length >= ADMIN_LIMIT.perClient ||
    recent(ALL, now).length >= ADMIN_LIMIT.total
  )
    return "limited";
  if (isAdminSecret(input)) return "ok";
  for (const k of [key, ALL]) failures.set(k, [...recent(k, now), now]);
  return "wrong";
}

/** The client key for the admin-secret rate limit: see clientKey. */
export const adminClientKey = clientKey;

export function resetAdminLimitForTests() {
  failures.clear();
}
