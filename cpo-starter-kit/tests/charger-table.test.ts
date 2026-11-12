import { describe, expect, it } from "vitest";
import {
  ago,
  chargerZone,
  chargerCounts,
  chargerStatusText,
  freeConnectorCount,
  needsAttention,
  zonedTime,
} from "@/lib/charger-table";

const conn = (status: string | null) => ({
  id: 1,
  number: 1,
  status,
  maxPowerKw: null,
  code: null,
});
const charger = (o: Partial<Parameters<typeof needsAttention>[0]> = {}) => ({
  pending: false,
  missing: false,
  online: true,
  connectors: [conn("Available")],
  ...o,
});

describe("charger list figures", () => {
  it("names the status in words", () => {
    expect(chargerStatusText(charger())).toBe("Online");
    expect(chargerStatusText(charger({ online: false }))).toBe("Offline");
    expect(chargerStatusText(charger({ pending: true }))).toBe(
      "Not registered yet",
    );
    expect(chargerStatusText(charger({ missing: true }))).toBe("Not in Ivora");
  });
  it("flags a charger that is offline, unregistered, gone or faulted", () => {
    expect(needsAttention(charger())).toBe(false);
    expect(needsAttention(charger({ online: false }))).toBe(true);
    expect(needsAttention(charger({ pending: true }))).toBe(true);
    expect(needsAttention(charger({ missing: true }))).toBe(true);
    expect(needsAttention(charger({ connectors: [conn("Faulted")] }))).toBe(
      true,
    );
  });
  it("counts free connectors and the totals", () => {
    const two = charger({ connectors: [conn("Available"), conn("Charging")] });
    expect(freeConnectorCount(two)).toBe(1);
    expect(
      chargerCounts([two, charger({ online: false, connectors: [] })]),
    ).toEqual({ total: 2, online: 1, connectors: 2, attention: 1 });
  });
  it("gives a rough age", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(ago(null, now)).toBe("Never");
    expect(ago("2026-01-01T11:59:29Z", now)).toBe("31 s ago");
    expect(ago("2026-01-01T10:00:00Z", now)).toBe("2 h ago");
    expect(ago("2026-01-01T11:30:00Z", now)).toBe("30 min ago");
  });
});

describe("chargerZone", () => {
  it("prefers the site's zone, then the company's, then UTC", () => {
    expect(chargerZone("America/Toronto", "Europe/Paris")).toBe(
      "America/Toronto",
    );
    expect(chargerZone(null, "Europe/Paris")).toBe("Europe/Paris");
    expect(chargerZone(undefined, null)).toBe("UTC");
  });
  it("skips a zone the browser does not know", () => {
    expect(chargerZone("Mars/Base", "Europe/Paris")).toBe("Europe/Paris");
    expect(chargerZone("Mars/Base", "")).toBe("UTC");
  });
});

describe("zonedTime", () => {
  it("shows local time in the zone, with UTC as the secondary detail", () => {
    expect(zonedTime("2026-01-15T15:31:00Z", "America/New_York")).toEqual({
      local: "2026-01-15 10:31",
      zone: "America/New_York",
      utc: "2026-01-15 15:31 UTC",
    });
  });
  it("follows daylight saving time", () => {
    expect(zonedTime("2026-07-01T15:31:00Z", "America/New_York")?.local).toBe(
      "2026-07-01 11:31",
    );
  });
  it("crosses midnight into the local date", () => {
    expect(zonedTime("2026-03-01T23:30:00Z", "Asia/Tokyo")?.local).toBe(
      "2026-03-02 08:30",
    );
  });
  it("uses a 24-hour clock, with midnight as 00", () => {
    expect(zonedTime("2026-03-01T00:05:00Z", "UTC")?.local).toBe(
      "2026-03-01 00:05",
    );
  });
  it("falls back to UTC for an unknown zone, and null for no time", () => {
    expect(zonedTime("2026-03-01T12:00:00Z", "Mars/Base")?.zone).toBe("UTC");
    expect(zonedTime(null, "UTC")).toBeNull();
    expect(zonedTime("not a time", "UTC")).toBeNull();
  });
});
