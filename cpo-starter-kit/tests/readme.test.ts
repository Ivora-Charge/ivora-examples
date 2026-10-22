import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDemo } from "@/lib/server/env";

// The Deploy to Vercel button, checked offline: it clones this repository's kit folder,
// asks only for variables the kit reads, and a deployment that answers `demo` to every
// question runs in demo mode.

const kit = path.resolve(__dirname, "..");
const readme = readFileSync(path.join(kit, "README.md"), "utf8");
const buttons = [
  ...readme.matchAll(/\]\((https:\/\/vercel\.com\/new\/clone\?[^)\s]+)\)/g),
].map((m) => new URL(m[1]));
const button = buttons[0];
const prompted = (button?.searchParams.get("env") ?? "").split(",");
const example = new Set(
  readFileSync(path.join(kit, ".env.example"), "utf8")
    .split("\n")
    .map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1])
    .filter(Boolean),
);

const LIVE = [
  "IVORA_API_KEY",
  "IVORA_TENANT_ID",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

describe("the Deploy to Vercel button", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of [...example] as string[]) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is one button that clones this kit's folder of the public repository", () => {
    expect(buttons).toHaveLength(1);
    expect(button.searchParams.get("repository-url")).toBe(
      "https://github.com/Ivora-Charge/ivora-examples",
    );
    const root = button.searchParams.get("root-directory")!;
    expect(root).toBe(path.basename(kit));
    expect(existsSync(path.join(kit, "..", root, "package.json"))).toBe(true);
  });

  it("asks for the live credentials, all of them variables the kit documents", () => {
    for (const k of LIVE) expect(prompted).toContain(k);
    for (const k of prompted) {
      expect(example.has(k), `${k} in .env.example`).toBe(true);
      expect(readme).toContain(`| \`${k}\``);
      expect(k.startsWith("NEXT_PUBLIC_")).toBe(false);
    }
    // Vercel's form shows the description and the link with the questions.
    expect(button.searchParams.get("envDescription")).toContain("demo");
    const link = new URL(button.searchParams.get("envLink")!);
    expect(link.href).toMatch(
      /^https:\/\/github\.com\/Ivora-Charge\/ivora-examples\/tree\/main\/cpo-starter-kit#/,
    );
    expect(readme).toContain(
      `\n## ${link.hash.slice(1).replace(/^./, (c) => c.toUpperCase())}\n`,
    );
  });

  it("deploys in demo mode when every question is answered `demo`, and live once they are real", () => {
    for (const k of prompted) process.env[k] = "demo";
    expect(isDemo()).toBe(true);
    Object.assign(process.env, {
      IVORA_API_KEY: "test-key",
      IVORA_TENANT_ID: "42",
      SUPABASE_URL: "https://project.supabase.example",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    });
    expect(isDemo()).toBe(false);
    process.env.DEMO_MODE = "true";
    expect(isDemo()).toBe(true);
  });
});
