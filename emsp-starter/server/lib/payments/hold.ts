import "server-only";
import type { HoldResult, PreAuth } from "@/lib/commands/pre-auth";
import type { Command } from "@/lib/commands/store";
import { primaryTariff } from "@/lib/locations/pricing";
import { tariffsFor, tariffsOfLocation } from "@/lib/locations/search";
import { sameId } from "@/lib/ocpi/locations";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { paymentDeps, type PaymentDeps } from "./registry";
import { audit, cancelHold, holdKey, nowOf } from "./settle";
import type { Payment } from "./store";
import {
  chargeOf,
  StripeError,
  StripeUnknownError,
  type PaymentIntent,
} from "./stripe";

/**
 * The payment hold before a START_SESSION (the PreAuth hook of lib/commands):
 *
 * 1. The driver's account must be active, with a default card saved through the app.
 * 2. The hold's currency is the charger's tariff currency (PAYMENT_DEFAULT_CURRENCY when
 *    no tariff says), and its amount HOLD_AMOUNTS for that currency.
 * 3. A payment row is made for the command (one per command), then a manual-capture
 *    PaymentIntent is confirmed off-session on the saved card, with the idempotency key
 *    `emsp:<command id>:hold`. The start goes to the CPO only once the card network
 *    authorised it.
 *
 * Demo mode places no hold on any card: the payment is marked held, labelled, and
 * nothing leaves the server.
 */

/** How long the hold of a start whose outcome we never learnt waits for a session. */
export const UNCERTAIN_KEEP_MS = 30 * 60_000;
/** When Stripe does not say how long a hold lasts: 7 days, the usual card rule. */
export const DEFAULT_HOLD_DAYS = 7;

const fail = (reason: string): HoldResult => ({ ok: false, reason });

/** Driver-facing words for a refused card, by Stripe's code. Never card details. */
export function declineReason(e: StripeError): string {
  if (e.code === "authentication_required")
    return "Your bank wants to confirm this card. Add it again in the app, or choose another card.";
  if (e.code === "expired_card")
    return "Your card has expired. Add another card in the app.";
  if (e.declineCode === "insufficient_funds")
    return "Your card was declined (insufficient funds). Choose another card in the app.";
  if (e.isCardError)
    return "Your card was declined. Choose another card in the app.";
  return "The payment check failed. Try again.";
}

/** The currency the charger bills in, by its tariff; the default when none says. */
export async function holdCurrency(
  c: Command,
  deps: Pick<PaymentDeps, "locations">,
): Promise<string> {
  const stored = await deps.locations.getLocation({
    peerId: c.peerId,
    countryCode: c.toCountryCode,
    partyId: c.toPartyId,
    id: c.locationId ?? "",
  });
  if (!stored) return config.defaultCurrency;
  const tariffs = tariffsOfLocation(
    stored,
    await tariffsFor(deps.locations, [stored]),
  );
  const connectors = (stored.location.evses ?? [])
    .filter((e) => !c.evseUid || sameId(e.uid, c.evseUid))
    .flatMap((e) => e.connectors)
    .filter((x) => !c.connectorId || sameId(x.id, c.connectorId));
  const currencies = new Set(
    connectors
      .map((x) => primaryTariff(x.tariff_ids, tariffs)?.currency)
      .filter((x): x is string => !!x),
  );
  // One currency for every connector the driver may use; else the default.
  return currencies.size === 1 ? [...currencies][0] : config.defaultCurrency;
}

/** When the card network drops a hold, from Stripe's capture_before. */
export function holdExpiry(pi: PaymentIntent, now: Date): string {
  const before = chargeOf(pi)?.payment_method_details?.card?.capture_before;
  return before
    ? new Date(before * 1000).toISOString()
    : new Date(now.getTime() + DEFAULT_HOLD_DAYS * 86_400_000).toISOString();
}

/** Places the hold for a start. See the file comment. */
export async function placeHold(
  c: Command,
  deps: PaymentDeps,
): Promise<HoldResult> {
  const demo = isDemo();
  const driver = await deps.accounts.getDriver(c.driverRef);
  if (!driver) return fail("Sign in to the app to charge.");
  if (driver.status !== "active")
    return fail("This account may not charge. Contact support.");
  if (!demo && !deps.stripe)
    return fail("Payments are not set up on this network yet.");
  if (!driver.defaultPaymentMethodId || (!demo && !driver.stripeCustomerId))
    return fail("Add a payment card in the app before you charge.");
  const currency = await holdCurrency(c, deps);
  const amount = config.holdAmounts[currency];
  if (!amount)
    return fail(`This network takes no app payments in ${currency}.`);

  const now = nowOf(deps);
  let p: Payment | null =
    (await deps.payments.insert(
      {
        commandId: c.id,
        driverRef: c.driverRef,
        currency,
        holdAmount: amount,
        paymentMethodId: driver.defaultPaymentMethodId,
      },
      now.toISOString(),
    )) ?? (await deps.payments.getByCommand(c.id));
  if (!p) throw new Error("Payment disappeared");
  if (p.status === "held") return { ok: true, reference: p.id };
  if (p.status !== "pending")
    return fail("The payment check failed. Try again.");
  await audit(deps, "payment.hold", p, { amount, currency });

  if (demo) {
    const held = await deps.payments.transition(
      p.id,
      ["pending"],
      {
        status: "held",
        authorizedAmount: amount,
        holdExpiresAt: new Date(
          now.getTime() + DEFAULT_HOLD_DAYS * 86_400_000,
        ).toISOString(),
        error: "Demo mode: no card was charged.",
      },
      now.toISOString(),
    );
    return held
      ? { ok: true, reference: held.id }
      : fail("The payment check failed. Try again.");
  }

  let pi: PaymentIntent;
  try {
    pi = await deps.stripe!.createHold(
      {
        amount,
        currency,
        customer: driver.stripeCustomerId!,
        paymentMethod: driver.defaultPaymentMethodId,
        metadata: { payment_id: p.id, command_id: c.id },
        incremental: config.incrementalAuth.enabled,
        description: "Charging session hold",
      },
      holdKey(c.id, "hold"),
    );
  } catch (e) {
    if (e instanceof StripeError) {
      p = await deps.payments.transition(
        p.id,
        ["pending"],
        { status: "failed", error: `Stripe ${e.code ?? e.type}`.slice(0, 300) },
        nowOf(deps).toISOString(),
      );
      if (p)
        await audit(deps, "payment.hold_failed", p, { code: e.code ?? e.type });
      return fail(declineReason(e));
    }
    if (e instanceof StripeUnknownError) {
      // A hold may exist on the card. The webhook cancels it when it reports one
      // for this payment; an admin sees it until then.
      p = await deps.payments.transition(
        p.id,
        ["pending"],
        {
          status: "failed",
          review: "hold_unknown",
          error: "No answer from Stripe",
        },
        nowOf(deps).toISOString(),
      );
      if (p) await audit(deps, "payment.hold_unknown", p);
      return fail("The payment check didn't answer. Try again in a minute.");
    }
    throw e;
  }

  if (pi.status !== "requires_capture") {
    // Off-session cards that need the driver (3-D Secure) cannot be held here.
    const failed = await deps.payments.transition(
      p.id,
      ["pending"],
      {
        status: "failed",
        paymentIntentId: pi.id,
        error: `Stripe ${pi.last_payment_error?.code ?? pi.status}`.slice(
          0,
          300,
        ),
      },
      nowOf(deps).toISOString(),
    );
    if (failed) {
      await audit(deps, "payment.hold_failed", failed, { status: pi.status });
      await cancelHold(failed, deps, "hold-not-usable").catch(() => undefined);
    }
    return fail(
      pi.status === "requires_action"
        ? "Your bank wants to confirm this card. Add it again in the app, or choose another card."
        : "Your card was declined. Choose another card in the app.",
    );
  }

  const card = chargeOf(pi)?.payment_method_details?.card;
  const held = await deps.payments.transition(
    p.id,
    ["pending"],
    {
      status: "held",
      paymentIntentId: pi.id,
      authorizedAmount: pi.amount_capturable,
      holdExpiresAt: holdExpiry(pi, now),
      incrementalAvailable:
        card?.incremental_authorization?.status === "available",
    },
    nowOf(deps).toISOString(),
  );
  if (!held) return fail("The payment check failed. Try again.");
  await audit(deps, "payment.held", held, {
    amount: held.authorizedAmount,
    currency,
    incremental_available: held.incrementalAvailable,
  });
  return { ok: true, reference: held.id };
}

/**
 * Releases the hold of a start that ended without charging. When we never learnt
 * whether the charger started (`uncertain`), the hold is kept for UNCERTAIN_KEEP_MS in
 * case a session appears; the payment sweep then releases it if none did.
 */
export async function releaseHold(
  c: Command,
  why: { uncertain: boolean },
  deps: PaymentDeps,
): Promise<void> {
  const p = await deps.payments.getByCommand(c.id);
  // No payment, or a hold still being placed: startSession releases again after it.
  if (!p || p.status !== "held") return;
  const now = nowOf(deps);
  if (why.uncertain) {
    if (p.releaseAfter) return;
    const kept = await deps.payments.transition(
      p.id,
      ["held"],
      {
        releaseAfter: new Date(now.getTime() + UNCERTAIN_KEEP_MS).toISOString(),
      },
      now.toISOString(),
    );
    if (kept) await audit(deps, "payment.release_later", kept);
    return;
  }
  // Queue it first, so the sweep finishes the release if Stripe does not answer now.
  const queued =
    (await deps.payments.transition(
      p.id,
      ["held"],
      { releaseAfter: now.toISOString() },
      now.toISOString(),
    )) ?? p;
  await cancelHold(queued, deps, "cancel");
}

/** The PreAuth hook the commands use: card holds on the network's Stripe account. */
export function paymentsPreAuth(
  deps: () => PaymentDeps = () => paymentDeps("app"),
): PreAuth {
  return {
    hold: (c) => placeHold(c, deps()),
    release: (c, why) => releaseHold(c, why, deps()),
  };
}
