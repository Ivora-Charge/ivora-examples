"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { listPeersAction } from "../peers/actions";
import { useAdmin } from "../ui/admin-context";
import { Head, Icon, Result, State, Tile, utc } from "../ui/kit";
import { ActionForm, Gated } from "../ui/parts";
import { fields, useAction, useList } from "../ui/use-action";
import {
  listSessionsAction,
  type SessionRow,
  type SessionsState,
} from "./actions";
import type { STATUS_FILTERS } from "./filters";
import { filterCount } from "@/lib/sessions/statuses";

type Status = (typeof STATUS_FILTERS)[number];

/** The filters as chips, in the reader's words; the list's counts go beside them. */
const CHIPS: [Status, string][] = [
  ["all", "All"],
  ["live", "Live"],
  ["ACTIVE", "Charging now"],
  ["PENDING", "Starting"],
  ["RESERVATION", "Reserved"],
  ["INVALID", "Needs a look"],
  ["COMPLETED", "Finished"],
];

/** Each status as a mark and a word, also on a driver's page. */
export const SESSION_STATE: Record<
  string,
  ["ok" | "todo" | "bad" | "done" | "off", string]
> = {
  ACTIVE: ["ok", "Charging"],
  PENDING: ["todo", "Starting"],
  RESERVATION: ["todo", "Reserved"],
  COMPLETED: ["done", "Finished"],
  INVALID: ["bad", "Needs a look"],
};

/** A UTC time that breaks only between its day and its time. */
function When({ iso }: { iso: string }) {
  const [day, ...time] = utc(iso).split(" ");
  return (
    <>
      <span className="nw">{day}</span>{" "}
      <span className="nw">{time.join(" ")}</span>
    </>
  );
}

function Row({ s }: { s: SessionRow }) {
  const [kind, word] = SESSION_STATE[s.status] ?? ["off", s.status];
  // "12.50 EUR excl. VAT, 15.00 incl.", as the CPO gave it: one amount per line.
  const [cost, inclVat] = s.cost ? s.cost.split(/, (?=[^,]*$)/) : [null];
  return (
    <tr>
      <th scope="row" className="c-main">
        {s.location}
        <span className="sub mono">{s.ref}</span>
      </th>
      <td className="c-kv" data-l="Peer">
        {s.peer}
      </td>
      <td className="c-kv" data-l="Driver">
        {s.driverRef ? (
          <span className="mono">{s.driverRef}</span>
        ) : (
          <span className="muted">not our token</span>
        )}
      </td>
      <td className="c-kv" data-l="Started">
        <span>
          <When iso={s.start} />
          {s.end && (
            <span className="sub">
              ended <When iso={s.end} />
            </span>
          )}
        </span>
      </td>
      <td className="c-kv num" data-l="Energy">
        {s.kwh} kWh
      </td>
      <td className="c-big num">
        {cost ?? <span className="muted">not yet</span>}
        {inclVat && <span className="sub">{inclVat}</span>}
        {s.commandId && (
          <span className="sub">
            charge <span className="mono">{s.commandId}</span>
          </span>
        )}
      </td>
      <td className="c-state">
        <State kind={kind}>{word}</State>
        {s.stopReason && <span className="sub">stopped: {s.stopReason}</span>}
      </td>
    </tr>
  );
}

type Filters = {
  status: Status;
  peerId: string;
  driverRef: string;
  search: string;
  before: string;
};
const NONE: Filters = {
  status: "all",
  peerId: "",
  driverRef: "",
  search: "",
  before: "",
};

/** The number beside a chip, from the list's counts: "500+" when a search capped it. */
function chipCount(value: Status, c: SessionsState["counts"]): string | null {
  if (!c) return null;
  const { n, more } = filterCount(value, c);
  return `${n}${more ? "+" : ""}`;
}

export function Sessions({
  prefill,
}: {
  /** Filters named in the page's address, applied from the start. */
  prefill?: Pick<Filters, "driverRef" | "search">;
}) {
  const { signedIn, demo } = useAdmin();
  const id = useId();
  const [filters, setFilters] = useState<Filters>({ ...NONE, ...prefill });
  // Bumped by "Clear all filters": remounts the fields so none keeps its old text
  // (a form reset only restores each field's default, which is the last applied value).
  const [cleared, setCleared] = useState(0);
  // The list is the page: it opens by itself and again on every change of a filter.
  const list = useList(listSessionsAction, filters);
  const older = useAction(listSessionsAction);
  const peers = useList(listPeersAction);
  // Pages of older sessions, added under the first one.
  const [more, setMore] = useState<SessionRow[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>();
  const state: SessionsState = list.state;
  useEffect(() => {
    setMore([]);
    setNextBefore(state.nextBefore);
  }, [state]);

  const seen = new Set<string>();
  const rows = [...(state.sessions ?? []), ...more].filter((s) =>
    seen.has(s.id) ? false : (seen.add(s.id), true),
  );
  const filtered =
    filters.status !== "all" ||
    Boolean(
      filters.peerId || filters.driverRef || filters.search || filters.before,
    );

  const showOlder = async () => {
    if (!nextBefore) return;
    const r = await older.run(fields({ ...filters, older: nextBefore }));
    if (r.ok && r.sessions) {
      setMore((m) => [...m, ...r.sessions!]);
      setNextBefore(r.nextBefore);
    }
  };

  return (
    <>
      <Head
        crumbs={["Charging"]}
        title="Sessions"
        lead="Every charge from every peer, newest first, as the CPO last described it. The list opens by itself: there is nothing to press first."
      />
      <Gated what="see sessions">
        <div className="stack">
          {demo && (
            <p className="muted">
              Demo mode: the sessions are the mock CPO&apos;s samples, kept in
              memory.
            </p>
          )}
          <div className="chips" role="group" aria-label="Show">
            {CHIPS.map(([value, label]) => (
              <button
                key={value}
                className="chip"
                type="button"
                aria-pressed={filters.status === value}
                onClick={() => setFilters((f) => ({ ...f, status: value }))}
              >
                {label}
                {chipCount(value, state.counts) !== null && (
                  <span className="muted">
                    {" "}
                    {chipCount(value, state.counts)}
                  </span>
                )}
              </button>
            ))}
          </div>
          {/* Open when the address set a filter, so the admin sees it. */}
          <details
            className="fold"
            open={prefill?.driverRef || prefill?.search ? true : undefined}
          >
            <summary>More filters</summary>
            <ActionForm
              onSend={async (form) =>
                setFilters((f) => ({
                  ...f,
                  peerId: String(form.get("peerId") ?? ""),
                  driverRef: String(form.get("driverRef") ?? "").trim(),
                  search: String(form.get("search") ?? "").trim(),
                  before: String(form.get("before") ?? "").trim(),
                }))
              }
            >
              <div className="fields" key={cleared}>
                <div className="field">
                  <label htmlFor={`${id}-peer`}>Peer</label>
                  <select
                    id={`${id}-peer`}
                    name="peerId"
                    defaultValue={filters.peerId}
                  >
                    <option value="">Every peer</option>
                    {peers.state.peers?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`${id}-search`}>Search</label>
                  <input
                    id={`${id}-search`}
                    name="search"
                    type="search"
                    maxLength={64}
                    autoComplete="off"
                    defaultValue={filters.search}
                    aria-describedby={`${id}-search-h`}
                  />
                  <span className="hint" id={`${id}-search-h`}>
                    Part of a driver reference, session ID, charger or location
                    ID. A _ matches any one character.
                  </span>
                </div>
                <div className="field">
                  <label htmlFor={`${id}-driver`}>Driver reference</label>
                  <input
                    id={`${id}-driver`}
                    name="driverRef"
                    defaultValue={filters.driverRef}
                    maxLength={64}
                    autoComplete="off"
                    aria-describedby={`${id}-driver-h`}
                  />
                  <span className="hint" id={`${id}-driver-h`}>
                    The whole reference, exactly.
                  </span>
                </div>
                <div className="field">
                  <label htmlFor={`${id}-before`}>Started before</label>
                  <input
                    id={`${id}-before`}
                    name="before"
                    defaultValue={filters.before}
                    maxLength={24}
                    autoComplete="off"
                    placeholder="2026-10-01"
                    aria-describedby={`${id}-before-h`}
                  />
                  <span className="hint" id={`${id}-before-h`}>
                    A UTC day (2026-10-01) or timestamp (2026-10-01T06:00:00Z).
                  </span>
                </div>
              </div>
              <div className="row">
                <button className="btn ghost sm" type="submit">
                  Apply filters
                </button>
                {signedIn && filtered && (
                  <button
                    className="btn ghost sm"
                    type="reset"
                    onClick={() => {
                      setFilters(NONE);
                      setCleared((n) => n + 1);
                    }}
                  >
                    Clear all filters
                  </button>
                )}
              </div>
            </ActionForm>
          </details>

          {list.loading && (
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
                  <h2>{filtered ? "No sessions match" : "No sessions yet"}</h2>
                  <p className="muted">
                    {filtered
                      ? "No session fits these filters. Choose All, or clear the other filters."
                      : "A session appears here the moment a driver starts a charge, or a CPO sends one. Sessions older than the first peer are not fetched."}
                  </p>
                </div>
              </div>
              {!filtered && (
                <div>
                  <Link className="btn ghost" href="/admin/peers">
                    See peers
                  </Link>
                </div>
              )}
            </div>
          )}
          {state.ok && rows.length > 0 && (
            <div className="card tablecard" aria-busy={list.pending}>
              <table className="data sessions">
                <caption className="sr">Sessions, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Location and reference</th>
                    <th scope="col">Peer</th>
                    <th scope="col">Driver</th>
                    <th scope="col">Started</th>
                    <th scope="col" className="num">
                      Energy
                    </th>
                    <th scope="col" className="num">
                      Cost (CPO)
                    </th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <Row key={s.id} s={s} />
                  ))}
                </tbody>
              </table>
              <div className="foot">
                <span role="status">
                  {rows.length}
                  {state.listTotal !== undefined &&
                  state.listTotal >= rows.length
                    ? ` of ${state.listTotal}${state.listTotalMore ? "+" : ""}`
                    : ""}{" "}
                  shown, newest first
                  {nextBefore ? "; there are older ones" : ""}. Times in UTC.
                </span>
                {nextBefore && (
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
              {older.done && !older.state.ok && <Result state={older.state} />}
            </div>
          )}
        </div>
      </Gated>
    </>
  );
}
