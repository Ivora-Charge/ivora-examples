import Link from "next/link";
import { formatMinor, mixedCurrenciesNote } from "@/lib/money";
import { requireRole } from "@/lib/server/auth";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { getOnboarding, loadStripe } from "@/lib/server/onboarding";
import {
  getReports,
  loadReportsContext,
  loadIvoraBills,
  loadIvoraSessions,
  loadSessions,
  cleanCursor,
  type IvoraBillsResult,
  type IvoraSessionsResult,
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
  type ReportStatus,
  type ReportTotals,
  type SessionRow,
  type SessionsResult,
  type StatsResult,
} from "@/lib/server/reports";
import {
  billedFigure,
  revenueText,
  totalsFigures,
} from "@/lib/server/reports/figures";
import { shortInZone } from "@/lib/server/reports/time";
import type { Stats, StatsBucket } from "@/lib/server/ivora";
import { STATION_CHIPS, type ChipTone } from "@/lib/status-chips";
import { formatKwh, whToKwh } from "@/lib/units";
import { Loading } from "@/app/loading-skeleton";
import { BarChart } from "@/app/ui/bar-chart";
import { DataTable, type DataTableRow } from "@/app/ui/data-table";
import { EmptyState } from "@/app/ui/empty-state";
import { InfoTip } from "@/app/ui/info-tip";
import { PageHeader } from "@/app/ui/page-header";
import { Chip, StatusChip } from "@/app/ui/status-chip";
import { SummaryStrip, type SummaryItem } from "@/app/ui/summary-strip";
import { Tabs } from "@/app/ui/tabs";

export const metadata = { title: "Reports" };

const ZONE_SOURCE = {
  company: "your company's time zone, set in Settings",
  sites: "your sites' time zone; set the company's in Settings",
  utc: "set your company's time zone in Settings to use local time",
} as const;

const STATUS_TONE: Record<ReportStatus, ChipTone> = {
  in_progress: "busy",
  charged: "ok",
  no_charge: "off",
  attention: "warn",
};

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
        <PageHeader title="Reports" />
        <EmptyState
          tone="error"
          title="Reports are unavailable"
          action={
            <Link className="button" href="/reports">
              Try again
            </Link>
          }
        >
          {r.error} Payments are not affected.
        </EmptyState>
      </>
    );
  const c = r.context;
  const q = c.query;
  const cursors = {
    s: cleanCursor(params.get("scursor")),
    b: cleanCursor(params.get("bcursor")),
  };
  const [stats, sessions, ivoraSessions, ivoraBills, stripe] =
    await Promise.all([
      loadStats(d.ivora, q),
      loadSessions(d, reportFilter(me, q), q.page, c.places),
      loadIvoraSessions(d, q, c.places, cursors.s),
      loadIvoraBills(d, q, cursors.b),
      loadStripe(getOnboarding()),
    ]);
  return (
    <>
      <PageHeader
        title="Reports"
        description={`Sessions, energy and revenue, ${
          q.fromDate === q.toDate ? q.fromDate : `${q.fromDate} to ${q.toDate}`
        }, in ${q.timeZone}.`}
        action={
          <a
            className="button"
            href={`/reports/export?${reportSearch(q)}`}
            download
          >
            Export CSV
          </a>
        }
      />
      <Filters q={q} stations={c.stations} zone={q.timeZone}>
        Times are in {q.timeZone} ({ZONE_SOURCE[c.timeZoneSource]}). In tables
        they are in each site&apos;s time zone, with UTC below. The CSV has
        both, and applies the charger and status filters.
      </Filters>
      {c.queryError && (
        <p className="error" role="alert">
          {c.queryError}
        </p>
      )}
      {c.truncated && (
        <p className="notice" role="note">
          Showing the first {(MAX_LIST_PAGES * 100).toLocaleString("en-US")}{" "}
          sites and chargers.
        </p>
      )}
      <StatsSection result={stats} demo={c.mode === "demo"} />
      <Tables
        sessions={sessions}
        ivoraSessions={ivoraSessions}
        ivoraBills={ivoraBills}
        q={q}
        cursors={cursors}
      />
      <Payouts stripe={stripe} />
    </>
  );
}

function Filters({
  q,
  stations,
  zone,
  children,
}: {
  q: ReportQuery;
  stations: { id: number; name: string }[];
  zone: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card report-toolbar" aria-label="Period and filters">
      <form className="report-filters" method="get" action="/reports">
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
          <label htmlFor="station">Charger</label>
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
          <label htmlFor="status">Status</label>
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
        <details className="custom-dates" open={q.preset === "custom"}>
          <summary>Custom dates</summary>
          <div className="report-custom">
            <div className="field">
              <label htmlFor="from">From</label>
              <input
                id="from"
                name="from"
                type="date"
                defaultValue={q.fromDate}
              />
            </div>
            <div className="field">
              <label htmlFor="to">To</label>
              <input id="to" name="to" type="date" defaultValue={q.toDate} />
            </div>
            <div className="field">
              <label htmlFor="bucket">Group by</label>
              <select id="bucket" name="bucket" defaultValue={q.bucket}>
                <option value="hour">Hour</option>
                <option value="day">Day</option>
                <option value="month">Month</option>
              </select>
            </div>
          </div>
        </details>
      </form>
      <p className="toolbar-note muted">
        Times in {zone}
        <InfoTip label="period and filters">
          {children} From, To and Group by apply to &quot;Custom dates&quot;
          (dates in {zone}, both included). Ivora reports up to 7 days by hour,
          92 days by day or 24 months by month. Charger and status filter your
          sessions (the table, its totals and the CSV); Ivora&apos;s figures
          cover every charger.
        </InfoTip>
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

/** A shorter label for a chart's axis. */
function axisLabel(b: StatsBucket, size: Stats["bucket"]): string {
  const [, m, d] = b.start.slice(0, 10).split("-");
  const month = MONTHS[Number(m) - 1];
  if (size === "month") return month;
  if (size === "day") return `${month} ${Number(d)}`;
  return b.start.slice(11, 16);
}

/** A visible "Mixed currencies" chip when amounts are shown in more than one currency. */
function MixedMarker({ currencies }: { currencies: readonly string[] }) {
  if (!mixedCurrenciesNote(currencies)) return null;
  return (
    <span data-testid="mixed-currencies">
      <StatusChip tone="idle">Mixed currencies</StatusChip>
    </span>
  );
}

/**
 * A money figure of one amount per currency ("CA$1.00 · $2.00"): each currency on its
 * own line so tiles keep one width; the " · " stays for screen readers and copying.
 */
function PerCurrency({ text }: { text: string }) {
  const parts = text.split(" · ");
  if (parts.length < 2) return <>{text}</>;
  return (
    <span className="per-currency">
      {parts.map((p, i) => (
        <span key={p}>
          {i > 0 && <span className="visually-hidden"> · </span>}
          {p}
        </span>
      ))}
    </span>
  );
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

function SectionHeading({
  id,
  children,
  info,
  label,
  marker,
}: {
  id: string;
  children: React.ReactNode;
  info?: React.ReactNode;
  label: string;
  /** A short chip after the heading, visible without opening the info. */
  marker?: React.ReactNode;
}) {
  return (
    <div className="section-head">
      <h2 id={id}>{children}</h2>
      {marker}
      {info && <InfoTip label={label}>{info}</InfoTip>}
    </div>
  );
}

function StatsSection({
  result,
  demo,
}: {
  result: StatsResult;
  demo: boolean;
}) {
  if (!result.ok)
    return (
      <section aria-labelledby="figures-heading">
        <SectionHeading id="figures-heading" label="the figures">
          Figures
          {result.tooLarge && (
            <>
              {" "}
              <StatusChip tone="warn">Period too large</StatusChip>
            </>
          )}
        </SectionHeading>
        <EmptyState
          tone="error"
          title="Figures are unavailable"
          action={
            <Link className="button secondary" href="/reports">
              Try again
            </Link>
          }
        >
          {result.error} Payments are not affected.
        </EmptyState>
      </section>
    );
  const s = result.stats;
  const t = s.totals;
  const billed = billedFigure(s.revenue);
  const items: SummaryItem[] = [
    { label: "Sessions", value: t.sessions.toLocaleString("en-US") },
    { label: "Energy", value: kwh(t.energy_wh) },
    { label: "Success", value: percent(t.success_rate) },
    { label: "Avg. duration", value: duration(t.average_duration_seconds) },
    { label: "Billed", value: <PerCurrency text={billed.value} /> },
  ];
  const notes = [
    t.active_sessions ? `${t.active_sessions} sessions charging now` : null,
    t.energy_unknown_sessions
      ? `${t.energy_unknown_sessions} sessions without an energy reading`
      : null,
    `Success: ${t.successful_sessions} of ${t.ended_sessions} ended sessions`,
    billed.note ? `Billed: ${billed.note}` : null,
  ].filter(Boolean);
  return (
    <>
      <SectionHeading
        id="figures-heading"
        label="these figures"
        marker={
          <MixedMarker
            currencies={(s.revenue?.currencies ?? []).map((l) => l.currency)}
          />
        }
        info={
          <>
            {demo && (
              <p>
                Demo: six months of sample sessions, bills and payments on the
                sample chargers, made up offline, plus your own demo sessions.
                Nobody paid anything.
              </p>
            )}
            <p>
              Every session on your chargers, as Ivora counts them: also
              staff/test sessions and sessions started outside this kit (RFID
              cards, roaming). Billed is the total of Ivora&apos;s final bills
              finalized in the period: what was billed, not what was collected
              (a bill under Stripe&apos;s minimum is not charged, a bill above
              the card hold is charged up to the hold, refunds come off). What
              drivers paid is under Your sessions. Session figures as of{" "}
              {shortInZone(Date.parse(s.sessions_as_of), "UTC")} UTC.
            </p>
            <ul>
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </>
        }
      >
        All sessions on your chargers (Ivora)
      </SectionHeading>
      <SummaryStrip items={items} label="Figures for the period" />
      <div className="report-main">
        <figure className="card report-chart" aria-labelledby="series-heading">
          <div className="chead">
            <h3 id="series-heading">Energy by {s.bucket} (kWh)</h3>
            <span className="muted">{s.time_zone}</span>
          </div>
          <BarChart
            bars={s.series.map((b) => ({
              label: axisLabel(b, s.bucket),
              value: b.energy_wh / 1000,
            }))}
            summary={`Energy by ${s.bucket}, ${s.series.length} bars; the table below has the same figures`}
            unit="kWh"
          />
          <figcaption>
            <details className="how">
              <summary>Show the figures by {s.bucket} as a table</summary>
              <SeriesTable s={s} />
            </details>
          </figcaption>
        </figure>
        <div className="report-side">
          <section className="card" aria-labelledby="top-heading">
            <h3 id="top-heading">Top chargers by energy</h3>
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
            <div className="section-head">
              <h3 id="state-heading">Chargers now</h3>
              <InfoTip label="chargers now">
                {s.stations.total} chargers, as of{" "}
                {shortInZone(Date.parse(s.stations.as_of), "UTC")} UTC. See{" "}
                <Link href="/live">Live</Link> for each one.
              </InfoTip>
            </div>
            <ul className="rows" aria-label="Chargers now">
              {(["online", "faulted", "offline"] as const).map((k) => (
                <li key={k}>
                  <Chip spec={STATION_CHIPS[k]} />
                  <span className="count">{s.stations[k]}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}

function SeriesTable({ s }: { s: Stats }) {
  return (
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
              <td className="num">{percent(b.success_rate)}</td>
              <td className="num">{revenueText(b.revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Your sessions (the kit's own records) ----

function money(minor: number | null, currency: string) {
  return minor === null ? "–" : formatMinor(minor, currency);
}

/** "EST", "GMT+1" or "UTC": the zone's short name at that instant. */
function zoneName(ms: number, zone: string): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(ms)
      .find((p) => p.type === "timeZoneName")?.value ?? zone
  );
}

/** Local time of the site first, UTC secondary (one line when the zone is UTC). */
function When({ iso, zone }: { iso: string | null; zone: string }) {
  if (!iso) return <span className="muted">–</span>;
  const ms = Date.parse(iso);
  const name = zoneName(ms, zone);
  return (
    <span className="when">
      <time dateTime={iso} title={zone}>
        {shortInZone(ms, zone)} {name}
      </time>
      {name !== "UTC" && (
        <span className="muted">{shortInZone(ms, "UTC")} UTC</span>
      )}
    </span>
  );
}

function Started({ r }: { r: SessionRow }) {
  if (r.startedAt) return <When iso={r.startedAt} zone={r.timeZone} />;
  return (
    <>
      <When iso={r.createdAt} zone={r.timeZone} />
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

function totalsItems(t: ReportTotals): SummaryItem[] {
  const f = totalsFigures(t);
  return [
    { label: "Sessions", value: t.withSession.toLocaleString("en-US") },
    { label: "Energy", value: kwh(t.energyWh) },
    { label: "Collected", value: <PerCurrency text={f.collected.value} /> },
    { label: "Refunded", value: <PerCurrency text={f.refunded.value} /> },
    { label: "Billed", value: <PerCurrency text={f.billed.value} /> },
    { label: "Needs you", value: t.byStatus.attention.toLocaleString("en-US") },
  ];
}

function TotalsInfo({ t }: { t: ReportTotals }) {
  const f = totalsFigures(t);
  return (
    <>
      <p>
        Sessions drivers paid for or started from your QR stickers, by when they
        tapped. Collected (captured minus refunds) is what was captured from
        drivers&apos; cards minus refunds, before Stripe&apos;s and Ivora&apos;s
        fees: a bill under Stripe&apos;s 50-cent minimum captures nothing, and a
        bill above the card hold is not captured by the kit (it needs you).
        Billed is their final bills. Free sessions never carry money. Staff/test
        sessions and sessions started outside this kit (RFID cards, roaming) are
        not in this table or its totals: they are in Ivora&apos;s figures above
        and listed under All sessions.
        {t.detailsPending > 0 &&
          " Energy and times of sessions that ended in the last few minutes are copied from Ivora by the settlement sweep."}
        {t.refundsUnchecked > 0 &&
          ` Refunds of ${t.refundsUnchecked} charged ${t.refundsUnchecked === 1 ? "session have" : "sessions have"} not been checked yet; the sweep reads each payment once a day for 90 days.`}
      </p>
      <ul>
        <li>
          {t.withSession} sessions of {t.checkouts} taps: {t.paid} paid,{" "}
          {t.free} free
        </li>
        {t.detailsPending > 0 && (
          <li>{t.detailsPending} sessions still pending</li>
        )}
        <li>{f.collected.note}</li>
        {t.byStatus.in_progress > 0 && (
          <li>{t.byStatus.in_progress} in progress</li>
        )}
      </ul>
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

function PeriodEmpty({
  q,
  title,
  children,
}: {
  q: ReportQuery;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <EmptyState
        title={title}
        action={
          <>
            {q.preset !== "90d" && (
              <Link className="button" href="/reports?period=90d">
                Show 90 days
              </Link>
            )}
            <Link href="/live">Open Live</Link>
          </>
        }
      >
        {children}
      </EmptyState>
    </div>
  );
}

function sessionRows(rows: SessionRow[]): DataTableRow[] {
  return rows.map((r) => ({
    id: r.reference,
    values: {
      started: r.startedAt ?? r.createdAt,
      ended: r.endedAt ?? "",
      charger: `${r.stationName} ${r.siteName ?? ""}`.trim(),
      energy: r.energyWh ?? r.energySoFarWh ?? 0,
      billed: r.billedMinor ?? 0,
      collected: r.netMinor ?? 0,
      type: SESSION_KIND_LABELS[r.kind],
      status: REPORT_STATUS_LABELS[r.status],
      reference: r.reference,
    },
    cells: {
      started: <Started r={r} />,
      ended: <When iso={r.endedAt} zone={r.timeZone} />,
      charger: (
        <>
          {r.stationName}
          <br />
          <span className="muted">
            Connector {r.connectorNumber ?? r.connectorId}
            {r.siteName ? ` · ${r.siteName}` : ""}
          </span>
        </>
      ),
      energy: <Energy r={r} />,
      billed: money(r.billedMinor, r.currency),
      collected: (
        <>
          {money(r.netMinor, r.currency)}
          {r.refundedMinor ? (
            <>
              <br />
              <span className="muted">
                {formatMinor(r.refundedMinor, r.currency)} refunded
              </span>
            </>
          ) : null}
        </>
      ),
      type: SESSION_KIND_LABELS[r.kind],
      status: (
        <>
          <StatusChip tone={STATUS_TONE[r.status]}>
            {REPORT_STATUS_LABELS[r.status]}
          </StatusChip>
          <br />
          <span className="muted mono">{r.reference}</span>
        </>
      ),
    },
  }));
}

function Sessions({ result, q }: { result: SessionsResult; q: ReportQuery }) {
  if (!result.ok)
    return (
      <EmptyState
        tone="error"
        title="Your sessions are unavailable"
        action={
          <Link
            className="button secondary"
            href={`/reports?${reportSearch(q)}`}
          >
            Try again
          </Link>
        }
      >
        {result.error} Payments are not affected.
      </EmptyState>
    );
  return (
    <>
      {result.rows.length === 0 ? (
        <PeriodEmpty q={q} title="No sessions match">
          No sessions match these filters in this period. Try a longer period.
        </PeriodEmpty>
      ) : (
        <DataTable
          caption="Sessions started from this kit"
          columns={[
            { key: "started", label: "Started" },
            { key: "ended", label: "Ended" },
            { key: "charger", label: "Charger" },
            { key: "energy", label: "Energy", numeric: true },
            { key: "billed", label: "Billed", numeric: true },
            { key: "collected", label: "Collected", numeric: true },
            { key: "type", label: "Type", filter: true },
            { key: "status", label: "Status", filter: true },
            { key: "reference", label: "Reference", hidden: true },
          ]}
          rows={sessionRows(result.rows)}
        />
      )}
      <p className="muted table-note">
        {result.totals.checkouts > PAGE_ROWS
          ? `Newest first, ${PAGE_ROWS} a page; the CSV has all ${result.totals.checkouts.toLocaleString("en-US")}.`
          : "Newest first."}
      </p>
      <Pager q={q} page={result.page} pages={result.pages} />
    </>
  );
}

// ---- Ivora's lists: every session and bill of the period ----

type Cursors = { s: string | null; b: string | null };

/** The page's link to the next page of one list, keeping the other list where it is. */
function listLink(q: ReportQuery, c: Cursors, which: "s" | "b", next: string) {
  const p = new URLSearchParams(reportSearch(q, q.page));
  const own = { s: "scursor", b: "bcursor" } as const;
  const other = which === "s" ? "b" : "s";
  if (c[other]) p.set(own[other], c[other]!);
  p.set(own[which], next);
  return `/reports?${p.toString()}`;
}

function ListPager({
  q,
  cursors,
  which,
  next,
  label,
}: {
  q: ReportQuery;
  cursors: Cursors;
  which: "s" | "b";
  next: string | null;
  label: string;
}) {
  if (!next && !cursors[which]) return null;
  const first = new URLSearchParams(reportSearch(q, q.page));
  const other = which === "s" ? "b" : "s";
  if (cursors[other])
    first.set(other === "s" ? "scursor" : "bcursor", cursors[other]!);
  return (
    <nav className="pager" aria-label={label}>
      {cursors[which] ? (
        <Link href={`/reports?${first.toString()}`}>Newest</Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link href={listLink(q, cursors, which, next)}>Older</Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

function IvoraSessions({
  result,
  q,
  cursors,
}: {
  result: IvoraSessionsResult;
  q: ReportQuery;
  cursors: Cursors;
}) {
  if (!result.ok)
    return (
      <EmptyState
        tone="error"
        title="Sessions are unavailable"
        action={
          <Link
            className="button secondary"
            href={`/reports?${reportSearch(q)}`}
          >
            Try again
          </Link>
        }
      >
        {result.error} Payments are not affected.
      </EmptyState>
    );
  if (result.rows.length === 0)
    return (
      <PeriodEmpty q={q} title="No sessions in this period">
        No sessions started in this period. Try a longer period, or check that
        your chargers are online.
      </PeriodEmpty>
    );
  const rows: DataTableRow[] = result.rows.map((r) => ({
    id: String(r.id),
    values: {
      started: r.startedAt ?? "",
      ended: r.active ? "Charging" : (r.endedAt ?? ""),
      charger: `${r.stationName} ${r.siteName ?? ""}`.trim(),
      token: r.idToken ?? "",
      energy: r.energyWh ?? 0,
      bill: r.billId ?? "",
    },
    cells: {
      started: <When iso={r.startedAt} zone={r.timeZone} />,
      ended: r.active ? (
        <StatusChip tone="busy">Charging</StatusChip>
      ) : (
        <When iso={r.endedAt} zone={r.timeZone} />
      ),
      charger: (
        <>
          {r.stationName}
          <br />
          <span className="muted">
            {r.connectorNumber
              ? `Connector ${r.connectorNumber}`
              : "Connector unknown"}
            {r.siteName ? ` · ${r.siteName}` : ""}
          </span>
        </>
      ),
      token: <span className="mono">{r.idToken ?? "–"}</span>,
      energy: r.energyWh === null ? "–" : kwh(r.energyWh),
      bill: <span className="mono">{r.billId ?? "–"}</span>,
    },
  }));
  return (
    <>
      <DataTable
        caption="Started sessions"
        columns={[
          { key: "started", label: "Started" },
          { key: "ended", label: "Ended" },
          { key: "charger", label: "Charger" },
          { key: "token", label: "ID token" },
          { key: "energy", label: "Energy", numeric: true },
          { key: "bill", label: "Bill" },
        ]}
        rows={rows}
      />
      <ListPager
        q={q}
        cursors={cursors}
        which="s"
        next={result.next}
        label="Started sessions pages"
      />
    </>
  );
}

function IvoraBills({
  result,
  q,
  cursors,
}: {
  result: IvoraBillsResult;
  q: ReportQuery;
  cursors: Cursors;
}) {
  if (!result.ok)
    return (
      <EmptyState
        tone="error"
        title="Bills are unavailable"
        action={
          <Link
            className="button secondary"
            href={`/reports?${reportSearch(q)}`}
          >
            Try again
          </Link>
        }
      >
        {result.error} Payments are not affected.
      </EmptyState>
    );
  if (result.bills.length === 0)
    return (
      <PeriodEmpty q={q} title="No bills in this period">
        No bills were created in this period. Try a longer period.
      </PeriodEmpty>
    );
  const rows: DataTableRow[] = result.bills.map((b) => ({
    id: b.id,
    values: {
      created: b.created_at,
      bill: b.id,
      status: b.status === "final" ? "Final" : "Open",
      total: b.total_minor ?? 0,
      session: b.transaction_id ?? "",
    },
    cells: {
      created: <When iso={b.created_at} zone={q.timeZone} />,
      bill: <span className="mono">{b.id}</span>,
      status: (
        <StatusChip tone={b.status === "final" ? "ok" : "busy"}>
          {b.status === "final" ? "Final" : "Open"}
        </StatusChip>
      ),
      total: money(b.total_minor, b.currency),
      session: b.transaction_id ?? "–",
    },
  }));
  return (
    <>
      <DataTable
        caption="Bills"
        columns={[
          { key: "created", label: "Created" },
          { key: "bill", label: "Bill" },
          { key: "status", label: "Status", filter: true },
          { key: "total", label: "Total", numeric: true },
          { key: "session", label: "Session" },
        ]}
        rows={rows}
      />
      <ListPager
        q={q}
        cursors={cursors}
        which="b"
        next={result.next}
        label="Bills pages"
      />
    </>
  );
}

function Tables({
  sessions,
  ivoraSessions,
  ivoraBills,
  q,
  cursors,
}: {
  sessions: SessionsResult;
  ivoraSessions: IvoraSessionsResult;
  ivoraBills: IvoraBillsResult;
  q: ReportQuery;
  cursors: Cursors;
}) {
  const initial = cursors.s ? "all" : cursors.b ? "bills" : "yours";
  return (
    <section aria-labelledby="sessions-heading" className="report-tables">
      <SectionHeading
        id="sessions-heading"
        label="your sessions"
        marker={
          sessions.ok && (
            <MixedMarker
              currencies={sessions.totals.currencies.map((l) => l.currency)}
            />
          )
        }
        info={
          sessions.ok ? (
            <TotalsInfo t={sessions.totals} />
          ) : (
            <p>Your sessions are the ones started from this kit.</p>
          )
        }
      >
        Your sessions (this kit)
      </SectionHeading>
      {sessions.ok && (
        <SummaryStrip
          items={totalsItems(sessions.totals)}
          label="Totals of your sessions"
        />
      )}
      <Tabs
        label="Session tables"
        initial={initial}
        tabs={[
          {
            id: "yours",
            label: "Your sessions",
            panel: <Sessions result={sessions} q={q} />,
          },
          {
            id: "all",
            label: "All sessions",
            panel: (
              <>
                <p className="muted table-note">
                  Every session that started in the period, whoever started it
                  (your QR stickers, RFID cards, roaming, staff), newest first,
                  from Ivora. Card numbers are masked by Ivora. Money is in Your
                  sessions and Bills.
                </p>
                <IvoraSessions result={ivoraSessions} q={q} cursors={cursors} />
              </>
            ),
          },
          {
            id: "bills",
            label: "Bills",
            panel: (
              <>
                <p className="muted table-note">
                  Ivora&apos;s bills by when they were created, newest first. A
                  final bill&apos;s total is what the driver owes; what was
                  collected, after refunds, is in Your sessions. Reading bills
                  needs the API key&apos;s billing:read permission.
                </p>
                <IvoraBills result={ivoraBills} q={q} cursors={cursors} />
              </>
            ),
          },
        ]}
      />
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
    <section className="card report-payouts" aria-labelledby="payouts-heading">
      <SectionHeading
        id="payouts-heading"
        label="payouts"
        info={
          <p>
            Drivers pay through Ivora Checkout into your own Stripe account, and
            Stripe pays out to your bank, after Stripe&apos;s and Ivora&apos;s
            fees. The kit holds no Stripe keys and does not read payouts: see
            them in your Stripe dashboard (Stripe asks you to sign in; with
            several Stripe accounts, pick the one connected in Onboarding).
          </p>
        }
      >
        Payouts
      </SectionHeading>
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
