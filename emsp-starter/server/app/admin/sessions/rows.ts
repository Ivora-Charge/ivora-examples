import "server-only";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { formatMoney } from "@/lib/locations/pricing";
import { peerStore } from "@/lib/ocpi/registry";
import type { StoredSession } from "@/lib/sessions/store";

/** A session as the admin list shows it: what the CPO said, and our links. */
export type SessionRow = {
  id: string;
  peer: string;
  /** `country_code/party_id/session_id`, as the CPO knows it. */
  ref: string;
  status: string;
  start: string;
  end: string | null;
  kwh: number;
  /** "12.50 EUR excl. VAT, 15.00 incl.", as the CPO gave it; null before it did. */
  cost: string | null;
  location: string;
  authMethod: string;
  driverRef: string | null;
  /** The START_SESSION command: the payment's charge ID. */
  commandId: string | null;
  stopReason: string | null;
};

const costOf = (s: StoredSession["session"]) =>
  s.total_cost
    ? `${formatMoney(s.total_cost.excl_vat, s.currency)} excl. VAT${s.total_cost.incl_vat === undefined ? "" : `, ${formatMoney(s.total_cost.incl_vat, s.currency)} incl.`}`
    : null;

export function sessionRow(
  s: StoredSession,
  labels: Map<string, string>,
): SessionRow {
  const o = s.session;
  return {
    id: s.id,
    peer: labels.get(s.peerId) ?? s.peerId,
    ref: `${o.country_code}/${o.party_id}/${o.id}`,
    status: o.status,
    start: o.start_date_time,
    end: o.end_date_time ?? null,
    kwh: o.kwh,
    cost: costOf(o),
    location: `${o.location_id} / ${o.evse_uid} / ${o.connector_id}`,
    authMethod: o.auth_method,
    driverRef: s.driverRef,
    commandId: s.commandId,
    stopReason: s.stopReason ?? null,
  };
}

/** Each peer's name by its ID, for the rows. */
export async function peerLabels(): Promise<Map<string, string>> {
  return new Map<string, string>([
    [DEMO_PEER_ID, "Mock CPO (demo)"],
    ...(await peerStore().listPeers()).map(
      (p) => [p.id, p.label] as [string, string],
    ),
  ]);
}
