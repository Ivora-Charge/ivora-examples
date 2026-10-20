import { beforeEach, describe, expect, it } from "vitest";
import {
  checkPassword,
  gate,
  guard,
  issueToken,
  SESSION_COOKIE,
  sameOrigin,
  verifyToken,
} from "@/lib/auth";
import { liveEnv } from "./support/fake-api";

const req = (headers: Record<string, string>, method = "POST") =>
  new Request("http://depot.example.com/api/drivers", { method, headers });

beforeEach(() => {
  liveEnv();
  process.env.OPERATOR_PASSWORD = "correct horse";
});

describe("operator gate", () => {
  it("is open in demo mode", () => {
    process.env.DEMO_MODE = "true";
    expect(gate().mode).toBe("open");
  });
  it("refuses live mode without OPERATOR_PASSWORD", async () => {
    process.env.OPERATOR_PASSWORD = "";
    expect(gate().mode).toBe("missing");
    const r = guard(
      req(
        { origin: "http://depot.example.com", host: "depot.example.com" },
        "GET",
      ),
      { write: false },
    );
    expect(r?.status).toBe(503);
  });
  it("checks the password in constant time", () => {
    expect(checkPassword("correct horse", "correct horse")).toBe(true);
    expect(checkPassword("correct hors", "correct horse")).toBe(false);
  });
  it("issues signed, expiring session tokens tied to the password", () => {
    const t = issueToken("correct horse", 0, 60);
    expect(verifyToken(t, "correct horse", 1000)).toBe(true);
    expect(verifyToken(t, "correct horse", 61_000)).toBe(false);
    expect(verifyToken(t, "other password", 1000)).toBe(false);
    const [exp, mac] = t.split(".");
    expect(
      verifyToken(`${Number(exp) + 999}.${mac}`, "correct horse", 1000),
    ).toBe(false);
    expect(verifyToken(undefined, "correct horse")).toBe(false);
  });
  it("requires a session cookie and a same-origin request for writes", () => {
    const cookie = `${SESSION_COOKIE}=${issueToken("correct horse")}`;
    const host = "depot.example.com";
    expect(
      guard(req({ host, origin: `http://${host}` }), { write: true })?.status,
    ).toBe(401);
    expect(
      guard(req({ host, origin: `http://${host}`, cookie }), { write: true }),
    ).toBeNull();
    expect(
      guard(req({ host, origin: "https://evil.example", cookie }), {
        write: true,
      })?.status,
    ).toBe(403);
    expect(guard(req({ host, cookie }), { write: true })?.status).toBe(403);
    expect(
      guard(req({ host, cookie, "sec-fetch-site": "same-origin" }), {
        write: true,
      }),
    ).toBeNull();
  });
  it("compares the Origin host with the forwarded host", () => {
    expect(
      sameOrigin(
        req({
          host: "internal:3000",
          "x-forwarded-host": "depot.example.com",
          origin: "https://depot.example.com",
        }),
      ),
    ).toBe(true);
    expect(sameOrigin(req({ host: "depot.example.com", origin: "null" }))).toBe(
      false,
    );
  });
});
