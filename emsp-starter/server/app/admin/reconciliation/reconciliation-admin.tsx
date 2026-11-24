"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listPeersAction } from "../peers/actions";
import { Icon, Result, State, Tile, utc } from "../ui/kit";
import { ActionForm } from "../ui/parts";
import { useList } from "../ui/use-action";
import {
  reconcileAction,
  type FlaggedPayment,
  type ReconLine,
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
  capture_refused: "Capture refused by Stripe",
};

/** One line per peer, day and currency: a table on desktop, a card each on a phone. */
function Lines({ lines, caption }: { lines: ReconLine[]; caption: string }) {
  if (!lines.length) return null;
  return (
    <section className="stack tight" aria-label={caption}>
      <h2 className="h3">{caption}</h2>
      <div
        className="card tablecard scroll"
        role="region"
        aria-label={`${caption}, table`}
        tabIndex={0}
      >
        <table className="data wide">
          <caption className="sr">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Peer and day</th>
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
                <th scope="row" className="c-main">
                  {l.peer}
                  <span className="sub">
                    {l.day ?? "all days"} · {l.currency}
                  </span>
                </th>
                <td className="c-kv num" data-l="Sessions">
                  <span>
                    {l.sessions}
                    {l.sessionsOpen > 0 && (
                      <span className="muted"> ({l.sessionsOpen} open)</span>
                    )}
                  </span>
                </td>
                <td className="c-kv num" data-l="Session kWh">
                  {l.sessionKwh}
                </td>
                <td className="c-kv num" data-l="CDRs">
                  <span>
                    {l.cdrs}
                    {l.creditCdrs > 0 && (
                      <span className="muted"> (+{l.creditCdrs} credit)</span>
                    )}
                  </span>
                </td>
                <td className="c-kv num" data-l="CDR kWh">
                  {l.cdrKwh}
                </td>
                <td className="c-kv num" data-l="CDR cost incl. VAT">
                  {l.cdrCostInclVat ?? (
                    <span>excl. VAT {l.cdrCostExclVat}</span>
                  )}
                </td>
                <td className="c-kv num" data-l="Paid CDRs">
                  {l.cdrsPaid}
                </td>
                <td className="c-kv num" data-l="Captured">
                  {l.captured}
                </td>
                <td className="c-kv num" data-l="Refunded">
                  {l.refunded}
                </td>
                <td className="c-kv num" data-l="Net">
                  {l.net}
                </td>
                <td className="c-kv num" data-l="Mismatches">
                  {l.mismatches ? (
                    <State kind="bad">{l.mismatches}</State>
                  ) : (
                    <span>0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Problems({ lines }: { lines: ReconLine[] }) {
  const withProblems = lines.filter((l) => l.problems.length);
  if (!withProblems.length) return null;
  return (
    <section className="stack tight" aria-label="Mismatches">
      <h2 className="h3">Mismatches</h2>
      <ul className="list">
        {withProblems.map((l) => (
          <li
            key={`${l.peer}:${l.day}:${l.currency}`}
            className="card stack tight"
          >
            <h3>
              {l.peer}, {l.day} ({l.currency})
            </h3>
            <dl className="facts small">
              {l.problems.map((p) => (
                <div key={p.what} style={{ display: "contents" }}>
                  <dt>
                    {p.what}: {p.count}
                  </dt>
                  <dd className="ids">
                    {p.ids.map((id) => (
                      <code key={id}>{id}</code>
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
          </li>
        ))}
      </ul>
      <p className="muted small">
        A session that ended minutes ago has no CDR yet: judge days that are
        over. Find a payment by its ID on{" "}
        <Link href="/admin/payments">Payments</Link>.
      </p>
    </section>
  );
}

function Flagged({ items }: { items: FlaggedPayment[] }) {
  if (!items.length) return null;
  return (
    <section className="stack tight" aria-label="Flagged payments">
      <h2 className="h3">Payments flagged for review</h2>
      <div className="card tablecard">
        <table className="data">
          <caption className="sr">Payments flagged for review</caption>
          <thead>
            <tr>
              <th scope="col">Why and payment</th>
              <th scope="col">Since</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Not charged
              </th>
              <th scope="col" className="num">
                Captured
              </th>
              <th scope="col">
                <span className="sr">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <th scope="row" className="c-main">
                  {REVIEW_TEXT[p.review] ?? p.review}
                  <span className="sub mono">{p.id}</span>
                </th>
                <td className="c-kv" data-l="Since">
                  {utc(p.createdAt)}
                </td>
                <td className="c-kv" data-l="Status">
                  {p.status}
                </td>
                <td className="c-kv num" data-l="Not charged">
                  {p.shortfall ?? "none"}
                </td>
                <td className="c-big num">{p.captured}</td>
                <td className="c-wide">
                  <Link
                    className="btn ghost sm"
                    href={`/admin/payments?find=${p.id}`}
                  >
                    Open<span className="sr"> payment {p.id}</span>
                    <Icon name="arrow" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
    <p className="row">
      <a className="btn ghost sm" href={href} download={filename}>
        Download CSV
      </a>
      <span className="muted small">One row per peer, day and currency.</span>
    </p>
  );
}

export function ReconciliationAdmin({
  from,
  to,
  demo,
}: {
  /** Default first and last day. */
  from: string;
  to: string;
  demo: boolean;
}) {
  const [range, setRange] = useState({ from, to, peerId: "" });
  // Runs by itself with the default days, and again when the days or the peer change.
  const recon = useList(reconcileAction, range);
  // The peers to choose from, by name: nobody copies a peer ID here.
  const peers = useList(listPeersAction);
  const s = recon.state;
  const empty = s.ok && !(s.lines ?? []).length && !(s.flagged ?? []).length;
  return (
    <div className="stack">
      {demo && (
        <p className="muted">
          Demo mode: the mock CPO&apos;s sample sessions and CDRs, kept in
          memory. Its CDRs are of sample tokens, so they show as not ours.
        </p>
      )}
      <ActionForm
        className="card form"
        aria-label="Days and peer"
        onSend={async (form) => {
          const next = {
            from: String(form.get("from") ?? ""),
            to: String(form.get("to") ?? ""),
            peerId: String(form.get("peerId") ?? ""),
          };
          const same =
            next.from === range.from &&
            next.to === range.to &&
            next.peerId === range.peerId;
          if (same) await recon.reload();
          else setRange(next);
        }}
      >
        <div className="fields">
          <div className="field">
            <label htmlFor="recon-from">First day (UTC)</label>
            <input
              id="recon-from"
              name="from"
              type="date"
              required
              defaultValue={from}
            />
          </div>
          <div className="field">
            <label htmlFor="recon-to">Last day (UTC)</label>
            <input
              id="recon-to"
              name="to"
              type="date"
              required
              defaultValue={to}
            />
          </div>
          <div className="field">
            <label htmlFor="recon-peer">Peer</label>
            <select id="recon-peer" name="peerId" defaultValue="">
              <option value="">Every peer</option>
              {(peers.state.peers ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <button className="btn" type="submit">
            Reconcile
          </button>
        </div>
      </ActionForm>

      {(recon.loading || recon.pending) && (
        <p className="muted" role="status">
          Loading…
        </p>
      )}
      {recon.done && !recon.pending && (
        <>
          {empty ? (
            <div className="card flat stack">
              <div className="row">
                <Tile kind="off" big="0" small="days" />
                <p style={{ flex: 1, minWidth: 0 }} role="status">
                  {s.message}
                </p>
              </div>
            </div>
          ) : (
            <Result state={s} />
          )}
          <CsvLink csv={s.csv} filename={s.filename} />
          <Lines lines={s.totals ?? []} caption="Per peer, over the days" />
          <Problems lines={s.lines ?? []} />
          <Lines lines={s.lines ?? []} caption="Per day" />
          <Flagged items={s.flagged ?? []} />
        </>
      )}
    </div>
  );
}
