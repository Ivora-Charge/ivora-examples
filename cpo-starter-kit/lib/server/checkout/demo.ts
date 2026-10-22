import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { demoPaymentAccount } from "../ivora/demo";
import type { IvoraClient } from "../ivora/types";
import {
  CheckoutError,
  type CheckoutRecord,
  type CheckoutStore,
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

const recordSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  stickerCode: z.string().max(16),
  stationId: z.number().int(),
  connectorId: z.number().int(),
  tariffId: z.number().int(),
  holdMinor: z.number().int(),
  currency: z.string().max(3),
  phase: z.enum(["creating", "checkout", "failed"]),
  billId: z.string().max(40).nullable(),
  paymentId: z.string().max(100).nullable(),
  checkoutUrl: z.string().max(200).nullable(),
  startRequestedAt: z.string().max(40).nullable(),
  error: z.string().max(600).nullable(),
  createdAt: z.string().max(40),
});

const stateSchema = z.object({
  v: z.literal(1),
  simulate: z.enum(DEMO_CHECKOUT_SIMULATIONS),
  records: z.array(recordSchema).max(MAX_RECORDS),
});
export type DemoCheckoutState = z.infer<typeof stateSchema>;

export const emptyDemoCheckout = (): DemoCheckoutState => ({
  v: 1,
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

/** Same rules as the Supabase store, in the visitor's cookie. */
export function createDemoCheckoutStore(
  cookie: DemoCheckoutCookie,
): CheckoutStore {
  const update = async <T>(change: (s: DemoCheckoutState) => T) => {
    const s = await cookie.load();
    const r = change(s);
    await cookie.save(s);
    return r;
  };
  return {
    mode: "demo",
    claim(n) {
      return update((s) => {
        const seen = s.records.find((r) => r.requestId === n.requestId);
        if (seen) {
          if (
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
        const id = randomUUID();
        s.records.push({
          id,
          requestId: n.requestId,
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
          error: null,
          createdAt: new Date().toISOString(),
        });
        s.records = s.records.slice(-MAX_RECORDS);
        return { id, created: true };
      });
    },
    async get(operatorId, id) {
      const r = (await cookie.load()).records.find((x) => x.id === id);
      return r ? ({ ...r, operatorId } satisfies CheckoutRecord) : null;
    },
    async record(_operatorId, id, c) {
      await update((s) => {
        const r = s.records.find((x) => x.id === id);
        if (!r) return;
        if (
          (c.billId && r.billId && c.billId !== r.billId) ||
          (c.paymentId && r.paymentId && c.paymentId !== r.paymentId)
        )
          throw new CheckoutError("invalid", "Reload the page and try again.");
        r.billId ??= c.billId ?? null;
        r.paymentId ??= c.paymentId ?? null;
        if (c.checkoutUrl !== undefined) r.checkoutUrl = c.checkoutUrl;
        if (r.phase === "creating" && c.phase) r.phase = c.phase;
        if (c.error !== undefined) r.error = c.error?.slice(0, 600) ?? null;
        if (c.startRequested) r.startRequestedAt ??= new Date().toISOString();
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
