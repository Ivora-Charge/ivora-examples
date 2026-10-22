import "server-only";
import type { SessionStore, StoredSession } from "@/lib/sessions/store";
import {
  cleanLive,
  LiveDataError,
  type LiveData,
  type LiveDataAdapter,
  type LiveSessionRef,
} from "./adapter";

/** What the app gets for a running session: whatever live data its CPO's adapter has. */
export type SessionLive = {
  /** Ours (the stored session's ID). */
  sessionId: string;
  status: StoredSession["session"]["status"];
  /** Energy so far, as the CPO's OCPI session says. */
  kwh: number;
  /** Only the fields the adapter returned and that make sense: the app hides the rest. */
  live: LiveData;
  /** The adapter that answered, or null when nothing extra was found. */
  source: string | null;
};

type Deps = {
  sessions: SessionStore;
  adapterFor: (peerId: string) => Promise<LiveDataAdapter>;
  now?: () => number;
};

const TIMEOUT_MS = 8000;

export const liveRef = (s: StoredSession): LiveSessionRef => ({
  peerId: s.peerId,
  countryCode: s.session.country_code,
  partyId: s.session.party_id,
  sessionId: s.session.id,
  status: s.session.status,
  startDateTime: s.session.start_date_time,
  locationId: s.session.location_id,
  evseUid: s.session.evse_uid,
  connectorId: s.session.connector_id,
  tokenUid: s.session.cdr_token.uid,
});

/**
 * Live data for one of a driver's sessions. Null when the session is not that driver's
 * (the caller answers 404, never saying whose it is). Only a running session asks its
 * adapter; a failing adapter is logged by code and the session is shown without
 * extras, so the app never breaks on a CPO's API. Readings too old to be true now (a
 * suspended or offline charger) are dropped by `cleanLive`.
 */
export async function sessionLive(
  id: string,
  driverRef: string,
  deps: Deps,
): Promise<SessionLive | null> {
  const stored = await deps.sessions.getSessionById(id);
  if (!stored || stored.driverRef === null || stored.driverRef !== driverRef)
    return null;
  const base = {
    sessionId: stored.id,
    status: stored.session.status,
    kwh: stored.session.kwh,
  };
  if (stored.session.status !== "ACTIVE" || stored.completedAt)
    return { ...base, live: {}, source: null };
  let adapter: LiveDataAdapter | undefined;
  try {
    adapter = await deps.adapterFor(stored.peerId);
    const live = cleanLive(
      await adapter.getLive(liveRef(stored), AbortSignal.timeout(TIMEOUT_MS)),
      (deps.now ?? Date.now)(),
    );
    return {
      ...base,
      live,
      source: Object.keys(live).length ? adapter.kind : null,
    };
  } catch (e) {
    const code =
      e instanceof LiveDataError
        ? e.code
        : e instanceof Error && "code" in e && typeof e.code === "string"
          ? e.code
          : e instanceof Error
            ? e.name
            : "unknown";
    console.warn(
      `Live data from ${adapter?.kind ?? "adapter"} for session ${stored.id} failed: ${code}`,
    );
    return { ...base, live: {}, source: null };
  }
}
