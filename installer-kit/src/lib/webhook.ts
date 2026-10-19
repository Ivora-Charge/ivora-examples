import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 over the raw body, hex encoded. Adjust header name per portal docs. */
export function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const a = Buffer.from(signBody(body, secret));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
