import type { DatabaseCheck } from "./database";

/**
 * What the setup status read reports, and how the six stops are judged from it. No
 * import from the server here: the Setup page (a client component) and the server's
 * public view judge the same status with the same code.
 *
 * The status carries no value of any setting, ever: names of variables, file names of
 * this build's own migrations, times, results and counts.
 */
export const STOP_NAMES = [
  "Environment",
  "Database",
  "Payments webhook",
  "Scheduled job",
  "First admin",
  "First peer",
] as const;

/**
 * A recorded run of the scheduled job. Few are: one when the job's outcome changes,
 * and one per 10 minutes while it fails (lib/setup/log.ts).
 */
export type JobRun = {
  at: string;
  /** Every part of the run got through. */
  ok: boolean;
  /**
   * Seconds between the payment sweep before this run and this run's start: how long
   * the job had been away. Null when no sweep had finished before.
   */
  sinceLastS: number | null;
};

export type SetupStatus = {
  checkedAt: string;
  demo: boolean;
  environment: {
    /** How many live-mode variables there are. */
    required: number;
    /**
     * Names of the unset live-mode variables; "<name> or <other>" for one that is
     * accepted under two names.
     */
    missing: string[];
    /** What is wrong with a set one, live-mode or optional: "<NAME> must ...". */
    malformed: string[];
    /** How many live-mode variables are set but malformed. */
    malformedRequired: number;
    /** DEMO_MODE is switched on. */
    demoForced: boolean;
    /** Whether each is set and well formed, never its value. */
    stripeKey: boolean;
    webhookSecret: boolean;
    cronSecret: boolean;
  };
  /** Null in demo mode, which has no database. */
  database: DatabaseCheck | null;
  /** Null: could not be read. */
  webhook: {
    /** The newest signed payment event: handled, or signed but failed here. */
    lastSigned: { at: string; result: "handled" | "failed" } | null;
    /** The newest request refused for its signature. */
    lastRefused: { at: string } | null;
  } | null;
  /** Null: could not be read. */
  job: {
    /** The last few recorded runs, newest first. */
    runs: JobRun[];
    /** When the payment sweep last finished a pass. */
    sweptAt: string | null;
  } | null;
  /** How many users are on the admin list. Null: could not be read. */
  admins: number | null;
  /** Null: could not be read. */
  peers: {
    total: number;
    registered: number;
    hubs: number;
    trustedParties: number;
  } | null;
};

/**
 * A card hold is refused when the payment sweep is older than this
 * (SWEEP_MAX_AGE_MS in lib/payments/hold.ts; a test holds the two together).
 */
export const HOLD_SWEEP_MAX_AGE_MS = 5 * 60_000;

/**
 * How often the job really runs, in seconds: the wait recorded with its newest good
 * entry. Entries are written when the job's outcome changes (lib/setup/log.ts), so the
 * newest one is how it runs now. Null: not known yet.
 */
export function jobInterval(runs: JobRun[]): number | null {
  return runs.find((r) => r.ok && r.sinceLastS !== null)?.sinceLastS ?? null;
}

/** "every minute", "every 10 minutes", "once a day". */
export function intervalWords(seconds: number): string {
  if (seconds <= 90) return "every minute";
  if (seconds < 90 * 60) return `every ${Math.round(seconds / 60)} minutes`;
  if (seconds < 20 * 3600) return `every ${Math.round(seconds / 3600)} hours`;
  if (seconds < 36 * 3600) return "once a day";
  return `every ${Math.round(seconds / 86_400)} days`;
}

/** Age of the payment sweep in milliseconds; null when it never ran. */
export function sweepAge(s: SetupStatus, now: number): number | null {
  const at = s.job?.sweptAt;
  return at ? Math.max(0, now - Date.parse(at)) : null;
}

/**
 * Whether each of the six stops passes, in the order of STOP_NAMES. A stop whose
 * facts could not be read does not pass. In demo mode none passes: there is no
 * environment to be live in, and nothing behind the other five.
 *
 * - Environment: the server is out of demo mode.
 * - Database: every shipped migration is applied.
 * - Payments webhook: both payment secrets are set and the newest signed event was
 *   handled. A refused request alone does not fail it: anyone can send one.
 * - Scheduled job: its secret is set, its newest recorded run was good (a recovery
 *   shows at most 10 minutes late), the payment sweep is fresh enough for card holds,
 *   and the job is not known to come less often than holds need.
 * - First admin: at least one user is on the admin list.
 * - First peer: at least one peer is registered.
 */
export function passes(s: SetupStatus, now: number): boolean[] {
  if (s.demo) return STOP_NAMES.map(() => false);
  const age = sweepAge(s, now);
  const every = s.job ? jobInterval(s.job.runs) : null;
  return [
    true,
    s.database?.state === "ok",
    s.environment.stripeKey &&
      s.environment.webhookSecret &&
      s.webhook?.lastSigned?.result === "handled",
    s.environment.cronSecret &&
      age !== null &&
      age <= HOLD_SWEEP_MAX_AGE_MS &&
      s.job?.runs[0]?.ok !== false &&
      (every === null || every * 1000 <= HOLD_SWEEP_MAX_AGE_MS),
    (s.admins ?? 0) > 0,
    (s.peers?.registered ?? 0) > 0,
  ];
}

/**
 * All a visitor may be shown before the first admin exists: the six fixed names, and
 * for each whether it passes. Nothing else of the status is in it.
 */
export type PublicStop = { name: string; pass: boolean };

export function publicStops(s: SetupStatus, now: number): PublicStop[] {
  const pass = passes(s, now);
  return STOP_NAMES.map((name, i) => ({ name, pass: pass[i] === true }));
}
