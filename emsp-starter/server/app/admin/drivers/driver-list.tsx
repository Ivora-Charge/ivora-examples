"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useAdmin } from "../ui/admin-context";
import { Head, Icon, Result, Tile, utc } from "../ui/kit";
import { ActionForm, Gated } from "../ui/parts";
import { fields, useAction, useList } from "../ui/use-action";
import {
  listDriversAction,
  type DriverRow,
  type DriversState,
} from "./actions";
import { AccountState, AppToken, lastSignIn, problemCount } from "./facts";
import { driverHref } from "./reference";

type Filters = { email: string; reference: string };
const NONE: Filters = { email: "", reference: "" };

function Row({ d, capped }: { d: DriverRow; capped?: boolean }) {
  return (
    <tr>
      <th scope="row" className="c-main">
        <Link href={driverHref(d.id)}>
          {d.email ?? <span className="mono">{d.id}</span>}
        </Link>
        {d.email && <span className="sub mono">{d.id}</span>}
      </th>
      <td className="c-kv" data-l="Joined">
        {utc(d.createdAt)}
      </td>
      <td className="c-kv" data-l="Last sign-in">
        {lastSignIn(d.lastSignInAt)}
      </td>
      <td className="c-kv" data-l="App token">
        <AppToken state={d.appToken} />
      </td>
      <td className="c-kv" data-l="Card on file">
        {d.hasCard ? "yes" : "no"}
      </td>
      <td className="c-kv num" data-l="Open problems">
        {problemCount(d.openProblems, capped)}
      </td>
      <td className="c-state">
        <AccountState status={d.status} />
      </td>
    </tr>
  );
}

function Counts({ c }: { c: NonNullable<DriversState["counts"]> }) {
  const facts: [string, number | string][] = [
    ["Accounts", c.total],
    ["Blocked", c.blocked],
    ["With a card", c.withCard],
    [
      "Signed in, last 30 days",
      c.signedInSince ?? "not recorded (a migration is pending)",
    ],
  ];
  return (
    <dl className="facts" aria-label="Counts">
      {facts.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DriverList({
  sampleDriver,
}: {
  /** Demo mode: the sample driver's reference. */
  sampleDriver: string | null;
}) {
  const { admin } = useAdmin();
  // The server decides; this only leaves out a field it would refuse.
  const byEmail = admin?.role === "admin";
  const id = useId();
  // Kept in the page, never in its address: an email must not reach a URL or a log.
  const [filters, setFilters] = useState<Filters>(NONE);
  // Bumped by "Clear search": remounts the fields so none keeps its old text.
  const [cleared, setCleared] = useState(0);
  const list = useList(listDriversAction, filters);
  const older = useAction(listDriversAction);
  const [more, setMore] = useState<DriverRow[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const state: DriversState = list.state;
  // The list the older pages belong to: a page that answers after another search is
  // dropped.
  const shown = useRef(state);
  useEffect(() => {
    shown.current = state;
    setMore([]);
    setNext(state.next);
    older.reset();
  }, [state, older.reset]);

  const seen = new Set<string>();
  const rows = [...(state.drivers ?? []), ...more].filter((d) =>
    seen.has(d.id) ? false : (seen.add(d.id), true),
  );
  const searched = Boolean(filters.email || filters.reference);
  const counts = state.counts;

  const showOlder = async () => {
    if (!next || older.pending) return;
    const of = state;
    const r = await older.run(fields({ ...filters, older: next }));
    if (shown.current === of && r.ok && r.drivers) {
      setMore((m) => [...m, ...r.drivers!]);
      setNext(r.next);
    }
  };

  return (
    <>
      <Head
        crumbs={["Drivers"]}
        title="Drivers"
        lead="Everyone who has signed in, newest first. Open a driver to block them, change their tokens and see their sessions and payments."
      />
      <Gated what="see drivers">
        <div className="stack">
          {sampleDriver && (
            <p className="muted">
              Demo mode: accounts are kept in memory. The sample driver is{" "}
              <Link href={driverHref(sampleDriver)}>
                <code>{sampleDriver}</code>
              </Link>
              .
            </p>
          )}
          {counts && state.ok && (
            <section className="card" aria-label="Driver counts">
              <Counts c={counts} />
            </section>
          )}

          {/* method="post": sent before the page is ready, nothing goes in the URL. */}
          <ActionForm
            className="card form"
            method="post"
            aria-label="Search drivers"
            onSend={async (form) => {
              const to = {
                email: String(form.get("email") ?? "").trim(),
                reference: String(form.get("reference") ?? "").trim(),
              };
              // The same search again reads again.
              if (JSON.stringify(to) === JSON.stringify(filters))
                await list.reload();
              else setFilters(to);
            }}
          >
            <div className="fields" key={cleared}>
              {byEmail && (
                <div className="field">
                  <label htmlFor={`${id}-email`}>Email contains</label>
                  <input
                    id={`${id}-email`}
                    name="email"
                    type="search"
                    maxLength={254}
                    autoComplete="off"
                    aria-describedby={`${id}-email-h`}
                  />
                  <span className="hint" id={`${id}-email-h`}>
                    Any part of the address, in any letter case. Each search is
                    written to the audit log, without what you searched for.
                  </span>
                </div>
              )}
              <div className="field">
                <label htmlFor={`${id}-ref`}>Driver reference</label>
                <input
                  id={`${id}-ref`}
                  name="reference"
                  maxLength={64}
                  autoComplete="off"
                  aria-describedby={`${id}-ref-h`}
                />
                <span className="hint" id={`${id}-ref-h`}>
                  The whole reference, exactly, as Sessions and Payments show
                  it.
                </span>
              </div>
            </div>
            {!byEmail && (
              <p className="small muted">
                Emails are shown and searched only for an admin signed in by
                email, not with the admin secret.
              </p>
            )}
            <div className="row">
              <button className="btn" type="submit">
                Search
              </button>
              {searched && (
                <button
                  className="btn ghost"
                  type="reset"
                  onClick={() => {
                    setFilters(NONE);
                    setCleared((n) => n + 1);
                  }}
                >
                  Clear search
                </button>
              )}
            </div>
          </ActionForm>

          {(list.loading || list.pending) && (
            <p className="muted" role="status">
              Loading…
            </p>
          )}
          {list.done && !state.ok && <Result state={state} />}
          {state.ok && rows.length === 0 && (
            <div className="card flat stack">
              <div className="row">
                <Tile kind="off" big="0" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2>
                    {state.filtered ? "No account matches" : "No drivers yet"}
                  </h2>
                  <p className="muted" role="status">
                    {state.filtered
                      ? state.message
                      : "A driver appears here at their first sign-in in the app."}
                  </p>
                </div>
              </div>
              {state.reference && (
                <p>
                  Tokens, sessions and payments may still carry this reference:{" "}
                  <Link href={driverHref(state.reference)}>
                    open the page of <code>{state.reference}</code>
                  </Link>
                  .
                </p>
              )}
            </div>
          )}
          {state.ok && rows.length > 0 && (
            <div className="card tablecard scroll" aria-busy={list.pending}>
              <table className="data wide">
                <caption className="sr">Drivers, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Driver</th>
                    <th scope="col">Joined</th>
                    <th scope="col">Last sign-in</th>
                    <th scope="col">App token</th>
                    <th scope="col">Card on file</th>
                    <th scope="col" className="num">
                      Open problems
                    </th>
                    <th scope="col">Account</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <Row key={d.id} d={d} capped={state.problemsCapped} />
                  ))}
                </tbody>
              </table>
              <div className="foot">
                <span role="status">
                  {rows.length} of{" "}
                  {Math.max(counts?.matching ?? 0, rows.length)} shown, newest
                  first
                  {state.filtered
                    ? `; ${counts?.matching} of ${counts?.total} account(s) match`
                    : ""}
                  . Times in UTC.
                </span>
                {next && (
                  <button
                    className="btn ghost sm"
                    type="button"
                    aria-disabled={older.pending}
                    onClick={showOlder}
                  >
                    Show older <Icon name="arrow" />
                  </button>
                )}
              </div>
              {older.done && older.state.ok === false && (
                <Result state={older.state} />
              )}
            </div>
          )}
        </div>
      </Gated>
    </>
  );
}
