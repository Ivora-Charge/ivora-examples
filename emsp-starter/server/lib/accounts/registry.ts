import "server-only";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { DEMO_DRIVER_REF } from "@/lib/tokens/registry";
import { DemoAuth, SupabaseAuth, type AuthProvider } from "./auth";
import { MemoryAccountStore, type AccountStore } from "./store";
import { SupabaseAccountStore } from "./store-supabase";

/** The demo driver's saved card: a placeholder, never a real card or Stripe object. */
export const DEMO_CARD_ID = "pm_demo4242";

const holder = globalThis as unknown as {
  __emspDemoAccounts?: MemoryAccountStore;
  __emspAccountStoreOverride?: AccountStore;
  __emspDemoAuth?: DemoAuth;
  __emspAuthOverride?: AuthProvider;
};

/** A memory store with the demo driver's account and demo card. */
export function demoAccountStore(): MemoryAccountStore {
  const store = new MemoryAccountStore();
  const now = new Date().toISOString();
  store.drivers.set(DEMO_DRIVER_REF, {
    id: DEMO_DRIVER_REF,
    email: "driver@example.com",
    status: "active",
    stripeCustomerId: null,
    defaultPaymentMethodId: DEMO_CARD_ID,
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

/** Driver accounts and admin roles: Supabase in live mode; in demo mode, in memory. */
export function accountStore(): AccountStore {
  if (holder.__emspAccountStoreOverride)
    return holder.__emspAccountStoreOverride;
  if (isDemo()) return (holder.__emspDemoAccounts ??= demoAccountStore());
  return new SupabaseAccountStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
}

/** Sign-in: Supabase Auth in live mode; in demo mode, DemoAuth (sends nothing). */
export function authProvider(): AuthProvider {
  if (holder.__emspAuthOverride) return holder.__emspAuthOverride;
  if (isDemo()) return (holder.__emspDemoAuth ??= new DemoAuth());
  return new SupabaseAuth(config.supabaseUrl, config.supabaseServiceRoleKey);
}

/** Tests only: use `store` instead, or go back to the default with undefined. */
export function setAccountStoreForTests(store: AccountStore | undefined) {
  holder.__emspAccountStoreOverride = store;
}

/** Tests only: use `auth` instead, or go back to the default with undefined. */
export function setAuthProviderForTests(auth: AuthProvider | undefined) {
  holder.__emspAuthOverride = auth;
}
