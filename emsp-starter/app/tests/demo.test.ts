import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ApiError,
  DEMO_CODE,
  DEMO_STATUS,
  getLocation,
  getStatus,
  requestCode,
  searchLocations,
  SAMPLE_LOCATIONS,
  verifyCode,
} from "../src/lib/api";
import { NO_FILTERS } from "../src/lib/search";
import { config, isOfflineDemo } from "../src/lib/config";

const VARS = ["EXPO_PUBLIC_API_URL", "EXPO_PUBLIC_DEMO_MODE"];

describe("app demo mode", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of VARS) delete process.env[k];
    // The offline demo must never reach the network: any fetch fails the test.
    fetchSpy = vi.fn(() => {
      throw new Error("offline demo must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("is on with no server URL, an empty one, or when forced", () => {
    expect(isOfflineDemo()).toBe(true);
    process.env.EXPO_PUBLIC_API_URL = "  ";
    expect(isOfflineDemo()).toBe(true);
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test/";
    expect(isOfflineDemo()).toBe(false);
    expect(config.apiUrl).toBe("https://emsp.example.test");
    for (const on of ["true", "1", "yes", "On"]) {
      process.env.EXPO_PUBLIC_DEMO_MODE = on;
      expect(isOfflineDemo()).toBe(true);
    }
    process.env.EXPO_PUBLIC_DEMO_MODE = "false";
    expect(isOfflineDemo()).toBe(false);
  });

  it("serves sample data without any network request", async () => {
    expect(await getStatus()).toEqual(DEMO_STATUS);
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test";
    process.env.EXPO_PUBLIC_DEMO_MODE = "1";
    expect(await getStatus()).toEqual(DEMO_STATUS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("searches, shows chargers and signs in offline, sending nothing", async () => {
    const found = await searchLocations({
      text: "station",
      filters: NO_FILTERS,
    });
    expect(found.mode).toBe("demo");
    expect(found.items.map((l) => l.name)).toContain("Station Square");
    const detail = await getLocation(found.items[0].id);
    expect(detail.evses.length).toBeGreaterThan(0);
    await expect(getLocation("nope")).rejects.toMatchObject({
      code: "not_found",
    });

    await requestCode("driver@example.com");
    await expect(requestCode("not an email")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      verifyCode("driver@example.com", "123456"),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
    const { driver, session } = await verifyCode(
      "Driver@Example.com",
      DEMO_CODE,
    );
    expect(driver).toMatchObject({ email: "driver@example.com", mode: "demo" });
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks only its own server when a URL is set", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test";
    const live = { ...DEMO_STATUS, mode: "live", name: "Example" };
    fetchSpy.mockImplementation(async () => Response.json(live));
    expect(await getStatus()).toEqual(live);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://emsp.example.test/api/v1/status",
      expect.anything(),
    );
  });

  it("signs in against the server, with the same answer for every address", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test";
    fetchSpy.mockImplementation(
      async () => new Response(null, { status: 202 }),
    );
    await requestCode(" Driver@Example.com ");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://emsp.example.test/api/v1/auth/code");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "driver@example.com",
    });

    fetchSpy.mockImplementation(
      async () =>
        new Response("{}", { status: 429, headers: { "Retry-After": "120" } }),
    );
    await expect(
      verifyCode("driver@example.com", "123456"),
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryAfter: 120,
    });

    const session = {
      accessToken: "a".repeat(20),
      refreshToken: "r",
      expiresAt: "2030-01-01T00:00:00Z",
    };
    fetchSpy.mockImplementation(async () =>
      Response.json({
        session,
        driver: { id: "d1", email: "driver@example.com" },
      }),
    );
    expect((await verifyCode("driver@example.com", "123 456")).session).toEqual(
      session,
    );
    expect(
      JSON.parse(
        (fetchSpy.mock.calls.at(-1) as [string, RequestInit])[1].body as string,
      ),
    ).toEqual({
      email: "driver@example.com",
      code: "123456",
    });
  });

  it("searches the server's location API with the filters", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test";
    fetchSpy.mockImplementation(async () =>
      Response.json({
        mode: "live",
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      }),
    );
    await searchLocations({
      text: "market",
      filters: { ...NO_FILTERS, price: "free" },
    });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://emsp.example.test/api/v1/locations?q=market&price=free&limit=100",
    );
  });

  it("reports server errors and an unreachable server with a code", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test";
    fetchSpy.mockImplementation(async () => new Response("", { status: 503 }));
    await expect(getStatus()).rejects.toMatchObject({ code: "http_503" });
    expect(SAMPLE_LOCATIONS.length).toBeGreaterThan(0);
    fetchSpy.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    await expect(getStatus()).rejects.toBeInstanceOf(ApiError);
    await expect(getStatus()).rejects.toMatchObject({ code: "unreachable" });
  });
});

const root = join(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

describe("app source rules", () => {
  it("only src/lib/api.ts makes network requests", () => {
    const offenders = files(join(root, "src"))
      .map((f) => relative(root, f))
      .filter((f) => f !== join("src", "lib", "api.ts"))
      .filter((f) =>
        /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/.test(
          readFileSync(join(root, f), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("takes every colour from the brand tokens", () => {
    const offenders = files(join(root, "src"))
      .map((f) => relative(root, f))
      .filter((f) =>
        /["']#[0-9a-f]{3,8}["']|rgba?\(|hsla?\(/i.test(
          readFileSync(join(root, f), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps the offline demo identity in step with the server's demo identity", () => {
    const server = readFileSync(
      join(root, "../server/lib/server/config.ts"),
      "utf8",
    );
    expect(server).toContain(
      `DEMO_PARTY = { countryCode: "${DEMO_STATUS.ocpi.country_code}", partyId: "${DEMO_STATUS.ocpi.party_id}" }`,
    );
  });
});
