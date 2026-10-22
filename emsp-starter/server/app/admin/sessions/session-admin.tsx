"use client";

import { ActionCard } from "../action-card";
import {
  listSessionsAction,
  type SessionRow,
  type SessionsState,
} from "./actions";
import { STATUS_FILTERS } from "./filters";

const STATUS_TEXT: Record<(typeof STATUS_FILTERS)[number], string> = {
  live: "Live (active, pending or reserved)",
  all: "All",
  ACTIVE: "Active",
  PENDING: "Pending",
  RESERVATION: "Reservation",
  COMPLETED: "Completed",
  INVALID: "Invalid",
};

function SessionTable({ sessions }: { sessions: SessionRow[] }) {
  if (!sessions.length) return null;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Status</th>
            <th scope="col">CPO</th>
            <th scope="col">Session</th>
            <th scope="col" className="num">
              kWh
            </th>
            <th scope="col">Cost (CPO)</th>
            <th scope="col">Location / EVSE / connector</th>
            <th scope="col">Driver</th>
            <th scope="col">Charge ID</th>
            <th scope="col">Ended</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td>{s.start}</td>
              <td className={s.status === "INVALID" ? "flag" : undefined}>
                {s.status}
                {s.stopReason && (
                  <span className="muted"> (stopped: {s.stopReason})</span>
                )}
              </td>
              <td>{s.peer}</td>
              <td>
                <code>{s.ref}</code>
              </td>
              <td className="num">{s.kwh}</td>
              <td>{s.cost ?? "-"}</td>
              <td>{s.location}</td>
              <td>
                {s.driverRef ?? <span className="muted">not our token</span>}
              </td>
              <td>{s.commandId ? <code>{s.commandId}</code> : "-"}</td>
              <td>{s.end ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SessionAdmin() {
  return (
    <ActionCard<SessionsState>
      id="list"
      title="Live and recent sessions"
      action={listSessionsAction}
      submit={(state) => (
        <>
          <button type="submit">Show sessions</button>
          {state.nextBefore && (
            <button type="submit" name="older" value={state.nextBefore}>
              Show older sessions
            </button>
          )}
        </>
      )}
      details={(state) => <SessionTable sessions={state.sessions ?? []} />}
    >
      {(state) => {
        // The form resets after each list; it keeps the filters of the last one.
        const f = state.filters;
        return (
          <div key={JSON.stringify(f ?? {})} style={{ display: "contents" }}>
            <label>
              Status
              <select name="status" defaultValue={f?.status ?? "live"}>
                {STATUS_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_TEXT[s]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Peer ID (optional)
              <input
                name="peerId"
                maxLength={36}
                autoComplete="off"
                defaultValue={f?.peerId}
              />
            </label>
            <label>
              Driver reference (optional)
              <input
                name="driverRef"
                maxLength={64}
                autoComplete="off"
                defaultValue={f?.driverRef}
              />
            </label>
            <label>
              Started before (optional)
              <input
                name="before"
                maxLength={24}
                autoComplete="off"
                placeholder="2026-10-01 or 2026-10-01T06:00:00Z"
                defaultValue={f?.before}
              />
              <span className="muted">A UTC day or timestamp.</span>
            </label>
          </div>
        );
      }}
    </ActionCard>
  );
}
