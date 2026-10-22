import "server-only";
import { DEMO_CARD_ID } from "@/lib/accounts/registry";
import type { Driver } from "@/lib/accounts/store";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import type { PaymentDeps } from "./registry";
import { nowOf, PaymentError } from "./settle";
import { StripeError, StripeUnknownError, type PaymentMethod } from "./stripe";

/**
 * A driver's saved cards. Stripe holds them, on the network's own Stripe account: one
 * Customer per driver, a SetupIntent for the app's PaymentSheet, and the card the
 * driver chose as default. We keep only the Customer and default card IDs. Card
 * details shown to the driver (brand, last 4 digits, expiry) are read from Stripe each
 * time and never stored.
 */
export type CardView = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
};

const PM = /^pm_[A-Za-z0-9_]{1,250}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;
/** A Stripe API version, as the mobile SDK reports it: 2024-06-20 or 2025-09-30.clover. */
const API_VERSION = /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/;

const driverKey = (d: Driver, action: string) =>
  `emsp:driver:${d.id}:${action}`;

function stripeOf(deps: PaymentDeps) {
  if (!deps.stripe)
    throw new PaymentError("Payments are not set up on this network yet.", 503);
  return deps.stripe;
}

/** Stripe's errors in words for the driver; anything else goes up. */
async function stripeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StripeUnknownError)
      throw new PaymentError(
        "The payment service didn't answer. Try again.",
        502,
      );
    if (e instanceof StripeError)
      throw new PaymentError(
        "The payment service refused this. Try again.",
        502,
      );
    throw e;
  }
}

/** The driver's Stripe Customer, made the first time. One per driver, even at once. */
async function customerOf(driver: Driver, deps: PaymentDeps): Promise<string> {
  if (driver.stripeCustomerId) return driver.stripeCustomerId;
  const stripe = stripeOf(deps);
  // The key is the driver's: two requests at once get the same Customer back.
  const customer = await stripeCall(() =>
    stripe.createCustomer(
      { email: driver.email, driverRef: driver.id },
      driverKey(driver, "customer"),
    ),
  );
  const set = await deps.accounts.setCustomer(
    driver.id,
    customer.id,
    nowOf(deps).toISOString(),
  );
  if (set) return customer.id;
  const held = await deps.accounts.getDriver(driver.id);
  if (!held?.stripeCustomerId) throw new Error("Driver account disappeared");
  return held.stripeCustomerId;
}

/**
 * What the app's PaymentSheet needs to save a card: the Customer, a SetupIntent's
 * client secret, an ephemeral key for the app SDK's API version, and the publishable
 * key. Demo mode saves no card and says so.
 */
export async function setupCard(
  driver: Driver,
  input: { requestId?: unknown; stripeVersion?: unknown },
  deps: PaymentDeps,
) {
  if (isDemo())
    return {
      mode: "demo" as const,
      message: "Demo mode: no card is saved. The demo card is used instead.",
      customerId: null,
      setupIntentClientSecret: null,
      ephemeralKeySecret: null,
      publishableKey: null,
    };
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  if (!REQUEST_ID.test(requestId))
    throw new PaymentError(
      "Request ID must be 8 to 64 letters, digits or . _ : - (a UUID, say).",
    );
  const version =
    typeof input.stripeVersion === "string" ? input.stripeVersion : "";
  if (!API_VERSION.test(version))
    throw new PaymentError(
      "Send the Stripe API version of the app's SDK (stripeVersion).",
    );
  if (!config.stripePublishableKey)
    throw new PaymentError("Payments are not set up on this network yet.", 503);
  const stripe = stripeOf(deps);
  const customer = await customerOf(driver, deps);
  const [setup, key] = await Promise.all([
    stripeCall(() =>
      stripe.createSetupIntent(
        customer,
        driverKey(driver, `setup:${requestId}`),
      ),
    ),
    stripeCall(() =>
      stripe.createEphemeralKey(
        customer,
        version,
        driverKey(driver, `ephemeral:${requestId}`),
      ),
    ),
  ]);
  return {
    mode: "live" as const,
    customerId: customer,
    setupIntentClientSecret: setup.client_secret,
    ephemeralKeySecret: key.secret,
    publishableKey: config.stripePublishableKey,
  };
}

const view = (pm: PaymentMethod, defaultId: string | null): CardView => ({
  id: pm.id,
  brand: pm.card?.brand ?? "card",
  last4: pm.card?.last4 ?? "",
  expMonth: pm.card?.exp_month ?? null,
  expYear: pm.card?.exp_year ?? null,
  isDefault: pm.id === defaultId,
});

/** The driver's saved cards, as Stripe holds them. */
export async function listCards(
  driver: Driver,
  deps: PaymentDeps,
): Promise<CardView[]> {
  if (isDemo())
    return [
      {
        id: DEMO_CARD_ID,
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: nowOf(deps).getUTCFullYear() + 3,
        isDefault: driver.defaultPaymentMethodId === DEMO_CARD_ID,
      },
    ];
  if (!driver.stripeCustomerId) return [];
  const stripe = stripeOf(deps);
  const cards = await stripeCall(() =>
    stripe.listCards(driver.stripeCustomerId!),
  );
  return cards.map((pm) => view(pm, driver.defaultPaymentMethodId));
}

/** A card of this driver's Customer, else a 404: never another driver's card. */
async function ownCard(
  driver: Driver,
  id: unknown,
  deps: PaymentDeps,
): Promise<string> {
  if (typeof id !== "string" || !PM.test(id))
    throw new PaymentError("No such card.", 404);
  if (isDemo()) {
    if (id !== DEMO_CARD_ID) throw new PaymentError("No such card.", 404);
    return id;
  }
  if (!driver.stripeCustomerId) throw new PaymentError("No such card.", 404);
  const stripe = stripeOf(deps);
  let pm: PaymentMethod;
  try {
    pm = await stripe.getPaymentMethod(id);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404)
      throw new PaymentError("No such card.", 404);
    return stripeCall(() => Promise.reject(e));
  }
  if (pm.customer !== driver.stripeCustomerId || pm.type !== "card")
    throw new PaymentError("No such card.", 404);
  return pm.id;
}

/** Makes one of the driver's cards the one their charging is paid with. */
export async function setDefaultCard(
  driver: Driver,
  id: unknown,
  deps: PaymentDeps,
): Promise<Driver> {
  const card = await ownCard(driver, id, deps);
  const done = await deps.accounts.updateDriver(
    driver.id,
    { defaultPaymentMethodId: card },
    nowOf(deps).toISOString(),
  );
  if (!done) throw new Error("Driver account disappeared");
  return done;
}

/** Removes a saved card from Stripe. Holds already placed on it are not affected. */
export async function removeCard(
  driver: Driver,
  id: unknown,
  deps: PaymentDeps,
): Promise<Driver> {
  const card = await ownCard(driver, id, deps);
  if (isDemo())
    throw new PaymentError("Demo mode: the demo card cannot be removed.");
  const stripe = stripeOf(deps);
  await stripeCall(() =>
    stripe.detachPaymentMethod(card, driverKey(driver, `detach:${card}`)),
  );
  if (driver.defaultPaymentMethodId !== card) return driver;
  return (
    (await deps.accounts.updateDriver(
      driver.id,
      { defaultPaymentMethodId: null },
      nowOf(deps).toISOString(),
    )) ?? driver
  );
}
