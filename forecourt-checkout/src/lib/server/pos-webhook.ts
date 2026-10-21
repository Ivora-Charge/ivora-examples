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
// few seconds apart; if all fail, the next read of the sale after a growing
// backoff runs it again. Every attempt carries the same event ID and body
// with a fresh signature timestamp. The POS must de-duplicate by event ID: a
// cold start or another instance may send an event again.

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
const MAX_TRACKED = 1000;

type State =
  | { status: "sending" }
  | { status: "delivered" }
  | { status: "waiting"; runs: number; nextAt: number }
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
    const state = this.states.get(event.id);
    if (state && state.status !== "waiting") return;
    if (state?.status === "waiting" && this.now() < state.nextAt) return;
    const runs = state?.status === "waiting" ? state.runs : 0;
    this.track(event.id, { status: "sending" });
    this.schedule(async () => {
      let result: RunResult;
      try {
        result = await this.run(event);
      } catch {
        result = "failed";
      }
      if (result === "delivered") this.track(event.id, { status: "delivered" });
      else if (result === "rejected" || runs >= POS_RUN_BACKOFF_MS.length) {
        this.track(event.id, { status: "gave_up" });
        this.config.log?.("pos webhook gave up", { event: event.id, result });
      } else
        this.track(event.id, {
          status: "waiting",
          runs: runs + 1,
          nextAt: this.now() + POS_RUN_BACKOFF_MS[runs],
        });
    });
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

  private track(id: string, state: State) {
    this.states.delete(id);
    this.states.set(id, state);
    if (this.states.size > MAX_TRACKED)
      this.states.delete(this.states.keys().next().value!);
  }
}
