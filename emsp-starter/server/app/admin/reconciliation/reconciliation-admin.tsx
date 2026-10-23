"use client";

import { useEffect, useState } from "react";
import { TableWrap } from "../table-wrap";
import { ActionCard } from "../action-card";
import {
  reconcileAction,
  type FlaggedPayment,
  type ReconLine,
  type ReconState,
} from "./actions";

const REVIEW_TEXT: Record<string, string> = {
  cdr_above_hold: "CDR above the hold",
  hold_expired: "Hold expired before the CDR",
  currency_mismatch: "CDR in another currency",
  vat_unknown: "CDR without an amount incl. VAT",
  increment_declined: "Raise of the hold refused",
  credit_cdr: "Credit CDR from the CPO",
  hold_unknown: "Hold outcome unknown",
  dispute: "Disputed by the driver",
  refund_outside: "Refunded outside this server",
  second_cdr: "Second CDR for one charge",
};

function Lines({ lines, caption }: { lines: ReconLine[]; caption: string }) {
  if (!lines.length) return null;
  return (
    <TableWrap label={caption}>
      <table>
        <caption className="muted">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">CPO</th>
            <th scope="col">Day</th>
            <th scope="col">Cur.</th>
            <th scope="col" className="num">
              Sessions
            </th>
            <th scope="col" className="num">
              Session kWh
            </th>
            <th scope="col" className="num">
              CDRs
            </th>
            <th scope="col" className="num">
              CDR kWh
            </th>
            <th scope="col" className="num">
              CDR cost incl. VAT
            </th>
            <th scope="col" className="num">
              Paid CDRs
            </th>
            <th scope="col" className="num">
              Captured
            </th>
            <th scope="col" className="num">
              Refunded
            </th>
            <th scope="col" className="num">
              Net
            </th>
            <th scope="col" className="num">
              Mismatches
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.peer}:${l.day}:${l.currency}`}>
              <td>{l.peer}</td>
              <td>{l.day ?? "all days"}</td>
              <td>{l.currency}</td>
              <td className="num">
                {l.sessions}
                {l.sessionsOpen > 0 && (
                  <span className="muted"> ({l.sessionsOpen} open)</span>
                )}
              </td>
              <td className="num">{l.sessionKwh}</td>
              <td className="num">
                {l.cdrs}
                {l.creditCdrs > 0 && (
                  <span className="muted"> (+{l.creditCdrs} credit)</span>
                )}
              </td>
              <td className="num">{l.cdrKwh}</td>
              <td className="num">
                {l.cdrCostInclVat ?? (
                  <span title="A CDR gave no amount incl. VAT">
                    excl. {l.cdrCostExclVat}
                  </span>
                )}
              </td>
              <td className="num">{l.cdrsPaid}</td>
              <td className="num">{l.captured}</td>
              <td className="num">{l.refunded}</td>
              <td className="num">{l.net}</td>
              <td className={l.mismatches ? "num flag" : "num"}>
                {l.mismatches}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function Problems({ lines }: { lines: ReconLine[] }) {
  const withProblems = lines.filter((l) => l.problems.length);
  if (!withProblems.length) return null;
  return (
    <section aria-label="Mismatches">
      <h3>Mismatches</h3>
      {withProblems.map((l) => (
        <div key={`${l.peer}:${l.day}:${l.currency}`} className="peer">
          <p>
            <strong>
              {l.peer}, {l.day} ({l.currency})
            </strong>
          </p>
          <dl className="facts">
            {l.problems.map((p) => (
              <div key={p.what} style={{ display: "contents" }}>
                <dt>
                  {p.what}: {p.count}
                </dt>
                <dd className="ids">
                  {p.ids.map((id) => (
                    <code key={id}>{id} </code>
                  ))}
                  {p.ids.length < p.count && (
                    <span className="muted">
                      (first {p.ids.length}; narrow the days for the rest)
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className="muted">
        A session that ended minutes ago has no CDR yet: judge days that are
        over. Look payments up by their ID on Payments and refunds.
      </p>
    </section>
  );
}

function Flagged({ items }: { items: FlaggedPayment[] }) {
  if (!items.length) return null;
  return (
    <section aria-label="Flagged payments">
      <h3>Payments flagged for review</h3>
      <TableWrap label="Flagged payments table">
        <table>
          <thead>
            <tr>
              <th scope="col">Since</th>
              <th scope="col">Why</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Captured
              </th>
              <th scope="col" className="num">
                Not charged
              </th>
              <th scope="col">Payment ID</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{p.createdAt}</td>
                <td>{REVIEW_TEXT[p.review] ?? p.review}</td>
                <td>{p.status}</td>
                <td className="num">{p.captured}</td>
                <td className="num">{p.shortfall ?? "-"}</td>
                <td>
                  <code>{p.id}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </section>
  );
}

/** A download link for the CSV, made in the browser from the action's result. */
function CsvLink({ csv, filename }: { csv?: string; filename?: string }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    if (!csv) return setHref(null);
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [csv]);
  if (!href) return null;
  return (
    <p>
      <a href={href} download={filename}>
        Download CSV
      </a>{" "}
      <span className="muted">(one row per peer, day and currency)</span>
    </p>
  );
}

export function ReconciliationAdmin({
  from,
  to,
}: {
  /** Default first and last day. */
  from: string;
  to: string;
}) {
  return (
    <ActionCard<ReconState>
      id="reconcile"
      title="Reconcile"
      action={reconcileAction}
      submit={<button type="submit">Reconcile</button>}
      details={(s) => (
        <>
          <CsvLink csv={s.csv} filename={s.filename} />
          <Lines lines={s.totals ?? []} caption="Per peer, over the days" />
          <Problems lines={s.lines ?? []} />
          <Lines lines={s.lines ?? []} caption="Per day" />
          <Flagged items={s.flagged ?? []} />
        </>
      )}
    >
      <label>
        First day (UTC)
        <input name="from" type="date" required defaultValue={from} />
      </label>
      <label>
        Last day (UTC)
        <input name="to" type="date" required defaultValue={to} />
      </label>
      <label>
        Peer ID (optional: every peer when empty)
        <input name="peerId" maxLength={36} autoComplete="off" />
      </label>
    </ActionCard>
  );
}
