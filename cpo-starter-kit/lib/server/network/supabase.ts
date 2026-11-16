import "server-only";
import type { FeeMode, FeeTerms } from "@/lib/network-fee";
import type { Database } from "../database.types";
import { toReportCheckout } from "../reports/supabase";
import { serviceClient } from "../supabase";
import {
  NetworkError,
  type CheckoutHost,
  type FeePlan,
  type NetworkStore,
  type PayoutAccount,
  type PayoutStatus,
} from "./types";

// Fee versions, payout accounts and checkout snapshots in Supabase. Read with the
// service role after the server checked the user (lib/server/network/service.ts);
// written only through database functions that check the actor again in the same
// statement as the write.

type DbError = { message: string; code?: string } | null;
type CheckoutRow = Database["public"]["Tables"]["cpo_checkouts"]["Row"];
type PlanRow = Database["public"]["Tables"]["cpo_host_fee_plans"]["Row"];

function check<R extends { error: DbError }>(r: R): R {
  if (!r.error) return r;
  const m = r.error.message;
  if (m.includes("cpo_not_allowed"))
    throw new NetworkError(
      "not_allowed",
      "Only owners and managers set a host's network fee. If your role just changed, reload the page.",
    );
  if (m.includes("cpo_host_not_found") || m.includes("cpo_not_found"))
    throw new NetworkError(
      "not_found",
      "That host is not in the kit any more. Reload the page.",
    );
  if (r.error.code === "23514")
    throw new NetworkError("invalid", "Check the fee and try again.");
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

/** Terms from a row's fee columns; null when there is no fee version. */
export function termsOf(r: {
  mode: string | null;
  percent_bps: number | null;
  per_kwh_minor: number | null;
  monthly_charger_fee_minor: number | null;
  currency: string | null;
}): FeeTerms | null {
  if (r.mode !== "percent" && r.mode !== "per_kwh") return null;
  return {
    mode: r.mode as FeeMode,
    percentBps: r.percent_bps ?? 0,
    perKwhMinor: r.per_kwh_minor ?? 0,
    monthlyChargerFeeMinor: r.monthly_charger_fee_minor ?? 0,
    currency: r.currency ?? "USD",
  };
}

const toPlan = (r: PlanRow): FeePlan => ({
  id: r.id,
  hostId: r.host_id,
  terms: termsOf(r)!,
  effectiveFrom: new Date(r.effective_from).toISOString(),
});

const STATUSES: PayoutStatus[] = ["none", "action_needed", "ready"];

export function createSupabaseNetworkStore(): NetworkStore {
  const svc = serviceClient;
  return {
    mode: "live",
    async feePlans(operatorId) {
      const r = check(
        await svc()
          .from("cpo_host_fee_plans")
          .select("*")
          .eq("operator_id", operatorId)
          .order("effective_from", { ascending: true })
          .limit(2000),
      );
      return (r.data ?? []).map(toPlan);
    },
    async setFeePlan(actor, hostId, terms) {
      const r = check(
        await svc().rpc("cpo_set_host_fee_plan", {
          p_operator_id: actor.operatorId,
          p_actor_id: actor.userId,
          p_host_id: hostId,
          p_mode: terms.mode,
          p_percent_bps: terms.percentBps,
          p_per_kwh_minor: terms.perKwhMinor,
          p_monthly_charger_fee_minor: terms.monthlyChargerFeeMinor,
          p_currency: terms.currency,
        }),
      );
      return toPlan(r.data as PlanRow);
    },
    async payouts(operatorId) {
      const r = check(
        await svc()
          .from("cpo_host_payout_accounts")
          .select("*")
          .eq("operator_id", operatorId),
      );
      return (r.data ?? []).map((x): PayoutAccount => ({
        hostId: x.host_id,
        status: STATUSES.includes(x.status as PayoutStatus)
          ? (x.status as PayoutStatus)
          : "none",
        accountId: x.stripe_account_id,
        requirements: x.requirements ?? [],
        checkedAt: x.checked_at,
      }));
    },
    async siteHost(operatorId, locationId) {
      const r = check(
        await svc().rpc("cpo_site_payout", {
          p_operator_id: operatorId,
          p_location_id: locationId,
        }),
      );
      const row = (r.data ?? [])[0];
      if (!row) return null;
      return {
        hostId: row.host_id,
        status: STATUSES.includes(row.status as PayoutStatus)
          ? (row.status as PayoutStatus)
          : "none",
      };
    },
    async snapshot(operatorId, checkoutId, locationId) {
      const r = check(
        await svc().rpc("cpo_snapshot_checkout_host", {
          p_operator_id: operatorId,
          p_checkout_id: checkoutId,
          p_location_id: locationId,
        }),
      );
      const row = (r.data ?? [])[0];
      if (!row) return null;
      const snap: CheckoutHost = {
        checkoutId: row.checkout_id,
        hostId: row.host_id,
        locationId: row.location_id,
        payoutAccountId: row.payout_account_id,
        feePlanId: row.fee_plan_id,
      };
      return snap;
    },
    async checkoutHosts(operatorId, checkouts) {
      const out = new Map<string, { hostId: string; terms: FeeTerms | null }>();
      if (!checkouts.length) return out;
      const r = check(
        await svc().rpc("cpo_checkout_host_fees", {
          p_operator_id: operatorId,
          p_checkout_ids: checkouts.map((c) => c.id),
        }),
      );
      for (const x of r.data ?? [])
        out.set(x.checkout_id, { hostId: x.host_id, terms: termsOf(x) });
      return out;
    },
    async hostCheckouts(operatorId, hostId, fromMs, toMs, limit) {
      const r = check(
        await svc().rpc("cpo_host_statement", {
          p_operator_id: operatorId,
          p_host_id: hostId,
          p_from: new Date(fromMs).toISOString(),
          p_to: new Date(toMs).toISOString(),
          p_limit: limit,
        }),
      );
      return (r.data ?? []).map((x) => ({
        checkout: toReportCheckout(x.checkout as unknown as CheckoutRow),
        terms: termsOf(x),
      }));
    },
  };
}
