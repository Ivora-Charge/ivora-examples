import Link from "next/link";
import { notFound } from "next/navigation";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { config } from "@/lib/server/env";
import {
  getFleet,
  loadCards,
  newRequestId,
  refreshCardSessions,
  STATE_FILTERS,
  type CardsView,
} from "@/lib/server/fleet";
import { describeError, IvoraError } from "@/lib/server/ivora";
import { DEMO_MAX_CARDS } from "@/lib/server/ivora/demo-cards";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { resetDemoCardsAction } from "./actions";
import { AddCardForm, ImportCardsForm } from "./forms";
import {
  FLEET_DEPOT_URL,
  holderText,
  kwh,
  PERIOD_LABELS,
  PeriodSelect,
  StatePill,
} from "./shared";

export const metadata = { title: "Cards" };

/** A page load catches the card ledger up for at most this long (live mode). */
const REFRESH_MS = 4_000;

const STATE_LABELS: Record<(typeof STATE_FILTERS)[number], string> = {
  all: "All cards",
  active: "Active",
  blocked: "Blocked",
  expired: "Expired",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function Heading() {
  return (
    <h1>
      Cards <span className="badge">Optional module</span>
    </h1>
  );
}

function Intro() {
  return (
    <p>
      RFID cards your drivers and vehicles tap to charge. They live in your
      Ivora project&apos;s token list and work at every one of your chargers,
      private ones included, with no payment. Smart charging and a site power
      cap are not part of this kit: see{" "}
      <a href={FLEET_DEPOT_URL}>the fleet-depot template</a>.
    </p>
  );
}

function PrivateChargers({ v }: { v: CardsView }) {
  return (
    <section className="card" aria-labelledby="private-heading">
      <h2 id="private-heading">Private chargers</h2>
      {v.privateChargers.length ? (
        <>
          <p>
            These have no QR checkout: your cards (and staff, from Live) start
            them.
          </p>
          <ul className="rows" aria-label="Private chargers">
            {v.privateChargers.map((s) => (
              <li key={s.id}>
                <span className="name">{s.name}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">
          No private chargers. In <Link href="/pricing">Pricing</Link>, mark a
          charger private so it has no QR checkout and only your cards (and
          staff) start it.
        </p>
      )}
      <p className="hint muted">
        Ivora authorizes a card at every charger of your project: it can&apos;t
        limit a card to some chargers. &quot;Private&quot; turns off the
        kit&apos;s QR checkout; see the README for what else can start a
        charger.
      </p>
    </section>
  );
}

function Filters({
  v,
  state,
  search,
}: {
  v: CardsView;
  state: string;
  search: string;
}) {
  return (
    <form className="form inline report-filters" method="get" action="/cards">
      <PeriodSelect days={v.days} id="cards-days" />
      <div className="field">
        <label htmlFor="cards-state">Status</label>
        <select id="cards-state" name="state" defaultValue={state}>
          {STATE_FILTERS.map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="cards-search">Name or last characters</label>
        <input
          id="cards-search"
          name="q"
          type="search"
          defaultValue={search}
          maxLength={80}
          autoComplete="off"
        />
      </div>
      <button type="submit" className="button">
        Show cards
      </button>
    </form>
  );
}

function CardsTable({ v }: { v: CardsView }) {
  if (!v.cards.length)
    return (
      <p className="muted">
        {v.total
          ? "No card matches these filters."
          : "No cards yet. Add one below, or import a file."}
      </p>
    );
  const shared = v.cards.some((c) => c.usage === null);
  return (
    <>
      <div className="table-scroll" tabIndex={0}>
        <table className="data-table" aria-label="Cards">
          <caption className="muted">
            Sessions and energy: {PERIOD_LABELS[v.days].toLowerCase()}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Card</th>
              <th scope="col">Holder</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Sessions
              </th>
              <th scope="col" className="num">
                Energy
              </th>
            </tr>
          </thead>
          <tbody>
            {v.cards.map((c) => (
              <tr key={c.id}>
                <td className="mono">
                  <Link href={`/cards/${c.id}`}>{c.masked}</Link>
                </td>
                <td>{holderText(c)}</td>
                <td>
                  <StatePill card={c} zone={v.zone} />
                </td>
                {c.usage ? (
                  <>
                    <td className="num">
                      {c.usage.sessions.toLocaleString("en-US")}
                      {c.usage.running ? ` (${c.usage.running} charging)` : ""}
                    </td>
                    <td className="num">{kwh(c.usage.energyWh)}</td>
                  </>
                ) : (
                  <td colSpan={2}>Can&apos;t tell apart*</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shared && (
        <p className="hint muted">
          * Ivora shows only the last 4 characters of a session&apos;s card, and
          another token in your list ends in the same 4, so the kit shows no
          figures for these cards rather than guess.
        </p>
      )}
    </>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!config.fleetModule) notFound();
  const me = await requireRole("viewer");
  const raw = await searchParams;
  const get = (k: string) => {
    const v = raw[k];
    return typeof v === "string" ? v : null;
  };
  const d = getFleet();
  // Catch the card ledger up (the settlement sweep does it every minute too).
  try {
    await refreshCardSessions(d, {
      deadline: Date.now() + REFRESH_MS,
      maxStations: 2,
      maxRechecks: 5,
    });
  } catch (e) {
    console.error("cpo-starter-kit: card refresh failed:", {
      error: e instanceof Error ? e.name : "error",
    });
  }

  let v: CardsView;
  try {
    v = await loadCards(d, me, {
      days: get("days"),
      state: get("state"),
      search: get("q"),
    });
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    return (
      <>
        <Heading />
        <Intro />
        <section className="card" aria-labelledby="cards-error-heading">
          <h2 id="cards-error-heading">Could not read your cards</h2>
          <p className="error" role="alert">
            {describeError(e)}
          </p>
          <p className="muted">
            The API key needs <code>tokens:read</code> to list cards and{" "}
            <code>tokens:write</code> to change them (only a project admin can
            grant it).
          </p>
        </section>
      </>
    );
  }
  const manager = atLeast(me.role, "manager");
  const state = get("state") ?? "all";

  return (
    <>
      <Heading />
      <Intro />
      <PrivateChargers v={v} />

      <section className="card" aria-labelledby="cards-heading">
        <h2 id="cards-heading">
          Your cards
          {v.demo && <span className="badge">Sample</span>}
        </h2>
        <Filters v={v} state={state} search={get("q") ?? ""} />
        {v.usageError && (
          <p className="error" role="alert">
            {v.usageError}
          </p>
        )}
        {v.truncated && (
          <p className="notice" role="note">
            Showing the first {(MAX_LIST_PAGES * 100).toLocaleString("en-US")}{" "}
            tokens of your Ivora token list.
          </p>
        )}
        <CardsTable v={v} />
        <p className="hint muted">
          A card&apos;s sessions are those Ivora reports with its last 4
          characters, on any of your chargers, since the module was turned on
          (the kit copies them as they end). Sessions drivers paid for through
          your QR stickers are not counted.
        </p>
      </section>

      {manager ? (
        <>
          <section className="card" aria-labelledby="add-heading">
            <h2 id="add-heading">Add a card</h2>
            <AddCardForm requestId={newRequestId()} />
          </section>
          <section className="card" aria-labelledby="import-heading">
            <h2 id="import-heading">Import cards (CSV)</h2>
            <ImportCardsForm />
          </section>
        </>
      ) : (
        <p className="muted">
          Owners and managers add, import, block and expire cards: they decide
          who can charge.
        </p>
      )}

      {v.demo && manager && (
        <form action={resetDemoCardsAction} className="demo-sim">
          <p className="hint muted">
            Demo: your cards and changes stay in this browser (up to{" "}
            {DEMO_MAX_CARDS} cards of your own). Nothing is sent to Ivora.
          </p>
          <button type="submit" className="button secondary">
            Demo: reset cards
          </button>
        </form>
      )}
    </>
  );
}
