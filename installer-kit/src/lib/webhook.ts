import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/** HMAC-SHA256 of "<t>.<raw body>", hex encoded. */
export function webhookDigest(secret: string, t: string, body: string) {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

/** Build an Ivora-Signature header value (used by tests and local tools). */
export function signWebhook(secret: string, body: string, nowMs = Date.now()) {
  const t = String(Math.floor(nowMs / 1000));
  return `t=${t},v1=${webhookDigest(secret, t, body)}`;
}

/**
 * Verify `Ivora-Signature: t=<unix>,v1=<hex>` over the raw body bytes, in
 * constant time, rejecting timestamps more than five minutes away.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string | null,
  body: string,
  nowMs = Date.now(),
): "ok" | "invalid" | "stale" {
  if (!secret || !header) return "invalid";
  const parts = new Map<string, string[]>();
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    parts.set(k, [...(parts.get(k) ?? []), part.slice(i + 1).trim()]);
  }
  const t = parts.get("t")?.[0];
  if (!t || !/^\d{1,12}$/.test(t)) return "invalid";
  const expected = Buffer.from(webhookDigest(secret, t, body), "utf8");
  // Several v1 values may be present while a secret is being rotated.
  const valid = (parts.get("v1") ?? []).some((v) => {
    if (!/^[a-f0-9]{64}$/i.test(v)) return false;
    return timingSafeEqual(expected, Buffer.from(v.toLowerCase(), "utf8"));
  });
  if (!valid) return "invalid";
  if (Math.abs(nowMs / 1000 - Number(t)) > WEBHOOK_TOLERANCE_SECONDS)
    return "stale";
  return "ok";
}

/** Remembers recent event IDs so at-least-once redeliveries are processed once. */
export class EventDeduper {
  private seen = new Set<string>();
  constructor(private capacity = 5000) {}
  /** Returns false if the ID was already seen. */
  add(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}
