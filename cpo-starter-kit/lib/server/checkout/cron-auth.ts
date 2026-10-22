import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of `Authorization: Bearer <CRON_SECRET>` for the settlement
 * sweep. A secret shorter than 32 characters turns the sweep off.
 */
export function cronAuthorized(header: string | null, secret: string): boolean {
  if (secret.length < 32 || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
