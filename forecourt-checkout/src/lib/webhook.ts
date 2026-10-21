import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Ivora signs deliveries with `Ivora-Signature: t=<unix seconds>,v1=<hex>`,
 * where v1 is HMAC-SHA256 of `<t>.<raw body>` with the endpoint's secret.
 */
export function verifyIvoraSignature(
  secret: string,
  header: string | null,
  body: string,
  now = Date.now(),
): "ok" | "invalid" | "stale" {
  if (!secret || !header) return "invalid";
  const parts = new Map<string, string>();
  for (const part of header.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    if (key && rest.length) parts.set(key, rest.join("="));
  }
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1 || !/^\d+$/.test(t) || !/^[a-f0-9]{64}$/i.test(v1))
    return "invalid";
  const expected = createHmac("sha256", secret)
    .update(`${t}.${body}`)
    .digest("hex");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(v1.toLowerCase())))
    return "invalid";
  if (Math.abs(now / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECONDS)
    return "stale";
  return "ok";
}

/** Test helper and documentation of the scheme. */
export function signIvoraBody(secret: string, body: string, t: number) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/** Ivora session ID carried by a charging session or bill event, if any. */
export function sessionIdFromEvent(event: {
  type: string;
  resource_id?: string | null;
  data?: Record<string, unknown>;
}): string | null {
  if (
    event.type !== "charging_session.status_changed" &&
    event.type !== "bill.finalized"
  )
    return null;
  const data = (event.data ?? {}) as {
    session_id?: unknown;
    session?: { id?: unknown };
  };
  const id = data.session_id ?? data.session?.id ?? null;
  if (typeof id === "string" && id) return id;
  const resource = event.resource_id;
  return typeof resource === "string" && resource.startsWith("ecs_")
    ? resource
    : null;
}

const positiveInt = (v: unknown) => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * A meter.sampled event's transaction and station, for the prepaid stop
 * check. Null for any other event.
 */
export function meterSampleFromEvent(event: {
  type: string;
  resource_id?: string | null;
  station_id?: number | null;
  data?: Record<string, unknown>;
}): { transactionId: number | null; stationId: number | null } | null {
  if (event.type !== "meter.sampled") return null;
  const data = event.data ?? {};
  return {
    transactionId:
      positiveInt(data.transaction_id) ?? positiveInt(event.resource_id),
    stationId: positiveInt(event.station_id) ?? positiveInt(data.station_id),
  };
}

/** Remembers recent event IDs so a redelivery is acknowledged without work. */
export class RecentIds {
  private readonly seen = new Map<string, number>();
  constructor(private readonly limit = 1000) {}
  /** True the first time an ID is seen. */
  add(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.set(id, Date.now());
    if (this.seen.size > this.limit) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}
