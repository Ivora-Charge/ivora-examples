"use server";

import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { asAdmin as gate, field } from "@/lib/server/admin-action";
import { sessionStore } from "@/lib/sessions/registry";
import { STATUS_FILTERS } from "./filters";
import { peerLabels, sessionRow, type SessionRow } from "./rows";
import {
  filterCount,
  OPEN_SESSION_STATUSES,
  sessionSearchTerm,
  type SessionCounts,
} from "@/lib/sessions/statuses";

export type { SessionRow };

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
    search: string;
    before: string;
  };
  /**
   * What the peer, driver and search filters match, whatever the status chip and
   * "started before": the chips' numbers. `total` is the sum of the statuses. With a
   * search term each status is counted up to 500 (`SESSION_SEARCH_COUNT_CAP`), and `more` names those with more.
   */
  counts?: SessionCounts;
  /** What the status chip, peer, driver and search match: the "128" of "8 of 128". */
  listTotal?: number;
  /** The list total is a capped count: there are more ("8 of 500+"). */
  listTotalMore?: boolean;
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
      const searchText = field(form, "search").trim();
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
      const search = searchText ? sessionSearchTerm(searchText) : null;
      if (searchText && !search)
        return {
          ok: false,
          message:
            "Search takes up to 64 letters, digits, spaces and . : @ / + - _ (a driver, charger or session reference).",
        };
      const beforeAt = before ? startedBefore(before) : null;
      if (before && !beforeAt)
        return {
          ok: false,
          message:
            "Started before must be a UTC day (2026-10-01) or timestamp (2026-10-01T06:00:00Z).",
        };

      const scope = {
        peerId: peerId.toLowerCase() || undefined,
        driverRef: driverRef || undefined,
        search: search ?? undefined,
      };
      const [counts, sessions] = await Promise.all([
        sessionStore().countSessions(scope),
        sessionStore().listSessions({
          ...scope,
          statuses:
            status === "live"
              ? OPEN_SESSION_STATUSES
              : status === "all"
                ? undefined
                : [status],
          before: beforeAt ?? undefined,
          limit: SESSION_LIST_LIMIT,
        }),
      ]);
      const { n: listTotal, more: listTotalMore } = filterCount(status, counts);
      const labels = await peerLabels();
      const full = sessions.length === SESSION_LIST_LIMIT;
      const oldest = sessions.at(-1)?.session.start_date_time;
      return {
        ok: true,
        message: sessions.length
          ? `${sessions.length} of ${Math.max(listTotal, sessions.length)}${listTotalMore ? "+" : ""} session(s)${full ? `, the newest ${SESSION_LIST_LIMIT}: "Show older sessions" lists the ones that started before these` : ""}.`
          : "No sessions match.",
        sessions: sessions.map((s) => sessionRow(s, labels)),
        counts,
        listTotal,
        ...(listTotalMore && { listTotalMore }),
        filters: {
          status,
          peerId,
          driverRef,
          search: search ?? "",
          before: beforeAt ?? "",
        },
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
