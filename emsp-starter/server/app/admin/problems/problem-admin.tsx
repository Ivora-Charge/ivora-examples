"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Result, State, Tile, utc } from "../ui/kit";
import { ActionForm } from "../ui/parts";
import { fields, useAction, useList } from "../ui/use-action";
import {
  listProblemsAction,
  resolveProblemAction,
  showProblemAction,
  type ProblemRow,
  type ProblemsState,
} from "./actions";

const CATEGORY_TEXT: Record<ProblemRow["category"], string> = {
  not_starting: "Won't start",
  stopped_early: "Stopped early",
  damaged: "Damaged",
  blocked: "Blocked bay",
  payment: "Payment",
  other: "Other",
};

const FILTERS = [
  ["open", "Open"],
  ["resolved", "Resolved"],
  ["all", "All"],
] as const;
type Filter = (typeof FILTERS)[number][0];

function ReportDetail({
  report,
}: {
  report: NonNullable<ProblemsState["report"]>;
}) {
  return (
    <div className="stack tight">
      <dl className="facts small">
        <dt>Reported</dt>
        <dd>{utc(report.createdAt)}</dd>
        <dt>What</dt>
        <dd>{CATEGORY_TEXT[report.category]}</dd>
        <dt>Message</dt>
        <dd>{report.message}</dd>
        <dt>Location</dt>
        <dd>
          {report.locationName && <>{report.locationName} </>}
          <code>{report.location}</code>
          {report.peerId && (
            <>
              {" "}
              at peer <code>{report.peerId}</code>
            </>
          )}
        </dd>
        <dt>EVSE</dt>
        <dd>{report.evseUid ? <code>{report.evseUid}</code> : "-"}</dd>
        <dt>Driver</dt>
        <dd>
          <code>{report.driverRef}</code>
        </dd>
        <dt>Status</dt>
        <dd>
          {report.status}
          {report.resolvedAt &&
            ` (${report.resolvedBy}, ${utc(report.resolvedAt)})`}
        </dd>
        <dt>Report ID</dt>
        <dd>
          <code>{report.id}</code>
        </dd>
      </dl>
      {report.photo ? (
        // A data URL the server checked to be a JPEG or PNG; never a remote image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={report.photo}
          alt="The driver's photo of the problem"
          className="report-photo"
        />
      ) : (
        <p className="small muted">The driver sent no photo.</p>
      )}
    </div>
  );
}

/** One report: a row of the table, with its own actions, and its detail when opened. */
function ReportRow({
  r,
  onResolve,
}: {
  r: ProblemRow;
  onResolve: (id: string) => Promise<unknown>;
}) {
  const show = useAction(showProblemAction);
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const what = CATEGORY_TEXT[r.category];
  const where = r.locationName ?? r.location;
  return (
    <>
      <tr>
        <th scope="row" className="c-main">
          {what}
          <span className="sub">{r.message}</span>
          <span className="sub">
            {r.locationName && <>{r.locationName} </>}
            <span className="mono">{r.location}</span>
            {r.evseUid && (
              <>
                {" "}
                / <span className="mono">{r.evseUid}</span>
              </>
            )}
          </span>
        </th>
        <td className="c-kv" data-l="Driver">
          <span className="mono">{r.driverRef}</span>
        </td>
        <td className="c-kv" data-l="Reported">
          {utc(r.createdAt)}
        </td>
        <td className="c-kv" data-l="Photo">
          {r.hasPhoto ? "Yes" : "No"}
        </td>
        <td className="c-state">
          {r.status === "open" ? (
            <State kind="todo">Open</State>
          ) : (
            <State kind="done">Resolved</State>
          )}
          {r.resolvedBy && <span className="sub">{r.resolvedBy}</span>}
        </td>
        <td className="c-wide">
          <span className="row" aria-busy={show.pending || resolving}>
            <button
              type="button"
              className="btn ghost sm"
              aria-expanded={open}
              onClick={() => {
                if (open) return setOpen(false);
                setOpen(true);
                void show.run(fields({ reportId: r.id }));
              }}
            >
              {open ? "Hide report" : "Show report"}
              <span className="sr">
                : {what}, {where}
              </span>
            </button>
            {r.status === "open" && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={async () => {
                  if (resolving) return;
                  setResolving(true);
                  try {
                    await onResolve(r.id);
                  } finally {
                    setResolving(false);
                  }
                }}
              >
                Mark resolved
                <span className="sr">
                  : {what}, {where}
                </span>
              </button>
            )}
          </span>
        </td>
      </tr>
      {open && (
        <tr>
          <td className="c-wide" colSpan={6}>
            {show.pending && !show.state.report ? (
              <p className="muted" role="status">
                Loading…
              </p>
            ) : show.state.report ? (
              <ReportDetail report={show.state.report} />
            ) : (
              <Result state={show.state} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * A report by its ID, whether or not it is among the listed rows (the list shows the
 * newest 100): show it and, while it is open, mark it resolved.
 */
export function FindReport({
  onResolved,
}: {
  onResolved: () => Promise<unknown>;
}) {
  const id = useId();
  const show = useAction(showProblemAction);
  const resolve = useAction(resolveProblemAction);
  const [resolving, setResolving] = useState(false);
  const report = show.state.report;
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="h3">
        Find a report by its ID
      </h2>
      <ActionForm
        aria-label="Find a report by its ID"
        onSend={(form) => show.run(form)}
      >
        <div className="field">
          <label htmlFor={`${id}-id`}>Report ID</label>
          <input
            id={`${id}-id`}
            name="reportId"
            required
            maxLength={36}
            autoComplete="off"
            aria-describedby={`${id}-hint`}
          />
          <span className="hint" id={`${id}-hint`}>
            For a report that is not in the rows above: the list shows the
            newest 100.
          </span>
        </div>
        <div>
          <button className="btn ghost sm" type="submit">
            Find report
          </button>
        </div>
      </ActionForm>
      <Result state={resolve.state} />
      {report ? (
        <>
          <ReportDetail report={report} />
          {report.status === "open" && (
            <div aria-busy={resolving}>
              <button
                type="button"
                className="btn ghost sm"
                onClick={async () => {
                  if (resolving) return;
                  setResolving(true);
                  try {
                    await resolve.run(fields({ reportId: report.id }));
                    await show.run(fields({ reportId: report.id }));
                    await onResolved();
                  } finally {
                    setResolving(false);
                  }
                }}
              >
                Mark resolved
                <span className="sr">: report {report.id}</span>
              </button>
            </div>
          )}
        </>
      ) : (
        <Result state={show.state} />
      )}
    </section>
  );
}

export function ProblemAdmin({ demo }: { demo: boolean }) {
  const [status, setStatus] = useState<Filter>("open");
  const list = useList(listProblemsAction, { status });
  const resolve = useAction(resolveProblemAction);
  const reports = list.state.reports ?? [];
  return (
    <div className="stack">
      <div className="chips" role="group" aria-label="Show">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            className="chip"
            type="button"
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <Result state={resolve.state} />

      {list.loading ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : list.state.ok === false ? (
        <Result state={list.state} />
      ) : reports.length === 0 ? (
        <div className="card flat stack">
          <div className="row">
            <Tile kind="off" big="0" small="reports" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2>
                {status === "open"
                  ? "No open reports"
                  : status === "resolved"
                    ? "No resolved reports"
                    : "No reports yet"}
              </h2>
              <p className="muted">
                A report appears here the moment a driver sends one from the
                app.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="card tablecard" aria-busy={list.pending}>
          <table className="data">
            <caption className="sr">Problem reports, newest first</caption>
            <thead>
              <tr>
                <th scope="col">What and where</th>
                <th scope="col">Driver</th>
                <th scope="col">Reported</th>
                <th scope="col">Photo</th>
                <th scope="col">State</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <ReportRow
                  key={r.id}
                  r={r}
                  onResolve={async (id) => {
                    await resolve.run(fields({ reportId: id }));
                    await list.reload();
                  }}
                />
              ))}
            </tbody>
          </table>
          <div className="foot">
            <span>{list.state.message}</span>
          </div>
        </div>
      )}

      <FindReport onResolved={list.reload} />

      <div className="msg" role="note">
        <p>
          Pass charger faults on to the CPO. Look up payments on{" "}
          <Link href="/admin/payments">Payments</Link> and the driver on{" "}
          <Link href="/admin/tokens">Drivers and tokens</Link>. Marking a report
          resolved records who did it, in the report and the audit log.
        </p>
        {demo && (
          <p>
            Demo mode: reports are kept in memory only, until the server
            restarts.
          </p>
        )}
      </div>
    </div>
  );
}
