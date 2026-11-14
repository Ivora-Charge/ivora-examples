import { describe, expect, it, vi } from "vitest";
import { isDemo, liveConfig } from "@/lib/server/config";

const creds = { IVORA_API_KEY: "k", IVORA_TENANT_ID: "42" };

describe("DEMO_MODE", () => {
  it.each(["true", "1", "yes", "on", " TRUE ", "Yes"])(
    "%j forces demo even with credentials set",
    (value) => {
      expect(isDemo({ ...creds, DEMO_MODE: value })).toBe(true);
    },
  );

  it.each(["", "0", "false", "no", "off", "maybe"])(
    "%j does not force demo",
    (value) => {
      expect(isDemo({ ...creds, DEMO_MODE: value })).toBe(false);
    },
  );

  it("is on without credentials", () => {
    expect(isDemo({})).toBe(true);
    expect(isDemo({ IVORA_API_KEY: "k" })).toBe(true);
  });
});

describe("API URL name", () => {
  it("reads IVORA_API_URL, and the old IVORA_API_BASE_URL with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      liveConfig({ ...creds, IVORA_API_URL: "https://a.example.com/x" }).origin,
    ).toBe("https://a.example.com");
    expect(warn).not.toHaveBeenCalled();
    expect(
      liveConfig({ ...creds, IVORA_API_BASE_URL: "https://old.example.com" })
        .origin,
    ).toBe("https://old.example.com");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("IVORA_API_URL");
    warn.mockRestore();
  });
});
