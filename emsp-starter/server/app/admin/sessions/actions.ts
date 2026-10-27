"use server";

import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { formatMoney } from "@/lib/locations/pricing";
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
  /** The filters of this list, so the form keeps them for the next one. */
  filters?: {
    status: string;
    peerId: string;
    driverRef: string;
    before: string;
  };
  /**
   * When the list is full: where the next page starts, as a UTC timestamp (the
   * "Started before" of the sessions older than these).
   */
  nextBefore?: string;
};

/** Rows per list. */
const SESSION_LIST_LIMIT = 100;

const UUID = /^[0-9a-f-]{36}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** "Started before": a UTC day (its midnight) or a UTC timestamp, as an ISO string. */
function startedBefore(v: string): string | null {
  if (!DAY.test(v) && !TIMESTAMP.test(v)) return null;
  const ms = Date.parse(DAY.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const costOf = (s: StoredSession["session"]) =>
  s.total_cost
    ? `${formatMoney(s.total_cost.excl_vat, s.currency)} excl. VAT${s.total_cost.incl_vat === undefined ? "" : `, ${formatMoney(s.total_cost.incl_vat, s.currency)} incl.`}`
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
      // "Show older sessions" sends the oldest start of the last list as `older`.
      const before = (field(form, "older") || field(form, "before")).trim();
      if (peerId && !UUID.test(peerId) && peerId !== DEMO_PEER_ID)
        return { ok: false, message: "Peer ID must be a UUID." };
      if (!(STATUS_FILTERS as readonly string[]).includes(status))
        return { ok: false, message: "Unknown status." };
      if (driverRef.length > 64)
        return {
          ok: false,
          message: "A driver reference is 64 characters at most.",
        };
      const beforeAt = before ? startedBefore(before) : null;
      if (before && !beforeAt)
        return {
          ok: false,
          message:
            "Started before must be a UTC day (2026-10-01) or timestamp (2026-10-01T06:00:00Z).",
        };

      const sessions = await sessionStore().listSessions({
        peerId: peerId.toLowerCase() || undefined,
        statuses:
          status === "live"
            ? OPEN_SESSION_STATUSES
            : status === "all"
              ? undefined
              : [status],
        driverRef: driverRef || undefined,
        before: beforeAt ?? undefined,
        limit: SESSION_LIST_LIMIT,
      });
      const labels = new Map<string, string>([
        [DEMO_PEER_ID, "Mock CPO (demo)"],
        ...(await peerStore().listPeers()).map(
          (p) => [p.id, p.label] as [string, string],
        ),
      ]);
      const full = sessions.length === SESSION_LIST_LIMIT;
      const oldest = sessions.at(-1)?.session.start_date_time;
      return {
        ok: true,
        message: sessions.length
          ? `${sessions.length} session(s)${full ? `, the newest ${SESSION_LIST_LIMIT}: "Show older sessions" lists the ones that started before these` : ""}.`
          : "No sessions match.",
        sessions: sessions.map((s) => row(s, labels)),
        filters: { status, peerId, driverRef, before: beforeAt ?? "" },
        // One millisecond after the oldest start, so sessions that started at the same
        // time and did not fit are on the next page too: it may repeat a row, but never
        // skips one.
        ...(full &&
          oldest && {
            nextBefore: new Date(Date.parse(oldest) + 1).toISOString(),
          }),
      };
    },
    {
      shown: () => false,
      fallback: "Could not read the sessions. Try again.",
      what: "session list",
    },
  );
}
