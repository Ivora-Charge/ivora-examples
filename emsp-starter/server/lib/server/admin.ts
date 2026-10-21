import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config";

/**
 * TEMPORARY admin gate, until admin sign-in lands (part 7): every admin action asks
 * for ADMIN_SECRET. Without an ADMIN_SECRET of at least 32 characters, admin actions
 * are disabled. The comparison takes the same time whatever the input.
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
