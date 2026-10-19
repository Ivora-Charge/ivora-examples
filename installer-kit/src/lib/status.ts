import type { ConnectionState } from "./types";

export type StatusView = {
  state: ConnectionState;
  label: string;
  hint?: string;
};

/** Map Ivora webhook event types (and polled station states) to UI state. */
export function mapEvent(type: string): ConnectionState | null {
  switch (type) {
    case "station.connected":
      return "connected";
    case "station.booted":
      return "booted";
    case "station.disconnected":
      return "offline";
    default:
      return null;
  }
}

export const HINTS = [
  "Wrong URL: check the endpoint and that the station ID is the last path segment.",
  "Wrong password: re-enter it as the Basic auth password (OCPP 1.6J security profile 1).",
  "No network: confirm the charger has internet access and port 443 outbound is open.",
];

export function describe(
  state: ConnectionState,
  waitedSeconds: number,
): StatusView {
  switch (state) {
    case "booted":
      return { state, label: "Charger booted" };
    case "connected":
      return { state, label: "Connected, waiting for boot notification" };
    case "offline":
      return { state, label: "Disconnected", hint: HINTS.join("\n") };
    default:
      return {
        state,
        label: "Waiting for connection",
        hint: waitedSeconds > 60 ? HINTS.join("\n") : undefined,
      };
  }
}
