import { describe, expect, it } from "vitest";
import {
  parseEvent,
  signIvora,
  TOLERANCE_SECONDS,
  verifyIvoraSignature,
} from "@/lib/webhook";
import { createHmac } from "node:crypto";

const secret = "whsec_test_fixed";
const body =
  '{"id":"evt_1","type":"meter.sampled","tenant_id":7,"resource_id":"31","created_at":"2026-10-01T10:00:00Z","data":{"transaction_id":31,"energy_wh":6941}}';
const t = 1_790_000_000;

describe("Ivora-Signature", () => {
  it("accepts t=,v1= with HMAC-SHA256 of '<t>.<raw body>'", () => {
    const v1 = createHmac("sha256", secret)
      .update(`${t}.${body}`)
      .digest("hex");
    expect(verifyIvoraSignature(body, `t=${t},v1=${v1}`, secret, t)).toEqual({
      ok: true,
    });
    expect(signIvora(body, secret, t)).toBe(`t=${t},v1=${v1}`);
  });
  it("accepts any matching v1 (secret rotation) and spaces after commas", () => {
    const good = signIvora(body, secret, t).split("v1=")[1];
    const header = `t=${t}, v1=${"0".repeat(64)}, v1=${good}`;
    expect(verifyIvoraSignature(body, header, secret, t).ok).toBe(true);
  });
  it("rejects a changed body, a wrong secret and a bare hex signature", () => {
    const h = signIvora(body, secret, t);
    expect(verifyIvoraSignature(body + " ", h, secret, t)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyIvoraSignature(body, h, "other", t).ok).toBe(false);
    expect(verifyIvoraSignature(body, h.split("v1=")[1], secret, t)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
  it("rejects timestamps older or newer than 5 minutes", () => {
    const h = signIvora(body, secret, t);
    expect(
      verifyIvoraSignature(body, h, secret, t + TOLERANCE_SECONDS).ok,
    ).toBe(true);
    expect(
      verifyIvoraSignature(body, h, secret, t + TOLERANCE_SECONDS + 1),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      verifyIvoraSignature(body, h, secret, t - TOLERANCE_SECONDS - 1).ok,
    ).toBe(false);
  });
  it("rejects missing header or secret", () => {
    expect(verifyIvoraSignature(body, null, secret, t)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(
      verifyIvoraSignature(body, signIvora(body, secret, t), "", t).ok,
    ).toBe(false);
  });
  it("parses the delivery body and refuses malformed JSON", () => {
    expect(parseEvent(body)?.data.energy_wh).toBe(6941);
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent('{"id":"x","type":"y"}')).toBeNull();
  });
});
