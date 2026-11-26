"use client";

import { useEffect, useId, useState } from "react";
import { formatMinorAmount } from "@/lib/locations/pricing";
import { useAdmin } from "../ui/admin-context";
import { Icon, Result, State, Tile, utc } from "../ui/kit";
import { ActionForm, ConfirmButton } from "../ui/parts";
import { fields, useAction, useList } from "../ui/use-action";
import {
  decideAction,
  driverPaymentsAction,
  lookupPaymentAction,
  paymentAuditAction,
  refundAction,
  reviewListAction,
  type AuditLine,
  type PaymentSummary,
} from "./actions";
import { PaymentFacts, REVIEW_TEXT } from "./payment-facts";
import {
  refundRequestId,
  requestIdSpent,
  spendRefundRequestId,
} from "./request-id";

const AMOUNT_LABEL =
  "Amount in the payment's minor units (cents for USD, CAD and EUR; whole yen for JPY; 3 decimals for KWD)";

/** Why a payment waits, in a few words, for a row of the review list. */
const reviewShort = (p: PaymentSummary) =>
  p.review ? (REVIEW_TEXT[p.review] ?? p.review).split(":")[0] : "Review";

function AuditLog({ lines }: { lines: AuditLine[] }) {
  if (!lines.length) return null;
  return (
    <div className="card tablecard">
      <table className="data">
        <caption className="sr">Audit log, newest first</caption>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.at}:${i}`}>
              <th scope="row" className="c-main">
                {l.action}
              </th>
              <td className="c-kv" data-l="When">
                {utc(l.at)}
              </td>
              <td className="c-kv" data-l="Who">
                {l.actor}
              </td>
              <td className="c-wide ids small">{l.details}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One payment with its own actions: refund, audit log and, while it waits for review,
 * the decision. Every form sends this payment's ID itself.
 */
export function PaymentPanel({ payment }: { payment: PaymentSummary }) {
  const id = useId();
  const [p, setP] = useState(payment);
  // One request ID per refund the admin means: a retry of the same form never
  // refunds twice. It is kept per payment for the life of the page, so closing and
  // reopening this panel retries the same refund while its outcome is unknown; a new
  // one only once that outcome is known (request-id.ts).
  const [requestId, setRequestId] = useState(() => refundRequestId(payment.id));
  const refund = useAction(refundAction);
  const audit = useAction(paymentAuditAction);
  const decide = useAction(decideAction);

  const took = (r: { payments?: PaymentSummary[] }) => {
    const next = r.payments?.find((x) => x.id === p.id) ?? r.payments?.[0];
    // An answer without refunds keeps the ones already shown.
    if (next)
      setP((old) => ({ ...next, refunds: next.refunds ?? old.refunds }));
  };
  const send = async (form: FormData) => took(await decide.run(form));

  return (
    <section className="card stack" aria-label={`Payment ${p.id}`}>
      <div className="row between">
        <h3>
          {formatMinorAmount(p.capturedAmount, p.currency)} captured{" "}
          <span className="muted small">
            of a {formatMinorAmount(p.holdAmount, p.currency)} hold
          </span>
        </h3>
        {p.review && !p.reviewedAt ? (
          <State kind="todo">Needs review</State>
        ) : (
          <State kind="done">{p.status}</State>
        )}
      </div>
      <PaymentFacts p={p} />

      <details className="fold">
        <summary>Refund</summary>
        {/* Remounted (and so cleared) once this refund's request ID is spent. */}
        <ActionForm
          key={requestId}
          onSend={async (form) => {
            const r = await refund.run(form);
            if (requestIdSpent(r)) setRequestId(spendRefundRequestId(p.id));
            took(r);
          }}
        >
          <p className="small muted">
            Part or all of a captured payment, never more than was captured.
            Sending the same form again never refunds twice. The reason and who
            refunded go to the audit log.
          </p>
          <input type="hidden" name="paymentId" value={p.id} />
          <input type="hidden" name="requestId" value={requestId} />
          <div className="field">
            <label htmlFor={`${id}-amount`}>{AMOUNT_LABEL}</label>
            <input
              id={`${id}-amount`}
              name="amount"
              inputMode="numeric"
              pattern="[0-9]{1,9}"
              autoComplete="off"
            />
          </div>
          <label className="check">
            <input type="checkbox" name="full" />
            Refund everything left (ignores the amount)
          </label>
          <div className="field">
            <label htmlFor={`${id}-reason`}>Reason</label>
            <input
              id={`${id}-reason`}
              name="reason"
              required
              maxLength={300}
              autoComplete="off"
            />
          </div>
          <div>
            <button className="btn sm" type="submit">
              Refund
            </button>
          </div>
        </ActionForm>
      </details>
      <Result state={refund.state} />

      {(p.status === "held" || p.review) && (
        <>
          <details className="fold">
            <summary>Decide this payment</summary>
            <ActionForm onSend={send}>
              <p className="small muted">
                Capture takes at most what the hold authorised, and only when
                you choose to. Release cancels the hold; nothing is charged.
              </p>
              <input type="hidden" name="paymentId" value={p.id} />
              <div className="field">
                <label htmlFor={`${id}-capture`}>{AMOUNT_LABEL}</label>
                <input
                  id={`${id}-capture`}
                  name="amount"
                  inputMode="numeric"
                  pattern="[0-9]{1,9}"
                  autoComplete="off"
                />
                <span className="hint">Only for a capture.</span>
              </div>
              <div className="row">
                <button
                  className="btn ghost sm"
                  type="submit"
                  name="intent"
                  value="capture"
                >
                  Capture amount
                </button>
                <button
                  className="btn ghost sm"
                  type="submit"
                  name="intent"
                  value="reviewed"
                >
                  Mark reviewed
                </button>
                <ConfirmButton
                  ask="Release the hold? Nothing will be charged."
                  yes="Yes, release the hold"
                  onConfirm={() =>
                    send(fields({ paymentId: p.id, intent: "release" }))
                  }
                >
                  Release hold
                </ConfirmButton>
              </div>
            </ActionForm>
          </details>
          <Result state={decide.state} />
        </>
      )}

      <div className="row" aria-busy={audit.pending}>
        <button
          className="btn ghost sm"
          type="button"
          onClick={() => void audit.run(fields({ paymentId: p.id }))}
        >
          <Icon name="clock" />
          Show audit log
        </button>
      </div>
      {audit.state.message &&
        (audit.state.ok ? (
          <p className="small muted" role="status">
            {audit.state.message}
          </p>
        ) : (
          <Result state={audit.state} />
        ))}
      <AuditLog lines={audit.state.audit ?? []} />
    </section>
  );
}

/** The payments waiting for a person: a table that opens by itself. */
function ReviewList() {
  const list = useList(reviewListAction);
  const [open, setOpen] = useState<string | null>(null);
  const payments = list.state.payments ?? [];
  const opened = payments.find((p) => p.id === open);
  return (
    <section className="stack" aria-labelledby="review-h">
      <div className="row between">
        <h2 id="review-h">To review</h2>
        {list.done && (
          <button
            className="btn ghost sm"
            type="button"
            onClick={() => void list.reload()}
          >
            <Icon name="refresh" />
            Refresh
          </button>
        )}
      </div>
      {list.loading && (
        <p className="muted" role="status">
          Loading…
        </p>
      )}
      {list.done && list.state.ok === false && <Result state={list.state} />}
      {list.done && list.state.ok && payments.length === 0 && (
        <div className="card flat stack">
          <div className="row">
            <Tile kind="off" big="0" small="waiting" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p role="status">
                <strong>{list.state.message}</strong>
              </p>
              <p className="muted">
                A payment appears here when the rules cannot settle it: a CDR
                above the hold, a hold that expired, another currency, a
                dispute.
              </p>
            </div>
          </div>
        </div>
      )}
      {payments.length > 0 && (
        <>
          <p className="muted small" role="status">
            {list.state.message} Oldest first.
          </p>
          <div className="card tablecard">
            <table className="data">
              <caption className="sr">Payments to review, oldest first</caption>
              <thead>
                <tr>
                  <th scope="col">Why and payment</th>
                  <th scope="col">Driver</th>
                  <th scope="col">Since</th>
                  <th scope="col" className="num">
                    Not charged
                  </th>
                  <th scope="col" className="num">
                    Captured
                  </th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="sr">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <th scope="row" className="c-main">
                      {reviewShort(p)}
                      <span className="sub mono">{p.id}</span>
                    </th>
                    <td className="c-kv" data-l="Driver">
                      <span className="mono">{p.driverRef}</span>
                    </td>
                    <td className="c-kv" data-l="Since">
                      {utc(p.createdAt)}
                    </td>
                    <td className="c-kv num" data-l="Not charged">
                      {p.shortfallAmount
                        ? formatMinorAmount(p.shortfallAmount, p.currency)
                        : "none"}
                    </td>
                    <td className="c-big num">
                      {formatMinorAmount(p.capturedAmount, p.currency)}
                    </td>
                    <td className="c-state">
                      {p.reviewedAt ? (
                        <State kind="done">Reviewed</State>
                      ) : (
                        <State kind="todo">Needs review</State>
                      )}
                    </td>
                    <td className="c-wide">
                      <button
                        className="btn ghost sm"
                        type="button"
                        aria-expanded={open === p.id}
                        onClick={() => setOpen(open === p.id ? null : p.id)}
                      >
                        {open === p.id ? "Close" : "Open"}
                        <span className="sr"> payment {p.id}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {opened && <PaymentPanel key={opened.id} payment={opened} />}
        </>
      )}
    </section>
  );
}

/** Any other payment, by its ID or its charge ID: the server has no search. */
function FindPayment({ find }: { find?: string }) {
  const { signedIn } = useAdmin();
  const lookup = useAction(lookupPaymentAction);
  const { run } = lookup;
  useEffect(() => {
    if (signedIn && find) void run(fields({ paymentId: find }));
  }, [signedIn, find, run]);
  const found = lookup.state.ok ? lookup.state.payments?.[0] : undefined;
  return (
    <section className="stack" aria-labelledby="find-h">
      <h2 id="find-h">Find a payment</h2>
      <ActionForm className="card form" onSend={(form) => run(form)}>
        <div className="field">
          <label htmlFor="find-id">Payment or charge ID</label>
          <input
            id="find-id"
            name="paymentId"
            required
            maxLength={36}
            autoComplete="off"
            defaultValue={find}
            aria-describedby="find-hint"
          />
          <span className="hint" id="find-hint">
            The charge ID is on a session&apos;s row; the payment ID in a
            reconciliation mismatch or a receipt.
          </span>
        </div>
        <div>
          <button className="btn" type="submit">
            Find payment
          </button>
        </div>
      </ActionForm>
      {lookup.state.ok === false && <Result state={lookup.state} />}
      {found && <PaymentPanel key={found.id} payment={found} />}
    </section>
  );
}

/** One driver's payments, by their exact reference; each opens with its actions. */
function DriverPayments({ driver }: { driver?: string }) {
  const { signedIn } = useAdmin();
  const list = useAction(driverPaymentsAction);
  const [open, setOpen] = useState<string | null>(null);
  const { run } = list;
  useEffect(() => {
    if (signedIn && driver) void run(fields({ driverRef: driver }));
  }, [signedIn, driver, run]);
  const payments = list.state.ok ? (list.state.payments ?? []) : [];
  const opened = payments.find((p) => p.id === open);
  return (
    <section className="stack" aria-labelledby="driver-h">
      <h2 id="driver-h">A driver&apos;s payments</h2>
      <ActionForm
        className="card form"
        onSend={async (form) => {
          setOpen(null);
          await run(form);
        }}
      >
        <div className="field">
          <label htmlFor="driver-ref">Driver reference</label>
          <input
            id="driver-ref"
            name="driverRef"
            required
            maxLength={64}
            autoComplete="off"
            defaultValue={driver}
            aria-describedby="driver-hint"
          />
          <span className="hint" id="driver-hint">
            The whole reference, exactly, as the driver&apos;s page shows it.
          </span>
        </div>
        <div>
          <button className="btn" type="submit">
            List payments
          </button>
        </div>
      </ActionForm>
      {list.state.ok === false && <Result state={list.state} />}
      {list.state.ok && (
        <p className="muted small" role="status">
          {list.state.message}
          {payments.length > 0 && " Newest first."}
        </p>
      )}
      {payments.length > 0 && (
        <div className="card tablecard">
          <table className="data">
            <caption className="sr">The driver&apos;s payments</caption>
            <thead>
              <tr>
                <th scope="col">Payment</th>
                <th scope="col">Since</th>
                <th scope="col" className="num">
                  Captured
                </th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="sr">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <th scope="row" className="c-main">
                    <span className="mono">{p.id}</span>
                  </th>
                  <td className="c-kv" data-l="Since">
                    {utc(p.createdAt)}
                  </td>
                  <td className="c-big num">
                    {formatMinorAmount(p.capturedAmount, p.currency)}
                  </td>
                  <td className="c-state">
                    {p.review && !p.reviewedAt ? (
                      <State kind="todo">Needs review</State>
                    ) : (
                      <State kind="done">{p.status}</State>
                    )}
                  </td>
                  <td className="c-wide">
                    <button
                      className="btn ghost sm"
                      type="button"
                      aria-expanded={open === p.id}
                      onClick={() => setOpen(open === p.id ? null : p.id)}
                    >
                      {open === p.id ? "Close" : "Open"}
                      <span className="sr"> payment {p.id}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {opened && <PaymentPanel key={opened.id} payment={opened} />}
    </section>
  );
}

export function PaymentAdmin({
  demo,
  stripeSet,
  find,
  driver,
}: {
  demo: boolean;
  /**
   * STRIPE_SECRET_KEY is set (never its value). Null when the server did not say: it
   * says only to an admin signed in by email, not to an admin-secret sign-in.
   */
  stripeSet: boolean | null;
  /** A payment or charge ID to look up at once (from a link). */
  find?: string;
  /** A driver reference whose payments are listed at once (from a link). */
  driver?: string;
}) {
  return (
    <div className="stack">
      {demo ? (
        <p className="muted">
          Demo mode: no card is charged and nothing is sent to Stripe.
        </p>
      ) : stripeSet === null ? (
        <p className="muted">
          Payments need <code>STRIPE_SECRET_KEY</code> on the server: without it
          every app start is refused. Whether it is set shows here only to an
          admin signed in by email.
        </p>
      ) : (
        !stripeSet && (
          <div className="msg wait" role="note">
            <p className="t">
              <Icon name="alert" />
              <span>Payments are not set up.</span>
            </p>
            <p>
              Set <code>STRIPE_SECRET_KEY</code> on the server. Until then every
              app start is refused.
            </p>
          </div>
        )
      )}
      {/* A driver named in the address is what was asked for: first. */}
      {driver && <DriverPayments key={driver} driver={driver} />}
      <ReviewList />
      <FindPayment find={find} />
      {!driver && <DriverPayments />}
    </div>
  );
}
