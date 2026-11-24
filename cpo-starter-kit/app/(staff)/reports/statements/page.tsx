import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMinor } from "@/lib/money";
import { describeTerms } from "@/lib/network-fee";
import { HOST_ROLE } from "@/lib/roles";
import { requireNetworkReader } from "@/lib/server/auth";
import { hostStore } from "@/lib/server/hosts";
import {
  getNetwork,
  loadStatement,
  NetworkError,
  PAYOUT_LABELS,
  shiftMonth,
  type StatementView,
} from "@/lib/server/network";
import { shortInZone } from "@/lib/server/reports/time";
import type { StatementRow, StatementTotals } from "@/lib/statement";
import { formatKwh, whToKwh } from "@/lib/units";
import { Loading } from "@/app/loading-skeleton";
import { EmptyState } from "@/app/ui/empty-state";
import { PageHeader } from "@/app/ui/page-header";
import { PrintStatement } from "./print-button";

export const metadata = { title: "Monthly statement" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const kwh = (wh: number) => formatKwh(whToKwh(wh));

const STATUS_WORDS: Record<StatementRow["session"]["status"], string> = {
  in_progress: "In progress",
  charged: "Charged",
  no_charge: "Nothing charged",
  attention: "Needs the operator",
};

function TotalsTable({ totals }: { totals: StatementTotals[] }) {
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="group"
      aria-label="Totals, scrolls sideways"
    >
      <table className="data-table">
        <caption>Totals: the sums of the sessions below</caption>
        <thead>
          <tr>
            <th scope="col">Currency</th>
            <th scope="col" className="num">
              Sessions
            </th>
            <th scope="col" className="num">
              Energy
            </th>
            <th scope="col" className="num">
              Revenue
            </th>
            <th scope="col" className="num">
              Refunds
            </th>
            <th scope="col" className="num">
              Network fee
            </th>
            <th scope="col" className="num">
              Host share
            </th>
          </tr>
        </thead>
        <tbody>
          {totals.map((t) => (
            <tr key={t.currency}>
              <th scope="row">{t.currency}</th>
              <td className="num">
                {t.sessions}
                <br />
                <span className="muted">{t.charged} charged</span>
              </td>
              <td className="num">{kwh(t.energyWh)}</td>
              <td className="num">{formatMinor(t.amountMinor, t.currency)}</td>
              <td className="num">
                {formatMinor(t.refundedMinor, t.currency)}
              </td>
              <td className="num">
                {formatMinor(t.netFeeMinor, t.currency)}
                {t.feeRefundedMinor > 0 && (
                  <>
                    <br />
                    <span className="muted">
                      {formatMinor(t.feeMinor, t.currency)} less{" "}
                      {formatMinor(t.feeRefundedMinor, t.currency)} returned
                      with refunds
                    </span>
                  </>
                )}
              </td>
              <td className="num">
                {formatMinor(t.hostShareMinor, t.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionsTable({ v }: { v: StatementView }) {
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="group"
      aria-label="Sessions, scrolls sideways"
    >
      <table className="data-table">
        <caption>Sessions, newest first, by when the driver tapped</caption>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Charger</th>
            <th scope="col" className="num">
              Energy
            </th>
            <th scope="col" className="num">
              Amount
            </th>
            <th scope="col" className="num">
              Refunded
            </th>
            <th scope="col" className="num">
              Network fee
            </th>
            <th scope="col" className="num">
              Host share
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {v.statement.rows.map((r) => {
            const s = r.session;
            const at = Date.parse(s.startedAt ?? s.createdAt);
            const money = r.kind === "revenue";
            return (
              <tr key={s.reference}>
                <td>
                  <time dateTime={s.startedAt ?? s.createdAt}>
                    {shortInZone(at, v.timeZone)}
                  </time>
                  <br />
                  <span className="muted mono">{s.reference}</span>
                </td>
                <td>
                  {s.chargerName}
                  {s.siteName && (
                    <>
                      <br />
                      <span className="muted">{s.siteName}</span>
                    </>
                  )}
                </td>
                <td className="num">
                  {s.energyWh === null ? "–" : kwh(s.energyWh)}
                </td>
                <td className="num">
                  {formatMinor(r.amountMinor, s.currency)}
                </td>
                <td className="num">
                  {r.refundedMinor
                    ? formatMinor(r.refundedMinor, s.currency)
                    : "–"}
                </td>
                <td className="num">
                  {money ? formatMinor(r.netFeeMinor, s.currency) : "–"}
                </td>
                <td className="num">
                  {money ? formatMinor(r.hostShareMinor, s.currency) : "–"}
                </td>
                <td>
                  {s.kind === "free" ? "Free" : STATUS_WORDS[s.status]}
                  {r.note && (
                    <>
                      <br />
                      <span className="muted">{r.note}</span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const me = await requireNetworkReader();
  const raw = await searchParams;
  const isHost = me.role === HOST_ROLE;
  const hosts = isHost
    ? []
    : (await hostStore().list(me.operatorId)).filter((h) => !h.archivedAt);
  const requested = one(raw.host);
  const hostId = isHost ? me.host?.id : (requested ?? hosts[0]?.id);
  if (!isHost && !hostId)
    return (
      <>
        <PageHeader title="Monthly statements" />
        <EmptyState
          title="No hosts yet"
          action={
            <Link className="button" href="/hosts">
              Add a host
            </Link>
          }
        >
          Statements are per site host. Add a host and assign its sites first.
        </EmptyState>
      </>
    );
  let v: StatementView;
  try {
    v = await loadStatement(getNetwork(), me, hostId, one(raw.month));
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    if (e.code === "not_found") notFound();
    return (
      <>
        <PageHeader title="Monthly statement" />
        <EmptyState tone="error" title="The statement can't be shown">
          {e.message}
        </EmptyState>
      </>
    );
  }
  const q = (month: string) =>
    `/reports/statements?${new URLSearchParams({
      ...(isHost ? {} : { host: v.host.id }),
      month,
    })}`;
  const open = v.statement.totals.reduce((n, t) => n + t.open, 0);
  return (
    <>
      <PageHeader
        title={`Statement: ${v.host.name}`}
        description={`${v.month}, in ${v.timeZone}.${v.mode === "demo" ? " Sample data." : ""}`}
        action={
          <a
            className="button no-print"
            href={`/reports/statements/export?${new URLSearchParams({
              ...(isHost ? {} : { host: v.host.id }),
              month: v.month,
            })}`}
            download
          >
            Download CSV
          </a>
        }
      />
      <form
        className="report-filters no-print"
        method="get"
        action="/reports/statements"
      >
        {!isHost && (
          <div className="field">
            <label htmlFor="statement-host">Host</label>
            <select id="statement-host" name="host" defaultValue={v.host.id}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="statement-month">Month</label>
          <input
            id="statement-month"
            type="month"
            name="month"
            defaultValue={v.month}
            pattern="[0-9]{4}-[0-9]{2}"
            required
          />
        </div>
        <button type="submit" className="button secondary">
          Show
        </button>
        <Link className="button secondary" href={q(shiftMonth(v.month, -1))}>
          Previous month
        </Link>
        <Link className="button secondary" href={q(shiftMonth(v.month, 1))}>
          Next month
        </Link>
        <PrintStatement />
      </form>
      {v.mode === "demo" && (
        <p className="notice no-print" role="note">
          Demo: a sample statement from the sample history. Nothing is sent to
          Stripe or anywhere else.
        </p>
      )}
      <section className="card statement" aria-labelledby="statement-heading">
        <h2 id="statement-heading">
          {v.host.name}: {v.month}
        </h2>
        <p className="muted">
          Network fee:{" "}
          {v.monthTerms
            ? describeTerms(v.monthTerms, formatMinor)
            : "none set (no fee)"}
          . A fee change applies to sessions started after it; each session uses
          the fee in effect when it started. Payouts: {PAYOUT_LABELS[v.payout]}.
        </p>
        <p className="muted">
          Driver sessions from this kit at the host&apos;s sites. Staff and test
          sessions (Live remote starts, charger tests) are never driver
          sessions, so they are not on a statement. Amounts are what was
          captured from cards; refunds return the network fee in proportion.
          {open > 0 &&
            ` ${open} ${open === 1 ? "session is" : "sessions are"} not counted yet (in progress, or waiting for energy details).`}
        </p>
        {v.statement.rows.length === 0 ? (
          <EmptyState title="No sessions this month">
            No driver sessions at this host&apos;s sites in {v.month}.
          </EmptyState>
        ) : (
          <TotalsTable totals={v.statement.totals} />
        )}
        {v.statement.chargerFee && (
          <p>
            <b>Monthly charger fee:</b> {v.statement.chargerFee.chargers}{" "}
            {v.statement.chargerFee.chargers === 1 ? "charger" : "chargers"} ×{" "}
            {formatMinor(
              v.statement.chargerFee.perChargerMinor,
              v.statement.chargerFee.currency,
            )}{" "}
            ={" "}
            {formatMinor(
              v.statement.chargerFee.totalMinor,
              v.statement.chargerFee.currency,
            )}
            . <span className="muted">Not collected by the kit.</span>
          </p>
        )}
        {v.statement.rows.length > 0 && <SessionsTable v={v} />}
      </section>
    </>
  );
}

/** Checks access first (a real redirect), then the page behind its loading skeleton. */
export default async function Page(props: { searchParams: SearchParams }) {
  await requireNetworkReader();
  return (
    <Loading shape="list">
      <Content searchParams={props.searchParams} />
    </Loading>
  );
}
