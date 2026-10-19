import { describe, expect, it } from "vitest";
import { sign, verifySignature } from "@/lib/webhook";

describe("verifySignature", () => {
  const body = '{"type":"transaction.started"}';
  it("accepts a valid signature, with or without prefix", () => {
    const sig = sign(body, "s3cret");
    expect(verifySignature(body, sig, "s3cret")).toBe(true);
    expect(verifySignature(body, `sha256=${sig}`, "s3cret")).toBe(true);
  });
  it("rejects tampering, wrong secret, and missing inputs", () => {
    const sig = sign(body, "s3cret");
    expect(verifySignature(body + " ", sig, "s3cret")).toBe(false);
    expect(verifySignature(body, sig, "other")).toBe(false);
    expect(verifySignature(body, null, "s3cret")).toBe(false);
    expect(verifySignature(body, sig, "")).toBe(false);
  });
});
