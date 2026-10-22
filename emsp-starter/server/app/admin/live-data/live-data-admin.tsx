"use client";

import type { ComponentProps } from "react";
import { ActionCard } from "../action-card";
import {
  listAdaptersAction,
  removeAdapterAction,
  setAdapterAction,
  type LiveDataActionState,
} from "./actions";

function Details({ state }: { state: LiveDataActionState }) {
  return (
    <>
      {state.adapters?.map((a) => (
        <div key={a.peerId} className="peer">
          <dl className="facts">
            <dt>Peer</dt>
            <dd>{a.peerLabel}</dd>
            <dt>Peer ID</dt>
            <dd>
              <code>{a.peerId}</code>
            </dd>
            <dt>Adapter</dt>
            <dd>{a.kindLabel}</dd>
            <dt>API URL</dt>
            <dd>
              <code className="wrap">{a.baseUrl}</code>
            </dd>
            <dt>Account</dt>
            <dd>
              <code>{a.accountId}</code>
            </dd>
            <dt>API key</dt>
            <dd>Stored encrypted</dd>
            <dt>Last changed</dt>
            <dd>{a.updatedAt}</dd>
          </dl>
        </div>
      ))}
    </>
  );
}

function LiveDataCard(
  props: Omit<
    ComponentProps<typeof ActionCard<LiveDataActionState>>,
    "details"
  >,
) {
  return (
    <ActionCard<LiveDataActionState>
      {...props}
      details={(state) => <Details state={state} />}
    />
  );
}

function PeerField() {
  return (
    <label>
      Peer ID
      <input
        name="peerId"
        required
        maxLength={36}
        autoComplete="off"
        placeholder="From the CPO peers page"
      />
    </label>
  );
}

export function LiveDataAdmin() {
  return (
    <>
      <LiveDataCard
        id="ivora"
        title="Read live data from the Ivora API"
        action={setAdapterAction}
        submit={<button type="submit">Save adapter</button>}
      >
        <input type="hidden" name="kind" value="ivora" />
        <p className="muted">
          For a CPO peer that runs on Ivora. Ask the CPO for its tenant ID and
          an API key with the <code>billing:read</code> scope only. The key is
          encrypted at once and never shown again.
        </p>
        <PeerField />
        <label>
          API URL
          <input
            name="baseUrl"
            type="url"
            required
            maxLength={255}
            defaultValue="https://api.ivoracharge.com"
          />
        </label>
        <label>
          Tenant ID
          <input
            name="accountId"
            required
            inputMode="numeric"
            pattern="[0-9]{1,18}"
            maxLength={18}
            autoComplete="off"
          />
        </label>
        <label>
          Read-only API key
          <input
            name="apiKey"
            type="password"
            required
            maxLength={512}
            autoComplete="off"
          />
        </label>
      </LiveDataCard>

      <LiveDataCard
        id="remove"
        title="Remove an adapter"
        action={removeAdapterAction}
        submit={
          <button type="submit" className="danger">
            Remove adapter
          </button>
        }
      >
        <p className="muted">
          The peer goes back to OCPI data only: no state of charge.
        </p>
        <PeerField />
      </LiveDataCard>

      <LiveDataCard
        id="list"
        title="Adapters"
        action={listAdaptersAction}
        submit={<button type="submit">Show adapters</button>}
      />
    </>
  );
}
