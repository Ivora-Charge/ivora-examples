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
import { DatabaseRequestError } from "@/lib/server/supabase-rest";
import { publicStops, type PublicStop, type SetupStatus } from "./checks";
import { databaseCheck, type DatabaseCheck } from "./database";
import { lastWebhookNotes, listJobRuns } from "./log";
import { logText } from "@/lib/server/log-error";

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
    console.error(`Setup status: reading ${what} failed: ${logText(e)}`);
    return null;
  }
}

/** "No such table": the answer of a database that has not had that migration. */
const noSuchTable = (e: unknown) =>
  e instanceof DatabaseRequestError &&
  (e.code === "PGRST205" || e.code === "42P01");

/**
 * How many users are on the admin list, asked of the list itself. A database whose
 * admin table does not exist yet has nobody on it: 0. Null: could not be read.
 * `brief` reads at most one row and answers 0 or 1.
 */
async function readAdmins(
  deps: SetupDeps,
  brief: boolean,
): Promise<number | null> {
  try {
    return brief
      ? Number(await deps.accounts.hasAdmin())
      : await deps.accounts.countAdmins();
  } catch (e) {
    return noSuchTable(e)
      ? 0
      : known("the admin list", () => Promise.reject(e));
  }
}

type Gather = {
  fresh?: boolean;
  /**
   * For the public view, which tells pass or fail only: the admins and the peers are
   * asked for one row each ("is there any"), never the rows, and the numbers of them
   * in the result are 0 or 1.
   */
  brief?: boolean;
  /** The admin count, when the caller has just read it. */
  admins?: number;
};

async function gather(
  deps: SetupDeps,
  { fresh = false, brief = false, admins: adminsRead }: Gather,
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
    ? [null, null, null, null, 0, null]
    : await Promise.all([
        known("the last payment event", async () => ({
          last: await deps.payments.lastEvent(),
        })),
        known("the webhook notes", () => lastWebhookNotes(deps)),
        known("the job runs", () => listJobRuns(deps)),
        known("the payment sweep", async () => ({
          at: await deps.payments.lastSweptAt(),
        })),
        adminsRead ?? readAdmins(deps, brief),
        known("the peers", async () => {
          if (brief) {
            const any = Number(await deps.peers.hasRegisteredPeer());
            return { total: any, registered: any, hubs: 0, trustedParties: 0 };
          }
          const all = await deps.peers.listPeers();
          const registered = all.filter((p) => p.status === "registered");
          const hubs = registered.filter(isHubPeer);
          return {
            total: all.length,
            registered: registered.length,
            hubs: hubs.length,
            trustedParties: hubs.reduce(
              (n, p) => n + trustedParties(p).length,
              0,
            ),
          };
        }),
      ]);

  let lastSigned: NonNullable<SetupStatus["webhook"]>["lastSigned"] = null;
  if (events?.last)
    lastSigned = { at: events.last.receivedAt, result: "handled" };
  if (
    notes?.failedAt &&
    (!lastSigned || Date.parse(notes.failedAt) > Date.parse(lastSigned.at))
  )
    lastSigned = { at: notes.failedAt, result: "failed" };

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
    admins,
    peers:
      peers ??
      (empty ? { total: 0, registered: 0, hubs: 0, trustedParties: 0 } : null),
  };
}

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
export function readSetupStatus(
  deps: SetupDeps = setupDeps(),
  { fresh = false } = {},
): Promise<SetupStatus> {
  return gather(deps, { fresh });
}

// An admin was seen on the list: for a minute the public view is refused without
// asking again.
const ADMIN_SEEN_TTL_MS = 60_000;
/** How long the public view is served from what this process last worked out. */
export const PUBLIC_VIEW_TTL_MS = 15_000;
/** How long a visitor's page waits for the view before it goes without. */
export const PUBLIC_VIEW_DEADLINE_MS = 3_000;

type View = PublicStop[] | null;
const holder = globalThis as unknown as {
  __emspAdminSeen?: { at: number; key: string };
  __emspPublicView?: { at: number; key: string; view: View };
  __emspPublicViewFlight?: { key: string; round: Promise<View> };
};

/** The view, worked out from the database: one admin read, then six small ones. */
async function workOutView(
  deps: SetupDeps,
  now: number,
  key: string,
): Promise<View> {
  // The admin list first, and the rest only while nobody is on it.
  let admins: number | null;
  if (isDemo()) admins = await readAdmins(deps, true);
  else {
    const database = await deps.database(false).catch(() => null);
    if (!database || database.state === "unreachable") return null;
    // No tables at all: no admin list to ask. Otherwise the list itself is asked.
    admins = database.state === "empty" ? 0 : await readAdmins(deps, true);
  }
  if (admins === null) return null;
  if (admins > 0) {
    holder.__emspAdminSeen = { at: now, key };
    return null;
  }
  return publicStops(await gather(deps, { brief: true, admins }), now);
}

/**
 * What a visitor who is not signed in may see of Setup, and only before the first
 * admin exists: the six stops' fixed names and whether each passes. Null once an
 * admin exists, and whenever the server cannot tell that none does (the database does
 * not answer, the admin list cannot be read, or the reads take longer than `deadlineMs`):
 * then the page shows the sign-in prompt only, as it does for every other page.
 *
 * No value, address, key, count, time or variable name is in it; see `publicStops`.
 *
 * It is public, so it is cheap by construction. The answer is kept for
 * PUBLIC_VIEW_TTL_MS per server process, and visitors who arrive while it is being
 * worked out share that one round: any number of requests costs at most one round of
 * small reads (one row or a few each, never a whole table) per 15 seconds. The price
 * is that the view can outlive the first admin by up to those 15 seconds.
 */
export async function publicSetupView(
  deps: SetupDeps = setupDeps(),
  { deadlineMs = PUBLIC_VIEW_DEADLINE_MS } = {},
): Promise<View> {
  const now = (deps.now?.() ?? new Date()).getTime();
  const key = isDemo() ? "demo" : config.supabaseUrl;
  const seen = holder.__emspAdminSeen;
  if (seen && seen.key === key && now - seen.at < ADMIN_SEEN_TTL_MS)
    return null;
  const kept = holder.__emspPublicView;
  if (kept && kept.key === key && now - kept.at < PUBLIC_VIEW_TTL_MS)
    return kept.view;
  const flying = holder.__emspPublicViewFlight;
  if (flying?.key === key) return flying.round;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const round = Promise.race([
    Promise.resolve()
      .then(() => workOutView(deps, now, key))
      .catch((e: unknown) => {
        console.error(`Public setup view failed: ${logText(e)}`);
        return null;
      }),
    // Too slow is "cannot tell": the page goes without, and so does the next 15 s.
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deadlineMs);
      timer.unref?.();
    }),
  ])
    .then((view) => {
      holder.__emspPublicView = { at: now, key, view };
      return view;
    })
    .finally(() => {
      clearTimeout(timer);
      if (holder.__emspPublicViewFlight?.round === round)
        holder.__emspPublicViewFlight = undefined;
    });
  holder.__emspPublicViewFlight = { key, round };
  return round;
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
  holder.__emspPublicView = undefined;
  holder.__emspPublicViewFlight = undefined;
}
