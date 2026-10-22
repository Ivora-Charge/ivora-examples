import "server-only";
import { startedSessionOwner, type SessionOwner } from "@/lib/commands/manage";
import type { SessionStore } from "./store";

/**
 * Whose session a CPO's session is, for STOP_SESSION (the commands' `sessionOwner`):
 * the driver whose start it links to, else the driver of the token it runs on (a
 * session started with an RFID card, say), from the sessions we hold. When the peer has
 * the same session ID at several of its parties, for different drivers, nobody owns
 * it: a stop is never a guess.
 */
export function sessionOwner(sessions: SessionStore): SessionOwner {
  return async (peerId, sessionId, deps) => {
    const started = await startedSessionOwner(peerId, sessionId, deps);
    if (started) return started;
    const held = (await sessions.findSessions(peerId, sessionId)).filter(
      (s) => s.driverRef !== null,
    );
    if (held.length !== 1) return null;
    const [s] = held;
    return {
      driverRef: s.driverRef!,
      party: {
        countryCode: s.session.country_code,
        partyId: s.session.party_id,
      },
    };
  };
}
