import { afterEach, describe, expect, it, vi } from "vitest";
import { config, isDemo, isFlagOn } from "@/lib/config";

const NAMES = [
  "DEMO_MODE",
  "IVORA_API_KEY",
  "IVORA_TENANT_ID",
  "IVORA_API_URL",
  "IVORA_API_BASE_URL",
  "BASELINE_PROFILE",
];

function live(extra: Record<string, string> = {}) {
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, {
    IVORA_API_KEY: "k",
    IVORA_TENANT_ID: "1",
    ...extra,
  });
}

afterEach(() => {
  for (const n of NAMES) delete process.env[n];
});

describe("DEMO_MODE", () => {
  it("is live with both credentials and no switch", () => {
    live();
    expect(isDemo()).toBe(false);
  });

  it.each(["true", "1", "yes", "on", " TRUE ", "Yes"])(
    "%j forces demo even with credentials set",
    (value) => {
      live({ DEMO_MODE: value });
      expect(isDemo()).toBe(true);
    },
  );

  it.each(["", "0", "false", "no", "off", "maybe"])(
    "%j does not force demo",
    (value) => {
      live({ DEMO_MODE: value });
      expect(isDemo()).toBe(false);
    },
  );

  it("isFlagOn treats unset as off", () => {
    expect(isFlagOn(undefined)).toBe(false);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["yes", false],
    ["on", false],
    ["TRUE", false],
    [" 1 ", true],
    ["", false],
  ])("BASELINE_PROFILE=%j keeps its exact rule: %s", (value, on) => {
    live({ BASELINE_PROFILE: value });
    expect(config.baselineProfile).toBe(on);
  });
});

describe("API URL name", () => {
  it("reads IVORA_API_URL, and the old IVORA_API_BASE_URL with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    live({ IVORA_API_URL: "https://a.example.com/" });
    expect(config.apiBase).toBe("https://a.example.com");
    expect(warn).not.toHaveBeenCalled();
    live({ IVORA_API_BASE_URL: "https://old.example.com" });
    expect(config.apiBase).toBe("https://old.example.com");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("IVORA_API_URL");
    live({
      IVORA_API_URL: "https://new.example.com",
      IVORA_API_BASE_URL: "https://old.example.com",
    });
    expect(config.apiBase).toBe("https://new.example.com");
    warn.mockRestore();
  });
});
