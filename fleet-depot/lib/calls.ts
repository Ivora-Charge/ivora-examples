/**
 * What the app would send to, and receive from, the Ivora API for each demo event.
 * Only endpoints and webhook events the live code uses (lib/ivora.ts, lib/events.ts).
 * Pure, so it is unit tested.
 */
export interface Call {
  kind: "request" | "webhook";
  text: string;
}

const PROFILE = "POST …/stations/{id}/charging-profiles";

/** The calls behind one event of the demo log; none for events that stay in the app. */
export function callsFor(type: string): Call[] {
  switch (type) {
    case "session.started":
      return [
        { kind: "webhook", text: "connector.status_changed" },
        { kind: "webhook", text: "meter.sampled" },
      ];
    case "charging_profile.accepted":
      return [
        { kind: "request", text: PROFILE },
        { kind: "webhook", text: "charging_profile.accepted" },
        { kind: "request", text: "POST …/stations/{id}/composite-schedule" },
      ];
    case "session.ended":
      return [{ kind: "webhook", text: "connector.status_changed" }];
    case "departure.changed":
      return [{ kind: "request", text: `${PROFILE} (new plan)` }];
    default:
      return [];
  }
}

/** The fixed list shown next to the live one. */
export const API_CALLS: { call: string; use: string }[] = [
  {
    call: PROFILE,
    use: "A limit per session, so the depot stays under its cap.",
  },
  {
    call: "POST …/stations/{id}/composite-schedule",
    use: "Asks the charger what it will apply.",
  },
  { call: "POST …/tokens", use: "Authorises a driver's RFID card." },
  { call: "meter.sampled", use: "Webhook: energy and plug-in." },
  {
    call: "connector.status_changed",
    use: "Webhook: plugged in, charging, free.",
  },
  {
    call: "charging_profile.accepted",
    use: "Webhook: the charger took the limit.",
  },
];

interface LogLine {
  id: string;
  at: string;
  type: string;
  detail: string;
}

/**
 * One log line per replan: the profiles a replan sends at the same moment are
 * listed together instead of one line each. Input and output are newest first.
 */
export function collapseEvents<E extends LogLine>(events: E[]): E[] {
  const out: E[] = [];
  for (const e of events) {
    const prev = out.at(-1);
    if (
      prev &&
      e.type === "charging_profile.accepted" &&
      prev.type === e.type &&
      prev.at === e.at
    )
      out[out.length - 1] = { ...prev, detail: `${prev.detail}; ${e.detail}` };
    else out.push(e);
  }
  return out;
}
