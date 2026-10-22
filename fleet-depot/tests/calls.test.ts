import { describe, expect, it } from "vitest";
import { API_CALLS, callsFor } from "@/lib/calls";

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
