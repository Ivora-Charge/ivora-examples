import "server-only";
import {
  POS_EVENT_HEADER,
  POS_SIGNATURE_HEADER,
  sessionDueBody,
  signPosBody,
} from "../pos";
import type { SaleDueEvent } from "../store";

// The outbound `session_due` webhook. A sale is read many times (console
// polls, Ivora webhooks, the sweep), so offer() is called many times for the
// same event; it sends once per event ID per server instance, and only
// retries a delivery that failed. One delivery run tries up to three times a
// few seconds apart; if all fail, the next read of the sale or the sweep
// (retryDue()) after a growing backoff runs it again. A run that never
// finished (the route hit its time limit while it ran after the response)
// counts as failed once POS_SENDING_STALE_MS has passed. Every attempt
// carries the same event ID and body with a fresh signature timestamp. The
// POS must de-duplicate by event ID: a cold start or another instance may
// send an event again. State is in memory, so the POS should also poll
// GET /api/pos/sessions?status=due as its backstop.

/** Waits before each attempt within one delivery run. */
export const POS_ATTEMPT_DELAYS_MS = [0, 1_000, 4_000];
/** After a failed run, the next run waits this long (then gives up). */
export const POS_RUN_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];
export const POS_TIMEOUT_MS = 5_000;
/**
 * A run still "sending" after this long was cut off: retry it. Longer than a
 * whole run (the attempt delays plus three timeouts, about 20 s).
 */
export const POS_SENDING_STALE_MS = 60_000;
const MAX_TRACKED = 1000;

/** `runs`: failed or cut-off runs before the current one. */
type State =
  | { status: "sending"; runs: number; since: number; event: SaleDueEvent }
  | { status: "delivered" }
  | { status: "waiting"; runs: number; nextAt: number; event: SaleDueEvent }
  | { status: "gave_up" };

export type PosOutboxConfig = {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Runs delivery after the response (Next's after()); tests run it directly. */
  schedule?: (task: () => Promise<void>) => void;
  log?: (message: string, details: Record<string, unknown>) => void;
};

/** "delivered"; "rejected" (a 4xx the POS won't change its mind about); "failed" (retry later). */
export type RunResult = "delivered" | "rejected" | "failed";

const retryable = (status: number) =>
  status === 408 || status === 429 || status >= 500;

export class PosOutbox {
  private readonly states = new Map<string, State>();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly schedule: (task: () => Promise<void>) => void;

  constructor(private readonly config: PosOutboxConfig) {
    if (!config.url || !config.secret)
      throw new Error("The POS webhook needs a URL and a secret.");
    this.fetcher = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
    this.sleep =
      config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.schedule = config.schedule ?? ((task) => void task());
  }

  /** A sale was read as due. Sends its event unless it was sent or is waiting to retry. */
  offer(event: SaleDueEvent) {
    const now = this.now();
    const state = this.states.get(event.id);
    let runs = 0;
    if (state?.status === "delivered" || state?.status === "gave_up") return;
    if (state?.status === "waiting") {
      if (now < state.nextAt) return;
      runs = state.runs;
    }
    if (state?.status === "sending") {
      if (now - state.since < POS_SENDING_STALE_MS) return;
      // That run was cut off before it recorded a result: count it as failed.
      runs = state.runs + 1;
      if (runs > POS_RUN_BACKOFF_MS.length) {
        this.giveUp(event.id, "failed");
        return;
      }
    }
    const sending: State = { status: "sending", runs, since: now, event };
    this.track(event.id, sending);
    this.schedule(async () => {
      let result: RunResult;
      try {
        result = await this.run(event);
      } catch {
        result = "failed";
      }
      if (result === "delivered") {
        this.track(event.id, { status: "delivered" });
        return;
      }
      // A newer run took over from this one (it was taken for cut off): leave it be.
      if (this.states.get(event.id) !== sending) return;
      if (result === "rejected" || runs >= POS_RUN_BACKOFF_MS.length)
        this.giveUp(event.id, result);
      else
        this.track(event.id, {
          status: "waiting",
          runs: runs + 1,
          nextAt: this.now() + POS_RUN_BACKOFF_MS[runs],
          event,
        });
    });
  }

  /**
   * The sweep: run every event whose backoff has passed, or whose run was cut
   * off, without waiting for its sale to be read again. Returns how many it started.
   */
  retryDue() {
    const now = this.now();
    const due: SaleDueEvent[] = [];
    for (const state of this.states.values())
      if (
        (state.status === "waiting" && now >= state.nextAt) ||
        (state.status === "sending" &&
          now - state.since >= POS_SENDING_STALE_MS)
      )
        due.push(state.event);
    for (const event of due) this.offer(event);
    return due.filter((e) => this.states.get(e.id)?.status === "sending")
      .length;
  }

  /** One delivery run: up to POS_ATTEMPT_DELAYS_MS.length attempts. */
  async run(event: SaleDueEvent): Promise<RunResult> {
    const body = sessionDueBody(event);
    for (const delay of POS_ATTEMPT_DELAYS_MS) {
      if (delay) await this.sleep(delay);
      const t = Math.floor(this.now() / 1000);
      let status: number;
      try {
        const response = await this.fetcher(this.config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "forecourt-checkout",
            [POS_SIGNATURE_HEADER]: signPosBody(this.config.secret, body, t),
            [POS_EVENT_HEADER]: event.id,
          },
          body,
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(POS_TIMEOUT_MS),
        });
        status = response.status;
      } catch (error) {
        this.config.log?.("pos webhook unreachable", {
          event: event.id,
          error: error instanceof Error ? error.name : "unknown",
        });
        continue;
      }
      if (status >= 200 && status < 300) return "delivered";
      this.config.log?.("pos webhook refused", { event: event.id, status });
      if (!retryable(status)) return "rejected";
    }
    return "failed";
  }

  private giveUp(id: string, result: RunResult) {
    this.track(id, { status: "gave_up" });
    this.config.log?.("pos webhook gave up", { event: id, result });
  }

  private track(id: string, state: State) {
    this.states.delete(id);
    this.states.set(id, state);
    if (this.states.size > MAX_TRACKED)
      this.states.delete(this.states.keys().next().value!);
  }
}
