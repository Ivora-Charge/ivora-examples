import "server-only";
import type { PeerStore } from "@/lib/ocpi/store";
import type { JobRun } from "./checks";

/**
 * What Setup needs remembered, kept in the audit log the server already has (so no new
 * table): runs of the scheduled job, and payment webhook requests that were refused or
 * failed. Each kind has its own subject, read back newest first.
 *
 * The audit log is append-only, so entries are thinned where they are written: the job
 * runs every minute and anyone can send a request with a wrong signature. No entry
 * holds anything of the request or the run but its time and outcome.
 */
export const JOB_SUBJECT = "setup:job";
export const WEBHOOK_SUBJECT = "setup:stripe-webhook";

export const JOB_RUN = "job.run";
export const WEBHOOK_REFUSED = "webhook.refused";
export const WEBHOOK_FAILED = "webhook.failed";

/** A run is recorded when the last recorded one is this old, or ended differently. */
export const JOB_SAMPLE_MS = 60 * 60_000;
/** At most one refused request is recorded per this long. */
export const REFUSED_SAMPLE_MS = 10 * 60_000;
/** At most one failed signed event is recorded per this long. */
export const FAILED_SAMPLE_MS = 60_000;

type Deps = { peers: PeerStore; now?: () => Date };
const nowOf = (deps: Deps) => deps.now?.() ?? new Date();

const failed = (what: string, e: unknown) =>
  console.error(
    `Recording ${what} failed: ${e instanceof Error ? e.name : "unknown error"}`,
  );

/**
 * Records a run of the scheduled job: the first, then one an hour, and any run that
 * ended differently from the last recorded one (so the newest entry always says how
 * the job is doing now). With `sweptBefore`, when the payment sweep had last finished
 * before this run, the entry says how long the job had been away: that is how the page
 * tells "every minute" from "once a day" without an entry per run. Never throws.
 */
export async function recordJobRun(
  deps: Deps,
  run: { ok: boolean; startedAt: Date; sweptBefore: string | null },
): Promise<boolean> {
  try {
    const [last] = await deps.peers.listAudit(JOB_SUBJECT, 1);
    if (
      last &&
      last.details?.ok === run.ok &&
      nowOf(deps).getTime() - Date.parse(last.at) < JOB_SAMPLE_MS
    )
      return false;
    const since = run.sweptBefore
      ? Math.round(
          (run.startedAt.getTime() - Date.parse(run.sweptBefore)) / 1000,
        )
      : null;
    await deps.peers.audit({
      actor: "cron",
      action: JOB_RUN,
      subjectId: JOB_SUBJECT,
      details: {
        ok: run.ok,
        since_last_s: since !== null && since >= 0 ? since : null,
      },
    });
    return true;
  } catch (e) {
    failed("the job run", e);
    return false;
  }
}

/** The last few recorded runs, newest first. */
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
};

/**
 * Records that a payment webhook request was refused for its signature
 * (WEBHOOK_REFUSED), or was signed but could not be handled (WEBHOOK_FAILED). Thinned
 * per server process and, across processes, by the newest entry of its kind. Never
 * throws.
 */
export async function noteWebhook(
  deps: Deps,
  action: typeof WEBHOOK_REFUSED | typeof WEBHOOK_FAILED,
): Promise<boolean> {
  const every =
    action === WEBHOOK_REFUSED ? REFUSED_SAMPLE_MS : FAILED_SAMPLE_MS;
  const now = nowOf(deps).getTime();
  const noted = (holder.__emspWebhookNoted ??= {});
  if (noted[action] !== undefined && now - noted[action] < every) return false;
  noted[action] = now;
  try {
    const last = (await deps.peers.listAudit(WEBHOOK_SUBJECT, 10)).find(
      (e) => e.action === action,
    );
    if (last && now - Date.parse(last.at) < every) return false;
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
}
