import Link from "next/link";
import { formatMinor } from "@/lib/money";
import { requireRole } from "@/lib/server/auth";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { getOnboarding, loadStripe } from "@/lib/server/onboarding";
import {
  getReports,
  loadReportsContext,
  loadSessions,
  loadStats,
  PAGE_ROWS,
  payoutsUrl,
  PRESET_LABELS,
  PRESETS,
  REPORT_STATUS_LABELS,
  reportFilter,
  reportSearch,
  SESSION_KIND_LABELS,
  STATUS_FILTER_LABELS,
  STATUS_FILTERS,
  type ReportQuery,
  type ReportTotals,
  type SessionRow,
  type SessionsResult,
  type StatsResult,
} from "@/lib/server/reports";
import { shortInZone } from "@/lib/server/reports/time";
import type { Stats, StatsBucket } from "@/lib/server/ivora";
import { formatKwh, whToKwh } from "@/lib/units";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Reports" };

const ZONE_SOURCE = {
  company: "your company's time zone, set in Settings",
  sites: "your sites' time zone; set the company's in Settings",
  utc: "set your company's time zone in Settings to use local time",
} as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const me = await requireRole("viewer");
  const raw = await searchParams;
  const params = {
    get: (k: string) => {
      const v = raw[k];
      return typeof v === "string" ? v : null;
    },
  };
  const d = getReports();
  const r = await loadReportsContext(d, me, params);
  if (!r.ok)
    return (
      <>
        <h1>Reports</h1>
        <p className="error" role="alert">
          {r.error}
        </p>
      </>
    );
  const c = r.context;
  const q = c.query;
  const [stats, sessions, stripe] = await Promise.all([
    loadStats(d.ivora, q),
    loadSessions(d, reportFilter(me, q), q.page, c.places),
    loadStripe(getOnboarding()),
  ]);
  return (
    <>
      <h1>Reports</h1>
      {c.mode === "demo" && (
        <p className="notice" role="note">
          Demo: six months of sample sessions, bills and payments on the sample
          chargers, made up offline, plus your own demo sessions. Nobody paid
          anything.
        </p>
      )}
      <Filters
        q={q}
        stations={c.stations}
        demo={c.mode === "demo"}
        zone={q.timeZone}
      />
      {c.queryError && (
        <p className="error" role="alert">
          {c.queryError}
        </p>
      )}
      <p className="muted">
        {q.fromDate === q.toDate
          ? `${q.fromDate}`
          : `${q.fromDate} to ${q.toDate}`}
        , in {q.timeZone} ({ZONE_SOURCE[c.timeZoneSource]}). Times in tables are
        UTC, with each site&apos;s local time below.
      </p>
      {c.truncated && (
        <p className="notice" role="note">
          Showing the first {(MAX_LIST_PAGES * 100).toLocaleString("en-US")}{" "}
          sites and chargers.
        </p>
      )}
      <StatsSection result={stats} />
      <Sessions result={sessions} q={q} />
      <Payouts stripe={stripe} />
    </>
  );
}

function Filters({
  q,
  stations,
  demo,
  zone,
}: {
  q: ReportQuery;
  stations: { id: number; name: string }[];
  demo: boolean;
  zone: string;
}) {
  return (
    <section className="card" aria-labelledby="filters-heading">
      <h2 id="filters-heading">
        Period and filters
        {demo && <span className="badge">Sample</span>}
      </h2>
      <form
        className="form inline report-filters"
        method="get"
        action="/reports"
      >
        <div className="field">
          <label htmlFor="period">Period</label>
          <select id="period" name="period" defaultValue={q.preset}>
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {PRESET_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="from">From</label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={q.fromDate}
            aria-describedby="custom-hint"
          />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={q.toDate}
            aria-describedby="custom-hint"
          />
        </div>
        <div className="field">
          <label htmlFor="bucket">Group by</label>
          <select
            id="bucket"
            name="bucket"
            defaultValue={q.bucket}
            aria-describedby="custom-hint"
          >
            <option value="hour">Hour</option>
            <option value="day">Day</option>
            <option value="month">Month</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="station">Charger (your sessions)</label>
          <select
            id="station"
            name="station"
            defaultValue={q.stationId === null ? "" : String(q.stationId)}
          >
            <option value="">All chargers</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="status">Status (your sessions)</label>
          <select id="status" name="status" defaultValue={q.status}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {STATUS_FILTER_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="button">
          Show report
        </button>
      </form>
      <p id="custom-hint" className="muted">
        From, To and Group by apply to &quot;Custom dates&quot; (dates in {zone}
        , both included). Ivora reports up to 7 days by hour, 92 days by day or
        24 months by month. Charger and status filter your sessions (the table,
        its totals and the CSV); Ivora&apos;s figures cover every charger.
      </p>
    </section>
  );
}

// ---- Figures from GET /stats ----

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** A bucket's label from its start, already in the report's time zone. */
function bucketLabel(b: StatsBucket, size: Stats["bucket"]): string {
  const [y, m, d] = b.start.slice(0, 10).split("-");
  const month = MONTHS[Number(m) - 1];
  if (size === "month") return `${month} ${y}`;
  if (size === "day") return `${month} ${Number(d)}, ${y}`;
  return `${month} ${Number(d)} ${b.start.slice(11, 16)}`;
}

/** "0.9500" to "95.0%": the API's decimal text, for display only. */
function percent(rate: string | null): string {
  if (rate === null) return "–";
  const n = Number(rate);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : rate;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "–";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const kwh = (wh: number) => formatKwh(whToKwh(wh));

function revenueText(
  lines: { currency: string; billed_minor: number }[] | null,
) {
  if (lines === null) return "Needs billing:read";
  if (!lines.length) return "None";
  return lines.map((l) => formatMinor(l.billed_minor, l.currency)).join(" · ");
}

function StatsSection({ result }: { result: StatsResult }) {
  if (!result.ok)
    return (
      <section className="card" aria-labelledby="figures-heading">
        <h2 id="figures-heading">
          Figures
          {result.tooLarge && (
            <span className="pill warn">Period too large</span>
          )}
        </h2>
        <p className="error" role="alert">
          {result.error}
        </p>
      </section>
    );
  const s = result.stats;
  const t = s.totals;
  const maxWh = Math.max(1, ...s.series.map((b) => b.energy_wh));
  return (
    <>
      <h2 className="section-heading">All sessions on your chargers (Ivora)</h2>
      <section className="stats" aria-label="Figures for the period">
        <Stat
          label="Sessions"
          value={t.sessions.toLocaleString("en-US")}
          note={t.active_sessions ? `${t.active_sessions} charging` : undefined}
        />
        <Stat
          label="Energy"
          value={kwh(t.energy_wh)}
          note={
            t.energy_unknown_sessions
              ? `${t.energy_unknown_sessions} without a reading`
              : undefined
          }
        />
        <Stat
          label="Success rate"
          value={percent(t.success_rate)}
          note={`${t.successful_sessions} of ${t.ended_sessions} ended`}
        />
        <Stat
          label="Average duration"
          value={duration(t.average_duration_seconds)}
        />
        <Stat
          label="Billed (final bills)"
          value={revenueText(s.revenue?.currencies ?? null)}
          note={
            s.revenue
              ? `${s.revenue.currencies.reduce((n, l) => n + l.bills, 0)} final bills`
              : undefined
          }
        />
      </section>
      <p className="muted">
        Every session on your chargers, as Ivora counts them: also staff/test
        sessions and sessions started outside this kit (RFID cards, roaming).
        Billed is the total of Ivora&apos;s final bills finalized in the period:
        what was billed, not what was collected (a bill under Stripe&apos;s
        minimum is not charged, a bill above the card hold is charged up to the
        hold, refunds come off). What drivers paid is under{" "}
        <a href="#sessions-heading">Your sessions</a>. Session figures as of{" "}
        {shortInZone(Date.parse(s.sessions_as_of), "UTC")} UTC.
      </p>
      <section className="card" aria-labelledby="series-heading">
        <h2 id="series-heading">By {s.bucket}</h2>
        <div
          className="table-scroll"
          tabIndex={0}
          role="group"
          aria-label={`By ${s.bucket}, scrolls sideways`}
        >
          <table className="data-table">
            <caption className="muted">
              {s.time_zone}; sessions count in the {s.bucket} they started.
            </caption>
            <thead>
              <tr>
                <th scope="col">{s.bucket === "hour" ? "Hour" : "Period"}</th>
                <th scope="col" className="num">
                  Sessions
                </th>
                <th scope="col" className="num">
                  Energy
                </th>
                <th scope="col" className="bar-cell">
                  <span className="visually-hidden">Energy chart</span>
                </th>
                <th scope="col" className="num">
                  Success
                </th>
                <th scope="col" className="num">
                  Billed
                </th>
              </tr>
            </thead>
            <tbody>
              {s.series.map((b) => (
                <tr key={b.start}>
                  <th scope="row">
                    <time dateTime={b.start}>{bucketLabel(b, s.bucket)}</time>
                  </th>
                  <td className="num">{b.sessions}</td>
                  <td className="num">{kwh(b.energy_wh)}</td>
                  <td className="bar-cell" aria-hidden="true">
                    <span
                      className="bar"
                      style={{ width: `${(b.energy_wh / maxWh) * 100}%` }}
                    />
                  </td>
                  <td className="num">{percent(b.success_rate)}</td>
                  <td className="num">{revenueText(b.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="report-pair">
        <section className="card" aria-labelledby="top-heading">
          <h2 id="top-heading">Top chargers by energy</h2>
          {s.top_stations.length === 0 ? (
            <p className="muted">No sessions in this period.</p>
          ) : (
            <ol className="rows" aria-label="Top chargers by energy">
              {s.top_stations.map((x) => (
                <li key={x.station_id}>
                  <span className="name">
                    {x.name ?? `Removed charger ${x.station_id}`}
                  </span>
                  <span className="muted">
                    {x.sessions} {x.sessions === 1 ? "session" : "sessions"}
                  </span>
                  <span>{kwh(x.energy_wh)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="card" aria-labelledby="state-heading">
          <h2 id="state-heading">Chargers now</h2>
          <ul className="rows" aria-label="Chargers now">
            <li>
              <span className="name">Online</span>
              <span className="pill ok">{s.stations.online}</span>
            </li>
            <li>
              <span className="name">Faulted</span>
              <span className="pill warn">{s.stations.faulted}</span>
            </li>
            <li>
              <span className="name">Offline</span>
              <span className="pill off">{s.stations.offline}</span>
            </li>
          </ul>
          <p className="muted">
            {s.stations.total} chargers, as of{" "}
            {shortInZone(Date.parse(s.stations.as_of), "UTC")} UTC. See{" "}
            <Link href="/live">Live</Link> for each one.
          </p>
        </section>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">
        {label}
        {note ? ` (${note})` : ""}
      </span>
    </div>
  );
}

// ---- Your sessions (the kit's own records) ----

function money(minor: number | null, currency: string) {
  return minor === null ? "–" : formatMinor(minor, currency);
}

function moneyText(
  lines: ReportTotals["currencies"],
  pick: (l: ReportTotals["currencies"][number]) => number,
) {
  return lines.length
    ? lines.map((l) => formatMinor(pick(l), l.currency)).join(" · ")
    : "None";
}

function When({ iso, zone }: { iso: string | null; zone: string }) {
  if (!iso) return <span className="muted">–</span>;
  const ms = Date.parse(iso);
  return (
    <>
      <time dateTime={iso}>{shortInZone(ms, "UTC")} UTC</time>
      <br />
      <span className="muted">
        {shortInZone(ms, zone).slice(11)} {zone}
      </span>
    </>
  );
}

function Started({ r }: { r: SessionRow }) {
  if (r.startedAt) return <When iso={r.startedAt} zone={r.timeZone} />;
  return (
    <>
      <When iso={r.createdAt} zone={r.timeZone} />
      <br />
      <span className="muted">
        {r.detailsPending ? "Tapped; details pending" : "Tapped; no session"}
      </span>
    </>
  );
}

function Energy({ r }: { r: SessionRow }) {
  if (r.energyWh !== null) return <>{kwh(r.energyWh)}</>;
  if (r.energySoFarWh !== null)
    return <span className="muted">{kwh(r.energySoFarWh)} so far</span>;
  return <span className="muted">–</span>;
}

function Totals({ t }: { t: ReportTotals }) {
  const sessions = t.withSession;
  return (
    <>
      <section className="stats" aria-label="Totals of your sessions">
        <Stat
          label="Sessions"
          value={sessions.toLocaleString("en-US")}
          note={`of ${t.checkouts} taps: ${t.paid} paid, ${t.free} free`}
        />
        <Stat
          label="Energy"
          value={kwh(t.energyWh)}
          note={
            t.detailsPending ? `${t.detailsPending} still pending` : undefined
          }
        />
        <Stat
          label="Collected (captured minus refunds)"
          value={moneyText(
            t.currencies,
            (l) => l.capturedMinor - l.refundedMinor,
          )}
          note={`${t.byStatus.charged} charged`}
        />
        <Stat
          label="Refunded"
          value={moneyText(t.currencies, (l) => l.refundedMinor)}
        />
        <Stat
          label="Billed (their final bills)"
          value={moneyText(t.currencies, (l) => l.billedMinor)}
        />
        <Stat
          label="Needs you"
          value={t.byStatus.attention.toLocaleString("en-US")}
          note={
            t.byStatus.in_progress
              ? `${t.byStatus.in_progress} in progress`
              : undefined
          }
        />
      </section>
      <p className="muted">
        Sessions drivers paid for or started from your QR stickers, by when they
        tapped. Collected is what was captured from drivers&apos; cards minus
        refunds, before Stripe&apos;s and Ivora&apos;s fees: a bill under
        Stripe&apos;s 50-cent minimum captures nothing, and a bill above the
        card hold is not captured by the kit (it needs you). Free sessions never
        carry money, and staff/test sessions and sessions started outside this
        kit (RFID cards, roaming) are not listed here: they are in Ivora&apos;s
        figures above.
        {t.detailsPending > 0 &&
          " Energy and times of sessions that ended in the last few minutes are copied from Ivora by the settlement sweep."}
        {t.refundsUnchecked > 0 &&
          ` Refunds of ${t.refundsUnchecked} charged ${t.refundsUnchecked === 1 ? "session have" : "sessions have"} not been checked yet; the sweep reads each payment once a day for 90 days.`}
      </p>
    </>
  );
}

function Pager({
  q,
  page,
  pages,
}: {
  q: ReportQuery;
  page: number;
  pages: number;
}) {
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label="Session pages">
      {page > 1 ? (
        <Link href={`/reports?${reportSearch(q, page - 1)}`}>Newer</Link>
      ) : (
        <span />
      )}
      <span className="muted">
        Page {page} of {pages}
      </span>
      {page < pages ? (
        <Link href={`/reports?${reportSearch(q, page + 1)}`}>Older</Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

function Sessions({ result, q }: { result: SessionsResult; q: ReportQuery }) {
  return (
    <section className="card" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">
        Your sessions (this kit)
        <a
          className="button secondary"
          href={`/reports/export?${reportSearch(q)}`}
          download
        >
          Download CSV
        </a>
      </h2>
      {!result.ok ? (
        <p className="error" role="alert">
          {result.error}
        </p>
      ) : (
        <>
          <Totals t={result.totals} />
          {result.rows.length === 0 ? (
            <p className="muted">No sessions match these filters.</p>
          ) : (
            <div
              className="table-scroll"
              tabIndex={0}
              role="group"
              aria-label="Sessions, scrolls sideways"
            >
              <table className="data-table sessions-table">
                <caption className="muted">
                  {result.totals.checkouts > PAGE_ROWS
                    ? `Newest first, ${PAGE_ROWS} a page; the CSV has all ${result.totals.checkouts.toLocaleString("en-US")}.`
                    : "Newest first."}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Ended</th>
                    <th scope="col">Charger</th>
                    <th scope="col" className="num">
                      Energy
                    </th>
                    <th scope="col" className="num">
                      Billed
                    </th>
                    <th scope="col" className="num">
                      Collected
                    </th>
                    <th scope="col">Type</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.reference}>
                      <td>
                        <Started r={r} />
                      </td>
                      <td>
                        <When iso={r.endedAt} zone={r.timeZone} />
                      </td>
                      <td>
                        {r.stationName}
                        <br />
                        <span className="muted">
                          Connector {r.connectorNumber ?? r.connectorId}
                          {r.siteName ? ` · ${r.siteName}` : ""}
                        </span>
                      </td>
                      <td className="num">
                        <Energy r={r} />
                      </td>
                      <td className="num">
                        {money(r.billedMinor, r.currency)}
                      </td>
                      <td className="num">
                        {money(r.netMinor, r.currency)}
                        {r.refundedMinor ? (
                          <>
                            <br />
                            <span className="muted">
                              {formatMinor(r.refundedMinor, r.currency)}{" "}
                              refunded
                            </span>
                          </>
                        ) : null}
                      </td>
                      <td>{SESSION_KIND_LABELS[r.kind]}</td>
                      <td>
                        {REPORT_STATUS_LABELS[r.status]}
                        <br />
                        <span className="muted mono">{r.reference}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager q={q} page={result.page} pages={result.pages} />
        </>
      )}
    </section>
  );
}

// ---- Payouts ----

function Payouts({
  stripe,
}: {
  stripe: Awaited<ReturnType<typeof loadStripe>>;
}) {
  const view = stripe.ok ? stripe.view : null;
  return (
    <section className="card" aria-labelledby="payouts-heading">
      <h2 id="payouts-heading">Payouts</h2>
      <p>
        Drivers pay through Ivora Checkout into your own Stripe account, and
        Stripe pays out to your bank, after Stripe&apos;s and Ivora&apos;s fees.
        The kit holds no Stripe keys and does not read payouts: see them in your
        Stripe dashboard (Stripe asks you to sign in; with several Stripe
        accounts, pick the one connected in Onboarding).
      </p>
      {view?.state === "none" ? (
        <p className="muted">
          No Stripe account is connected yet.{" "}
          <Link href="/onboarding?step=payments">Connect Stripe</Link> first.
        </p>
      ) : (
        <p>
          <a
            className="button secondary"
            href={payoutsUrl(view?.livemode ?? null)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open payouts in Stripe
            {view?.livemode === false ? " (test mode)" : ""}
          </a>
        </p>
      )}
      {!stripe.ok && (
        <p className="muted">
          The Stripe account&apos;s status can&apos;t be read right now:{" "}
          {stripe.error}
        </p>
      )}
    </section>
  );
}

/** Checks the role first (a real redirect), then the page behind its loading skeleton. */
export default async function Page(props: Parameters<typeof Content>[0]) {
  await requireRole("viewer");
  return (
    <Loading shape="stats">
      <Content {...props} />
    </Loading>
  );
}
