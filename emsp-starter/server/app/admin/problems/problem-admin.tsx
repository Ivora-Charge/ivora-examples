"use client";

import { TableWrap } from "../table-wrap";
import { ActionCard } from "../action-card";
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

function ProblemTable({ reports }: { reports: ProblemRow[] }) {
  if (!reports.length) return null;
  return (
    <TableWrap label="Problem reports table">
      <table>
        <thead>
          <tr>
            <th scope="col">Reported</th>
            <th scope="col">Status</th>
            <th scope="col">What</th>
            <th scope="col">Message</th>
            <th scope="col">Location / EVSE</th>
            <th scope="col">Driver</th>
            <th scope="col">Photo</th>
            <th scope="col">Report ID</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td>{r.createdAt}</td>
              <td className={r.status === "open" ? "flag" : undefined}>
                {r.status}
                {r.resolvedBy && (
                  <span className="muted"> ({r.resolvedBy})</span>
                )}
              </td>
              <td>{CATEGORY_TEXT[r.category]}</td>
              <td className="wrap">{r.message}</td>
              <td>
                {r.locationName && <>{r.locationName} </>}
                <code>{r.location}</code>
                {r.evseUid && (
                  <>
                    {" "}
                    / <code>{r.evseUid}</code>
                  </>
                )}
              </td>
              <td>
                <code>{r.driverRef}</code>
              </td>
              <td>{r.hasPhoto ? "Yes" : "-"}</td>
              <td>
                <code>{r.id}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function ReportDetail({ report }: { report: ProblemsState["report"] }) {
  if (!report) return null;
  return (
    <>
      <dl className="facts">
        <dt>Reported</dt>
        <dd>{report.createdAt}</dd>
        <dt>What</dt>
        <dd>{CATEGORY_TEXT[report.category]}</dd>
        <dt>Message</dt>
        <dd className="wrap">{report.message}</dd>
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
          {report.resolvedAt && ` (${report.resolvedBy}, ${report.resolvedAt})`}
        </dd>
      </dl>
      {report.photo && (
        // A data URL the server checked to be a JPEG or PNG; never a remote image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={report.photo}
          alt="The driver's photo of the problem"
          className="report-photo"
        />
      )}
    </>
  );
}

export function ProblemAdmin() {
  return (
    <>
      <ActionCard<ProblemsState>
        id="list"
        title="Reported problems"
        action={listProblemsAction}
        submit={<button type="submit">Show reports</button>}
        details={(state) => <ProblemTable reports={state.reports ?? []} />}
      >
        <label>
          Status
          <select name="status" defaultValue="open">
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </label>
      </ActionCard>
      <ActionCard<ProblemsState>
        id="show"
        title="Look up a report"
        action={showProblemAction}
        submit={<button type="submit">Show report</button>}
        details={(state) => <ReportDetail report={state.report} />}
      >
        <label>
          Report ID
          <input name="reportId" maxLength={36} required autoComplete="off" />
        </label>
      </ActionCard>
      <ActionCard<ProblemsState>
        id="resolve"
        title="Mark a report resolved"
        action={resolveProblemAction}
        submit={<button type="submit">Mark resolved</button>}
      >
        <label>
          Report ID
          <input name="reportId" maxLength={36} required autoComplete="off" />
        </label>
      </ActionCard>
    </>
  );
}
