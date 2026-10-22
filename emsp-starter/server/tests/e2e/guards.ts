import { randomUUID } from "node:crypto";
import type { CommandStatus } from "@/lib/commands/store";
import type { DriverToken } from "@/lib/tokens/store";
import { waitFor, type Harness } from "./harness";

/**
 * What the OCPI e2e suite (ocpi.e2e.ts) does so that a run never leaves a real charger
 * charging, and never passes a check on answers that were not about this run.
 */

/**
 * After these, a charger may be running: the CPO took the start (or its answer never
 * reached us). After any other status it refused the start, or never got it.
 */
const MAY_RUN: readonly CommandStatus[] = [
  "sending",
  "accepted",
  "succeeded",
  "timed_out",
];

export type Leftover =
  /** No start, or the CPO did not take it. */
  | { outcome: "none" }
  /** The start's session has ended already. */
  | { outcome: "ended"; sessionId: string }
  /** We sent STOP_SESSION and the CPO stopped the session. */
  | { outcome: "stopped"; sessionId: string }
  /** We could not stop it: `instruction` says how to, on the CPO side. */
  | { outcome: "left_running"; instruction: string };

/**
 * Stops whatever a START_SESSION of this run may have started, before the eMSP
 * unregisters: also a start the CPO accepted while the run expected it refused, or one
 * whose session took too long to link. Waits (at most `timeoutMs` for each) for the
 * session link, then for the STOP_SESSION result. When neither works, prints how to
 * stop it at the CPO: its authorization_reference, location and EVSE.
 */
export async function stopLeftoverStart(
  h: Pick<Harness, "api" | "cpo" | "stores" | "waitMs" | "pollMs">,
  run: { startId?: string; accessToken?: string },
  {
    timeoutMs = h.waitMs,
    tick,
    warn = (m: string) => console.error(m),
  }: {
    timeoutMs?: number;
    tick?: () => Promise<void>;
    warn?: (message: string) => void;
  } = {},
): Promise<Leftover> {
  const start = run.startId && (await h.stores.commands.get(run.startId));
  if (!start) return { outcome: "none" };
  if (!start.sessionId && !MAY_RUN.includes(start.status))
    return { outcome: "none" };

  const leftRunning = (why: string): Leftover => {
    const instruction =
      `A START_SESSION the CPO accepted may still be charging: ${why}. ` +
      `Stop it on the CPO side: authorization_reference ${start.authorizationReference ?? "(none)"}, ` +
      `location ${start.locationId ?? "(none)"}, EVSE ${start.evseUid ?? "(any)"}.`;
    warn(instruction);
    return { outcome: "left_running", instruction };
  };
  const wait = <T>(what: string, check: () => Promise<T | undefined>) =>
    waitFor(h, what, check, { timeoutMs, tick }).catch(() => undefined);

  // The session link, unless the CPO's CommandResult says it never started.
  const settled = await wait("the session link", async () => {
    const c = await h.stores.commands.get(start.id);
    return c && (c.sessionId || !MAY_RUN.includes(c.status)) ? c : undefined;
  });
  const now = settled ?? (await h.stores.commands.get(start.id));
  if (!now) return { outcome: "none" };
  if (!now.sessionId) {
    if (!MAY_RUN.includes(now.status)) return { outcome: "none" };
    return leftRunning(
      `its session was not linked within ${Math.round(timeoutMs / 1000)} s`,
    );
  }
  const sessionId = now.sessionId;
  const ended = async () => {
    const [s] = await h.stores.sessions.findSessions(start.peerId, sessionId);
    return s?.completedAt ? true : undefined;
  };
  if (await ended()) return { outcome: "ended", sessionId };
  if (!run.accessToken) return leftRunning("the driver is not signed in");

  const res = await h
    .api("POST", `/api/v1/charges/${start.id}/stop`, {
      token: run.accessToken,
      body: { requestId: `e2e-cleanup-${randomUUID()}` },
    })
    .catch(() => undefined);
  const stop = res?.body.command as { id: string } | undefined;
  if (!res || res.status >= 300 || !stop)
    return leftRunning(
      `STOP_SESSION was refused (HTTP ${res?.status ?? "error"})`,
    );
  const sent = await h.stores.commands.get(stop.id);
  if (!sent || !MAY_RUN.includes(sent.status) || sent.status === "timed_out")
    return leftRunning(`the CPO answered STOP_SESSION ${sent?.status}`);
  await h.cpo.finish(sessionId);
  const result = await wait("the STOP_SESSION result", async () => {
    const c = await h.stores.commands.get(stop.id);
    return c && c.status !== "sending" && c.status !== "accepted"
      ? c
      : undefined;
  });
  if (result?.status === "succeeded" || (await ended()))
    return { outcome: "stopped", sessionId };
  return leftRunning(
    result
      ? `STOP_SESSION ended ${result.status}`
      : `no STOP_SESSION result within ${Math.round(timeoutMs / 1000)} s`,
  );
}

/**
 * The CPO's real-time authorization requests (our answers, from the audit log) about
 * this run's own tokens. A CPO's sandbox may ask about anyone's tokens; only these say
 * anything about this run.
 */
export function authorizationsAsked(
  h: Pick<Harness, "stores">,
  tokens: Pick<DriverToken, "id">[],
) {
  const ours = new Set(tokens.map((t) => t.id));
  return h.stores.peers.auditLog
    .filter(
      (a) =>
        a.action === "token.authorize" &&
        a.subjectId != null &&
        ours.has(a.subjectId),
    )
    .map((a) => ({
      tokenId: a.subjectId!,
      ...(a.details as { allowed: string; type: string }),
    }));
}
