"use client";

import { useState, type ComponentProps } from "react";
import { ActionCard } from "../action-card";
import {
  decideAction,
  lookupPaymentAction,
  refundAction,
  reviewListAction,
  type PaymentActionState,
  type PaymentSummary,
} from "./actions";

const REVIEW_TEXT: Record<string, string> = {
  cdr_above_hold: "CDR above the hold: the hold was captured, the rest was not",
  hold_expired: "The hold expired before the CDR: nothing was charged",
  currency_mismatch:
    "CDR in another currency than the hold: nothing charged yet",
  vat_unknown:
    "The CDR gave no amount incl. VAT: the amount excl. VAT was captured",
  increment_declined:
    "A raise of the hold was refused; the session was stopped",
  credit_cdr: "The CPO sent a credit CDR: refund the driver if owed",
  hold_unknown: "Stripe never answered the hold; the webhook cancels any hold",
  dispute: "The driver disputed the charge with their bank",
  refund_outside: "Money moved outside this server (the Stripe Dashboard)",
};

function PaymentFacts({ p }: { p: PaymentSummary }) {
  const rows: [string, string | number | null][] = [
    ["Payment", p.id],
    ["Charge", p.commandId],
    ["Driver", p.driverRef],
    ["Status", p.status],
    ["Hold", `${p.holdAmount} ${p.currency}`],
    ["Authorised", `${p.authorizedAmount} ${p.currency}`],
    ["Captured", `${p.capturedAmount} ${p.currency}`],
    ["Refunded", `${p.refundedAmount} ${p.currency}`],
    [
      "CDR total",
      p.cdrAmount === null ? null : `${p.cdrAmount} ${p.cdrCurrency}`,
    ],
    [
      "Not charged",
      p.shortfallAmount ? `${p.shortfallAmount} ${p.currency}` : null,
    ],
    ["Review", p.review ? (REVIEW_TEXT[p.review] ?? p.review) : null],
    ["Reviewed", p.reviewedAt],
    ["Stopped", p.stopReason],
    ["Note", p.error || null],
    ["Created", p.createdAt],
  ];
  return (
    <div className="peer">
      <dl className="facts">
        {rows
          .filter(([, v]) => v !== null && v !== "")
          .map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>
                {k === "Payment" || k === "Charge" ? <code>{v}</code> : v}
              </dd>
            </div>
          ))}
      </dl>
      {p.refunds?.map((r) => (
        <p key={r.id} className="muted">
          Refund {r.amount} {p.currency}: {r.status}
          {r.reason ? ` (${r.reason})` : ""}
        </p>
      ))}
    </div>
  );
}

function PaymentCard(
  props: Omit<ComponentProps<typeof ActionCard<PaymentActionState>>, "details">,
) {
  return (
    <ActionCard<PaymentActionState>
      {...props}
      details={(state) =>
        state.payments?.map((p) => <PaymentFacts key={p.id} p={p} />)
      }
    />
  );
}

function PaymentField() {
  return (
    <label>
      Payment or charge ID
      <input name="paymentId" required maxLength={36} autoComplete="off" />
    </label>
  );
}

function AmountField({ required = true }: { required?: boolean }) {
  return (
    <label>
      Amount in minor units (cents)
      <input
        name="amount"
        inputMode="numeric"
        pattern="[0-9]{1,9}"
        required={required}
      />
    </label>
  );
}

export function PaymentAdmin() {
  // One request ID per refund the admin means: a retry of the same form never
  // refunds twice. A new one after each refund that went through.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  return (
    <>
      <PaymentCard
        id="review"
        title="Payments to review"
        action={reviewListAction}
        submit={<button type="submit">Show payments to review</button>}
      />
      <PaymentCard
        id="lookup"
        title="Look up a payment"
        action={lookupPaymentAction}
        submit={<button type="submit">Show payment</button>}
      >
        <PaymentField />
      </PaymentCard>
      <PaymentCard
        id="refund"
        title="Refund"
        action={async (prev, form) => {
          const r = await refundAction(prev, form);
          if (r.ok) setRequestId(crypto.randomUUID());
          return r;
        }}
        submit={<button type="submit">Refund</button>}
      >
        <p className="muted">
          Part or all of a captured payment. Sending the same form again never
          refunds twice.
        </p>
        <PaymentField />
        <AmountField />
        <label>
          Reason (optional)
          <input name="reason" maxLength={300} />
        </label>
        <input type="hidden" name="requestId" value={requestId} />
      </PaymentCard>
      <PaymentCard
        id="decide"
        title="Decide a payment under review"
        action={decideAction}
        submit={
          <>
            <button type="submit" name="intent" value="capture">
              Capture amount
            </button>
            <button
              type="submit"
              name="intent"
              value="release"
              className="danger"
            >
              Release hold
            </button>
            <button type="submit" name="intent" value="reviewed">
              Mark reviewed
            </button>
          </>
        }
      >
        <p className="muted">
          Capture takes at most what the hold authorised, and only when you
          choose to. Release cancels the hold; nothing is charged.
        </p>
        <PaymentField />
        <AmountField required={false} />
      </PaymentCard>
    </>
  );
}
