import { describe, expect, it } from "vitest";
import { API_CALLS, callsFor, collapseEvents } from "@/lib/calls";

// Webhook events the app handles (lib/events.ts) and the paths it calls (lib/ivora.ts).
const WEBHOOKS = [
  "meter.sampled",
  "connector.status_changed",
  "charging_profile.accepted",
  "charging_profile.rejected",
  "charging_profile.cleared",
  "token.updated",
];

describe("API panel", () => {
  it("only names real webhook events and endpoints", () => {
    const calls = [
      ...API_CALLS.map((c) => c.call),
      ...[
        "session.started",
        "charging_profile.accepted",
        "session.ended",
        "departure.changed",
      ].flatMap((t) => callsFor(t).map((c) => c.text)),
    ];
    for (const c of calls) {
      if (/^POST /.test(c))
        expect(c).toMatch(/\/(charging-profiles|composite-schedule|tokens)/);
      else expect(WEBHOOKS).toContain(c);
    }
  });
  it("has no calls for events that stay inside the app", () => {
    expect(callsFor("demo.ready")).toEqual([]);
  });
});

describe("event log", () => {
  it("lists the profiles of one replan on one line", () => {
    const at = "2026-10-22T21:30:00.000Z";
    const ev = (id: string, type: string, detail: string, t = at) => ({
      id,
      at: t,
      type,
      detail,
    });
    const out = collapseEvents([
      ev("1", "charging_profile.accepted", "Van A: 11.0 kW (simulated)"),
      ev("2", "charging_profile.accepted", "Van B: 19.0 kW (simulated)"),
      ev("3", "session.started", "Van B"),
      ev("4", "charging_profile.accepted", "Van A: 9.0 kW (simulated)", "x"),
    ]);
    expect(out.map((e) => e.id)).toEqual(["1", "3", "4"]);
    expect(out[0].detail).toBe(
      "Van A: 11.0 kW (simulated); Van B: 19.0 kW (simulated)",
    );
  });
});
