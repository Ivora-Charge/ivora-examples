import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentDeps } from "./registry";
import { audit, cancelHold, holdKey, nowOf, settleCdr } from "./settle";
import { refundStatusOf, type Payment } from "./store";
import type { Charge, PaymentIntent, Refund as StripeRefund } from "./stripe";

/**
 * The Stripe webhook (`POST /api/webhooks/stripe`): payment intent and charge events
 * for our holds, so the database follows what happened on Stripe's side even when an
 * answer to us was lost, plus saved cards. Every request is checked against
 * STRIPE_WEBHOOK_SECRET (the `Stripe-Signature` header: HMAC-SHA256 of
 * `<timestamp>.<raw body>`, at most 5 minutes old); an event is handled once by its ID.
 */
export const SIGNATURE_TOLERANCE_S = 300;

/** True when `header` signs `payload` with `secret`, within the tolerance. */
export function verifySignature(
  payload: string,
  header: string | null,
  secret: string,
  now = Date.now(),
): boolean {
  if (!header || header.length > 2048) return false;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((x) => x?.trim());
    if (k === "t" && /^\d{1,12}$/.test(v ?? "")) timestamp = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "")) signatures.push(v!);
  }
  if (timestamp === undefined || !signatures.length) return false;
  if (Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest();
  return signatures.some((s) =>
    timingSafeEqual(Buffer.from(s, "hex"), expected),
  );
}

export type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

export function parseEvent(payload: string): StripeEvent | null {
  try {
    const e = JSON.parse(payload) as StripeEvent;
    return typeof e?.id === "string" &&
      /^evt_[A-Za-z0-9]+$/.test(e.id) &&
      typeof e.type === "string" &&
      e.data?.object &&
      typeof e.data.object === "object"
      ? e
      : null;
  } catch {
    return null;
  }
}

/** The payment of a PaymentIntent: by its ID, else by the payment ID we put on it. */
async function paymentOf(
  pi: PaymentIntent,
  deps: PaymentDeps,
): Promise<Payment | null> {
  const byIntent = await deps.payments.getByIntent(pi.id);
  if (byIntent) return byIntent;
  const id = pi.metadata?.payment_id;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const p = await deps.payments.get(id);
  // Only ours if it names the same command too.
  return p && pi.metadata?.command_id === p.commandId ? p : null;
}

async function onIntent(pi: PaymentIntent, deps: PaymentDeps) {
  const p = await paymentOf(pi, deps);
  if (!p) return;
  const now = nowOf(deps).toISOString();
  if (pi.status === "requires_capture") {
    // A hold on the card for a payment that has none: one we never heard back about,
    // or one placed after its start ended. Cancel it; the card must not stay held.
    let orphan = ["failed", "released", "expired"].includes(p.status);
    if (p.status === "pending") {
      const c = await deps.commands.get(p.commandId);
      orphan =
        !!c &&
        !["claimed", "sending", "accepted", "succeeded"].includes(c.status);
    }
    if (!orphan) return;
    await cancelHold({ ...p, paymentIntentId: pi.id }, deps, "cancel-orphan");
    if (p.review === "hold_unknown")
      await deps.payments.transition(
        p.id,
        [p.status],
        { paymentIntentId: pi.id, reviewedAt: now },
        now,
      );
    await audit(deps, "payment.orphan_cancelled", p);
    return;
  }
  if (p.status !== "held") return;
  if (pi.status === "canceled") {
    // Released by us (queued), or dropped by the card network or the Dashboard.
    const done = await deps.payments.transition(
      p.id,
      ["held"],
      { status: p.releaseAfter ? "released" : "expired", releaseAfter: null },
      now,
    );
    if (done)
      await audit(deps, `payment.${done.status}`, done, { source: "webhook" });
  } else if (pi.status === "succeeded") {
    // Captured while still held here: our own capture whose answer was lost, or one
    // not written yet. With the start's CDR, record it from the CDR (amount, review,
    // shortfall, receipt) exactly as the capture would have.
    const cdrs = await deps.sessions.findCdrsByCommand(p.commandId);
    const cdr = p.cdrId
      ? cdrs.find((c) => c.id === p.cdrId)
      : cdrs.find((c) => !c.cdr.credit);
    if (cdr) {
      await settleCdr(cdr, deps, pi);
      return;
    }
    // No CDR: captured outside the CDR flow (the Dashboard). Keep the record true.
    const done = await deps.payments.transition(
      p.id,
      ["held"],
      {
        status: "captured",
        capturedAmount: pi.amount_received,
        releaseAfter: null,
        review: "refund_outside",
      },
      now,
    );
    if (done)
      await audit(deps, "payment.captured", done, { source: "webhook" });
  }
}

async function onCharge(type: string, charge: Charge, deps: PaymentDeps) {
  if (!charge.payment_intent) return;
  const p = await deps.payments.getByIntent(charge.payment_intent);
  if (!p) return;
  const now = nowOf(deps).toISOString();
  if (type === "charge.expired" && p.status === "held") {
    const done = await deps.payments.transition(
      p.id,
      ["held"],
      { status: "expired", releaseAfter: null },
      now,
    );
    if (done) await audit(deps, "payment.expired", done, { source: "webhook" });
  }
  if (type === "charge.refunded") {
    // Refunds we made are counted already; more than that was refunded elsewhere.
    const ours = (await deps.payments.listRefunds(p.id))
      .filter((r) => r.status !== "failed")
      .reduce((sum, r) => sum + r.amount, 0);
    if (charge.amount_refunded > ours && p.review !== "refund_outside") {
      const done = await deps.payments.transition(
        p.id,
        [p.status],
        { review: "refund_outside", reviewedAt: null },
        now,
      );
      if (done)
        await audit(deps, "payment.review", done, { reason: "refund_outside" });
    }
  }
}

/** A refund's status, from Stripe: pending ones settle here, and late failures too. */
async function onRefund(re: StripeRefund, deps: PaymentDeps) {
  if (typeof re.id !== "string" || !/^re_[A-Za-z0-9_]+$/.test(re.id)) return;
  let r = await deps.payments.getRefundByStripeId(re.id);
  if (!r) {
    // A refund whose answer to us was lost: found by the IDs we put on it.
    const id = re.metadata?.refund_id;
    const paymentId = re.metadata?.payment_id;
    if (typeof id !== "string" || typeof paymentId !== "string") return;
    const p = await deps.payments.get(paymentId);
    if (!p || !re.payment_intent || p.paymentIntentId !== re.payment_intent)
      return;
    r =
      (await deps.payments.listRefunds(p.id)).find((x) => x.id === id) ?? null;
    if (!r) return;
  }
  const status = refundStatusOf(re.status);
  const done = await deps.payments.settleRefund(r.id, status, re.id);
  if (done && done.status !== r.status) {
    const p = await deps.payments.get(done.paymentId);
    if (p)
      await audit(deps, `payment.refund_${done.status}`, p, {
        refund_id: done.id,
        amount: done.amount,
        source: "webhook",
      });
  }
}

async function onDispute(dispute: Record<string, unknown>, deps: PaymentDeps) {
  const pi = dispute.payment_intent;
  if (typeof pi !== "string") return;
  const p = await deps.payments.getByIntent(pi);
  if (!p) return;
  const now = nowOf(deps).toISOString();
  const done = await deps.payments.transition(
    p.id,
    [p.status],
    { review: "dispute", reviewedAt: null },
    now,
  );
  if (done) await audit(deps, "payment.review", done, { reason: "dispute" });
}

/** A card saved through the PaymentSheet becomes the default when there is none. */
async function onSetup(intent: Record<string, unknown>, deps: PaymentDeps) {
  const customer = intent.customer;
  const pm = intent.payment_method;
  if (
    typeof customer !== "string" ||
    typeof pm !== "string" ||
    !/^pm_[A-Za-z0-9_]+$/.test(pm)
  )
    return;
  const driver = await deps.accounts.getDriverByCustomer(customer);
  if (!driver || driver.defaultPaymentMethodId) return;
  await deps.accounts.updateDriver(
    driver.id,
    { defaultPaymentMethodId: pm },
    nowOf(deps).toISOString(),
  );
}

/** Handles a verified event, once per event ID. */
export async function handleEvent(
  event: StripeEvent,
  deps: PaymentDeps,
): Promise<"handled" | "duplicate"> {
  if (await deps.payments.hasEvent(event.id)) return "duplicate";
  const object = event.data.object;
  try {
    if (
      event.type.startsWith("payment_intent.") &&
      object.object === "payment_intent"
    )
      await onIntent(object as unknown as PaymentIntent, deps);
    else if (
      ["refund.created", "refund.updated", "refund.failed"].includes(
        event.type,
      ) ||
      (event.type.startsWith("charge.refund.") && object.object === "refund")
    ) {
      if (object.object === "refund")
        await onRefund(object as unknown as StripeRefund, deps);
    } else if (event.type.startsWith("charge.dispute."))
      await onDispute(object, deps);
    else if (event.type.startsWith("charge.") && object.object === "charge")
      await onCharge(event.type, object as unknown as Charge, deps);
    else if (event.type === "setup_intent.succeeded")
      await onSetup(object, deps);
  } catch (e) {
    // Not recorded: Stripe delivers it again. Every step above is a compare-and-swap,
    // so handling it twice changes nothing twice.
    console.error(
      `Stripe event ${event.id} (${event.type}) failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
    throw e;
  }
  return (await deps.payments.recordEvent(event.id, event.type))
    ? "handled"
    : "duplicate";
}

/** For tests: the idempotency key an orphan cancel uses. */
export const orphanKey = (commandId: string) =>
  holdKey(commandId, "cancel-orphan");
