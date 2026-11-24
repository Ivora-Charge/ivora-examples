import "server-only";
import type { FeeTerms } from "@/lib/network-fee";
import type { ReportCheckout } from "../reports/types";
import type { Staff } from "../team/types";

/**
 * One version of a host's network fee. Versions are never edited: a change is a new
 * version, effective from when it was saved, and applies to sessions started after it.
 */
export interface FeePlan {
  id: string;
  hostId: string;
  terms: FeeTerms;
  /** From this instant (UTC, ISO 8601) on. */
  effectiveFrom: string;
}

/**
 * A host's payout account: where card payments at its sites are to be paid, as a
 * direct charge on the host's own Stripe account (see README: Host payouts).
 * none: not connected. action_needed: connected, but Stripe needs more from the host
 * before it can take charges or pay out. ready: charges and payouts are enabled.
 */
export type PayoutStatus = "none" | "action_needed" | "ready";

export interface PayoutAccount {
  hostId: string;
  status: PayoutStatus;
  /** The connected account's ID (acct_…); never sent to a browser. */
  accountId: string | null;
  /** Stripe's open requirements, in its own words (codes). */
  requirements: string[];
  checkedAt: string | null;
}

/**
 * What the kit records about a checkout at a host's site when it starts, in one
 * database statement: the host the site belonged to, the host's payout account and
 * the fee version in effect. Later changes (a site moved to another host, a new fee, a
 * new account) never change it.
 */
export interface CheckoutHost {
  checkoutId: string;
  hostId: string;
  locationId: number;
  payoutAccountId: string | null;
  feePlanId: string | null;
}

/** A checkout of a host's statement, with the fee terms recorded at its start. */
export interface HostCheckout {
  checkout: ReportCheckout;
  terms: FeeTerms | null;
}

/**
 * Where fee plans, payout accounts and checkout snapshots are kept: Supabase (service
 * role, after the server checked the user; writes check the role again in the same
 * statement) or, in demo mode, the visitor's cookie.
 */
export interface NetworkStore {
  readonly mode: "live" | "demo";
  /** Every fee version of the operator's hosts, oldest first. */
  feePlans(operatorId: string): Promise<FeePlan[]>;
  /** Saves a new fee version for a host, effective now. Owners and managers only. */
  setFeePlan(actor: Staff, hostId: string, terms: FeeTerms): Promise<FeePlan>;
  payouts(operatorId: string): Promise<PayoutAccount[]>;
  /**
   * The active host of a site and its payout status, or null for a site with no host.
   * Read with the service role in live mode: the driver asking is not signed in.
   */
  siteHost(
    operatorId: string,
    locationId: number,
  ): Promise<{ hostId: string; status: PayoutStatus } | null>;
  /**
   * Records the host, payout account and fee version of a checkout at `locationId`
   * once (the first call wins). Null when the site has no host.
   */
  snapshot(
    operatorId: string,
    checkoutId: string,
    locationId: number,
  ): Promise<CheckoutHost | null>;
  /**
   * The host and fee terms recorded for these checkouts (the Reports page's rows), by
   * checkout ID. Checkouts at no host's site are absent.
   */
  checkoutHosts(
    operatorId: string,
    checkouts: Pick<ReportCheckout, "id" | "stationId" | "createdAt">[],
  ): Promise<Map<string, { hostId: string; terms: FeeTerms | null }>>;
  /**
   * One host's checkouts made in [fromMs, toMs), newest first, with the fee terms
   * recorded at each one's start. At most `limit`.
   */
  hostCheckouts(
    operatorId: string,
    hostId: string,
    fromMs: number,
    toMs: number,
    limit: number,
  ): Promise<HostCheckout[]>;
}

export type NetworkErrorCode = "invalid" | "not_allowed" | "not_found";

export class NetworkError extends Error {
  constructor(
    public code: NetworkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}
