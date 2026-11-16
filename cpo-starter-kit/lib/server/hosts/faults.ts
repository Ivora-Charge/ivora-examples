import "server-only";
import { eventStation, type IvoraEvent } from "../live/service";
import type { IvoraClient } from "../ivora";
import { faultEmail, MailerError, type Mailer } from "../mail";
import type { HostStore } from "./types";

export interface FaultMailDeps {
  store: HostStore;
  ivora: IvoraClient;
  /** Null without an email provider (and in demo mode): nothing is sent. */
  mailer: Mailer | null;
  appUrl: string;
}

/** What the fault event says went wrong, without anything but the codes. */
function faultText(e: IvoraEvent): string {
  const f = (e.data.fault ?? {}) as Record<string, unknown>;
  const code =
    typeof f.error_code === "string"
      ? f.error_code
      : typeof e.data.error_code === "string"
        ? e.data.error_code
        : null;
  const status = typeof f.ocpp_status === "string" ? f.ocpp_status : null;
  return (code ?? status ?? "a fault").slice(0, 60);
}

/**
 * A verified, new `station.fault_opened` webhook event: emails the users of the host
 * whose site the charger is at, while the host's "fault emails" switch is on. The
 * station's site is read from Ivora (the event is only a cue); recipients come from
 * the kit's database. Each email's idempotency key is the event and the user, so a
 * retry never sends one twice. Returns how many were sent.
 */
export async function notifyFault(
  d: FaultMailDeps,
  e: IvoraEvent,
): Promise<number> {
  if (e.type !== "station.fault_opened" || !d.mailer) return 0;
  const stationId = eventStation(e);
  if (!stationId) return 0;
  const station = await d.ivora.getStation(stationId);
  if (station.location_id == null) return 0;
  const recipients = await d.store.faultRecipients(station.location_id);
  let sent = 0;
  for (const r of recipients) {
    try {
      await d.mailer.send(
        faultEmail({
          to: r.email,
          hostName: r.hostName,
          stationName: station.name,
          fault: faultText(e),
          link: `${d.appUrl}/live/stations/${station.id}`,
        }),
        `cpo-fault-${e.id}-${r.userId}`.slice(0, 256),
      );
      sent++;
    } catch (err) {
      // Logged by IDs and status only, never the address.
      console.warn("cpo-starter-kit: fault email failed", {
        host: r.hostId,
        user: r.userId,
        status: err instanceof MailerError ? err.status : null,
      });
    }
  }
  return sent;
}
