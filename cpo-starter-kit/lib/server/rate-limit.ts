import "server-only";
import { createHmac } from "node:crypto";
import { TeamError } from "./team/types";

/**
 * Fixed-window quotas for sign-in, setup and invites. Subjects (email addresses, IP
 * addresses, user IDs) are HMAC'd before they are stored or compared, so the store
 * never holds them in plain text.
 */
export interface RateLimiter {
  /** True when the attempt fits the quota, and counts it. */
  take(key: string, quota: number, periodSeconds: number): Promise<boolean>;
}

export function digest(secret: string, subject: string): string {
  return createHmac("sha256", secret).update(subject).digest("hex");
}

/** In-process quotas: demo mode and tests. */
export function createMemoryLimiter(now = () => Date.now()): RateLimiter {
  const windows = new Map<string, { attempts: number; resetsAt: number }>();
  return {
    async take(key, quota, periodSeconds) {
      const t = now();
      const w = windows.get(key);
      if (!w || w.resetsAt <= t) {
        windows.set(key, { attempts: 1, resetsAt: t + periodSeconds * 1000 });
        return true;
      }
      if (w.attempts >= quota) return false;
      w.attempts++;
      return true;
    },
  };
}

/** The quotas, in one place. */
export const LIMITS = {
  passwordSource: { quota: 30, periodSeconds: 600 },
  passwordAccount: { quota: 10, periodSeconds: 600 },
  linkSource: { quota: 10, periodSeconds: 600 },
  linkRecipient: { quota: 1, periodSeconds: 60 },
  setupSource: { quota: 10, periodSeconds: 600 },
  acceptSource: { quota: 20, periodSeconds: 600 },
  inviteActor: { quota: 20, periodSeconds: 3600 },
  inviteRecipient: { quota: 3, periodSeconds: 3600 },
} as const;

export type LimitName = keyof typeof LIMITS;

/**
 * Count an attempt against `name` for `subject`, or throw `rate_limited`. A null
 * subject (no trusted client address, see sourceOf) skips the quota.
 */
export async function limit(
  limiter: RateLimiter,
  secret: string,
  name: LimitName,
  subject: string | null,
  message = "Too many attempts. Wait a few minutes and try again.",
): Promise<void> {
  if (subject === null) return;
  const { quota, periodSeconds } = LIMITS[name];
  if (
    !(await limiter.take(
      `${name}:${digest(secret, subject)}`,
      quota,
      periodSeconds,
    ))
  )
    throw new TeamError("rate_limited", message);
}

/**
 * The caller's address for per-source quotas, or null when no trusted header says it.
 *
 * - TRUSTED_PROXY_HEADER names a header that your own proxy or CDN sets to the client
 *   address and that callers can't set themselves (for example `cf-connecting-ip`,
 *   `x-real-ip`, or `x-forwarded-for` from a proxy that appends to it). For a comma
 *   list, the last entry is used: the one your proxy added.
 * - On Vercel, without it, Vercel's own `x-vercel-forwarded-for`.
 * - Otherwise null: per-source quotas are skipped rather than shared, so one client
 *   can't lock everyone out. The per-account quotas still apply.
 */
export function sourceOf(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const name = env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (name) {
    const parts = (headers.get(name) ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.at(-1) ?? null;
  }
  if (env.VERCEL === "1")
    return headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || null;
  return null;
}
