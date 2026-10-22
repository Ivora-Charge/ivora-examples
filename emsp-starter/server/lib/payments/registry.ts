import "server-only";
import { accountStore } from "@/lib/accounts/registry";
import type { AccountStore } from "@/lib/accounts/store";
import { commandStore } from "@/lib/commands/registry";
import type { CommandStore } from "@/lib/commands/store";
import { locationStore } from "@/lib/locations/registry";
import type { LocationStore } from "@/lib/locations/store";
import { peerStore } from "@/lib/ocpi/registry";
import type { PeerStore } from "@/lib/ocpi/store";
import { mailer, type Mailer } from "@/lib/receipts/mailer";
import { sessionStore } from "@/lib/sessions/registry";
import type { SessionStore } from "@/lib/sessions/store";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { tokenStore } from "@/lib/tokens/registry";
import type { TokenStore } from "@/lib/tokens/store";
import { MemoryPaymentStore, type PaymentStore } from "./store";
import { SupabasePaymentStore } from "./store-supabase";
import { stripeClient, type StripeApi } from "./stripe";

/** Everything the payment flows read and write. */
export type PaymentDeps = {
  payments: PaymentStore;
  accounts: AccountStore;
  commands: CommandStore;
  sessions: SessionStore;
  locations: LocationStore;
  peers: PeerStore;
  tokens: TokenStore;
  /**
   * The network's Stripe account. Null in demo mode, which never charges a card, and in
   * live mode without STRIPE_SECRET_KEY, which refuses every hold.
   */
  stripe: StripeApi | null;
  /** Null: receipts are not set up. */
  mailer: Mailer | null;
  now?: () => Date;
  /** For the audit log. */
  actor?: string;
};

const holder = globalThis as unknown as {
  __emspDemoPayments?: MemoryPaymentStore;
  __emspPaymentStoreOverride?: PaymentStore;
  __emspStripeOverride?: StripeApi | null;
};

/** Payments: Supabase in live mode; in demo mode, in memory. */
export function paymentStore(): PaymentStore {
  if (holder.__emspPaymentStoreOverride)
    return holder.__emspPaymentStoreOverride;
  if (isDemo()) return (holder.__emspDemoPayments ??= new MemoryPaymentStore());
  return new SupabasePaymentStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
}

/**
 * The Stripe client, or null. Demo mode never gets one: this and `outboundFetch` are
 * the two locks that keep the demo from charging a card.
 */
export function stripeApi(): StripeApi | null {
  if (isDemo()) return null;
  if (holder.__emspStripeOverride !== undefined)
    return holder.__emspStripeOverride;
  const key = config.stripeSecretKey;
  return key ? stripeClient(key) : null;
}

/** The deps from the registries in use. */
export function paymentDeps(actor = "system"): PaymentDeps {
  return {
    payments: paymentStore(),
    accounts: accountStore(),
    commands: commandStore(),
    sessions: sessionStore(),
    locations: locationStore(),
    peers: peerStore(),
    tokens: tokenStore(),
    stripe: stripeApi(),
    mailer: mailer(),
    actor,
  };
}

/** Tests only: use `store` instead, or go back to the default with undefined. */
export function setPaymentStoreForTests(store: PaymentStore | undefined) {
  holder.__emspPaymentStoreOverride = store;
}

/** Tests only: the Stripe client live mode uses; undefined goes back to the default. */
export function setStripeForTests(stripe: StripeApi | null | undefined) {
  holder.__emspStripeOverride = stripe;
}
