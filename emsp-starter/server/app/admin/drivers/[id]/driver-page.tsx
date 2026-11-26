"use client";

import Link from "next/link";
import { useId } from "react";
import { formatMinorAmount } from "@/lib/locations/pricing";
import type { SessionRow } from "../../sessions/rows";
import { SESSION_STATE } from "../../sessions/session-admin";
import { sessionSearchTerm } from "@/lib/sessions/statuses";
import { driverAccountAction } from "../../tokens/actions";
import { DriverTokens } from "../../tokens/token-admin";
import { useAdmin } from "../../ui/admin-context";
import { Head, Result, State, utc } from "../../ui/kit";
import { ConfirmButton, Gated } from "../../ui/parts";
import { fields, useAction, useList } from "../../ui/use-action";
import {
  driverPageAction,
  type DriverPageState,
  type DriverRow,
  type PaymentLine,
} from "../actions";
import { AccountState, AppToken, lastSignIn, problemCount } from "../facts";

export function AccountFacts({
  d,
  capped,
}: {
  d: DriverRow;
  capped?: boolean;
}) {
  return (
    <dl className="facts">
      <dt>Driver reference</dt>
      <dd>
        <code>{d.id}</code>
      </dd>
      <dt>Email</dt>
      <dd>
        {d.email ?? (
          <span className="muted">
            shown only to an admin signed in by email
          </span>
        )}
      </dd>
      <dt>Account</dt>
      <dd>
        <AccountState status={d.status} />
      </dd>
      <dt>Joined</dt>
      <dd>{utc(d.createdAt)}</dd>
      <dt>Last sign-in</dt>
      <dd>{lastSignIn(d.lastSignInAt)}</dd>
      <dt>App token</dt>
      <dd>
        <AppToken state={d.appToken} />
      </dd>
      <dt>Card on file</dt>
      <dd>{d.hasCard ? "yes" : "no"}</dd>
      <dt>Open problems</dt>
      <dd>
        {problemCount(d.openProblems, capped)}{" "}
        {d.openProblems > 0 && (
          <Link href="/admin/problems">See reported problems</Link>
        )}
      </dd>
    </dl>
  );
}

/** The account, with its block and unblock: the audited driverAccountAction. */
function Account({
  driverRef,
  state,
  reload,
}: {
  driverRef: string;
  state: DriverPageState;
  reload: () => Promise<unknown>;
}) {
  const id = useId();
  const change = useAction(driverAccountAction);
  const send = async (intent: "block" | "unblock") => {
    await change.run(fields({ driverRef, intent }));
    await reload();
  };
  const d = state.account;
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Account</h2>
      {d === null && (
        <>
          <p role="status">
            <State kind="off">No account yet</State>
          </p>
          <p className="muted">
            Nobody has signed in to the app with this reference. Tokens,
            sessions and payments below are those that carry it. To stop it
            charging, block its tokens.
          </p>
          {Boolean(state.openProblems) && (
            <p>
              {problemCount(state.openProblems!, state.problemsCapped)} open
              problem report(s).{" "}
              <Link href="/admin/problems">See reported problems</Link>
            </p>
          )}
        </>
      )}
      {d && (
        <>
          <AccountFacts d={d} capped={state.problemsCapped} />
          <p className="small muted">
            A blocked driver may not charge with any of their tokens: CPOs that
            ask us get NOT_ALLOWED, and the app refuses to start. A CPO may let
            a whitelisted token charge without asking: block the tokens too for
            that.
          </p>
          <div className="row" aria-busy={change.pending}>
            {d.status === "active" ? (
              <ConfirmButton
                ask="Block this driver? They may not charge until unblocked."
                yes="Yes, block the driver"
                onConfirm={() => send("block")}
              >
                Block driver
              </ConfirmButton>
            ) : (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => void send("unblock")}
              >
                Unblock driver
              </button>
            )}
          </div>
        </>
      )}
      <Result state={change.state} />
    </section>
  );
}

/** The Sessions page, filtered to this driver (and to one session, when it can be). */
const sessionsHref = (driverRef: string, sessionId?: string) => {
  const query = new URLSearchParams({ driver: driverRef });
  const search = sessionId ? sessionSearchTerm(sessionId) : null;
  if (search) query.set("search", search);
  return `/admin/sessions?${query}`;
};

export function RecentSessions({
  driverRef,
  sessions,
}: {
  driverRef: string;
  sessions: SessionRow[];
}) {
  const id = useId();
  return (
    <section className="stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Last sessions</h2>
      {sessions.length === 0 ? (
        <p className="muted">No sessions for this driver.</p>
      ) : (
        <div className="card tablecard">
          <table className="data">
            <caption className="sr">Last sessions, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Location and reference</th>
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
              {sessions.map((s) => (
                <tr key={s.id}>
                  <th scope="row" className="c-main">
                    <Link
                      href={sessionsHref(driverRef, s.ref.split("/").pop())}
                    >
                      {s.location}
                    </Link>
                    <span className="sub mono">{s.ref}</span>
                  </th>
                  <td className="c-kv" data-l="Started">
                    {utc(s.start)}
                  </td>
                  <td className="c-kv num" data-l="Energy">
                    {s.kwh} kWh
                  </td>
                  <td className="c-big num">
                    {s.cost ?? <span className="muted">not yet</span>}
                  </td>
                  <td className="c-state">
                    <State kind={SESSION_STATE[s.status]?.[0] ?? "off"}>
                      {SESSION_STATE[s.status]?.[1] ?? s.status}
                    </State>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        <Link href={sessionsHref(driverRef)}>All sessions of this driver</Link>
      </p>
    </section>
  );
}

export function RecentPayments({
  driverRef,
  payments,
}: {
  driverRef: string;
  payments: PaymentLine[];
}) {
  const id = useId();
  return (
    <section className="stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Last payments</h2>
      {payments.length === 0 ? (
        <p className="muted">No payments for this driver.</p>
      ) : (
        <div className="card tablecard">
          <table className="data">
            <caption className="sr">Last payments, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Payment</th>
                <th scope="col">Since</th>
                <th scope="col" className="num">
                  Hold
                </th>
                <th scope="col" className="num">
                  Refunded
                </th>
                <th scope="col" className="num">
                  Captured
                </th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <th scope="row" className="c-main">
                    <Link
                      className="mono"
                      href={`/admin/payments?find=${encodeURIComponent(p.id)}`}
                    >
                      {p.id}
                    </Link>
                  </th>
                  <td className="c-kv" data-l="Since">
                    {utc(p.createdAt)}
                  </td>
                  <td className="c-kv num" data-l="Hold">
                    {formatMinorAmount(p.holdAmount, p.currency)}
                  </td>
                  <td className="c-kv num" data-l="Refunded">
                    {formatMinorAmount(p.refundedAmount, p.currency)}
                  </td>
                  <td className="c-big num">
                    {formatMinorAmount(p.capturedAmount, p.currency)}
                  </td>
                  <td className="c-state">
                    {p.review && !p.reviewedAt ? (
                      <State kind="todo">Needs review</State>
                    ) : (
                      <State kind="done">{p.status}</State>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        <Link
          href={`/admin/payments?${new URLSearchParams({ driver: driverRef })}`}
        >
          All payments of this driver
        </Link>
      </p>
    </section>
  );
}

function Loaded({ driverRef }: { driverRef: string }) {
  const { demo } = useAdmin();
  const page = useList(driverPageAction, { driverRef });
  const state: DriverPageState = page.state;
  return (
    <div className="stack">
      {demo && (
        <p className="muted">
          Demo mode: tokens are kept in memory only and nothing is pushed to a
          CPO.
        </p>
      )}
      {page.loading && (
        <p className="muted" role="status">
          Loading…
        </p>
      )}
      {page.done && state.ok === false && <Result state={state} />}
      {state.ok && (
        <Account driverRef={driverRef} state={state} reload={page.reload} />
      )}
      {/* Tokens are read on their own, so they show even if the rest cannot. */}
      <DriverTokens driverRef={driverRef} onChange={page.reload} />
      {state.ok && (
        <>
          <RecentSessions
            driverRef={driverRef}
            sessions={state.sessions ?? []}
          />
          <RecentPayments
            driverRef={driverRef}
            payments={state.payments ?? []}
          />
        </>
      )}
    </div>
  );
}

export function DriverPage({ driverRef }: { driverRef: string }) {
  return (
    <>
      <Head
        crumbs={[<Link href="/admin/drivers">Drivers</Link>, "Driver"]}
        title={
          <>
            Driver <span className="mono muted ids">{driverRef}</span>
          </>
        }
      />
      <Gated what="see this driver">
        <Loaded driverRef={driverRef} />
      </Gated>
    </>
  );
}
