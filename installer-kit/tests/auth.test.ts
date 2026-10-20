import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  authorized,
  checkPassword,
  gate,
  issueToken,
  requireOperator,
  sameOrigin,
  verifyToken,
} from "@/lib/server/auth";

const LIVE = { IVORA_API_KEY: "k", IVORA_TENANT_ID: "42" };
const PW = "correct horse battery";

describe("operator gate", () => {
  it("refuses live mode without an operator password", () => {
    expect(gate(LIVE).mode).toBe("missing");
    expect(authorized(undefined, LIVE)).toBe(false);
  });

  it("refuses a short password in any mode", () => {
    expect(gate({ ...LIVE, OPERATOR_PASSWORD: "short" }).mode).toBe("missing");
    expect(gate({ OPERATOR_PASSWORD: "short" }).mode).toBe("missing");
  });

  it("leaves demo open unless a password is set", () => {
    expect(gate({}).mode).toBe("open");
    expect(authorized(undefined, {})).toBe(true);
    expect(gate({ OPERATOR_PASSWORD: PW }).mode).toBe("password");
  });

  it("checks passwords in constant time", () => {
    expect(checkPassword(PW, PW)).toBe(true);
    expect(checkPassword("wrong", PW)).toBe(false);
    expect(checkPassword("", PW)).toBe(false);
  });
});

describe("session token", () => {
  const now = Date.UTC(2026, 9, 19, 12);

  it("verifies a token signed with the current password", () => {
    const token = issueToken(PW, now);
    expect(verifyToken(token, PW, now)).toBe(true);
    // authorized() checks against the real clock.
    expect(authorized(issueToken(PW), { ...LIVE, OPERATOR_PASSWORD: PW })).toBe(
      true,
    );
    expect(authorized(undefined, { ...LIVE, OPERATOR_PASSWORD: PW })).toBe(
      false,
    );
  });

  it("rejects tampered, expired or re-keyed tokens", () => {
    const token = issueToken(PW, now);
    const [exp, mac] = token.split(".");
    expect(verifyToken(`${Number(exp) + 1}.${mac}`, PW, now)).toBe(false);
    expect(verifyToken(token, PW, now + 13 * 3600_000)).toBe(false);
    expect(verifyToken(token, "a different password", now)).toBe(false);
    expect(verifyToken("garbage", PW, now)).toBe(false);
    expect(verifyToken(undefined, PW, now)).toBe(false);
  });
});

describe("request checks", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const req = (headers: Record<string, string>, method = "POST") =>
    new Request("http://charge.example.com/api/sites", { method, headers });

  it("requires a same-origin Origin header on writes", () => {
    expect(
      sameOrigin(
        req({
          origin: "http://charge.example.com",
          host: "charge.example.com",
        }),
      ),
    ).toBe(true);
    expect(
      sameOrigin(
        req({ origin: "https://evil.example", host: "charge.example.com" }),
      ),
    ).toBe(false);
    expect(sameOrigin(req({ host: "charge.example.com" }))).toBe(false);
    expect(
      sameOrigin(
        req({
          origin: "https://charge.example.com",
          host: "internal:3000",
          "x-forwarded-host": "charge.example.com",
        }),
      ),
    ).toBe(true);
  });

  it("guards routes by cookie, origin and configuration", () => {
    Object.assign(process.env, LIVE);
    delete process.env.OPERATOR_PASSWORD;
    expect(() => requireOperator(req({}), { write: false })).toThrow(
      /OPERATOR_PASSWORD/,
    );

    process.env.OPERATOR_PASSWORD = PW;
    expect(() => requireOperator(req({}, "GET"), { write: false })).toThrow(
      /Sign in/,
    );
    const cookie = `${SESSION_COOKIE}=${issueToken(PW)}`;
    const host = "charge.example.com";
    expect(() =>
      requireOperator(req({ cookie, host }, "GET"), { write: false }),
    ).not.toThrow();
    expect(() =>
      requireOperator(req({ cookie, host, origin: "https://evil.example" }), {
        write: true,
      }),
    ).toThrow(/installer kit itself/);
    expect(() =>
      requireOperator(req({ cookie, host, origin: `http://${host}` }), {
        write: true,
      }),
    ).not.toThrow();
  });
});
