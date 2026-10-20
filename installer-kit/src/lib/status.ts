import type { ConnectionState } from "./types";

export type StatusView = {
  state: ConnectionState;
  label: string;
  hints: string[];
};

/** Map Ivora charger event types to UI state; other events are ignored. */
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

/**
 * Map a polled station record to UI state. Ivora reports the protocol once the
 * charger has sent its BootNotification, so online + protocol means booted.
 */
export function stationState(s: {
  online: boolean;
  protocol: string | null;
  lastSeen?: string | null;
}): ConnectionState {
  if (s.online) return s.protocol ? "booted" : "connected";
  return s.lastSeen ? "offline" : "waiting";
}

export const HINTS = {
  wrongUrl:
    "Wrong URL: the central system URL must be exactly the connection URL above, starting with wss://. Some chargers want the base URL and the charge point ID in separate fields.",
  wrongPassword:
    "Wrong password: enter it as the Basic authentication (security profile 1) password, and the connection name as the charge point ID. A rejected password looks like no connection at all.",
  noNetwork:
    "No network: check the charger has internet access (Ethernet, Wi-Fi or SIM) and that outbound port 443 is not blocked by the site's firewall.",
  noBoot:
    "Connected but not booted: reboot the charger so it sends a BootNotification, and check it is set to OCPP 1.6J (JSON over WebSocket).",
  dropped:
    "Disconnected after connecting: check power and network, and whether the charger's password was changed since it last connected.",
};

/** Hints appear once a wait is long enough to suggest something is wrong. */
export function describe(
  state: ConnectionState,
  waitedSeconds: number,
): StatusView {
  switch (state) {
    case "booted":
      return { state, label: "Charger connected and booted", hints: [] };
    case "connected":
      return {
        state,
        label: "Connected, waiting for the boot notification",
        hints: waitedSeconds > 30 ? [HINTS.noBoot] : [],
      };
    case "offline":
      return {
        state,
        label: "Disconnected",
        hints: [HINTS.dropped, HINTS.noNetwork],
      };
    default:
      return {
        state,
        label: "Waiting for the charger to connect",
        hints:
          waitedSeconds > 45
            ? [HINTS.wrongUrl, HINTS.wrongPassword, HINTS.noNetwork]
            : [],
      };
  }
}
