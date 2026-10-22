import "server-only";
import { stopSession, type CommandDeps } from "@/lib/commands/manage";
import { receiptEmail } from "@/lib/receipts/receipt";
import type { StoredCdr, StoredSession } from "@/lib/sessions/store";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { emitPaymentEvent } from "./events";
import { cdrAmount } from "./money";
import type { PaymentDeps } from "./registry";
import {
  refundStatusOf,
  type Payment,
  type PaymentPatch,
  type PaymentStatus,
  type Refund,
  type ReviewReason,
} from "./store";
import { StripeError, StripeUnknownError, type PaymentIntent } from "./stripe";

/**
 * Settling a payment from its CDR, releasing holds, raising them during a long
 * session, refunds, and the admin's decisions on payments under review.
 *
 * The rules (see the README, Payments):
 *
 * - A payment is captured only from a CDR linked to its own START_SESSION command
 *   (the Sessions module links a CDR to the start only through the start's own session).
 * - The amount is the CDR's total_cost incl. VAT, rounded once to minor units, and
 *   never more than the hold. A CDR above the hold captures the hold and goes to
 *   admin review with the difference: nothing more is ever charged automatically.
 * - A CDR in another currency than the hold charges nothing and goes to review.
 * - A CDR that comes after the hold expired charges nothing and goes to review.
 * - A zero-cost CDR releases the hold.
 * - Every Stripe write has an idempotency key from the command ID and the action.
 */
export const nowOf = (deps: Pick<PaymentDeps, "now">) =>
  deps.now?.() ?? new Date();

/** The idempotency key of a Stripe write for a charge request (a command) and action. */
export const holdKey = (commandId: string, action: string) =>
  `emsp:${commandId}:${action}`;

/** The most raises of one hold, with incremental authorization on. */
export const MAX_INCREMENTS = 10;

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export async function audit(
  deps: Pick<PaymentDeps, "peers" | "actor">,
  action: string,
  p: Payment,
  details: Record<string, unknown> = {},
) {
  try {
    await deps.peers.audit({
      actor: deps.actor ?? "system",
      action,
      subjectId: p.id,
      // The payment and its command; never the driver, the card or the email.
      details: {
        command_id: p.commandId,
        status: p.status,
        currency: p.currency,
        review: p.review,
        ...details,
      },
    });
  } catch (e) {
    console.error(
      `Audit of payment ${p.id} failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
  }
}

async function reread(id: string, deps: Pick<PaymentDeps, "payments">) {
  const p = await deps.payments.get(id);
  if (!p) throw new Error("Payment disappeared");
  return p;
}

/** A transition, audited, with the matching event; the current version if it lost. */
async function move(
  p: Payment,
  from: readonly PaymentStatus[],
  patch: PaymentPatch,
  deps: PaymentDeps,
  action: string,
  details: Record<string, unknown> = {},
): Promise<{ moved: boolean; payment: Payment }> {
  const done = await deps.payments.transition(
    p.id,
    from,
    patch,
    nowOf(deps).toISOString(),
  );
  if (!done) return { moved: false, payment: await reread(p.id, deps) };
  await audit(deps, action, done, details);
  const event = {
    paymentId: done.id,
    commandId: done.commandId,
    driverRef: done.driverRef,
  };
  if (patch.status === "captured" && done.status === "captured")
    await emitPaymentEvent({ type: "payment.captured", ...event });
  if (patch.status === "released" && done.status === "released")
    await emitPaymentEvent({ type: "payment.released", ...event });
  if (patch.review && !p.review)
    await emitPaymentEvent({ type: "payment.review", ...event });
  return { moved: true, payment: done };
}

/** Marks a payment for review, whatever its status, unless it already is. */
async function flag(
  p: Payment,
  review: ReviewReason,
  deps: PaymentDeps,
  patch: PaymentPatch = {},
): Promise<Payment> {
  if (p.review === review && !p.reviewedAt) return p;
  return (
    await move(
      p,
      [p.status],
      { ...patch, review, reviewedAt: null },
      deps,
      "payment.review",
      {
        reason: review,
      },
    )
  ).payment;
}

/** What Stripe holds for a payment whose write failed: captured, cancelled, or held. */
async function syncFromStripe(
  p: Payment,
  pi: PaymentIntent,
  deps: PaymentDeps,
): Promise<Payment> {
  if (p.status !== "held") return p;
  if (pi.status === "succeeded")
    return (
      await move(
        p,
        ["held"],
        {
          status: "captured",
          capturedAmount: pi.amount_received,
          releaseAfter: null,
        },
        deps,
        "payment.captured",
        { amount: pi.amount_received, source: "stripe" },
      )
    ).payment;
  if (pi.status === "canceled")
    return (
      await move(
        p,
        ["held"],
        { status: p.releaseAfter ? "released" : "expired", releaseAfter: null },
        deps,
        p.releaseAfter ? "payment.released" : "payment.expired",
      )
    ).payment;
  return p;
}

/**
 * Cancels the hold on the card and marks a held payment released (with `patch`). On
 * no answer from Stripe the payment stays held, queued, and the sweep tries again with
 * the same key. A payment that is not held only has its PaymentIntent cancelled.
 */
export async function cancelHold(
  p: Payment,
  deps: PaymentDeps,
  action = "cancel",
  patch: PaymentPatch = {},
): Promise<Payment> {
  if (!isDemo() && p.paymentIntentId) {
    if (!deps.stripe) return p;
    try {
      await deps.stripe.cancel(p.paymentIntentId, holdKey(p.commandId, action));
    } catch (e) {
      if (e instanceof StripeUnknownError) return p;
      if (!(e instanceof StripeError)) throw e;
      // Already cancelled or captured: go by what Stripe holds.
      let pi: PaymentIntent;
      try {
        pi = await deps.stripe.getPaymentIntent(p.paymentIntentId);
      } catch {
        return p;
      }
      if (pi.status !== "canceled") return syncFromStripe(p, pi, deps);
    }
  }
  if (p.status !== "held") return p;
  return (
    await move(
      p,
      ["held"],
      { ...patch, status: "released", releaseAfter: null },
      deps,
      "payment.released",
    )
  ).payment;
}

/** Sends the receipt of a settled payment, once. A failure is logged, not retried. */
export async function sendReceipt(
  p: Payment,
  cdr: StoredCdr,
  deps: PaymentDeps,
): Promise<void> {
  if (!deps.mailer) return;
  const driver = await deps.accounts.getDriver(p.driverRef);
  if (!driver) return;
  if (!(await deps.payments.claimReceipt(p.id, nowOf(deps).toISOString())))
    return;
  try {
    await deps.mailer.send(
      receiptEmail(driver.email, p, cdr.cdr, { demo: isDemo() }),
    );
    await audit(deps, "payment.receipt", p, { mailer: deps.mailer.name });
  } catch (e) {
    console.error(
      `Receipt of payment ${p.id} failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
  }
}

/**
 * Settles the payment of a CDR's START_SESSION command. Safe to call more than once
 * and at once (the CDR event, the sweep and the webhook): each step is a
 * compare-and-swap, and the capture has one idempotency key per command.
 *
 * `captured` is Stripe's word (a webhook) that the hold was captured already, by a
 * capture of ours whose answer was lost or that has not been written yet: the payment
 * is then recorded from the CDR, as if our capture had answered, without capturing.
 */
export async function settleCdr(
  stored: StoredCdr,
  deps: PaymentDeps,
  captured?: PaymentIntent,
): Promise<Payment | null> {
  if (!stored.commandId) return null;
  let p = await deps.payments.getByCommand(stored.commandId);
  if (!p) return null;
  const onStripe =
    captured?.status === "succeeded" && captured.id === p.paymentIntentId
      ? captured
      : null;
  const cdr = stored.cdr;
  if (cdr.credit) return flag(p, "credit_cdr", deps);
  // One CDR settles a payment; another one for the same start (a correction, say) is
  // for a person: nothing more is charged or refunded automatically.
  if (p.cdrId && p.cdrId !== stored.id) {
    if (p.review === "second_cdr" && !p.reviewedAt) return p;
    // Already looked at, and this CDR was there then: not new.
    if (
      p.review === "second_cdr" &&
      p.reviewedAt &&
      Date.parse(stored.receivedAt) <= Date.parse(p.reviewedAt)
    )
      return p;
    return (
      await move(
        p,
        [p.status],
        { review: "second_cdr", reviewedAt: null },
        deps,
        "payment.review",
        {
          reason: "second_cdr",
          cdr_id: stored.id,
          cdr_amount: cdrAmount(cdr.total_cost, cdr.currency).minor,
          cdr_currency: cdr.currency,
        },
      )
    ).payment;
  }
  const { minor, vatKnown } = cdrAmount(cdr.total_cost, cdr.currency);
  const fromCdr: PaymentPatch = {
    cdrId: stored.id,
    cdrCurrency: cdr.currency,
    cdrAmount: minor,
  };

  if (p.status === "released" || p.status === "expired") {
    // The hold is gone (it expired, or the start looked like it never charged): no
    // automatic charge. Zero costs nothing.
    if (p.cdrId) return p;
    return minor === 0
      ? (await move(p, [p.status], fromCdr, deps, "payment.cdr")).payment
      : flag(p, "hold_expired", deps, { ...fromCdr, shortfallAmount: minor });
  }
  if (p.status !== "held") return p;
  if (p.cdrId && p.review === "currency_mismatch" && !onStripe) return p;

  if (cdr.currency !== p.currency) {
    if (!onStripe)
      return flag(p, "currency_mismatch", deps, {
        ...fromCdr,
        releaseAfter: null,
      });
    // Captured on Stripe all the same (an admin's capture, or the Dashboard): keep
    // the record true, still for a person.
    return (
      await move(
        p,
        ["held"],
        {
          ...fromCdr,
          status: "captured",
          capturedAmount: onStripe.amount_received,
          releaseAfter: null,
          review: "currency_mismatch",
        },
        deps,
        "payment.captured",
        { amount: onStripe.amount_received, source: "stripe" },
      )
    ).payment;
  }

  const now = nowOf(deps);
  if (
    !onStripe &&
    p.holdExpiresAt &&
    Date.parse(p.holdExpiresAt) <= now.getTime()
  ) {
    return (
      await move(
        p,
        ["held"],
        {
          ...fromCdr,
          status: "expired",
          releaseAfter: null,
          review: minor ? "hold_expired" : null,
          shortfallAmount: minor || null,
        },
        deps,
        "payment.expired",
      )
    ).payment;
  }

  if (minor === 0 && !onStripe) {
    p = await cancelHold(p, deps, "cancel", fromCdr);
    if (p.status === "released") await sendReceipt(p, stored, deps);
    return p;
  }

  const capture = Math.min(minor, p.authorizedAmount);
  let taken = capture;
  if (onStripe) taken = onStripe.amount_received;
  else if (!isDemo()) {
    if (!deps.stripe || !p.paymentIntentId) return p;
    try {
      const pi = await deps.stripe.capture(
        p.paymentIntentId,
        capture,
        holdKey(p.commandId, "capture"),
      );
      taken = pi.amount_received;
    } catch (e) {
      if (e instanceof StripeUnknownError) return p; // the sweep tries again
      if (!(e instanceof StripeError)) throw e;
      let pi: PaymentIntent;
      try {
        pi = await deps.stripe.getPaymentIntent(p.paymentIntentId);
      } catch {
        return p;
      }
      if (pi.status === "canceled")
        // The card network dropped the hold before we captured: nothing is charged.
        return flag(p, "hold_expired", deps, {
          ...fromCdr,
          status: "expired",
          releaseAfter: null,
          shortfallAmount: minor,
        });
      if (pi.status !== "succeeded") {
        await deps.payments.transition(
          p.id,
          ["held"],
          { error: `Stripe ${e.code ?? e.type}`.slice(0, 300) },
          now.toISOString(),
        );
        return p;
      }
      taken = pi.amount_received;
    }
  }
  const above = minor > p.authorizedAmount;
  // A new reason replaces an older one (a declined raise is then also a CDR above
  // the hold); without one, the older reason stays. Stripe holding another amount
  // than ours means it was captured outside this server.
  const review: ReviewReason | null =
    taken !== capture
      ? "refund_outside"
      : above
        ? "cdr_above_hold"
        : vatKnown
          ? null
          : "vat_unknown";
  const r = await move(
    p,
    ["held"],
    {
      ...fromCdr,
      status: "captured",
      capturedAmount: taken,
      releaseAfter: null,
      ...(review ? { review, reviewedAt: null } : {}),
      shortfallAmount: above ? minor - p.authorizedAmount : null,
    },
    deps,
    "payment.captured",
    {
      amount: taken,
      cdr_amount: minor,
      ...(onStripe ? { source: "stripe" } : {}),
    },
  );
  if (r.moved) await sendReceipt(r.payment, stored, deps);
  return r.payment;
}

/**
 * The scheduled pass over held payments (the cron route), since events are not queued:
 *
 * - a hold queued for release: released, unless a session appeared for its start
 *   (then it waits for the CDR);
 * - a hold whose start has a CDR: settled from it;
 * - a hold past its expiry with no CDR: marked expired (a CDR that comes later goes to
 *   review).
 */
export async function sweepPayments(
  deps: PaymentDeps,
  { limit = 100 } = {},
): Promise<{ settled: number; released: number; expired: number }> {
  const out = { settled: 0, released: 0, expired: 0 };
  const now = nowOf(deps);
  for (const held of await deps.payments.listHeld(limit)) {
    try {
      let p = held;
      if (p.cdrId) continue; // waiting for a person (currency_mismatch)
      const cdr = (await deps.sessions.findCdrsByCommand(p.commandId)).find(
        (c) => !c.cdr.credit,
      );
      if (cdr) {
        p = (await settleCdr(cdr, deps)) ?? p;
        if (p.status !== "held") out.settled++;
        continue;
      }
      if (p.releaseAfter && Date.parse(p.releaseAfter) <= now.getTime()) {
        const command = await deps.commands.get(p.commandId);
        if (command?.sessionId && command.status !== "hold_failed") {
          // A session appeared after all: its CDR settles the payment.
          await deps.payments.transition(
            p.id,
            ["held"],
            { releaseAfter: null },
            now.toISOString(),
          );
          continue;
        }
        if ((await cancelHold(p, deps)).status === "released") out.released++;
        continue;
      }
      if (p.holdExpiresAt && Date.parse(p.holdExpiresAt) <= now.getTime()) {
        const r = await move(
          p,
          ["held"],
          { status: "expired", releaseAfter: null },
          deps,
          "payment.expired",
        );
        if (r.moved) out.expired++;
      }
    } catch (e) {
      console.error(
        `Payment sweep of ${held.id} failed: ${e instanceof Error ? e.name : "unknown error"}`,
      );
    }
  }
  return out;
}

/** Why we stop a session whose hold could not be raised: stored and shown to the driver. */
export const INCREMENT_DECLINED_REASON =
  "Stopped because your card did not allow a higher payment hold.";

/**
 * Incremental authorization (off unless STRIPE_INCREMENTAL_AUTH is on): when a running
 * session's cost reaches HOLD_INCREMENT_AT_PERCENT of the hold, raise the hold by
 * another HOLD_AMOUNTS step, with the key `emsp:<command>:increment:<n>`. If the raise
 * is refused (or MAX_INCREMENTS is reached), ask the CPO to stop the session, store
 * the reason on the session and the payment, flag the payment for review, and emit
 * `hold_increment_declined`. Never charges beyond what is authorised.
 */
export async function maybeIncrement(
  stored: StoredSession,
  deps: PaymentDeps,
  commandDeps: () => CommandDeps,
): Promise<Payment | null> {
  if (!config.incrementalAuth.enabled || !stored.commandId) return null;
  const s = stored.session;
  if (s.status !== "ACTIVE" || !s.total_cost) return null;
  const p = await deps.payments.getByCommand(stored.commandId);
  if (!p || p.status !== "held" || !p.incrementalAvailable) return null;
  if (s.currency !== p.currency) return null;
  const cost = cdrAmount(s.total_cost, s.currency).minor;
  const threshold = Math.ceil(
    (p.authorizedAmount * config.incrementalAuth.atPercent) / 100,
  );
  if (cost < threshold) return null;

  const n = p.increments + 1;
  const amount = p.authorizedAmount + p.holdAmount;
  let declined = n > MAX_INCREMENTS;
  let authorized = amount;
  if (!declined && !isDemo()) {
    if (!deps.stripe || !p.paymentIntentId) return null;
    try {
      const pi = await deps.stripe.incrementAuthorization(
        p.paymentIntentId,
        amount,
        holdKey(p.commandId, `increment:${n}`),
      );
      authorized = pi.amount_capturable;
    } catch (e) {
      if (e instanceof StripeUnknownError) return p; // the next update tries again
      if (!(e instanceof StripeError)) throw e;
      declined = true;
    }
  }
  const now = nowOf(deps).toISOString();
  if (!declined) {
    const raised = await deps.payments.transition(
      p.id,
      ["held"],
      { authorizedAmount: authorized, increments: n },
      now,
      { ifIncrements: p.increments },
    );
    if (raised)
      await audit(deps, "payment.increment", raised, { amount: authorized, n });
    return raised ?? reread(p.id, deps);
  }
  return declineIncrement(stored, p, deps, commandDeps);
}

/**
 * A raise of `p`'s hold was declined (or MAX_INCREMENTS reached): flag the payment,
 * store why on the session and the payment, emit `hold_increment_declined` and ask the
 * CPO to stop the session. Only the caller whose compare-and-swap uses the attempt's
 * number does this, so the session is stopped once. Demo mode also comes here for its
 * demo card that declines raises (lib/driver-app/demo-charging.ts).
 */
export async function declineIncrement(
  stored: StoredSession,
  p: Payment,
  deps: PaymentDeps,
  commandDeps: () => CommandDeps,
): Promise<Payment | null> {
  const s = stored.session;
  const n = p.increments + 1;
  const now = nowOf(deps).toISOString();
  // Declined: this attempt's number is used, so one caller alone stops the session.
  const stopped = await deps.payments.transition(
    p.id,
    ["held"],
    {
      increments: n,
      incrementalAvailable: false,
      review: "increment_declined",
      stopReason: INCREMENT_DECLINED_REASON,
    },
    now,
    { ifIncrements: p.increments },
  );
  if (!stopped) return reread(p.id, deps);
  await audit(deps, "payment.increment_declined", stopped, { n });
  await deps.sessions.setStopReason(stored.id, INCREMENT_DECLINED_REASON, now);
  await emitPaymentEvent({
    type: "hold_increment_declined",
    paymentId: stopped.id,
    commandId: stopped.commandId,
    driverRef: stopped.driverRef,
    sessionId: s.id,
    authorizedAmount: stopped.authorizedAmount,
    currency: stopped.currency,
    stopReason: INCREMENT_DECLINED_REASON,
  });
  await emitPaymentEvent({
    type: "payment.review",
    paymentId: stopped.id,
    commandId: stopped.commandId,
    driverRef: stopped.driverRef,
  });
  try {
    await stopSession(
      {
        driverRef: stopped.driverRef,
        requestId: `hold-declined:${stopped.id}`,
        peerId: stored.peerId,
        sessionId: s.id,
      },
      { ...commandDeps(), actor: "payments" },
    );
  } catch (e) {
    // The payment is flagged: an admin sees it even if the stop did not go out.
    console.error(
      `Stopping the session of payment ${stopped.id} failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
  }
  return stopped;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/**
 * Refunds part or all of a captured payment. `requestId` is the admin's: the same one
 * again never refunds twice, and retries a refund whose outcome was unknown.
 */
export async function refundPayment(
  input: {
    paymentId: string;
    amount: number;
    requestId: string;
    reason?: string;
  },
  deps: PaymentDeps,
): Promise<Refund> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new PaymentError("Enter an amount in minor units (cents), above 0.");
  if (!REQUEST_ID.test(input.requestId))
    throw new PaymentError("Invalid request ID.");
  const reason = input.reason?.trim().slice(0, 300) ?? "";
  if (!reason) throw new PaymentError("Give a reason for the refund.");
  const p = await deps.payments.get(input.paymentId);
  if (!p) throw new PaymentError("No such payment.", 404);
  if (p.status !== "captured")
    throw new PaymentError("Only a captured payment can be refunded.");
  const reserved = await deps.payments.reserveRefund({
    paymentId: p.id,
    requestId: input.requestId,
    amount: input.amount,
    reason,
    actor: deps.actor ?? "admin",
  });
  if (reserved.outcome === "not_found")
    throw new PaymentError("No such payment.", 404);
  if (!reserved.refund)
    throw new PaymentError("That is more than what is left to refund.");
  let refund: Refund = reserved.refund;
  if (reserved.outcome === "replayed" && refund.amount !== input.amount)
    throw new PaymentError("This request ID was used for another refund.", 409);
  // Settled, or at Stripe already (pending there, or waiting on the bank): its webhook
  // settles it. Sending it again could refund twice once Stripe forgets the key.
  if (refund.status !== "pending" || refund.stripeRefundId) return refund;

  if (isDemo()) {
    refund =
      (await deps.payments.settleRefund(refund.id, "succeeded", null)) ??
      refund;
    await audit(deps, "payment.refund_succeeded", await reread(p.id, deps), {
      refund_id: refund.id,
      amount: refund.amount,
      reason,
      demo: true,
    });
    return refund;
  }
  if (!deps.stripe || !p.paymentIntentId)
    throw new PaymentError("Payments are not set up on this network.", 503);
  try {
    const r = await deps.stripe.refund(
      {
        paymentIntent: p.paymentIntentId,
        amount: refund.amount,
        metadata: { payment_id: p.id, refund_id: refund.id },
      },
      holdKey(p.commandId, `refund:${refund.requestId}`),
    );
    refund =
      (await deps.payments.settleRefund(
        refund.id,
        refundStatusOf(r.status),
        r.id,
      )) ?? refund;
  } catch (e) {
    if (e instanceof StripeUnknownError)
      throw new PaymentError(
        "Stripe did not answer. Send the same refund again to retry it; it will not refund twice.",
        502,
      );
    if (!(e instanceof StripeError)) throw e;
    refund =
      (await deps.payments.settleRefund(refund.id, "failed", null)) ?? refund;
    await audit(deps, "payment.refund_failed", p, {
      code: e.code ?? e.type,
      refund_id: refund.id,
      amount: refund.amount,
      reason,
    });
    throw new PaymentError(`Stripe refused the refund (${e.code ?? e.type}).`);
  }
  await audit(
    deps,
    `payment.refund_${refund.status}`,
    await reread(p.id, deps),
    {
      refund_id: refund.id,
      amount: refund.amount,
      reason,
    },
  );
  return refund;
}

/** An admin's decision for a held payment under review: capture up to the hold. */
export async function captureForReview(
  input: { paymentId: string; amount: number },
  deps: PaymentDeps,
): Promise<Payment> {
  const p = await deps.payments.get(input.paymentId);
  if (!p) throw new PaymentError("No such payment.", 404);
  if (p.status !== "held")
    throw new PaymentError("Only a held payment can be captured.");
  if (
    !Number.isSafeInteger(input.amount) ||
    input.amount <= 0 ||
    input.amount > p.authorizedAmount
  )
    throw new PaymentError("The amount must be above 0 and at most the hold.");
  let captured = input.amount;
  if (!isDemo()) {
    if (!deps.stripe || !p.paymentIntentId)
      throw new PaymentError("Payments are not set up on this network.", 503);
    try {
      captured = (
        await deps.stripe.capture(
          p.paymentIntentId,
          input.amount,
          holdKey(p.commandId, `capture:review:${input.amount}`),
        )
      ).amount_received;
    } catch (e) {
      if (e instanceof StripeUnknownError)
        throw new PaymentError("Stripe did not answer. Try again.", 502);
      if (!(e instanceof StripeError)) throw e;
      // Refused: perhaps captured already (an earlier try whose answer was lost, with
      // another amount and so another key) or dropped. Go by what Stripe holds.
      let pi: PaymentIntent | null = null;
      try {
        pi = await deps.stripe.getPaymentIntent(p.paymentIntentId);
      } catch {
        // Unknown: refuse below; the payment stays held for another try.
      }
      if (pi?.status === "succeeded")
        return (
          await move(
            p,
            ["held"],
            {
              status: "captured",
              capturedAmount: pi.amount_received,
              releaseAfter: null,
              reviewedAt: nowOf(deps).toISOString(),
            },
            deps,
            "payment.captured",
            { amount: pi.amount_received, source: "stripe" },
          )
        ).payment;
      if (pi?.status === "canceled") {
        await syncFromStripe(p, pi, deps);
        throw new PaymentError(
          "The hold is gone on Stripe (it expired or was cancelled): nothing was charged.",
        );
      }
      throw new PaymentError(
        `Stripe refused the capture (${e.code ?? e.type}).`,
      );
    }
  }
  return (
    await move(
      p,
      ["held"],
      {
        status: "captured",
        capturedAmount: captured,
        releaseAfter: null,
        reviewedAt: nowOf(deps).toISOString(),
      },
      deps,
      "payment.captured",
      { amount: captured, source: "admin" },
    )
  ).payment;
}

/** An admin's decision for a held payment under review: release the hold. */
export async function releaseForReview(
  paymentId: string,
  deps: PaymentDeps,
): Promise<Payment> {
  const p = await deps.payments.get(paymentId);
  if (!p) throw new PaymentError("No such payment.", 404);
  if (p.status !== "held")
    throw new PaymentError("Only a held payment can be released.");
  const done = await cancelHold(p, deps, "cancel", {
    reviewedAt: nowOf(deps).toISOString(),
  });
  if (done.status !== "released")
    throw new PaymentError(
      "Stripe did not release the hold yet. Try again.",
      502,
    );
  return done;
}

/** Marks a payment under review as dealt with. */
export async function markReviewed(
  paymentId: string,
  deps: PaymentDeps,
): Promise<Payment> {
  const p = await deps.payments.get(paymentId);
  if (!p || !p.review)
    throw new PaymentError("No such payment under review.", 404);
  if (p.reviewedAt) return p;
  return (
    await move(
      p,
      [p.status],
      { reviewedAt: nowOf(deps).toISOString() },
      deps,
      "payment.reviewed",
    )
  ).payment;
}
