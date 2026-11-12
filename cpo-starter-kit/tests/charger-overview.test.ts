import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverviewPanel } from "@/app/(staff)/chargers/[key]/overview";
import type { ChargerView } from "@/lib/server/chargers";

const charger = (o: Partial<ChargerView> = {}): ChargerView => ({
  key: "rec-1",
  recordId: "rec-1",
  stationId: null,
  name: "AMPLEAF-DEMO-01",
  label: "Depot bay 1",
  locationId: null,
  siteName: null,
  pending: false,
  missing: false,
  online: false,
  protocol: null,
  vendor: null,
  model: null,
  lastSeen: null,
  connectionUrl: "wss://ocpp.example.com/AMPLEAF-DEMO-01",
  username: "AMPLEAF-DEMO-01",
  passwordSet: true,
  connectors: [],
  connectionTest: null,
  remoteTest: null,
  ...o,
});

const overview = (c: ChargerView, registered: boolean) =>
  renderToStaticMarkup(h(OverviewPanel, { c, zone: "UTC", registered }));

describe("charger overview", () => {
  it("shows the Connection card for a charger not registered yet", () => {
    const out = overview(charger({ pending: true }), false);
    expect(out).toContain('id="connection-heading"');
    expect(out).toContain("AMPLEAF-DEMO-01");
    expect(out).toContain("wss://ocpp.example.com/AMPLEAF-DEMO-01");
    expect(out).toContain("Set by the kit (not shown again)");
  });

  it("shows the Connection card for a charger missing in Ivora", () => {
    const out = overview(charger({ missing: true, stationId: 7 }), false);
    expect(out).toContain('id="connection-heading"');
    expect(out).toContain("wss://ocpp.example.com/AMPLEAF-DEMO-01");
  });

  it("leaves the connection to the Configuration tab once registered", () => {
    const out = overview(charger({ stationId: 7 }), true);
    expect(out).toContain('id="connectors-heading"');
    expect(out).not.toContain('id="connection-heading"');
    expect(out).not.toContain("wss://ocpp.example.com");
  });
});
