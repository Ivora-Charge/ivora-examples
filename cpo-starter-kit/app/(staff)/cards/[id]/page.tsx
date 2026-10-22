import Link from "next/link";
import { notFound } from "next/navigation";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { config } from "@/lib/server/env";
import {
  CARD_SESSIONS,
  FleetError,
  getFleet,
  lastValidDay,
  loadCard,
  newRequestId,
  type CardDetail,
} from "@/lib/server/fleet";
import { describeError, IvoraError } from "@/lib/server/ivora";
import { localDate } from "@/lib/server/pricing/time";
import { shortInZone } from "@/lib/server/reports/time";
import { ExpiryForm, HolderForm, StatusActions } from "../forms";
import {
  holderText,
  kwh,
  PERIOD_LABELS,
  PeriodSelect,
  StatePill,
} from "../shared";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Card" };

function When({ iso, zone }: { iso: string | null; zone: string }) {
  if (!iso) return <span className="muted">–</span>;
  return <>{shortInZone(Date.parse(iso), zone)}</>;
}

function Sessions({ v }: { v: CardDetail }) {
  if (v.usageError)
    return (
      <p className="error" role="alert">
        {v.usageError}
      </p>
    );
  if (!v.sessions.length)
    return <p className="muted">No sessions with this card in this period.</p>;
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data-table" aria-label="Sessions with this card">
        <caption className="muted">
          Newest first, times in {v.zone}
          {v.sessions.length >= CARD_SESSIONS
            ? `; the latest ${CARD_SESSIONS}`
            : ""}
          .
        </caption>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Ended</th>
            <th scope="col">Charger</th>
            <th scope="col" className="num">
              Energy
            </th>
          </tr>
        </thead>
        <tbody>
          {v.sessions.map((s) => (
            <tr key={s.transactionId}>
              <td>
                <When iso={s.startedAt} zone={v.zone} />
              </td>
              <td>
                {s.active ? (
                  <span className="pill ok">Charging</span>
                ) : (
                  <When iso={s.endedAt} zone={v.zone} />
                )}
              </td>
              <td>
                {s.stationName ?? `Charger ${s.stationId}`}
                {s.connectorNumber ? `, connector ${s.connectorNumber}` : ""}
              </td>
              <td className="num">
                {s.energyWh === null ? "–" : kwh(s.energyWh)}
                {s.active ? " so far" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function Content({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  if (!config.fleetModule) notFound();
  const me = await requireRole("viewer");
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) notFound();
  const days = (await searchParams).days;

  let v: CardDetail;
  try {
    v = await loadCard(
      getFleet(),
      me,
      Number(id),
      typeof days === "string" ? days : null,
    );
  } catch (e) {
    if (e instanceof FleetError && e.code === "not_found") notFound();
    if (!(e instanceof IvoraError)) throw e;
    return (
      <>
        <h1>Card</h1>
        <p>
          <Link href="/cards">← Cards</Link>
        </p>
        <p className="error" role="alert">
          {describeError(e)}
        </p>
      </>
    );
  }
  const c = v.card;
  const manager = atLeast(me.role, "manager");
  const shared = v.sharedWith.length + v.sharedOther;

  return (
    <>
      <h1>
        Card <span className="mono">{c.masked}</span>
      </h1>
      <p>
        <Link href="/cards">← Cards</Link>
      </p>

      <section className="card" aria-labelledby="card-heading">
        <h2 id="card-heading">
          {holderText(c)}
          {v.demo && <span className="badge">Sample</span>}
        </h2>
        <dl className="facts">
          <div>
            <dt>Status</dt>
            <dd>
              <StatePill card={c} zone={v.zone} />
            </dd>
          </div>
          <div>
            <dt>Valid until</dt>
            <dd>
              {c.expiresAt
                ? `End of ${lastValidDay(c.expiresAt, v.zone)} (${v.zone})`
                : "No expiry date"}
            </dd>
          </div>
          <div>
            <dt>Card</dt>
            <dd>
              Ends in <span className="mono">{c.key}</span>; the full value
              stays in Ivora.
            </dd>
          </div>
        </dl>
        {!c.ocpp16 && (
          <p className="notice" role="note">
            This value is longer than 20 characters: OCPP 1.6 chargers
            can&apos;t read it (OCPP 2.0.1 chargers can).
          </p>
        )}
        {c.state !== "active" && (
          <p className="muted">
            Ivora refuses this card when it is tapped. A session that was
            already running when it was blocked or expired may go on until it
            ends.
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="usage-heading">
        <h2 id="usage-heading">Sessions and energy</h2>
        <form
          className="form inline report-filters"
          method="get"
          action={`/cards/${c.id}`}
        >
          <PeriodSelect days={v.days} id="card-days" />
          <button type="submit" className="button">
            Show
          </button>
        </form>
        {c.short ? (
          <p className="notice" role="note">
            This card&apos;s value has 4 characters or fewer. Ivora hides all of
            it in a session&apos;s details, so the kit can&apos;t find its
            sessions and shows no figures for it.
          </p>
        ) : shared > 0 ? (
          <p className="notice" role="note">
            {shared === 1 ? "Another token" : `${shared} other tokens`} in your
            list {shared === 1 ? "ends" : "end"} in the same 4 characters
            {v.sharedWith.length
              ? ` (${v.sharedWith.map((x) => holderText(x)).join(", ")})`
              : ""}
            . Ivora shows only the last 4 characters of a session&apos;s card,
            so the sessions below may be theirs: the kit gives no total for this
            card.
          </p>
        ) : (
          v.usage && (
            <section
              className="stats"
              aria-label={`Figures: ${PERIOD_LABELS[v.days].toLowerCase()}`}
            >
              <div className="stat">
                <span className="stat-value">
                  {v.usage.sessions.toLocaleString("en-US")}
                </span>
                <span className="stat-label">
                  Sessions
                  {v.usage.running ? ` (${v.usage.running} charging)` : ""}
                </span>
              </div>
              <div className="stat">
                <span className="stat-value">{kwh(v.usage.energyWh)}</span>
                <span className="stat-label">Energy</span>
              </div>
            </section>
          )
        )}
        <Sessions v={v} />
      </section>

      {manager ? (
        <>
          <section className="card" aria-labelledby="status-heading">
            <h2 id="status-heading">Block or expire</h2>
            <p className="muted">
              Ivora checks a card at every tap, so a change applies from the
              next one. A charger that keeps its own list of cards, or answers
              taps itself while it is offline, may still accept it until it asks
              Ivora again.
            </p>
            <StatusActions
              id={c.id}
              revision={c.revision}
              requestId={newRequestId()}
              state={c.state}
            />
          </section>
          <section className="card" aria-labelledby="expiry-heading">
            <h2 id="expiry-heading">Expiry date</h2>
            <ExpiryForm
              id={c.id}
              revision={c.revision}
              requestId={newRequestId()}
              validUntil={
                c.expiresAt ? lastValidDay(c.expiresAt, v.zone) : null
              }
              today={localDate(v.zone)}
              zone={v.zone}
            />
          </section>
          <section className="card" aria-labelledby="holder-heading">
            <h2 id="holder-heading">Change holder</h2>
            <HolderForm
              id={c.id}
              revision={c.revision}
              requestId={newRequestId()}
              kind={c.holder.kind}
              name={c.holder.name}
            />
          </section>
        </>
      ) : (
        <p className="muted">
          Owners and managers change cards: they decide who can charge.
        </p>
      )}
    </>
  );
}

/** Answers 404 first, then the page behind its loading skeleton. */
export default async function Page(props: Parameters<typeof Content>[0]) {
  if (!config.fleetModule) notFound();
  if (!/^\d{1,15}$/.test((await props.params).id)) notFound();
  return (
    <Loading shape="detail">
      <Content {...props} />
    </Loading>
  );
}
