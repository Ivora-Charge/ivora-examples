"use server";

import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { peerStore } from "@/lib/ocpi/registry";
import { asAdmin as gate, field } from "@/lib/server/admin-action";
import { sessionStore } from "@/lib/sessions/registry";
import { STATUS_FILTERS } from "./filters";
import {
  OPEN_SESSION_STATUSES,
  type StoredSession,
} from "@/lib/sessions/store";

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

export type SessionsState = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
  sessions?: SessionRow[];
};

/** Rows per list. */
const SESSION_LIST_LIMIT = 100;

const UUID = /^[0-9a-f-]{36}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const costOf = (s: StoredSession["session"]) =>
  s.total_cost
    ? `${s.total_cost.excl_vat} ${s.currency} excl. VAT${s.total_cost.incl_vat === undefined ? "" : `, ${s.total_cost.incl_vat} incl.`}`
    : null;

function row(s: StoredSession, labels: Map<string, string>): SessionRow {
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

/** Live and recent sessions, newest first, filtered by peer, status and driver. */
export async function listSessionsAction(
  _prev: SessionsState,
  form: FormData,
): Promise<SessionsState> {
  return gate(
    form,
    async (): Promise<SessionsState> => {
      const peerId = field(form, "peerId").trim();
      const status = field(form, "status") || "live";
      const driverRef = field(form, "driverRef").trim();
      const before = field(form, "before").trim();
      if (peerId && !UUID.test(peerId) && peerId !== DEMO_PEER_ID)
        return { ok: false, message: "Peer ID must be a UUID." };
      if (!(STATUS_FILTERS as readonly string[]).includes(status))
        return { ok: false, message: "Unknown status." };
      if (driverRef.length > 64)
        return {
          ok: false,
          message: "A driver reference is 64 characters at most.",
        };
      if (before && (!DAY.test(before) || Number.isNaN(Date.parse(before))))
        return { ok: false, message: "Started before must be a date." };

      const sessions = await sessionStore().listSessions({
        peerId: peerId.toLowerCase() || undefined,
        statuses:
          status === "live"
            ? OPEN_SESSION_STATUSES
            : status === "all"
              ? undefined
              : [status],
        driverRef: driverRef || undefined,
        before: before ? `${before}T00:00:00Z` : undefined,
        limit: SESSION_LIST_LIMIT,
      });
      const labels = new Map<string, string>([
        [DEMO_PEER_ID, "Mock CPO (demo)"],
        ...(await peerStore().listPeers()).map(
          (p) => [p.id, p.label] as [string, string],
        ),
      ]);
      return {
        ok: true,
        message: sessions.length
          ? `${sessions.length} session(s)${sessions.length === SESSION_LIST_LIMIT ? `, the newest ${SESSION_LIST_LIMIT}: narrow the filters or set "Started before" to see older ones` : ""}.`
          : "No sessions match.",
        sessions: sessions.map((s) => row(s, labels)),
      };
    },
    {
      shown: () => false,
      fallback: "Could not read the sessions. Try again.",
      what: "session list",
    },
  );
}
