import { afterEach, describe, expect, it } from "vitest";
import {
  parseCredentials,
  parseEnvelope,
  parseVersionDetails,
  parseVersions,
} from "@/lib/ocpi/schema";
import {
  authorizationHeader,
  decryptToken,
  encryptToken,
  generateToken,
  hashToken,
  tokensFromHeader,
} from "@/lib/ocpi/tokens";
import { configErrors } from "@/lib/server/config";
import { LIVE_ENV } from "./support/network";

const ROLE = {
  role: "CPO",
  party_id: "mck",
  country_code: "zz",
  business_details: {
    name: "Mock CPO",
    website: "https://cpo.example.test",
    logo: {
      url: "https://cpo.example.test/logo.png",
      category: "OPERATOR",
      type: "png",
      width: 64,
    },
  },
};
const CREDS = {
  token: "abc",
  url: "https://cpo.example.test/ocpi/versions",
  roles: [ROLE],
};

describe("2.2.1 schema", () => {
  it("accepts valid credentials, upper-cases CiStrings and drops unknown fields", () => {
    const r = parseCredentials({
      ...CREDS,
      extra: 1,
      roles: [{ ...ROLE, x: 1 }],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        ...CREDS,
        roles: [{ ...ROLE, party_id: "MCK", country_code: "ZZ" }],
      },
    });
  });

  it("rejects invalid credentials, naming fields but not values", () => {
    const bad = [
      { ...CREDS, token: "x".repeat(65) },
      { ...CREDS, token: "has space" },
      { ...CREDS, url: "http://cpo.example.test/ocpi/versions" },
      { ...CREDS, url: "https://user:pw@cpo.example.test/" },
      { ...CREDS, roles: [] },
      { ...CREDS, roles: [{ ...ROLE, role: "DRIVER" }] },
      { ...CREDS, roles: [{ ...ROLE, country_code: "NLD" }] },
      { ...CREDS, roles: [{ ...ROLE, party_id: "AB" }] },
      { ...CREDS, roles: [{ ...ROLE, business_details: {} }] },
      { ...CREDS, roles: [ROLE, ROLE] },
      { token: "abc", url: CREDS.url },
      null,
      [],
    ];
    for (const b of bad) {
      const r = parseCredentials(b);
      expect(r.ok, JSON.stringify(b)).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).not.toContain("NLD");
    }
  });

  it("validates versions and version details", () => {
    expect(
      parseVersions([
        { version: "2.2.1", url: "https://cpo.example.test/2.2.1" },
      ]).ok,
    ).toBe(true);
    expect(parseVersions([]).ok).toBe(false);
    expect(parseVersions([{ version: "two", url: "https://a.test" }]).ok).toBe(
      false,
    );
    const details = {
      version: "2.2.1",
      endpoints: [
        { identifier: "credentials", role: "SENDER", url: "https://a.test/c" },
      ],
    };
    expect(parseVersionDetails(details).ok).toBe(true);
    expect(
      parseVersionDetails({
        ...details,
        endpoints: [{ ...details.endpoints[0], role: "BOTH" }],
      }).ok,
    ).toBe(false);
    expect(
      parseVersionDetails({
        ...details,
        endpoints: [{ ...details.endpoints[0], identifier: "Bad Module" }],
      }).ok,
    ).toBe(false);
  });

  it("requires status_code and timestamp in the envelope", () => {
    expect(
      parseEnvelope({ status_code: 1000, timestamp: "2026-10-21T00:00:00Z" })
        .ok,
    ).toBe(true);
    expect(parseEnvelope({ status_code: 1000 }).ok).toBe(false);
    expect(
      parseEnvelope({ status_code: 10, timestamp: "2026-10-21T00:00:00Z" }).ok,
    ).toBe(false);
    expect(parseEnvelope("ok").ok).toBe(false);
  });
});

describe("tokens", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("generates 43-character random tokens and hashes them", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads base64 and unencoded tokens from the Authorization header", () => {
    const t = "my-token";
    expect(tokensFromHeader(authorizationHeader(t))).toContain(t);
    expect(tokensFromHeader(`Token ${t}`)).toEqual([t]);
    expect(tokensFromHeader("token  " + t)).toEqual([t]);
    expect(tokensFromHeader(`Bearer ${t}`)).toEqual([]);
    expect(tokensFromHeader(null)).toEqual([]);
    expect(tokensFromHeader("Token a b")).toEqual([]);
  });

  it("encrypts peer tokens, bound to the peer", () => {
    Object.assign(process.env, LIVE_ENV);
    const ct = encryptToken("peer-token", "peer-1");
    expect(ct).toMatch(/^v1:/);
    expect(ct).not.toContain("peer-token");
    expect(encryptToken("peer-token", "peer-1")).not.toBe(ct);
    expect(decryptToken(ct, "peer-1")).toBe("peer-token");
    expect(() => decryptToken(ct, "peer-2")).toThrow("could not be decrypted");
    const [v, iv, data, tag] = ct.split(":");
    const flipped = Buffer.from(data, "base64url");
    flipped[0] ^= 1;
    expect(() =>
      decryptToken(
        [v, iv, flipped.toString("base64url"), tag].join(":"),
        "peer-1",
      ),
    ).toThrow("could not be decrypted");
    // Another key cannot read it.
    process.env.OCPI_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString(
      "base64",
    );
    expect(() => decryptToken(ct, "peer-1")).toThrow("could not be decrypted");
  });

  it("requires a 32-byte encryption key in live mode", () => {
    Object.assign(process.env, LIVE_ENV, {
      OCPI_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64"),
    });
    expect(configErrors()).toEqual([
      "OCPI_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded",
    ]);
  });
});
