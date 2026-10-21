import "server-only";
import { readSettings, type Settings } from "../settings";
import { IvoraClient } from "./ivora";
import type { Deps } from "./sessions";
import { saleEvents } from "./sale-events";
import type { StoreDeps } from "./store";
import { StripeGateway } from "./stripe";

export function settings(): Settings {
  return readSettings(process.env);
}

export function signingSecret(s: Settings = settings()) {
  // Demo mode signs operator cookies with a fixed value; it guards nothing real.
  return s.demo ? "forecourt-demo-only" : (process.env.SESSION_SECRET ?? "");
}

export function operatorPassword(s: Settings = settings()) {
  return s.demo
    ? process.env.OPERATOR_PASSWORD || "demo"
    : (process.env.OPERATOR_PASSWORD ?? "");
}

/** The cashier console's password. It can authorise, stop and mark paid; never change prices. */
export function cashierPassword(s: Settings = settings()) {
  return s.demo
    ? process.env.CASHIER_PASSWORD || "demo"
    : (process.env.CASHIER_PASSWORD ?? "");
}

let cached: { key: string; ivora: IvoraClient } | null = null;

export function ivoraClient(s: Settings = settings()) {
  if (s.demo) throw new Error("Demo mode never calls the Ivora API.");
  const key = `${s.ivoraApiUrl}|${process.env.IVORA_TENANT_ID}`;
  if (!cached || cached.key !== key)
    cached = {
      key,
      ivora: new IvoraClient({
        apiUrl: s.ivoraApiUrl,
        apiKey: process.env.IVORA_API_KEY ?? "",
        tenantId: process.env.IVORA_TENANT_ID ?? "",
      }),
    };
  return cached.ivora;
}

/** Live dependencies. Demo mode has none: it never sends payment or charger requests. */
export function liveDeps(s: Settings = settings()): Deps {
  if (s.demo) throw new Error("Demo mode never calls Ivora or Stripe.");
  return {
    ivora: ivoraClient(s),
    payments: new StripeGateway(
      process.env.STRIPE_SECRET_KEY ?? "",
      s.stripeConnectedAccount,
    ),
    settings: s,
    now: Date.now,
    log: (message, details) => console.warn(`[forecourt] ${message}`, details),
  };
}

/** Live dependencies for pay in store. Demo mode answers from src/lib/demo-store.ts instead. */
export function liveStoreDeps(s: Settings = settings()): StoreDeps {
  if (s.demo) throw new Error("Demo mode never calls the Ivora API.");
  return {
    ivora: ivoraClient(s),
    settings: s,
    now: Date.now,
    events: saleEvents,
    log: (message, details) => console.warn(`[forecourt] ${message}`, details),
  };
}
