import { describe, expect, it } from "vitest";
import { readSettings } from "@/lib/settings";
import { startOfLocalDay } from "@/lib/time";
import { formatDuration, whToKwhText, wToKwText } from "@/lib/units";

const live = {
  IVORA_API_KEY: "k",
  IVORA_TENANT_ID: "1",
  STRIPE_SECRET_KEY: "s",
  SESSION_SECRET: "x",
  OPERATOR_PASSWORD: "p",
  PUBLIC_BASE_URL: "https://charge.example.com/",
};

describe("settings", () => {
  it("runs in demo mode without credentials and names what is missing", () => {
    const s = readSettings({ IVORA_API_KEY: "k" });
    expect(s.demo).toBe(true);
    expect(s.missing).toContain("STRIPE_SECRET_KEY");
    expect(s.missing).not.toContain("IVORA_API_KEY");
  });

  it("goes live only with every variable, and DEMO_MODE=1 forces demo", () => {
    expect(readSettings(live).demo).toBe(false);
    expect(readSettings({ ...live, DEMO_MODE: "1" }).demo).toBe(true);
  });

  it("defaults the application fee to 1000 bps and validates it", () => {
    expect(readSettings(live).applicationFeeBps).toBe(1000);
    expect(
      readSettings({ ...live, APPLICATION_FEE_BPS: "0" }).applicationFeeBps,
    ).toBe(0);
    expect(() =>
      readSettings({ ...live, APPLICATION_FEE_BPS: "10.5" }),
    ).toThrow();
    expect(() =>
      readSettings({ ...live, APPLICATION_FEE_BPS: "20000" }),
    ).toThrow();
  });

  it("keeps the default hold within what a card can carry", () => {
    expect(readSettings(live).defaultHoldCents).toBe(5000);
    expect(() => readSettings({ ...live, DEFAULT_HOLD_CENTS: "49" })).toThrow();
    expect(() =>
      readSettings({ ...live, DEFAULT_HOLD_CENTS: "50.5" }),
    ).toThrow();
    expect(() =>
      readSettings({ ...live, DEFAULT_HOLD_CENTS: "60000" }),
    ).toThrow();
  });

  it("requires an HTTPS public URL in live mode", () => {
    expect(readSettings(live).publicBaseUrl).toBe("https://charge.example.com");
    expect(() =>
      readSettings({ ...live, PUBLIC_BASE_URL: "http://charge.example.com" }),
    ).toThrow();
    expect(
      readSettings({ ...live, PUBLIC_BASE_URL: "http://localhost:3000" }).demo,
    ).toBe(false);
  });

  it("validates the idle grace and typical session", () => {
    expect(readSettings(live)).toMatchObject({
      idleGraceMinutes: 10,
      typicalSessionKwh: 30,
      typicalSessionMinutes: 25,
    });
    expect(() => readSettings({ ...live, IDLE_GRACE_MINUTES: "-5" })).toThrow();
  });
});

describe("units", () => {
  it("converts Wh to kWh in one place, half up for display", () => {
    expect(whToKwhText(12_345)).toBe("12.35");
    expect(whToKwhText(12_344)).toBe("12.34");
    expect(whToKwhText(999)).toBe("1.00");
    expect(whToKwhText(0)).toBe("0.00");
    expect(whToKwhText(6941, 3)).toBe("6.941");
    expect(() => whToKwhText(1.5)).toThrow();
    expect(() => whToKwhText(-1)).toThrow();
  });

  it("formats power and durations", () => {
    expect(wToKwText(61_234)).toBe("61.2");
    expect(wToKwText(61_250)).toBe("61.3");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(-3)).toBe("0:00");
  });
});

describe("site day", () => {
  it("finds local midnight in the site's time zone, across DST", () => {
    const noon = Date.parse("2026-10-19T19:00:00Z"); // 12:00 in Los Angeles (PDT)
    expect(startOfLocalDay(noon, "America/Los_Angeles").toISOString()).toBe(
      "2026-10-19T07:00:00.000Z",
    );
    expect(startOfLocalDay(noon, "UTC").toISOString()).toBe(
      "2026-10-19T00:00:00.000Z",
    );
    // The day DST ends: midnight is still PDT (UTC-7).
    const fallBack = Date.parse("2026-11-01T20:00:00Z");
    expect(startOfLocalDay(fallBack, "America/Los_Angeles").toISOString()).toBe(
      "2026-11-01T07:00:00.000Z",
    );
    // The day after, midnight is PST (UTC-8).
    expect(
      startOfLocalDay(
        Date.parse("2026-11-02T20:00:00Z"),
        "America/Los_Angeles",
      ).toISOString(),
    ).toBe("2026-11-02T08:00:00.000Z");
  });
});
