"use client";

import { useState, type ComponentProps } from "react";
import { TableWrap } from "../table-wrap";
import { ActionCard } from "../action-card";
import {
  decideAction,
  lookupPaymentAction,
  paymentAuditAction,
  refundAction,
  reviewListAction,
  type AuditLine,
  type PaymentActionState,
} from "./actions";
import { PaymentFacts } from "./payment-facts";
import { requestIdSpent } from "./request-id";

function AuditLog({ lines }: { lines: AuditLine[] }) {
  if (!lines.length) return null;
  return (
    <TableWrap label="Audit log table">
      <table>
        <caption className="muted">Audit log, newest first</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">What</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.at}:${i}`}>
              <td>{l.at}</td>
              <td>{l.actor}</td>
              <td>{l.action}</td>
              <td className="ids">{l.details}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function PaymentCard(
  props: Omit<ComponentProps<typeof ActionCard<PaymentActionState>>, "details">,
) {
  return (
    <ActionCard<PaymentActionState>
      {...props}
      details={(state) => (
        <>
          {state.payments?.map((p) => (
            <PaymentFacts key={p.id} p={p} />
          ))}
          <AuditLog lines={state.audit ?? []} />
        </>
      )}
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
      Amount in the payment&apos;s minor units (cents for USD, CAD and EUR;
      whole yen for JPY; 3 decimals for KWD)
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
  // refunds twice. A new one once that refund's outcome is known (request-id.ts).
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
          if (requestIdSpent(r)) setRequestId(crypto.randomUUID());
          return r;
        }}
        submit={<button type="submit">Refund</button>}
      >
        <p className="muted">
          Part or all of a captured payment, never more than was captured.
          Sending the same form again never refunds twice. The reason and who
          refunded go to the audit log.
        </p>
        <label>
          Payment ID
          <input name="paymentId" required maxLength={36} autoComplete="off" />
        </label>
        <AmountField required={false} />
        <label className="check">
          <input type="checkbox" name="full" />
          Refund everything left (ignores the amount)
        </label>
        <label>
          Reason
          <input name="reason" required maxLength={300} />
        </label>
        <input type="hidden" name="requestId" value={requestId} />
      </PaymentCard>
      <PaymentCard
        id="audit"
        title="Audit log of a payment"
        action={paymentAuditAction}
        submit={<button type="submit">Show audit log</button>}
      >
        <p className="muted">
          Every change of the payment: the hold, the capture, each refund with
          its reason, and who made it.
        </p>
        <PaymentField />
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
