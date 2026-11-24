import "server-only";
import { after } from "next/server";
import type { PeerStore } from "@/lib/ocpi/store";
import { logText } from "@/lib/server/log-error";
import { HOLD_SWEEP_MAX_AGE_MS, type JobRun } from "./checks";

/**
 * What Setup needs remembered, kept in the audit log the server already has (so no new
 * table): the scheduled job's outcome, and payment webhook requests that were refused
 * or failed. Each kind has its own subject, read back newest first.
 *
 * The audit log is append-only: an entry written is kept. So these are written rarely,
 * by one rule for all three kinds:
 *
 * - only when something is wrong, or has just stopped being wrong: a deployment where
 *   everything works adds no entry;
 * - at most one entry of a kind per 10 minutes, however often the job runs and
 *   whoever sends requests. While something stays wrong that is one "still failing"
 *   entry per window.
 *
 * MAX_SETUP_ROWS_PER_DAY is what that comes to at worst. No entry holds anything of
 * the request or the run but its time and outcome.
 */
export const JOB_SUBJECT = "setup:job";
export const WEBHOOK_SUBJECT = "setup:stripe-webhook";

export const JOB_RUN = "job.run";
export const WEBHOOK_REFUSED = "webhook.refused";
export const WEBHOOK_FAILED = "webhook.failed";

/** At most one job entry is written per this long. */
export const JOB_SAMPLE_MS = 10 * 60_000;
/** At most one refused request is recorded per this long. */
export const REFUSED_SAMPLE_MS = 10 * 60_000;
/** At most one failed signed event is recorded per this long. */
export const FAILED_SAMPLE_MS = 10 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
/**
 * The most entries the three kinds together add to the audit log in a day, when the
 * job fails or flaps all day, every signed event fails and unsigned requests never
 * stop: 144 of each, 432. (Per kind, counted from one entry to the next. Two server
 * processes that check in the same instant can each write one.)
 */
export const MAX_SETUP_ROWS_PER_DAY =
  Math.ceil(DAY_MS / JOB_SAMPLE_MS) +
  Math.ceil(DAY_MS / REFUSED_SAMPLE_MS) +
  Math.ceil(DAY_MS / FAILED_SAMPLE_MS);

type Deps = { peers: PeerStore; now?: () => Date };
const nowOf = (deps: Deps) => deps.now?.() ?? new Date();

const failed = (what: string, e: unknown) =>
  console.error(`Recording ${what} failed: ${logText(e)}`);

/**
 * How a run of the job stands. "pass": every part got through, and it came soon enough
 * after the last payment sweep for card holds. "fail": a part failed, or the job had
 * been away too long. "unknown": every part got through, but no sweep had finished
 * before it, so its pace cannot be told yet.
 */
type JobState = "pass" | "fail" | "unknown";
const jobState = (ok: boolean, sinceS: number | null): JobState =>
  !ok
    ? "fail"
    : sinceS === null
      ? "unknown"
      : sinceS * 1000 <= HOLD_SWEEP_MAX_AGE_MS
        ? "pass"
        : "fail";

/**
 * Records a run of the scheduled job when it says something new, and never more than
 * one per JOB_SAMPLE_MS:
 *
 * - a run that fails, or comes too rarely for card holds: the first, then one "still
 *   failing" entry per window;
 * - the first good run after those (within a window of the last entry it waits for
 *   the window to end, so a job that flaps writes one entry per window, not per run);
 * - the first good run of a new deployment whose pace is known (its second run).
 *
 * A job that runs every minute and works therefore adds one entry, once. The newest
 * entry says how the job is doing, at most one window late. With `sweptBefore`, when
 * the payment sweep had last finished before this run, the entry says how long the job
 * had been away: that is how the page tells "every minute" from "once a day". Never
 * throws.
 */
export async function recordJobRun(
  deps: Deps,
  run: { ok: boolean; startedAt: Date; sweptBefore: string | null },
): Promise<boolean> {
  try {
    const away = run.sweptBefore
      ? Math.round(
          (run.startedAt.getTime() - Date.parse(run.sweptBefore)) / 1000,
        )
      : null;
    const since = away !== null && away >= 0 ? away : null;
    const state = jobState(run.ok, since);
    const [last] = await deps.peers.listAudit(JOB_SUBJECT, 1);
    if (last && nowOf(deps).getTime() - Date.parse(last.at) < JOB_SAMPLE_MS)
      return false;
    const before = last
      ? jobState(
          last.details?.ok === true,
          typeof last.details?.since_last_s === "number"
            ? last.details.since_last_s
            : null,
        )
      : null;
    // Nothing new: still good, or good with nothing bad before it.
    if (state === "pass" && before === "pass") return false;
    if (state === "unknown" && before !== "fail") return false;
    await deps.peers.audit({
      actor: "cron",
      action: JOB_RUN,
      subjectId: JOB_SUBJECT,
      details: { ok: run.ok, since_last_s: since },
    });
    return true;
  } catch (e) {
    failed("the job run", e);
    return false;
  }
}

/** The last few recorded entries of the job, newest first. */
export async function listJobRuns(deps: Deps, limit = 5): Promise<JobRun[]> {
  return (await deps.peers.listAudit(JOB_SUBJECT, limit))
    .filter((e) => e.action === JOB_RUN)
    .map((e) => ({
      at: e.at,
      ok: e.details?.ok === true,
      sinceLastS:
        typeof e.details?.since_last_s === "number"
          ? e.details.since_last_s
          : null,
    }));
}

// When this server process last recorded each kind: the first, cheap limit, so a
// flood of unsigned requests costs no database read either.
const holder = globalThis as unknown as {
  __emspWebhookNoted?: Record<string, number>;
  __emspWebhookPending?: Set<Promise<unknown>>;
};
const pending = () => (holder.__emspWebhookPending ??= new Set());

type WebhookNote = typeof WEBHOOK_REFUSED | typeof WEBHOOK_FAILED;
const sampleMs = (action: WebhookNote) =>
  action === WEBHOOK_REFUSED ? REFUSED_SAMPLE_MS : FAILED_SAMPLE_MS;

/** Whether this process may record `action` now; if so, it counts as recorded. */
function due(action: WebhookNote, now: number): boolean {
  const noted = (holder.__emspWebhookNoted ??= {});
  if (noted[action] !== undefined && now - noted[action] < sampleMs(action))
    return false;
  noted[action] = now;
  return true;
}

async function writeNote(
  deps: Deps,
  action: WebhookNote,
  now: number,
): Promise<boolean> {
  try {
    // The newest entry of this kind, asked for by kind: entries of the other kind
    // cannot hide it.
    const [last] = await deps.peers.listAudit(WEBHOOK_SUBJECT, 1, action);
    if (last && now - Date.parse(last.at) < sampleMs(action)) {
      // Another process wrote it: this one's window runs from that entry too.
      (holder.__emspWebhookNoted ??= {})[action] = Date.parse(last.at);
      return false;
    }
    await deps.peers.audit({
      actor: "stripe-webhook",
      action,
      subjectId: WEBHOOK_SUBJECT,
    });
    return true;
  } catch (e) {
    failed("the webhook outcome", e);
    return false;
  }
}

/**
 * Records that a payment webhook request was refused for its signature
 * (WEBHOOK_REFUSED), or was signed but could not be handled (WEBHOOK_FAILED): the
 * first, then at most one per window while it goes on. A handled event writes nothing
 * here (it is in the payment events already). Limited per server process and, across
 * processes, by the newest entry of its kind. Never throws.
 */
export async function noteWebhook(
  deps: Deps,
  action: WebhookNote,
): Promise<boolean> {
  const now = nowOf(deps).getTime();
  return due(action, now) ? writeNote(deps, action, now) : false;
}

/** How long the response's function is kept for a note written after the response. */
export const NOTE_WAIT_MS = 3_000;

/**
 * `noteWebhook` for the webhook route: the answer to the sender never waits for the
 * note. The per-process limit is checked at once; the database read and write run
 * once the response has been sent (Next's `after`, which keeps a serverless function
 * for it, for at most NOTE_WAIT_MS), or outside a request just start. Never throws.
 */
export function noteWebhookLater(deps: Deps, action: WebhookNote): void {
  const now = nowOf(deps).getTime();
  if (!due(action, now)) return;
  const run = () => {
    const note = writeNote(deps, action, now).finally(() =>
      pending().delete(note),
    );
    pending().add(note);
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      note,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, NOTE_WAIT_MS);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

/** Waits for the notes started so far (tests). */
export async function flushWebhookNotesForTests(): Promise<void> {
  while (pending().size) await Promise.all([...pending()]);
}

/** The newest refused request and the newest failed signed event, if any. */
export async function lastWebhookNotes(
  deps: Deps,
): Promise<{ refusedAt: string | null; failedAt: string | null }> {
  const entries = await deps.peers.listAudit(WEBHOOK_SUBJECT, 20);
  const at = (action: string) =>
    entries.find((e) => e.action === action)?.at ?? null;
  return { refusedAt: at(WEBHOOK_REFUSED), failedAt: at(WEBHOOK_FAILED) };
}

export function resetWebhookNotesForTests() {
  holder.__emspWebhookNoted = undefined;
  holder.__emspWebhookPending = undefined;
}
