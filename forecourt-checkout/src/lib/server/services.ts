import "server-only";
import { after } from "next/server";
import { readSettings, type Settings } from "../settings";
import { IvoraClient } from "./ivora";
import { ResendMailer, type ReceiptMailer } from "./mailer";
import { PosOutbox } from "./pos-webhook";
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

/** The demo's simulated POS uses this token. It guards nothing real. */
export const DEMO_POS_API_SECRET = "demo-pos-secret";
/** The demo signs its simulated session_due deliveries with this. */
export const DEMO_POS_WEBHOOK_SECRET = "demo-pos-webhook-secret";

/** Bearer token for /api/pos/*. Empty (endpoints off) unless POS_API_SECRET is set. */
export function posApiSecret(s: Settings = settings()) {
  return s.demo
    ? DEMO_POS_API_SECRET
    : (process.env.POS_API_SECRET?.trim() ?? "");
}

/** Run after the response when inside a request (Next's after()), else now. */
function schedule(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    void task();
  }
}

let outbox: { key: string; box: PosOutbox } | null = null;

/** The signed session_due webhook, or null when off. Never in demo mode. */
export function posOutbox(s: Settings = settings()): PosOutbox | null {
  const secret = process.env.POS_WEBHOOK_SECRET?.trim() ?? "";
  if (s.demo || !s.posWebhookUrl || !secret) return null;
  // Keyed by URL only: the secret never leaves this function.
  if (!outbox || outbox.key !== s.posWebhookUrl)
    outbox = {
      key: s.posWebhookUrl,
      box: new PosOutbox({
        url: s.posWebhookUrl,
        secret,
        schedule,
        log: (message, details) =>
          console.warn(`[forecourt] ${message}`, details),
      }),
    };
  return outbox.box;
}

/** The provider for emailed receipts, or null. Demo mode never gets one: it can't send. */
export function receiptMailer(s: Settings = settings()): ReceiptMailer | null {
  const key = process.env.RESEND_API_KEY?.trim() ?? "";
  const from = process.env.RECEIPT_EMAIL_FROM?.trim() ?? "";
  if (s.demo || !key || !from) return null;
  return new ResendMailer(key, from);
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
    events: {
      async emit(event) {
        await saleEvents.emit(event);
        posOutbox(s)?.offer(event);
      },
    },
    log: (message, details) => console.warn(`[forecourt] ${message}`, details),
  };
}
