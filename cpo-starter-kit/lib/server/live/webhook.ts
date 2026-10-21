import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IvoraEvent } from "./service";

// Copied from fleet-depot (templates share no code).

/** Reject deliveries whose timestamp is more than 5 minutes from our clock. */
export const TOLERANCE_SECONDS = 300;
/** Ivora's event bodies are small; refuse anything far larger before hashing it. */
export const MAX_BODY_BYTES = 256 * 1024;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/**
 * Verify `Ivora-Signature: t=<unix>,v1=<hex>`, where v1 is the HMAC-SHA256 of
 * "<t>.<raw body>" with the endpoint's signing secret. Several v1 entries are
 * accepted (secret rotation). Compares in constant time.
 */
export function verifyIvoraSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!header || !secret) return { ok: false, reason: "missing" };
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  if (!t || !/^\d{1,12}$/.test(t) || v1.length === 0)
    return { ok: false, reason: "malformed" };
  if (Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS)
    return { ok: false, reason: "stale" };
  const expected = createHmac("sha256", secret)
    .update(`${t}.`)
    .update(rawBody)
    .digest();
  for (const sig of v1) {
    if (!/^[0-9a-fA-F]{64}$/.test(sig)) continue;
    if (timingSafeEqual(Buffer.from(sig, "hex"), expected)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}

/** Build a header the way Ivora does; used by tests. */
export function signIvora(
  rawBody: string,
  secret: string,
  t = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

export function parseEvent(raw: string): IvoraEvent | null {
  try {
    const e = JSON.parse(raw) as Partial<IvoraEvent>;
    if (
      typeof e.id !== "string" ||
      !e.id ||
      e.id.length > 100 ||
      typeof e.type !== "string" ||
      e.type.length > 80 ||
      typeof e.data !== "object" ||
      e.data === null
    )
      return null;
    return e as IvoraEvent;
  } catch {
    return null;
  }
}
