import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { demoPaymentAccount } from "../ivora/demo";
import type { IvoraClient } from "../ivora/types";
import {
  CheckoutError,
  HOLDS_CONNECTOR,
  NEXT_PHASES,
  UNSETTLED,
  type CheckoutPhase,
  type CheckoutRecord,
  type CheckoutStore,
  type ClaimResult,
} from "./types";

// Demo checkout: each visitor's checkouts in their own cookie, and a switch that
// simulates what can stop a checkout (an offline charger, a connector in use, a Stripe
// account that isn't ready). Bills and payments are the demo Ivora client's: nothing
// is charged and nothing is sent anywhere.

/** What the visitor chose to simulate on the sticker page. */
export const DEMO_CHECKOUT_SIMULATIONS = [
  "none",
  "offline",
  "in_use",
  "stripe_not_ready",
] as const;
export type DemoCheckoutSimulation = (typeof DEMO_CHECKOUT_SIMULATIONS)[number];

const MAX_RECORDS = 5;

const PHASES = [
  "creating",
  "open",
  "settling",
  "releasing",
  "settled",
  "released",
  "failed",
  "attention",
] as const;

const recordSchema = z.object({
  id: z.uuid(),
  operatorId: z.string().max(64),
  requestId: z.uuid(),
  reference: z.string().regex(/^ck_[0-9a-f]{32}$/),
  kind: z.enum(["paid", "free"]),
  stickerCode: z.string().max(16),
  stationId: z.number().int(),
  connectorId: z.number().int(),
  tariffId: z.number().int(),
  holdMinor: z.number().int(),
  currency: z.string().max(3),
  phase: z.enum(PHASES),
  billId: z.string().max(40).nullable(),
  paymentId: z.string().max(100).nullable(),
  checkoutUrl: z.string().max(200).nullable(),
  startRequestedAt: z.string().max(40).nullable(),
  startOperationId: z.string().max(100).nullable(),
  transactionId: z.number().int().nullable(),
  stopRequestedAt: z.string().max(40).nullable(),
  stopRetriedAt: z.string().max(40).nullable(),
  meterWh: z.number().int().nullable(),
  meterAt: z.string().max(40).nullable(),
  alert: z.enum(["stalled", "hold_stop_ignored"]).nullable(),
  finalMinor: z.number().int().nullable(),
  capturedMinor: z.number().int().nullable(),
  error: z.string().max(600).nullable(),
  checkedAt: z.string().max(40).nullable(),
  settledAt: z.string().max(40).nullable(),
  createdAt: z.string().max(40),
});

const stateSchema = z.object({
  v: z.literal(3),
  simulate: z.enum(DEMO_CHECKOUT_SIMULATIONS),
  records: z.array(recordSchema).max(MAX_RECORDS),
});
export type DemoCheckoutState = z.infer<typeof stateSchema>;

export const emptyDemoCheckout = (): DemoCheckoutState => ({
  v: 3,
  simulate: "none",
  records: [],
});

export function decodeDemoCheckout(raw: string | undefined): DemoCheckoutState {
  if (!raw) return emptyDemoCheckout();
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : emptyDemoCheckout();
  } catch {
    return emptyDemoCheckout();
  }
}

export function encodeDemoCheckout(s: DemoCheckoutState): string {
  return Buffer.from(JSON.stringify(stateSchema.parse(s)), "utf8").toString(
    "base64url",
  );
}

export interface DemoCheckoutCookie {
  load(): Promise<DemoCheckoutState>;
  save(s: DemoCheckoutState): Promise<void>;
}

export function memoryDemoCheckout(
  initial = emptyDemoCheckout(),
): DemoCheckoutCookie & { state: DemoCheckoutState } {
  const store = {
    state: structuredClone(initial),
    async load() {
      return structuredClone(store.state);
    },
    async save(s: DemoCheckoutState) {
      store.state = structuredClone(stateSchema.parse(s));
    },
  };
  return store;
}

const TERMINAL: ReadonlySet<CheckoutPhase> = new Set([
  "settled",
  "released",
  "failed",
  "attention",
]);

/** Same rules as the Supabase store, in the visitor's cookie. */
export function createDemoCheckoutStore(
  cookie: DemoCheckoutCookie,
  now: () => number = Date.now,
): CheckoutStore {
  const update = async <T>(change: (s: DemoCheckoutState) => T) => {
    const s = await cookie.load();
    const r = change(s);
    await cookie.save(s);
    return r;
  };
  const view = (r: DemoCheckoutState["records"][number]): CheckoutRecord => ({
    ...r,
  });
  const mine = (r: { operatorId: string }, operatorId: string) =>
    r.operatorId === operatorId;
  const iso = () => new Date(now()).toISOString();
  return {
    mode: "demo",
    claim(n) {
      return update((s): ClaimResult => {
        const seen = s.records.find(
          (r) => mine(r, n.operatorId) && r.requestId === n.requestId,
        );
        if (seen) {
          if (
            seen.kind !== n.kind ||
            seen.stickerCode !== n.stickerCode ||
            seen.stationId !== n.stationId ||
            seen.connectorId !== n.connectorId ||
            seen.tariffId !== n.tariffId
          )
            throw new CheckoutError(
              "invalid",
              "Reload the page and try again.",
            );
          return { id: seen.id, created: false };
        }
        const busy = s.records.find(
          (r) =>
            mine(r, n.operatorId) &&
            r.stationId === n.stationId &&
            r.connectorId === n.connectorId &&
            HOLDS_CONNECTOR.has(r.phase),
        );
        if (busy) return { busy: busy.id };
        const id = randomUUID();
        s.records.push({
          id,
          operatorId: n.operatorId,
          requestId: n.requestId,
          reference: `ck_${randomUUID().replaceAll("-", "")}`,
          kind: n.kind,
          stickerCode: n.stickerCode,
          stationId: n.stationId,
          connectorId: n.connectorId,
          tariffId: n.tariffId,
          holdMinor: n.holdMinor,
          currency: n.currency,
          phase: "creating",
          billId: null,
          paymentId: null,
          checkoutUrl: null,
          startRequestedAt: null,
          startOperationId: null,
          transactionId: null,
          stopRequestedAt: null,
          stopRetriedAt: null,
          meterWh: null,
          meterAt: null,
          alert: null,
          finalMinor: null,
          capturedMinor: null,
          error: null,
          checkedAt: null,
          settledAt: null,
          createdAt: iso(),
        });
        // The oldest settled ones go first when the cookie is full.
        while (s.records.length > MAX_RECORDS) {
          const i = s.records.findIndex((r) => TERMINAL.has(r.phase));
          s.records.splice(Math.max(0, i), 1);
        }
        return { id, created: true };
      });
    },
    async get(operatorId, id) {
      const r = (await cookie.load()).records.find(
        (x) => mine(x, operatorId) && x.id === id,
      );
      return r ? view(r) : null;
    },
    async getByRequest(operatorId, requestId) {
      const r = (await cookie.load()).records.find(
        (x) => mine(x, operatorId) && x.requestId === requestId.toLowerCase(),
      );
      return r ? view(r) : null;
    },
    async getByReference(reference) {
      const r = (await cookie.load()).records.find(
        (x) => x.reference === reference,
      );
      return r ? view(r) : null;
    },
    async listUnsettled(o) {
      return (await cookie.load()).records
        .filter(
          (r) =>
            UNSETTLED.has(r.phase) &&
            (!o.stationId || r.stationId === o.stationId),
        )
        .sort((a, b) => (a.checkedAt ?? "").localeCompare(b.checkedAt ?? ""))
        .slice(0, o.limit)
        .map(view);
    },
    async listAlerts(operatorId, o) {
      const since = now() - o.days * 86_400_000;
      return (await cookie.load()).records
        .filter(
          (r) =>
            mine(r, operatorId) &&
            ((r.phase === "attention" && Date.parse(r.createdAt) >= since) ||
              (r.alert !== null && UNSETTLED.has(r.phase))),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, o.limit)
        .map(view);
    },
    async record(operatorId, id, c) {
      return update((s) => {
        const r = s.records.find((x) => mine(x, operatorId) && x.id === id);
        if (!r) return false;
        const differs = <T>(a: T | null, b: T | undefined) =>
          b !== undefined && a !== null && a !== b;
        if (
          differs(r.billId, c.billId) ||
          differs(r.paymentId, c.paymentId) ||
          differs(r.startOperationId, c.startOperationId) ||
          differs(r.transactionId, c.transactionId)
        )
          throw new CheckoutError("invalid", "Reload the page and try again.");
        let phase = c.phase;
        if (phase && phase !== r.phase) {
          if (!NEXT_PHASES[r.phase].includes(phase)) return false;
          if (
            phase === "open" &&
            s.records.some(
              (x) =>
                x.id !== r.id &&
                mine(x, operatorId) &&
                x.stationId === r.stationId &&
                x.connectorId === r.connectorId &&
                HOLDS_CONNECTOR.has(x.phase),
            )
          )
            phase = undefined;
        }
        if (c.holdMinor !== undefined && UNSETTLED.has(r.phase))
          r.holdMinor = c.holdMinor;
        r.billId ??= c.billId ?? null;
        r.paymentId ??= c.paymentId ?? null;
        r.startOperationId ??= c.startOperationId ?? null;
        r.transactionId ??= c.transactionId ?? null;
        r.finalMinor ??= c.finalMinor ?? null;
        r.capturedMinor ??= c.capturedMinor ?? null;
        if (c.checkoutUrl !== undefined) r.checkoutUrl = c.checkoutUrl;
        if (phase) r.phase = phase;
        if (c.error !== undefined) r.error = c.error?.slice(0, 600) ?? null;
        if (c.startRequested) r.startRequestedAt ??= iso();
        if (c.stopRequested) r.stopRequestedAt ??= iso();
        if (c.stopRetried) r.stopRetriedAt ??= iso();
        if (c.meterWh !== undefined) {
          if (r.meterAt === null || r.meterWh !== c.meterWh) r.meterAt = iso();
          r.meterWh = c.meterWh;
        }
        if (c.alert !== undefined) r.alert = c.alert;
        if (c.checked) r.checkedAt = iso();
        if (TERMINAL.has(r.phase)) r.settledAt ??= iso();
        return true;
      });
    },
  };
}

/**
 * The demo Ivora client as the sticker page sees it, with the visitor's simulation
 * applied: the charger offline or its connectors in use, or the Stripe account not
 * ready. Without one, Stripe is ready, so the whole flow can be tried.
 */
export function withDemoSimulation(
  client: IvoraClient,
  simulation: () => Promise<DemoCheckoutSimulation>,
): IvoraClient {
  return {
    ...client,
    async getStation(id) {
      const s = await client.getStation(id);
      const sim = await simulation();
      if (sim === "offline")
        return {
          ...s,
          online: false,
          connectors: s.connectors.map((c) => ({
            ...c,
            status: "Unavailable",
          })),
        };
      if (sim === "in_use")
        return {
          ...s,
          connectors: s.connectors.map((c) => ({ ...c, status: "Charging" })),
        };
      return s;
    },
    async getPaymentAccount() {
      return demoPaymentAccount(
        (await simulation()) === "stripe_not_ready" ? "pending" : "ready",
      );
    },
  };
}
