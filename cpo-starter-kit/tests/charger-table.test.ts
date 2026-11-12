import { describe, expect, it } from "vitest";
import {
  ago,
  chargerCounts,
  chargerStatusText,
  freeConnectorCount,
  needsAttention,
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
