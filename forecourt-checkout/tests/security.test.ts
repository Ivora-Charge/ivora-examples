import { describe, expect, it } from "vitest";
import { passwordMatches, signToken, verifyToken } from "@/lib/tokens";
import {
  RecentIds,
  sessionIdFromEvent,
  signIvoraBody,
  verifyIvoraSignature,
} from "@/lib/webhook";

const SECRET = "whsec_test_fixed";
const BODY =
  '{"id":"evt_1","type":"charging_session.status_changed","tenant_id":1,"data":{"session_id":"ecs_9"}}';
const NOW = Date.parse("2026-10-19T12:00:00Z");
const T = Math.floor(NOW / 1000);

describe("Ivora webhook signatures", () => {
  it("accepts a valid signature over the raw body", () => {
    expect(
      verifyIvoraSignature(SECRET, signIvoraBody(SECRET, BODY, T), BODY, NOW),
    ).toBe("ok");
  });

  it("matches the documented scheme: HMAC-SHA256 of `<t>.<body>`, hex", () => {
    // Computed independently: printf '%s' '1700000000.{}' | openssl dgst -sha256 -hmac secret
    const header =
      "t=1700000000,v1=b8569b78799ff9e3cbff0fc2d63a33a2b57f3282abd07c37ae5e8e7d79a5f163";
    expect(signIvoraBody("secret", "{}", 1700000000)).toBe(header);
    expect(verifyIvoraSignature("secret", header, "{}", 1700000000_000)).toBe(
      "ok",
    );
  });

  it("rejects a changed body, a wrong secret, or missing parts", () => {
    const header = signIvoraBody(SECRET, BODY, T);
    expect(
      verifyIvoraSignature(SECRET, header, BODY.replace("ecs_9", "ecs_8"), NOW),
    ).toBe("invalid");
    expect(verifyIvoraSignature("other", header, BODY, NOW)).toBe("invalid");
    expect(verifyIvoraSignature(SECRET, null, BODY, NOW)).toBe("invalid");
    expect(verifyIvoraSignature(SECRET, `t=${T}`, BODY, NOW)).toBe("invalid");
    expect(verifyIvoraSignature(SECRET, `t=${T},v1=zz`, BODY, NOW)).toBe(
      "invalid",
    );
    expect(verifyIvoraSignature("", header, BODY, NOW)).toBe("invalid");
  });

  it("rejects old or future timestamps", () => {
    expect(
      verifyIvoraSignature(
        SECRET,
        signIvoraBody(SECRET, BODY, T - 301),
        BODY,
        NOW,
      ),
    ).toBe("stale");
    expect(
      verifyIvoraSignature(
        SECRET,
        signIvoraBody(SECRET, BODY, T + 301),
        BODY,
        NOW,
      ),
    ).toBe("stale");
    expect(
      verifyIvoraSignature(
        SECRET,
        signIvoraBody(SECRET, BODY, T - 299),
        BODY,
        NOW,
      ),
    ).toBe("ok");
  });

  it("finds the session in charging session and bill events only", () => {
    expect(
      sessionIdFromEvent({
        type: "charging_session.status_changed",
        data: { session_id: "ecs_9" },
      }),
    ).toBe("ecs_9");
    expect(
      sessionIdFromEvent({
        type: "bill.finalized",
        data: { session: { id: "ecs_8" } },
      }),
    ).toBe("ecs_8");
    expect(
      sessionIdFromEvent({
        type: "bill.finalized",
        resource_id: "ecs_7",
        data: {},
      }),
    ).toBe("ecs_7");
    expect(
      sessionIdFromEvent({
        type: "station.connected",
        data: { session_id: "ecs_9" },
      }),
    ).toBeNull();
  });

  it("acknowledges redeliveries once", () => {
    const seen = new RecentIds(2);
    expect(seen.add("a")).toBe(true);
    expect(seen.add("a")).toBe(false);
    seen.add("b");
    seen.add("c"); // evicts "a"
    expect(seen.add("a")).toBe(true);
  });
});

describe("signed cookies", () => {
  it("round-trips and expires", () => {
    const token = signToken("s", "guest", "cs_test_1", NOW + 1000);
    expect(verifyToken("s", "guest", token, NOW)).toBe("cs_test_1");
    expect(verifyToken("s", "guest", token, NOW + 1000)).toBeNull();
  });

  it("is bound to its secret and purpose", () => {
    const token = signToken("s", "guest", "cs_test_1", NOW + 1000);
    expect(verifyToken("t", "guest", token, NOW)).toBeNull();
    expect(verifyToken("s", "operator", token, NOW)).toBeNull();
    expect(
      verifyToken("s", "guest", token.replace("cs_test_1", "cs_test_2"), NOW),
    ).toBeNull();
    expect(verifyToken("s", "guest", `${token}.x`, NOW)).toBeNull();
    expect(verifyToken("s", "guest", undefined, NOW)).toBeNull();
    expect(() => signToken("", "guest", "x", NOW)).toThrow();
  });

  it("checks the operator password in constant time and never accepts an empty one", () => {
    expect(passwordMatches("correct horse", "correct horse")).toBe(true);
    expect(passwordMatches("correct hors", "correct horse")).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
  });
});

describe("same-origin check for form posts and fetches", () => {
  const post = (headers: Record<string, string>) =>
    new Request("https://charge.example.com/api/operator/login", {
      method: "POST",
      headers,
    });

  it("trusts Sec-Fetch-Site when the browser sends it", async () => {
    const { sameOrigin } = await import("@/lib/server/http");
    expect(sameOrigin(post({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(post({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(post({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("falls back to the Origin header", async () => {
    const { sameOrigin } = await import("@/lib/server/http");
    expect(sameOrigin(post({ origin: "https://charge.example.com" }))).toBe(
      true,
    );
    expect(sameOrigin(post({ origin: "https://evil.example" }))).toBe(false);
    expect(sameOrigin(post({ origin: "null" }))).toBe(false);
    expect(sameOrigin(post({}))).toBe(true);
  });
});
