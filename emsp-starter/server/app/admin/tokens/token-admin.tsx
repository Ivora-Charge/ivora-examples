"use client";

import type { ComponentProps } from "react";
import { ActionCard } from "../action-card";
import {
  addRfidCardAction,
  changeTokenAction,
  createAppTokenAction,
  driverAccountAction,
  driverTokensAction,
  retryPushesAction,
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

function WhitelistField() {
  return (
    <label>
      Whitelist
      <select name="whitelist" defaultValue="ALLOWED_OFFLINE">
        {WHITELISTS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DriverField() {
  return (
    <label>
      Driver reference
      <input name="driverRef" required maxLength={64} autoComplete="off" />
    </label>
  );
}

function TokenFacts({ token }: { token: TokenSummary }) {
  return (
    <dl className="facts">
      <dt>Type</dt>
      <dd>{token.type === "APP_USER" ? "App" : "RFID card"}</dd>
      <dt>UID</dt>
      <dd>
        <code>{token.uid}</code>
      </dd>
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
      <dt>Driver</dt>
      <dd>{token.driverRef}</dd>
      <dt>Status</dt>
      <dd>
        {token.status}
        {token.valid ? " (may charge)" : " (may not charge)"}
      </dd>
      <dt>Whitelist</dt>
      <dd>{token.whitelist}</dd>
      {token.expiresAt && (
        <>
          <dt>Expires</dt>
          <dd>{token.expiresAt}</dd>
        </>
      )}
      <dt>Last updated</dt>
      <dd>{token.lastUpdated}</dd>
    </dl>
  );
}

function Details({ state }: { state: TokenActionState }) {
  const d = state.driver;
  return (
    <>
      {d && (
        <dl className="facts">
          <dt>Driver</dt>
          <dd>
            <code>{d.id}</code>
          </dd>
          <dt>Email</dt>
          <dd>{d.email}</dd>
          <dt>Status</dt>
          <dd className={d.status === "active" ? undefined : "flag"}>
            {d.status === "active" ? "active (may charge)" : "blocked"}
          </dd>
          <dt>Card on file</dt>
          <dd>{d.hasCard ? "yes" : "no"}</dd>
          <dt>Since</dt>
          <dd>{d.createdAt}</dd>
        </dl>
      )}
      {state.tokens?.map((t) => (
        <div key={`${t.type}:${t.uid}`} className="peer">
          <TokenFacts token={t} />
        </div>
      ))}
      {state.pushes
        ?.filter((p) => !p.ok)
        .map((p) => (
          <p key={p.peerId} className="note">
            {p.label}: {p.error}
          </p>
        ))}
    </>
  );
}

function TokenCard(
  props: Omit<ComponentProps<typeof ActionCard<TokenActionState>>, "details">,
) {
  return (
    <ActionCard<TokenActionState>
      {...props}
      details={(state) => <Details state={state} />}
    />
  );
}

export function TokenAdmin() {
  return (
    <>
      <TokenCard
        id="lookup"
        title="Look up a driver"
        action={driverTokensAction}
        submit={<button type="submit">Show tokens</button>}
      >
        <DriverField />
      </TokenCard>

      <TokenCard
        id="driver"
        title="Block or unblock a driver"
        action={driverAccountAction}
        submit={
          <>
            <button type="submit" name="intent" value="show">
              Show driver
            </button>
            <button
              type="submit"
              name="intent"
              value="block"
              className="danger"
            >
              Block driver
            </button>
            <button type="submit" name="intent" value="unblock">
              Unblock driver
            </button>
          </>
        }
      >
        <p className="muted">
          A blocked driver may not charge with any of their tokens: CPOs that
          ask us get NOT_ALLOWED, and the app refuses to start. A CPO may let a
          whitelisted token charge without asking: block the tokens too for
          that.
        </p>
        <DriverField />
      </TokenCard>

      <TokenCard
        id="app-token"
        title="Create an app token"
        action={createAppTokenAction}
        submit={<button type="submit">Create app token</button>}
      >
        <p className="muted">
          Gives a driver a new contract ID and the token the app charges with.
          One per driver.
        </p>
        <DriverField />
        <WhitelistField />
        <label>
          Language (optional)
          <input name="language" maxLength={2} placeholder="en" />
        </label>
      </TokenCard>

      <TokenCard
        id="rfid"
        title="Add an RFID card"
        action={addRfidCardAction}
        submit={<button type="submit">Add card</button>}
      >
        <p className="muted">
          The card joins the driver&apos;s contract. The driver needs an app
          token first. Until RFID billing is available, cards are pushed as
          NEVER and refused at authorization: they cannot start charging yet.
        </p>
        <DriverField />
        <label>
          Card UID
          <input
            name="uid"
            required
            maxLength={64}
            autoComplete="off"
            placeholder="04A1B2C3D4E5F6"
          />
        </label>
        <label>
          Printed number (optional)
          <input name="visualNumber" maxLength={64} autoComplete="off" />
        </label>
        <label>
          Expires (optional)
          <input name="expiresAt" type="date" />
        </label>
      </TokenCard>

      <TokenCard
        id="change"
        title="Block, unblock or change the whitelist"
        action={changeTokenAction}
        submit={
          <>
            <button
              type="submit"
              name="intent"
              value="block"
              className="danger"
            >
              Block
            </button>
            <button type="submit" name="intent" value="unblock">
              Unblock
            </button>
            <button type="submit" name="intent" value="whitelist">
              Set whitelist
            </button>
          </>
        }
      >
        <p className="muted">
          A blocked token is refused from now on and the change is pushed to
          every CPO at once.
        </p>
        <label>
          Token UID
          <input name="uid" required maxLength={64} autoComplete="off" />
        </label>
        <label>
          Type
          <select name="type" defaultValue="APP_USER">
            <option value="APP_USER">App</option>
            <option value="RFID">RFID card</option>
          </select>
        </label>
        <WhitelistField />
      </TokenCard>

      <TokenCard
        id="pushes"
        title="Retry missed pushes"
        action={retryPushesAction}
        submit={<button type="submit">Retry now</button>}
      >
        <p className="muted">
          Pushes a CPO missed are retried by the scheduled job; this sends the
          ones that are due now.
        </p>
      </TokenCard>
    </>
  );
}
