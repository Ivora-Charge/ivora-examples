import "server-only";
import { accountStore } from "@/lib/accounts/registry";
import type { AccountStore } from "@/lib/accounts/store";
import { isHubPeer, trustedParties } from "@/lib/ocpi/parties";
import { peerStore } from "@/lib/ocpi/registry";
import type { PeerStore } from "@/lib/ocpi/store";
import { paymentStore } from "@/lib/payments/registry";
import type { PaymentStore } from "@/lib/payments/store";
import {
  config,
  configErrors,
  LIVE_REQUIRED,
  missingForLive,
} from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { publicStops, type PublicStop, type SetupStatus } from "./checks";
import { databaseCheck, type DatabaseCheck } from "./database";
import { lastWebhookNotes, listJobRuns } from "./log";
import { ADMINS_MIGRATION } from "./migrations";

export type SetupDeps = {
  accounts: AccountStore;
  peers: PeerStore;
  payments: PaymentStore;
  /** The database check; `fresh` asks past what the process remembers. */
  database: (fresh: boolean) => Promise<DatabaseCheck>;
  now?: () => Date;
};

export function setupDeps(): SetupDeps {
  return {
    accounts: accountStore(),
    peers: peerStore(),
    payments: paymentStore(),
    database: (fresh) => databaseCheck({ fresh }),
  };
}

const FORCED_ON = new Set(["true", "1", "yes", "on"]);

/** A read that failed is "not known" (null), by name only in the log. */
async function known<T>(
  what: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    console.error(
      `Setup status: reading ${what} failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
    return null;
  }
}

/** The admin list cannot have anyone on it while its table does not exist. */
const noAdminTable = (db: DatabaseCheck | null) =>
  db !== null &&
  (db.state === "empty" ||
    (db.state === "pending" && db.pending.includes(ADMINS_MIGRATION)));

/**
 * The one setup status read, for the Setup and Health page. It reports names, times,
 * results and counts, and no value of any setting, ever:
 *
 * - names of the unset or malformed variables, and whether the payment and job secrets
 *   are set;
 * - applied migrations against the files shipped (and "no tables");
 * - time and result of the last signed payment webhook, and time of the last refused;
 * - the last few recorded runs of the scheduled job and when the payment sweep ran;
 * - how many admins and how many peers there are.
 *
 * For a signed-in admin only; a visitor gets `publicSetupView` at most. Each part is
 * read on its own, and one that fails is reported as not known.
 */
export async function readSetupStatus(
  deps: SetupDeps = setupDeps(),
  { fresh = false } = {},
): Promise<SetupStatus> {
  const demo = isDemo();
  const missing = missingForLive();
  const errors = configErrors();
  const required: readonly string[] = LIVE_REQUIRED;
  const database = demo
    ? null
    : await deps.database(fresh).catch((): DatabaseCheck => ({
        state: "unreachable",
        shipped: 0,
        applied: 0,
        pending: [],
        newest: null,
      }));
  // With no tables there is nothing to read, and nothing is asked.
  const empty = database?.state === "empty";
  const [events, notes, runs, sweptAt, admins, peers] = empty
    ? [null, null, null, null, null, null]
    : await Promise.all([
        known("the last payment event", async () => ({
          last: await deps.payments.lastEvent(),
        })),
        known("the webhook notes", () => lastWebhookNotes(deps)),
        known("the job runs", () => listJobRuns(deps)),
        known("the payment sweep", async () => ({
          at: await deps.payments.lastSweptAt(),
        })),
        known("the admin list", () => deps.accounts.countAdmins()),
        known("the peers", () => deps.peers.listPeers()),
      ]);

  let lastSigned: NonNullable<SetupStatus["webhook"]>["lastSigned"] = null;
  if (events?.last)
    lastSigned = { at: events.last.receivedAt, result: "handled" };
  if (
    notes?.failedAt &&
    (!lastSigned || Date.parse(notes.failedAt) > Date.parse(lastSigned.at))
  )
    lastSigned = { at: notes.failedAt, result: "failed" };
  const registered = peers?.filter((p) => p.status === "registered") ?? [];
  const hubs = registered.filter(isHubPeer);

  return {
    checkedAt: (deps.now?.() ?? new Date()).toISOString(),
    demo,
    environment: {
      required: required.length,
      missing,
      malformed: errors,
      // A malformed live-mode setting is not "present and well formed" either.
      malformedRequired: required.filter((name) =>
        errors.some((e) => e.startsWith(`${name} `)),
      ).length,
      demoForced: FORCED_ON.has(
        process.env.DEMO_MODE?.trim().toLowerCase() ?? "",
      ),
      stripeKey: config.stripeSecretKey !== undefined,
      webhookSecret: config.stripeWebhookSecret !== undefined,
      cronSecret: config.cronSecret !== undefined,
    },
    database,
    webhook:
      events && notes
        ? {
            lastSigned,
            lastRefused: notes.refusedAt ? { at: notes.refusedAt } : null,
          }
        : null,
    job: runs && sweptAt ? { runs, sweptAt: sweptAt.at } : null,
    admins: admins ?? (noAdminTable(database) ? 0 : null),
    peers: peers
      ? {
          total: peers.length,
          registered: registered.length,
          hubs: hubs.length,
          trustedParties: hubs.reduce(
            (n, p) => n + trustedParties(p).length,
            0,
          ),
        }
      : empty
        ? { total: 0, registered: 0, hubs: 0, trustedParties: 0 }
        : null,
  };
}

// An admin was seen on the list: for a minute the public view is refused without
// asking again. "No admin" is never remembered, so the view is gone with the first
// read after the first admin is added.
const ADMIN_SEEN_TTL_MS = 60_000;
const holder = globalThis as unknown as {
  __emspAdminSeen?: { at: number; key: string };
};

/**
 * What a visitor who is not signed in may see of Setup, and only before the first
 * admin exists: the six stops' fixed names and whether each passes. Null as soon as
 * an admin exists, and whenever the server cannot tell that none does (the database
 * does not answer, or the admin list cannot be read): then the page shows the sign-in
 * prompt only, as it does for every other page.
 *
 * No value, address, key, count, time or variable name is in it; see `publicStops`.
 */
export async function publicSetupView(
  deps: SetupDeps = setupDeps(),
): Promise<PublicStop[] | null> {
  const now = (deps.now?.() ?? new Date()).getTime();
  const key = isDemo() ? "demo" : config.supabaseUrl;
  const seen = holder.__emspAdminSeen;
  if (seen && seen.key === key && now - seen.at < ADMIN_SEEN_TTL_MS)
    return null;
  // The admin list first, and the rest only while nobody is on it.
  let admins: number | null;
  if (isDemo())
    admins = await known("the admin list", () => deps.accounts.countAdmins());
  else {
    const database = await deps.database(false).catch(() => null);
    if (!database || database.state === "unreachable") return null;
    admins = noAdminTable(database)
      ? 0
      : await known("the admin list", () => deps.accounts.countAdmins());
  }
  if (admins === null) return null;
  if (admins > 0) {
    holder.__emspAdminSeen = { at: now, key };
    return null;
  }
  const status = await readSetupStatus(deps);
  // Read again with the rest: an admin added in between ends the view too.
  return status.admins === 0 ? publicStops(status, now) : null;
}

/**
 * Whether the public status API may say "live": the environment is complete and the
 * database has every shipped migration. Out of demo mode with a database that is not
 * ready (no tables, pending migrations, no answer), the API says "setup".
 */
export async function databaseReady(
  deps: Pick<SetupDeps, "database"> = setupDeps(),
): Promise<boolean> {
  try {
    return (await deps.database(false)).state === "ok";
  } catch {
    return false;
  }
}

export function resetPublicSetupViewForTests() {
  holder.__emspAdminSeen = undefined;
}
