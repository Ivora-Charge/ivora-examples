import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Generator, NewValue } from "@/app/admin/setup/generate";
import { GET as runJob } from "@/app/api/cron/ocpi-sync/route";
import { decryptToken, encryptToken } from "@/lib/ocpi/tokens";
import {
  ADMIN_SECRET_MIN_LENGTH,
  config,
  configErrors,
  missingForLive,
} from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { GENERATED_SETTINGS, generateSetting } from "@/lib/setup/generate";
import { LIVE_ENV } from "./support/network";

/** The Setup page's generator: values the server accepts, that it is never sent. */
const saved = { ...process.env };
const fetched = vi.fn(async () => {
  throw new Error("the generator must send nothing");
});

beforeEach(() => {
  fetched.mockClear();
  vi.stubGlobal("fetch", fetched);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

/** `count` new values of one setting. */
const many = (name: (typeof GENERATED_SETTINGS)[number], count = 200) =>
  Array.from({ length: count }, () => generateSetting(name));

describe("generated values", () => {
  it("are made for exactly the encryption key and the job's secret", () => {
    expect([...GENERATED_SETTINGS]).toEqual([
      "OCPI_TOKEN_ENCRYPTION_KEY",
      "CRON_SECRET",
    ]);
  });

  it("the key is 32 bytes in base64, which the server's own check takes", () => {
    Object.assign(process.env, LIVE_ENV, { DEMO_MODE: "" });
    for (const value of many("OCPI_TOKEN_ENCRYPTION_KEY")) {
      process.env.OCPI_TOKEN_ENCRYPTION_KEY = value;
      expect(value).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(config.tokenEncryptionKey?.length).toBe(32);
      // Exactly what was made: nothing is dropped in decoding.
      expect(config.tokenEncryptionKey?.toString("base64")).toBe(value);
      expect(configErrors()).toEqual([]);
    }
    expect(missingForLive()).toEqual([]);
    expect(isDemo()).toBe(false);
    // And it works for what it is for: a peer's token, stored and read back.
    const stored = encryptToken("peer-token", "peer-1");
    expect(stored).not.toContain("peer-token");
    expect(decryptToken(stored, "peer-1")).toBe("peer-token");
  });

  it("the job's secret is long enough, header-safe, and opens the job", async () => {
    Object.assign(process.env, { DEMO_MODE: "true" });
    for (const value of many("CRON_SECRET")) {
      process.env.CRON_SECRET = value;
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(value.length).toBeGreaterThanOrEqual(ADMIN_SECRET_MIN_LENGTH);
      expect(config.cronSecret).toBe(value);
    }
    const call = (secret: string) =>
      runJob(
        new Request("http://localhost/api/cron/ocpi-sync", {
          headers: { Authorization: `Bearer ${secret}` },
        }),
      );
    expect((await call(process.env.CRON_SECRET!)).status).toBe(200);
    expect((await call(generateSetting("CRON_SECRET"))).status).toBe(401);
  });

  it("come from Web Crypto, 32 random bytes each, and never repeat", () => {
    for (const name of GENERATED_SETTINGS)
      expect(new Set(many(name)).size, name).toBe(200);
    // Bytes whose base64 has both `+` and `/`.
    const random = vi.fn((bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 2 ? 0xff : 0xfb;
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues: random });
    const key = generateSetting("OCPI_TOKEN_ENCRYPTION_KEY");
    const secret = generateSetting("CRON_SECRET");
    expect(random).toHaveBeenCalledTimes(2);
    for (const [into] of random.mock.calls) expect(into.byteLength).toBe(32);
    expect(key).toMatch(/\+/);
    expect(key).toMatch(/\//);
    expect(secret).toBe(
      key.replaceAll("+", "-").replaceAll("/", "_").replace("=", ""),
    );
  });
});

describe("nothing of a value reaches the server", () => {
  it("making one sends and logs nothing", () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    for (const name of GENERATED_SETTINGS) generateSetting(name);
    expect(fetched).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  // e2e/generate.spec.ts watches a browser's requests; this holds the code to it.
  const source = (path: string) =>
    readFileSync(join(__dirname, "..", path), "utf8");
  const imports = (code: string) =>
    [...code.matchAll(/^import\b[^;]*?from "([^"]+)";/gms)].map((m) => m[1]);

  it("the code that holds a value has no way to send or keep one", () => {
    const maker = source("lib/setup/generate.ts");
    const view = source("app/admin/setup/generate.tsx");
    expect(imports(maker)).toEqual([]);
    // No server action, store or router: React, the maker and two shared pieces.
    expect(imports(view)).toEqual([
      "react",
      "@/lib/setup/generate",
      "../ui/kit",
      "../ui/parts",
    ]);
    expect(view).toMatch(/^"use client";/);
    for (const code of [maker, view])
      expect(code).not.toMatch(
        /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|Storage\b|indexedDB|document\.cookie|console\.|<form|action=|href=|history\.|location\./,
      );
  });

  it("only the Setup page's client code makes values: no server code does", () => {
    const users = ["app", "lib"].flatMap((dir) =>
      readdirSync(join(__dirname, "..", dir), {
        recursive: true,
        encoding: "utf8",
      })
        .map((file) => `${dir}/${file}`)
        .filter(
          (path) =>
            /\.tsx?$/.test(path) &&
            imports(source(path)).some((from) => /\/generate$/.test(from)),
        ),
    );
    expect(users.sort()).toEqual([
      "app/admin/setup/generate.tsx",
      "app/admin/setup/setup.tsx",
    ]);
    expect(source("app/admin/setup/setup.tsx")).toMatch(/^"use client";/);
  });
});

describe("the page's words", () => {
  const html = (part: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(part);

  it("shows a button per setting and no value before one is pressed", () => {
    const out = html(createElement(Generator, { names: GENERATED_SETTINGS }));
    expect(out.match(/<button type="button"/g)).toHaveLength(2);
    expect(out).not.toContain("<pre");
    expect(out).toContain("after peers are registered");
    expect(out).toContain("unreadable");
    expect(out).toContain("does not send a value to the server");
  });

  it("the job's secret alone carries no warning about the key", () => {
    const out = html(createElement(Generator, { names: ["CRON_SECRET"] }));
    expect(out).not.toMatch(/OCPI_TOKEN_ENCRYPTION_KEY|unreadable/);
  });

  it("a new value comes with a copy button, where to paste it and the redeploy", () => {
    for (const name of GENERATED_SETTINGS) {
      const value = generateSetting(name);
      const out = html(createElement(NewValue, { name, value }));
      expect(out.split(value), "shown once").toHaveLength(2);
      expect(out).toMatch(/<button type="button">Copy/);
      expect(out).toContain("shown only now");
      expect(out).toContain("environment settings");
      expect(out).toContain("Environment Variables");
      expect(out).toContain("Then redeploy");
    }
  });
});
