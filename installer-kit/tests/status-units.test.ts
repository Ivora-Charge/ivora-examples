import { describe, expect, it } from "vitest";
import {
  HINTS,
  describe as describeStatus,
  mapEvent,
  stationState,
} from "@/lib/status";
import { formatCents, quoteCents } from "@/lib/tariff";
import { formatKwh, kwhTextToWh, whToKwh } from "@/lib/units";

describe("status mapping", () => {
  it("maps charger events", () => {
    expect(mapEvent("station.connected")).toBe("connected");
    expect(mapEvent("station.booted")).toBe("booted");
    expect(mapEvent("station.disconnected")).toBe("offline");
    expect(mapEvent("connector.status_changed")).toBeNull();
    expect(mapEvent("x")).toBeNull();
  });

  it("maps polled station records", () => {
    expect(stationState({ online: false, protocol: null })).toBe("waiting");
    expect(stationState({ online: true, protocol: null })).toBe("connected");
    expect(stationState({ online: true, protocol: "ocpp1.6" })).toBe("booted");
    expect(
      stationState({
        online: false,
        protocol: "ocpp1.6",
        lastSeen: "2026-10-19T10:00:00Z",
      }),
    ).toBe("offline");
  });

  it("shows troubleshooting hints only after a long wait", () => {
    expect(describeStatus("waiting", 10).hints).toEqual([]);
    expect(describeStatus("waiting", 60).hints).toEqual([
      HINTS.wrongUrl,
      HINTS.wrongPassword,
      HINTS.noNetwork,
    ]);
    expect(describeStatus("connected", 5).hints).toEqual([]);
    expect(describeStatus("connected", 40).hints).toEqual([HINTS.noBoot]);
    expect(describeStatus("offline", 0).hints).toContain(HINTS.dropped);
    expect(describeStatus("booted", 999).hints).toEqual([]);
  });
});

describe("units and money", () => {
  it("converts Wh registers to kWh in one place", () => {
    expect(whToKwh(425)).toBe(0.425);
    expect(formatKwh(425)).toBe("0.43 kWh");
    expect(kwhTextToWh("0.425")).toBe(425);
    expect(kwhTextToWh(null)).toBe(0);
    expect(kwhTextToWh("bad")).toBe(0);
  });

  it("quotes in integer cents, rounding once", () => {
    expect(quoteCents(20_000, 35)).toBe(700);
    expect(quoteCents(425, 35)).toBe(15); // 14.875 -> 15
    expect(Number.isInteger(quoteCents(333, 7))).toBe(true);
    expect(() => quoteCents(1000, 3.5)).toThrow();
    expect(formatCents(700)).toBe("$7.00");
  });
});
