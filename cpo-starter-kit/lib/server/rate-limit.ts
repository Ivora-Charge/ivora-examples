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

/** Count an attempt against `name` for `subject`, or throw `rate_limited`. */
export async function limit(
  limiter: RateLimiter,
  secret: string,
  name: LimitName,
  subject: string,
  message = "Too many attempts. Wait a few minutes and try again.",
): Promise<void> {
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
 * The caller's address for per-source quotas. Only Vercel's own header is trusted;
 * elsewhere every caller shares one bucket and the per-account quotas do the work.
 */
export function sourceOf(headers: Headers): string {
  if (process.env.VERCEL === "1")
    return (
      headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown"
    );
  return "shared";
}
