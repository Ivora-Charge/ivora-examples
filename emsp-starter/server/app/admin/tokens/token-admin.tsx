"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Result, State, utc } from "../ui/kit";
import { ActionForm, ConfirmButton } from "../ui/parts";
import { fields, useAction } from "../ui/use-action";
import {
  addRfidCardAction,
  changeTokenAction,
  createAppTokenAction,
  driverAccountAction,
  driverTokensAction,
  retryPushesAction,
  type DriverSummary,
  type TokenActionState,
  type TokenSummary,
} from "./actions";

const WHITELISTS = [
  [
    "ALLOWED_OFFLINE",
    "ALLOWED_OFFLINE (default): CPO must ask us; charges unasked only if it cannot reach us",
  ],
  ["NEVER", "NEVER: CPO must ask us; no answer, no charging"],
  ["ALLOWED", "ALLOWED: CPO may charge unasked, even while it can reach us"],
  ["ALWAYS", "ALWAYS: CPO never asks us"],
] as const;

function WhitelistField({ value = "ALLOWED_OFFLINE" }: { value?: string }) {
  const id = useId();
  return (
    <div className="field" style={{ flex: 1, minWidth: "12rem" }}>
      <label htmlFor={id}>Whitelist</label>
      <select id={id} name="whitelist" defaultValue={value}>
        {WHITELISTS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The pushes a change could not deliver: the CPO and its error, never a token. */
function FailedPushes({ state }: { state: TokenActionState }) {
  const failed = state.pushes?.filter((p) => !p.ok) ?? [];
  if (!failed.length) return null;
  return (
    <ul className="bullets small">
      {failed.map((p) => (
        <li key={p.peerId}>
          {p.label}: {p.error}
        </li>
      ))}
    </ul>
  );
}

function Answer({ state }: { state: TokenActionState }) {
  return (
    <Result state={state}>
      <FailedPushes state={state} />
    </Result>
  );
}

function DriverFacts({ d }: { d: DriverSummary }) {
  return (
    <dl className="facts">
      <dt>Driver</dt>
      <dd>
        <code>{d.id}</code>
      </dd>
      <dt>Email</dt>
      <dd>{d.email}</dd>
      <dt>Status</dt>
      <dd>
        {d.status === "active" ? (
          <State kind="ok">active (may charge)</State>
        ) : (
          <State kind="bad">blocked</State>
        )}
      </dd>
      <dt>Card on file</dt>
      <dd>{d.hasCard ? "yes" : "no"}</dd>
      <dt>Since</dt>
      <dd>{utc(d.createdAt)}</dd>
    </dl>
  );
}

/** One token: its facts, and its own block, unblock and whitelist actions. */
function TokenItem({
  token,
  onChange,
}: {
  token: TokenSummary;
  onChange: (values: Record<string, string>) => Promise<unknown>;
}) {
  const kind = token.type === "APP_USER" ? "App token" : "RFID card";
  const key = { uid: token.uid, type: token.type };
  return (
    <li className="item block">
      <div className="row between">
        <h3>
          {kind} <span className="mono muted">{token.uid}</span>
        </h3>
        <State kind={token.valid ? "ok" : "bad"}>
          {token.status}
          {token.valid ? " (may charge)" : " (may not charge)"}
        </State>
      </div>
      <dl className="facts small">
        {token.visualNumber && (
          <>
            <dt>Printed number</dt>
            <dd>{token.visualNumber}</dd>
          </>
        )}
        <dt>Contract ID</dt>
        <dd>
          <code>{token.contractId}</code>
        </dd>
        <dt>Whitelist</dt>
        <dd>{token.whitelist}</dd>
        {token.expiresAt && (
          <>
            <dt>Expires</dt>
            <dd>{utc(token.expiresAt)}</dd>
          </>
        )}
        <dt>Last updated</dt>
        <dd>{utc(token.lastUpdated)}</dd>
      </dl>
      <ActionForm
        className="row"
        style={{ alignItems: "end" }}
        onSend={(fd) =>
          onChange({
            ...key,
            intent: "whitelist",
            whitelist: String(fd.get("whitelist") ?? ""),
          })
        }
      >
        <WhitelistField value={token.whitelist} />
        <button type="submit" className="btn ghost sm">
          Set whitelist<span className="sr"> of {token.uid}</span>
        </button>
      </ActionForm>
      <div className="row">
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => void onChange({ ...key, intent: "unblock" })}
        >
          Unblock<span className="sr"> {token.uid}</span>
        </button>
        <ConfirmButton
          ask={`Block ${token.uid}? It is refused from now on.`}
          yes="Yes, block"
          onConfirm={() => onChange({ ...key, intent: "block" })}
        >
          Block<span className="sr"> {token.uid}</span>
        </ConfirmButton>
      </div>
    </li>
  );
}

/**
 * One token by its UID and type, without the driver: for a card or a token a CPO
 * reports, when the driver reference is not at hand. The same action as a token's own
 * buttons in a driver's list.
 */
export function TokenByUid() {
  const id = useId();
  const change = useAction(changeTokenAction);
  const found = change.state.tokens?.[0];
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="h3">
        Change a token by its UID
      </h2>
      <p className="small muted">
        Without the driver reference: block, unblock or set the whitelist of one
        token from its UID and type. A blocked token is refused from now on and
        the change is pushed to every CPO at once.
      </p>
      <ActionForm
        aria-label="Change a token by its UID"
        onSend={(fd) => change.run(fd)}
      >
        <div className="fields">
          <div className="field">
            <label htmlFor={`${id}-uid`}>Token UID</label>
            <input
              id={`${id}-uid`}
              name="uid"
              required
              maxLength={64}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-type`}>Type</label>
            <select id={`${id}-type`} name="type" defaultValue="APP_USER">
              <option value="APP_USER">App</option>
              <option value="RFID">RFID card</option>
            </select>
          </div>
          <WhitelistField />
        </div>
        <div className="row">
          <button
            type="submit"
            className="btn ghost sm"
            name="intent"
            value="whitelist"
          >
            Set whitelist
          </button>
          <button
            type="submit"
            className="btn ghost sm"
            name="intent"
            value="unblock"
          >
            Unblock token
          </button>
          <button
            type="submit"
            className="btn danger sm"
            name="intent"
            value="block"
          >
            Block token
          </button>
        </div>
      </ActionForm>
      <Answer state={change.state} />
      {found && (
        <dl className="facts small">
          <dt>Token</dt>
          <dd>
            {found.type === "APP_USER" ? "App token" : "RFID card"}{" "}
            <code>{found.uid}</code>
          </dd>
          <dt>Driver</dt>
          <dd>
            <code>{found.driverRef}</code>
          </dd>
          <dt>Contract ID</dt>
          <dd>
            <code>{found.contractId}</code>
          </dd>
          <dt>Status</dt>
          <dd>
            <State kind={found.valid ? "ok" : "bad"}>
              {found.status}
              {found.valid ? " (may charge)" : " (may not charge)"}
            </State>
          </dd>
          <dt>Whitelist</dt>
          <dd>{found.whitelist}</dd>
          <dt>Last updated</dt>
          <dd>{utc(found.lastUpdated)}</dd>
        </dl>
      )}
    </section>
  );
}

function Driver({ driverRef }: { driverRef: string }) {
  const account = useAction(driverAccountAction);
  const tokens = useAction(driverTokensAction);
  const change = useAction(changeTokenAction);
  const create = useAction(createAppTokenAction);
  const rfid = useAction(addRfidCardAction);
  const id = useId();

  const { run: readAccount } = account;
  const { run: runTokens } = tokens;
  const readTokens = useCallback(
    () => runTokens(fields({ driverRef })),
    [runTokens, driverRef],
  );
  // Read when this driver is shown (the parent gives each search its own key).
  useEffect(() => {
    void readAccount(fields({ driverRef, intent: "show" }));
    void readTokens();
  }, [readAccount, readTokens, driverRef]);
  const driver = account.state.driver;
  const list = tokens.state.tokens ?? [];
  const hasApp = list.some((t) => t.type === "APP_USER");

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby={`${id}-account`}>
        <h2 id={`${id}-account`}>
          Driver <span className="mono muted">{driverRef}</span>
        </h2>
        {!account.done ? (
          <p className="muted" role="status">
            Loading…
          </p>
        ) : (
          <>
            <Result state={account.state} />
            {driver && <DriverFacts d={driver} />}
          </>
        )}
        {driver && (
          <>
            <p className="small muted">
              A blocked driver may not charge with any of their tokens: CPOs
              that ask us get NOT_ALLOWED, and the app refuses to start. A CPO
              may let a whitelisted token charge without asking: block the
              tokens too for that.
            </p>
            <div className="row" aria-busy={account.pending}>
              {driver.status === "active" ? (
                <ConfirmButton
                  ask="Block this driver? They may not charge until unblocked."
                  yes="Yes, block the driver"
                  onConfirm={() =>
                    account.run(fields({ driverRef, intent: "block" }))
                  }
                >
                  Block driver
                </ConfirmButton>
              ) : (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    void account.run(fields({ driverRef, intent: "unblock" }))
                  }
                >
                  Unblock driver
                </button>
              )}
            </div>
          </>
        )}
      </section>

      <section className="stack" aria-labelledby={`${id}-tokens`}>
        <h2 id={`${id}-tokens`}>Tokens</h2>
        <Answer state={change.state} />
        {!tokens.done ? (
          <p className="muted" role="status">
            Loading…
          </p>
        ) : tokens.state.ok === false ? (
          <Result state={tokens.state} />
        ) : (
          <>
            <p className="muted" role="status">
              {tokens.state.message}
            </p>
            {list.length > 0 && (
              <ul className="list" aria-busy={tokens.pending || change.pending}>
                {list.map((t) => (
                  <TokenItem
                    key={`${t.type}:${t.uid}`}
                    token={t}
                    onChange={async (values) => {
                      await change.run(fields(values));
                      await readTokens();
                    }}
                  />
                ))}
              </ul>
            )}
            <p className="small muted">
              A blocked token is refused from now on and the change is pushed to
              every CPO at once.
            </p>
          </>
        )}

        <div className="card stack">
          <details
            className="fold"
            open={tokens.done && !hasApp ? true : undefined}
          >
            <summary>Create an app token</summary>
            <ActionForm
              aria-label="Create an app token"
              onSend={async (fd) => {
                const r = await create.run(fd);
                if (r.ok) await readTokens();
              }}
            >
              <p className="muted">
                Gives a driver a new contract ID and the token the app charges
                with. One per driver. Drivers get their app token at their first
                sign-in in the app; use this for support.
              </p>
              <input type="hidden" name="driverRef" value={driverRef} />
              <div className="fields">
                <WhitelistField />
                <div className="field">
                  <label htmlFor={`${id}-lang`}>Language (optional)</label>
                  <input
                    id={`${id}-lang`}
                    name="language"
                    maxLength={2}
                    placeholder="en"
                  />
                </div>
              </div>
              <div>
                <button type="submit" className="btn ghost sm">
                  Create app token
                </button>
              </div>
            </ActionForm>
          </details>
          <Answer state={create.state} />
        </div>

        <div className="card stack">
          <details className="fold">
            <summary>Add an RFID card</summary>
            <ActionForm
              aria-label="Add an RFID card"
              onSend={async (fd) => {
                const r = await rfid.run(fd);
                if (r.ok) await readTokens();
              }}
            >
              <p className="muted">
                The card joins the driver&apos;s contract. The driver needs an
                app token first. Until RFID billing is available, cards are
                pushed as NEVER and refused at authorization: they cannot start
                charging yet.
              </p>
              <input type="hidden" name="driverRef" value={driverRef} />
              <div className="fields">
                <div className="field">
                  <label htmlFor={`${id}-uid`}>Card UID</label>
                  <input
                    id={`${id}-uid`}
                    name="uid"
                    required
                    maxLength={64}
                    autoComplete="off"
                    placeholder="04A1B2C3D4E5F6"
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${id}-visual`}>
                    Printed number (optional)
                  </label>
                  <input
                    id={`${id}-visual`}
                    name="visualNumber"
                    maxLength={64}
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${id}-exp`}>Expires (optional)</label>
                  <input id={`${id}-exp`} name="expiresAt" type="date" />
                </div>
              </div>
              <div>
                <button type="submit" className="btn ghost sm">
                  Add card
                </button>
              </div>
            </ActionForm>
          </details>
          <Answer state={rfid.state} />
        </div>
      </section>
    </div>
  );
}

export function TokenAdmin({
  tokensUrl,
  sampleDriver,
}: {
  /** Where CPOs pull every token from: null unless an admin is signed in by email. */
  tokensUrl: string | null;
  /** Demo mode: the sample driver's reference. */
  sampleDriver: string | null;
}) {
  const [driverRef, setDriverRef] = useState<string | null>(null);
  // A new search of the same driver reads it again.
  const [round, setRound] = useState(0);
  const retry = useAction(retryPushesAction);
  const id = useId();
  return (
    <div className="stack">
      <section className="card stack" aria-labelledby={`${id}-find`}>
        <h2 id={`${id}-find`}>Find a driver</h2>
        <ActionForm
          onSend={async (fd) => {
            const ref = String(fd.get("driverRef") ?? "").trim();
            if (!ref) return;
            setDriverRef(ref);
            setRound((n) => n + 1);
          }}
        >
          <div className="field">
            <label htmlFor={`${id}-ref`}>Driver reference</label>
            <input
              id={`${id}-ref`}
              name="driverRef"
              required
              maxLength={64}
              autoComplete="off"
              defaultValue={sampleDriver ?? undefined}
              aria-describedby={`${id}-ref-h`}
            />
            <span className="hint" id={`${id}-ref-h`}>
              The exact reference, as Sessions and Payments show it. There is no
              search by name or email.
              {sampleDriver && (
                <>
                  {" "}
                  Demo mode: tokens are kept in memory only and nothing is
                  pushed to a CPO. The sample driver is{" "}
                  <code>{sampleDriver}</code>.
                </>
              )}
            </span>
          </div>
          <div>
            <button type="submit" className="btn">
              Find driver
            </button>
          </div>
        </ActionForm>
      </section>

      {driverRef && (
        <Driver key={`${driverRef}:${round}`} driverRef={driverRef} />
      )}

      <TokenByUid />

      <section className="card stack" aria-labelledby={`${id}-push`}>
        <h2 id={`${id}-push`} className="h3">
          Retry missed pushes
        </h2>
        <p className="small muted">
          Every change is pushed to each CPO at once; CPOs can also pull every
          token from{" "}
          {tokensUrl ? <code>{tokensUrl}</code> : "our OCPI tokens endpoint"}{" "}
          and ask us in real time before a driver charges. Pushes a CPO missed
          are retried by the scheduled job; this sends the ones that are due
          now.
        </p>
        <div aria-busy={retry.pending}>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void retry.run()}
          >
            Retry now
          </button>
        </div>
        <Result state={retry.state} />
      </section>
    </div>
  );
}
