import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ApiError, DEMO_STATUS, getStatus } from "../src/lib/api";
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

  it("reports server errors and an unreachable server with a code", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test";
    fetchSpy.mockImplementation(async () => new Response("", { status: 503 }));
    await expect(getStatus()).rejects.toMatchObject({ code: "http_503" });
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
