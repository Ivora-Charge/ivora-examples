import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  assertLive,
  DemoModeError,
  isDemo,
  mode,
  outboundFetch,
} from "@/lib/server/demo";
import { configErrors, missingForLive } from "@/lib/server/config";
import { GET } from "@/app/api/v1/status/route";
import { peerFetch, setPeerNetworkForTests } from "@/lib/server/peer-fetch";

const LIVE = {
  EMSP_COUNTRY_CODE: "nl",
  EMSP_PARTY_ID: "abc",
  PUBLIC_BASE_URL: "https://emsp.example.test",
  SUPABASE_URL: "https://db.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  OCPI_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const VARS = [...Object.keys(LIVE), "DEMO_MODE"];

describe("demo mode", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of VARS) delete process.env[k];
    // Demo mode must never reach the network: any fetch fails the test.
    fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("is on with no credentials, with any one missing or empty, and when forced", () => {
    expect(isDemo()).toBe(true);
    expect(missingForLive()).toEqual(Object.keys(LIVE));
    Object.assign(process.env, LIVE);
    expect(isDemo()).toBe(false);
    expect(mode()).toBe("live");
    for (const name of Object.keys(LIVE)) {
      // `demo` is the Deploy to Vercel form's "not yet" (README: Deploy).
      for (const unset of ["  ", "demo", " Demo "]) {
        process.env[name] = unset;
        expect(isDemo()).toBe(true);
        expect(missingForLive()).toEqual([name]);
        expect(configErrors()).toEqual([]);
      }
      process.env[name] = LIVE[name as keyof typeof LIVE];
    }
    for (const on of ["true", "1", "yes", "on", " TRUE "]) {
      process.env.DEMO_MODE = on;
      expect(isDemo()).toBe(true);
    }
    process.env.DEMO_MODE = "false";
    expect(isDemo()).toBe(false);
  });

  it("stays on when a set value is invalid, naming the variable but not its value", () => {
    Object.assign(process.env, LIVE, {
      EMSP_COUNTRY_CODE: "NLD",
      PUBLIC_BASE_URL: "http://emsp.example.test",
    });
    expect(isDemo()).toBe(true);
    const errors = configErrors();
    expect(errors).toHaveLength(2);
    expect(errors.join(" ")).not.toContain("NLD");
    expect(errors.join(" ")).not.toContain("emsp.example.test");
  });

  it("refuses every outbound request and action without calling fetch", async () => {
    await expect(
      outboundFetch("https://cpo.example.test/ocpi/versions?token=x"),
    ).rejects.toBeInstanceOf(DemoModeError);
    await expect(
      outboundFetch("https://cpo.example.test/ocpi/versions?token=x"),
    ).rejects.toThrow(
      "Demo mode: refused to send a request to cpo.example.test",
    );
    expect(() => assertLive("charge a card")).toThrow(DemoModeError);
    // Forced demo wins over complete credentials.
    Object.assign(process.env, LIVE, { DEMO_MODE: "true" });
    await expect(
      outboundFetch("https://cpo.example.test/ocpi/versions"),
    ).rejects.toBeInstanceOf(DemoModeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves the status API offline, labelled demo, with no secrets", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: "demo",
      name: expect.any(String),
      ocpi: { version: "2.2.1", country_code: "ZZ", party_id: "DMO" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports the configured OCPI identity in live mode, still without secrets", async () => {
    Object.assign(process.env, LIVE);
    const body = await GET().text();
    expect(JSON.parse(body)).toMatchObject({
      mode: "live",
      ocpi: { country_code: "NL", party_id: "ABC" },
    });
    expect(body).not.toContain(LIVE.SUPABASE_SERVICE_ROLE_KEY);
    expect(body).not.toContain(LIVE.SUPABASE_URL);
  });

  it("lets outboundFetch through only in live mode", async () => {
    Object.assign(process.env, LIVE);
    fetchSpy.mockImplementation(async () => new Response("ok"));
    const res = await outboundFetch("https://cpo.example.test/ocpi/versions");
    expect(await res.text()).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("outbound requests have one gate", () => {
  const root = join(__dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
    });

  // demo.ts: outboundFetch. peer-fetch.ts: peerFetch, which calls assertLive first.
  const gates = [
    join("lib", "server", "demo.ts"),
    join("lib", "server", "peer-fetch.ts"),
  ];

  it("no server or app code sends requests except the two gate files", () => {
    const offenders = [...files(join(root, "app")), ...files(join(root, "lib"))]
      .map((f) => relative(root, f))
      .filter((f) => !gates.includes(f))
      .filter((f) =>
        /\bfetch\s*\(|(?:from\s+|require\s*\(\s*|import\s*\(\s*)["'](?:node:)?(?:https?|http2|net|tls|dgram|dns|undici)(?:\/[\w/]*)?["']|\bundici\b|\bXMLHttpRequest\b|\bWebSocket\b/.test(
          readFileSync(join(root, f), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("peerFetch refuses in demo mode before resolving anything", async () => {
    const resolve = vi.fn(async () => [
      { address: "93.184.215.14", family: 4 },
    ]);
    const send = vi.fn(async () => new Response("ok"));
    setPeerNetworkForTests({ resolve, send });
    try {
      for (const v of Object.keys(LIVE)) delete process.env[v];
      await expect(
        peerFetch("https://cpo.example.test/ocpi/versions"),
      ).rejects.toBeInstanceOf(DemoModeError);
      expect(resolve).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      setPeerNetworkForTests(undefined);
    }
  });
});
