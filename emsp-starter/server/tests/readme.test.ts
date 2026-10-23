import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIVE_REQUIRED } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";

// The Deploy to Vercel button, checked offline: it clones this server's folder of the
// public repository, asks only for variables the server reads, and a deployment that
// answers `demo` to every question runs in demo mode.

const server = path.resolve(__dirname, "..");
const readme = readFileSync(path.join(server, "README.md"), "utf8");
const buttons = [
  ...readme.matchAll(/\]\((https:\/\/vercel\.com\/new\/clone\?[^)\s]+)\)/g),
].map((m) => new URL(m[1]));
const button = buttons[0];
const prompted = (button?.searchParams.get("env") ?? "").split(",");
const example = new Set(
  readFileSync(path.join(server, ".env.example"), "utf8")
    .split("\n")
    .map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1])
    .filter(Boolean),
);

describe("the Deploy to Vercel button", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of [...example] as string[]) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is one button that clones this server's folder of the public repository", () => {
    expect(buttons).toHaveLength(1);
    expect(button.searchParams.get("repository-url")).toBe(
      "https://github.com/Ivora-Charge/ivora-examples",
    );
    const root = button.searchParams.get("root-directory")!;
    expect(root).toBe("emsp-starter/server");
    expect(existsSync(path.join(server, "../..", root, "package.json"))).toBe(
      true,
    );
  });

  it("asks for every live-mode variable, all of them documented and server-side", () => {
    expect([...prompted].sort()).toEqual([...LIVE_REQUIRED].sort());
    for (const k of prompted) {
      expect(example.has(k), `${k} in .env.example`).toBe(true);
      expect(readme).toContain(`| \`${k}\``);
      expect(k.startsWith("NEXT_PUBLIC_")).toBe(false);
    }
    // Vercel's form shows the description and the link with the questions.
    expect(button.searchParams.get("envDescription")).toContain("demo");
    const link = new URL(button.searchParams.get("envLink")!);
    expect(link.href).toMatch(
      /^https:\/\/github\.com\/Ivora-Charge\/ivora-examples\/tree\/main\/emsp-starter\/server#/,
    );
    expect(readme).toContain(
      `\n## ${link.hash.slice(1).replace(/^./, (c) => c.toUpperCase())}\n`,
    );
  });

  it("is the same button in the template README", () => {
    const template = readFileSync(path.join(server, "../README.md"), "utf8");
    expect(template).toContain(`](${button.href})`);
  });

  it("deploys in demo mode when every question is answered `demo`, and live once they are real", () => {
    for (const k of prompted) process.env[k] = "demo";
    expect(isDemo()).toBe(true);
    Object.assign(process.env, {
      EMSP_COUNTRY_CODE: "NL",
      EMSP_PARTY_ID: "ABC",
      PUBLIC_BASE_URL: "https://emsp.example.test",
      SUPABASE_URL: "https://db.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      OCPI_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(isDemo()).toBe(false);
    process.env.DEMO_MODE = "true";
    expect(isDemo()).toBe(true);
  });
});
