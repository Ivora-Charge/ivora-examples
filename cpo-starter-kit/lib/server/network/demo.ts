import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validTerms, type FeeTerms } from "@/lib/network-fee";
import { atLeast } from "@/lib/roles";
import { DEMO_HOST_A, DEMO_HOST_B } from "../hosts/demo";
import type { HostStore } from "../hosts/types";
import type { ReportsStore } from "../reports/types";
import {
  NetworkError,
  type CheckoutHost,
  type FeePlan,
  type HostCheckout,
  type NetworkStore,
  type PayoutAccount,
  type PayoutStatus,
} from "./types";

// Demo network: the two sample hosts' fee versions and payout status, in the visitor's
// cookie. Nothing is sent to Stripe or Supabase. A demo checkout's host is the site's
// host now (the demo keeps no snapshot), and statements read the sample history.

const SEEDED = "2026-01-01T00:00:00.000Z";
const MAX_PLANS = 24;
const MAX_COOKIE_CHARS = 3800;

const termsSchema = z.object({
  mode: z.enum(["percent", "per_kwh"]),
  percentBps: z.number().int(),
  perKwhMinor: z.number().int(),
  monthlyChargerFeeMinor: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const stateSchema = z.object({
  v: z.literal(1),
  plans: z
    .array(
      z.object({
        id: z.string().max(64),
        hostId: z.string().max(64),
        terms: termsSchema,
        effectiveFrom: z.string().max(40),
      }),
    )
    .max(MAX_PLANS),
  payouts: z
    .array(
      z.object({
        hostId: z.string().max(64),
        status: z.enum(["none", "action_needed", "ready"]),
      }),
    )
    .max(16),
});
export type DemoNetworkState = z.infer<typeof stateSchema>;

/** Demo account IDs: shaped like Stripe's, never real. */
export const demoAccountId = (hostId: string) =>
  `acct_demo_${hostId.replace(/[^a-z0-9]/g, "_")}`;

export function demoNetworkSeed(): DemoNetworkState {
  return {
    v: 1,
    plans: [
      {
        // Host A: a flat amount per kWh and a monthly fee per charger.
        id: "demo-fee-a1",
        hostId: DEMO_HOST_A,
        terms: {
          mode: "per_kwh",
          percentBps: 0,
          perKwhMinor: 5,
          monthlyChargerFeeMinor: 1500,
          currency: "USD",
        },
        effectiveFrom: SEEDED,
      },
      {
        // Host B: a share of each session's amount (any currency).
        id: "demo-fee-b1",
        hostId: DEMO_HOST_B,
        terms: {
          mode: "percent",
          percentBps: 800,
          perKwhMinor: 0,
          monthlyChargerFeeMinor: 0,
          currency: "USD",
        },
        effectiveFrom: SEEDED,
      },
    ],
    payouts: [
      { hostId: DEMO_HOST_A, status: "ready" },
      { hostId: DEMO_HOST_B, status: "ready" },
    ],
  };
}

export function decodeDemoNetwork(raw: string | undefined): DemoNetworkState {
  if (!raw) return demoNetworkSeed();
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : demoNetworkSeed();
  } catch {
    return demoNetworkSeed();
  }
}

export function encodeDemoNetwork(s: DemoNetworkState): string {
  return Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
}

export interface DemoNetworkCookie {
  load(): Promise<DemoNetworkState>;
  save(s: DemoNetworkState): Promise<void>;
}

export function memoryDemoNetwork(initial = demoNetworkSeed()) {
  const store = {
    state: structuredClone(initial),
    async load() {
      return structuredClone(store.state);
    },
    async save(s: DemoNetworkState) {
      store.state = structuredClone(s);
    },
  };
  return store;
}

/** The fee version in effect at `atMs`: the latest one effective by then. */
export function planAt(
  plans: FeePlan[],
  hostId: string,
  atMs: number,
): FeePlan | null {
  let best: FeePlan | null = null;
  for (const p of plans) {
    if (p.hostId !== hostId) continue;
    const from = Date.parse(p.effectiveFrom);
    if (from > atMs) continue;
    if (!best || from >= Date.parse(best.effectiveFrom)) best = p;
  }
  return best;
}

export function createDemoNetworkStore(o: {
  cookie: DemoNetworkCookie;
  hosts: HostStore;
  reports: ReportsStore;
  /** Every station and its site (the demo Ivora client's). */
  stations: () => Promise<{ id: number; locationId: number | null }[]>;
  now?: () => number;
}): NetworkStore {
  const now = o.now ?? Date.now;
  const plansOf = async (): Promise<FeePlan[]> =>
    (await o.cookie.load()).plans.map((p) => ({
      ...p,
      terms: { ...p.terms },
    }));
  const hostOfSite = async (operatorId: string, locationId: number) =>
    (await o.hosts.sites(operatorId)).find((s) => s.locationId === locationId)
      ?.hostId ?? null;
  return {
    mode: "demo",
    feePlans: plansOf,
    async setFeePlan(actor, hostId, terms: FeeTerms) {
      if (!atLeast(actor.role, "manager"))
        throw new NetworkError(
          "not_allowed",
          "Only owners and managers set a host's network fee.",
        );
      if (!validTerms(terms))
        throw new NetworkError("invalid", "Check the fee and try again.");
      const host = (await o.hosts.list(actor.operatorId)).find(
        (h) => h.id === hostId && !h.archivedAt,
      );
      if (!host)
        throw new NetworkError(
          "not_found",
          "That host is not in the kit any more. Reload the page.",
        );
      const s = await o.cookie.load();
      const plan = {
        id: `demo-fee-${randomUUID().slice(0, 8)}`,
        hostId,
        terms: { ...terms },
        // Strictly after the latest version, so "effective from" always moves on.
        effectiveFrom: new Date(
          Math.max(
            now(),
            ...s.plans
              .filter((p) => p.hostId === hostId)
              .map((p) => Date.parse(p.effectiveFrom) + 1),
          ),
        ).toISOString(),
      };
      s.plans.push(plan);
      // Keep the cookie small: drop the oldest versions of the demo beyond the cap.
      while (
        s.plans.length > MAX_PLANS ||
        encodeDemoNetwork(s).length > MAX_COOKIE_CHARS
      )
        s.plans.shift();
      await o.cookie.save(s);
      return { ...plan, terms: { ...plan.terms } };
    },
    async payouts() {
      return (await o.cookie.load()).payouts.map((p): PayoutAccount => ({
        hostId: p.hostId,
        status: p.status,
        accountId: p.status === "none" ? null : demoAccountId(p.hostId),
        requirements:
          p.status === "action_needed"
            ? ["individual.verification.document", "external_account"]
            : [],
        checkedAt: SEEDED,
      }));
    },
    async siteHost(operatorId, locationId) {
      const hostId = await hostOfSite(operatorId, locationId);
      if (!hostId) return null;
      const payout = (await o.cookie.load()).payouts.find(
        (p) => p.hostId === hostId,
      );
      return { hostId, status: payout?.status ?? "none" };
    },
    async snapshot(operatorId, checkoutId, locationId) {
      const hostId = await hostOfSite(operatorId, locationId);
      if (!hostId) return null;
      const s = await o.cookie.load();
      const payout = s.payouts.find((p) => p.hostId === hostId);
      const plan = planAt(await plansOf(), hostId, now());
      const snap: CheckoutHost = {
        checkoutId,
        hostId,
        locationId,
        payoutAccountId:
          payout && payout.status !== "none" ? demoAccountId(hostId) : null,
        feePlanId: plan?.id ?? null,
      };
      return snap;
    },
    async checkoutHosts(operatorId, checkouts) {
      // The demo keeps no snapshot: each checkout's host is its site's host now.
      const out = new Map<string, { hostId: string; terms: FeeTerms | null }>();
      if (!checkouts.length) return out;
      const [sites, plans, stations] = await Promise.all([
        o.hosts.sites(operatorId),
        plansOf(),
        o.stations(),
      ]);
      const siteOf = new Map(stations.map((x) => [x.id, x.locationId]));
      for (const c of checkouts) {
        const site = siteOf.get(c.stationId);
        const hostId = sites.find((s) => s.locationId === site)?.hostId;
        if (!hostId) continue;
        out.set(c.id, {
          hostId,
          terms: planAt(plans, hostId, Date.parse(c.createdAt))?.terms ?? null,
        });
      }
      return out;
    },
    async hostCheckouts(operatorId, hostId, fromMs, toMs, limit) {
      const sites = (await o.hosts.sites(operatorId)).filter(
        (s) => s.hostId === hostId,
      );
      const ids = new Set(sites.map((s) => s.locationId));
      const stationIds = (await o.stations())
        .filter((x) => x.locationId !== null && ids.has(x.locationId))
        .map((x) => x.id);
      if (!stationIds.length) return [];
      const plans = await plansOf();
      const rows = await allRows(o.reports, operatorId, fromMs, toMs, {
        stationIds,
        limit,
      });
      return rows.map((c): HostCheckout => ({
        checkout: c,
        terms: planAt(plans, hostId, Date.parse(c.createdAt))?.terms ?? null,
      }));
    },
  };
}

/** Every report row in [fromMs, toMs), newest first, up to `limit`. */
async function allRows(
  reports: ReportsStore,
  operatorId: string,
  fromMs: number,
  toMs: number,
  o: { stationIds?: number[]; limit?: number } = {},
) {
  const limit = o.limit ?? 5_000;
  const out = [];
  for (let offset = 0; out.length < limit; offset += 500) {
    const page = await reports.list(
      {
        operatorId,
        stationIds: o.stationIds ?? null,
        fromMs,
        toMs,
        stationId: null,
        status: "all",
      },
      { limit: Math.min(500, limit - out.length), offset },
    );
    out.push(...page);
    if (page.length < 500) break;
  }
  return out;
}

/** Demo only: what the Hosts page's "simulate" switch sets. */
export async function setDemoPayout(
  cookie: DemoNetworkCookie,
  hostId: string,
  status: PayoutStatus,
) {
  const s = await cookie.load();
  s.payouts = s.payouts.filter((p) => p.hostId !== hostId);
  s.payouts.push({ hostId, status });
  await cookie.save(s);
}
