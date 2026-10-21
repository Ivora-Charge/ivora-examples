import "server-only";
import type { PaymentAccount } from "../ivora/types";

/**
 * What the kit shows for the Stripe account Ivora Checkout charges:
 * - none: no account (or it was disconnected). Connect one in the Ivora dashboard.
 * - pending: connected, but Stripe can't take charges yet (details or requirements due).
 * - pending_review: onboarded, awaiting Ivora's approval before it takes payments.
 * - ready: active and Stripe reports charges_enabled. Requirements can still be open.
 */
export type StripeState = "none" | "pending" | "pending_review" | "ready";

export interface StripeView {
  state: StripeState;
  label: string;
  detail: string;
  /** Stripe's open requirements, for example `external_account`. */
  requirements: string[];
  disabledReason: string | null;
  accountId: string | null;
  /** Null when Ivora didn't say (for example with no account). */
  livemode: boolean | null;
  /** The API's own status, for support. */
  status: string;
}

export const STRIPE_LABELS: Record<StripeState, string> = {
  none: "Not connected",
  pending: "Pending",
  pending_review: "Awaiting Ivora approval",
  ready: "Ready",
};

export function stripeView(a: PaymentAccount): StripeView {
  const requirements = Array.isArray(a.requirements_due)
    ? a.requirements_due.filter((r): r is string => typeof r === "string")
    : [];
  const state: StripeState =
    a.status === "none" || a.status === "disconnected"
      ? "none"
      : a.status === "pending_review"
        ? "pending_review"
        : a.status === "active" && a.charges_enabled === true
          ? "ready"
          : "pending";
  const detail = {
    none:
      a.status === "disconnected"
        ? "The Stripe account was disconnected. Connect one in your Ivora dashboard to take card payments."
        : "No Stripe account is connected yet. Connect one in your Ivora dashboard to take card payments.",
    pending:
      "Stripe can't take charges on this account yet. Finish the details Stripe asks for, then check again.",
    pending_review:
      "Your Stripe account is connected and waiting for Ivora to approve it. Payments start once it is approved.",
    ready: requirements.length
      ? "Card payments are on. Stripe still lists open requirements: complete them before their deadline so payments keep working."
      : "Card payments are on: drivers pay through Ivora Checkout into your Stripe account.",
  }[state];
  return {
    state,
    label: STRIPE_LABELS[state],
    detail,
    requirements,
    disabledReason:
      typeof a.disabled_reason === "string" ? a.disabled_reason : null,
    accountId:
      typeof a.stripe_account_id === "string" ? a.stripe_account_id : null,
    livemode: typeof a.livemode === "boolean" ? a.livemode : null,
    status: String(a.status),
  };
}
