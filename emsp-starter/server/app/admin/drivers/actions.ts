"use server";

import { accountStore } from "@/lib/accounts/registry";
import {
  emailSearchTerm,
  type Driver,
  type DriverCounts,
  type DriverCursor,
} from "@/lib/accounts/store";
import { driverAppStore } from "@/lib/driver-app/registry";
import { peerStore } from "@/lib/ocpi/registry";
import { paymentStore } from "@/lib/payments/registry";
import type { Payment } from "@/lib/payments/store";
import { asAdmin as gate, field } from "@/lib/server/admin-action";
import { sessionStore } from "@/lib/sessions/registry";
import { tokenValid } from "@/lib/tokens/push";
import { tokenStore } from "@/lib/tokens/registry";
import { peerLabels, sessionRow, type SessionRow } from "../sessions/rows";
import { isDriverReference } from "./reference";

/** The state of a driver's app token, or "none" when they have none. */
export type AppTokenState = "none" | "active" | "blocked" | "expired";

/** An account as the admin web shows it: never card data or Stripe IDs. */
export type DriverRow = {
  id: string;
  /** Null for an admin-secret session: emails go to an admin signed in by email. */
  email: string | null;
  status: Driver["status"];
  hasCard: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  appToken: AppTokenState;
  openProblems: number;
};

export type DriversState = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
  drivers?: DriverRow[];
  counts?: DriverCounts;
  /** The filter of this list: whether it narrows, and the reference it asked for. */
  filtered?: boolean;
  reference?: string;
  /** When there are older accounts: what "Show older" sends back as `older`. */
  next?: string;
  /** There are more open reports than were read: the problem counts are at least. */
  problemsCapped?: boolean;
};

export type PaymentLine = Pick<
  Payment,
  | "id"
  | "status"
  | "currency"
  | "holdAmount"
  | "capturedAmount"
  | "refundedAmount"
  | "review"
  | "reviewedAt"
  | "createdAt"
>;

export type DriverPageState = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
  /** Null: nobody has signed in with this reference, so there is no account. */
  account?: DriverRow | null;
  /** Newest first, at most RECENT of each. */
  sessions?: SessionRow[];
  payments?: PaymentLine[];
  openProblems?: number;
  problemsCapped?: boolean;
};

/** Accounts per page of the list. */
const PAGE_SIZE = 25;
/** Sessions and payments on a driver's page. */
const RECENT = 10;
/** Open problem reports read for the counts: the most the database answers at once. */
const PROBLEM_SCAN = 1000;
const SIGNED_IN_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** An admin-secret session is a shared credential, not a person: no emails for it. */
const seesEmails = (actor: string) => actor !== "admin:secret";

/** How many open problem reports each driver has, among the newest PROBLEM_SCAN. */
async function openProblems() {
  const reports = await driverAppStore().listReports({
    status: "open",
    limit: PROBLEM_SCAN,
  });
  const byDriver = new Map<string, number>();
  for (const r of reports)
    byDriver.set(r.driverRef, (byDriver.get(r.driverRef) ?? 0) + 1);
  return { byDriver, capped: reports.length >= PROBLEM_SCAN };
}

async function appTokenState(ref: string): Promise<AppTokenState> {
  const app = (await tokenStore().listByDriver(ref)).find(
    (t) => t.type === "APP_USER",
  );
  if (!app) return "none";
  if (tokenValid(app)) return "active";
  return app.status === "blocked" ? "blocked" : "expired";
}

async function driverRow(
  d: Driver,
  emails: boolean,
  problems: Map<string, number>,
): Promise<DriverRow> {
  return {
    id: d.id,
    email: emails ? d.email : null,
    status: d.status,
    hasCard: d.defaultPaymentMethodId !== null,
    createdAt: d.createdAt,
    lastSignInAt: d.lastSignInAt,
    appToken: await appTokenState(d.id),
    openProblems: problems.get(d.id) ?? 0,
  };
}

/** A cursor as the page carries it: `<joined>|<ID>`. */
const cursorText = (c: DriverCursor) => `${c.createdAt}|${c.id}`;
const CURSOR =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?))\|([\x21-\x7b\x7d\x7e]{1,64})$/;

/**
 * Driver accounts, newest first, one page at a time, with the counts. Searches by part
 * of an email address (an admin signed in by email only, and each such search is
 * written to the audit log, without what was searched for) or by the exact driver
 * reference.
 */
export async function listDriversAction(
  _prev: DriversState,
  form: FormData,
): Promise<DriversState> {
  return gate(
    form,
    async (actor): Promise<DriversState> => {
      const emails = seesEmails(actor);
      const typed = field(form, "email").trim();
      if (typed && !emails)
        return {
          ok: false,
          message: "Search by email needs an admin signed in by email.",
          code: "email_search_refused",
          nextStep:
            "Search by driver reference, or sign in by email (Account) instead of with the admin secret.",
        };
      const email = typed ? emailSearchTerm(typed) : undefined;
      if (email === null)
        return {
          ok: false,
          message:
            "Search by part of an email address: up to 254 characters, without spaces, * or quotes.",
        };
      const reference = field(form, "reference").trim() || undefined;
      if (reference !== undefined && !isDriverReference(reference))
        return {
          ok: false,
          message:
            "A driver reference is up to 64 printable characters without spaces.",
        };
      const older = field(form, "older");
      const cursor = older ? CURSOR.exec(older) : null;
      if (older && !cursor)
        return { ok: false, message: "Reload the list, then try again." };

      const filter = { email, reference };
      const accounts = accountStore();
      const [page, counts, problems] = await Promise.all([
        accounts.listDrivers({
          ...filter,
          after: cursor ? { createdAt: cursor[1], id: cursor[2] } : undefined,
          limit: PAGE_SIZE,
        }),
        accounts.countDrivers({
          ...filter,
          signedInSince: new Date(
            Date.now() - SIGNED_IN_WINDOW_MS,
          ).toISOString(),
        }),
        openProblems(),
      ]);
      const drivers = await Promise.all(
        page.drivers.map((d) => driverRow(d, emails, problems.byDriver)),
      );
      // Written before the answer: a search that cannot be recorded shows nothing.
      // Who, how and how many rows; never the address or the part of it.
      if (email !== undefined)
        await peerStore().audit({
          actor,
          action: "driver.search",
          details: { by: "email", rows: drivers.length },
        });
      const filtered = email !== undefined || reference !== undefined;
      return {
        ok: true,
        message: filtered
          ? `${counts.matching} of ${counts.total} account(s) match.`
          : `${counts.total} account(s).`,
        drivers,
        counts,
        filtered,
        reference,
        ...(page.next && { next: cursorText(page.next) }),
        ...(problems.capped && { problemsCapped: true }),
      };
    },
    {
      shown: () => false,
      fallback: "Could not read the drivers. Try again.",
      what: "driver list",
    },
  );
}

const paymentLine = (p: Payment): PaymentLine => ({
  id: p.id,
  status: p.status,
  currency: p.currency,
  holdAmount: p.holdAmount,
  capturedAmount: p.capturedAmount,
  refundedAmount: p.refundedAmount,
  review: p.review,
  reviewedAt: p.reviewedAt,
  createdAt: p.createdAt,
});

/**
 * One driver's page: the account (if there is one), open problems, and the last
 * sessions and payments under this reference. Tokens are read on their own
 * (driverTokensAction).
 */
export async function driverPageAction(
  _prev: DriverPageState,
  form: FormData,
): Promise<DriverPageState> {
  return gate(
    form,
    async (actor): Promise<DriverPageState> => {
      const ref = field(form, "driverRef").trim();
      if (!isDriverReference(ref))
        return {
          ok: false,
          message:
            "A driver reference is up to 64 printable characters without spaces.",
        };
      const [page, problems, sessions, labels, payments] = await Promise.all([
        accountStore().listDrivers({ reference: ref, limit: 1 }),
        openProblems(),
        sessionStore().listSessions({ driverRef: ref, limit: RECENT }),
        peerLabels(),
        paymentStore().listByDriver(ref, RECENT),
      ]);
      const [held] = page.drivers;
      return {
        ok: true,
        message: held ? "Driver found." : "No account yet.",
        account: held
          ? await driverRow(held, seesEmails(actor), problems.byDriver)
          : null,
        openProblems: problems.byDriver.get(ref) ?? 0,
        ...(problems.capped && { problemsCapped: true }),
        sessions: sessions.map((s) => sessionRow(s, labels)),
        payments: payments.map(paymentLine),
      };
    },
    {
      shown: () => false,
      fallback: "Could not read the driver. Try again.",
      what: "driver page",
    },
  );
}
