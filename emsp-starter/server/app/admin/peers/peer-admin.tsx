"use client";

import type { ComponentProps } from "react";
import { ActionCard, ErrorHelp } from "../action-card";
import {
  connectPeerAction,
  invitePeerAction,
  listPeersAction,
  managePeerAction,
  syncPeerAction,
  type ActionState,
  type ModuleSync,
  type PeerSummary,
} from "./actions";

function SyncTable({ peer, sync }: { peer: string; sync: ModuleSync[] }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="muted">Last pull per module: {peer}</caption>
        <thead>
          <tr>
            <th scope="col">Module</th>
            <th scope="col">Last pull</th>
            <th scope="col">Result</th>
            <th scope="col" className="num">
              Stored
            </th>
            <th scope="col" className="num">
              Invalid
            </th>
            <th scope="col">Last full pull</th>
          </tr>
        </thead>
        <tbody>
          {sync.map((m) => (
            <tr key={m.module}>
              <th scope="row">{m.module}</th>
              <td>{m.lastPullAt ?? "never"}</td>
              <td className={m.ok === false ? "flag ids" : undefined}>
                {m.ok === null ? "-" : m.ok ? "ok" : `failed: ${m.error}`}
                {m.running && " (part way: the next pull resumes it)"}
              </td>
              <td className="num">{m.items}</td>
              <td className="num">{m.invalid}</td>
              <td>{m.lastFullSyncAt ?? "never"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sync
        .filter((m) => m.ok === false)
        .map((m) => (
          <div key={m.module}>
            <p className="muted">{m.module}:</p>
            <ErrorHelp code={m.code} nextStep={m.nextStep} />
          </div>
        ))}
    </div>
  );
}

function PeerFacts({ peer }: { peer: PeerSummary }) {
  return (
    <dl className="facts">
      <dt>Name</dt>
      <dd>{peer.label}</dd>
      <dt>Peer ID</dt>
      <dd>
        <code>{peer.id}</code>
      </dd>
      <dt>Status</dt>
      <dd>{peer.status}</dd>
      <dt>Direction</dt>
      <dd>
        {peer.direction === "outbound"
          ? "We registered at the CPO"
          : "The CPO registers with us"}
      </dd>
      {peer.versionsUrl && (
        <>
          <dt>Versions URL</dt>
          <dd>
            <code>{peer.versionsUrl}</code>
          </dd>
        </>
      )}
      {peer.parties.length > 0 && (
        <>
          <dt>Parties</dt>
          <dd>{peer.parties.join(", ")}</dd>
        </>
      )}
      {peer.modules.length > 0 && (
        <>
          <dt>Modules</dt>
          <dd>{peer.modules.join(", ")}</dd>
        </>
      )}
      {peer.registeredAt && (
        <>
          <dt>Registered</dt>
          <dd>{peer.registeredAt}</dd>
        </>
      )}
    </dl>
  );
}

function Details({ state }: { state: ActionState }) {
  return (
    <>
      {state.tokenA && (
        <dl className="facts">
          <dt>Our versions URL</dt>
          <dd>
            <code>{state.versionsUrl}</code>
          </dd>
          <dt>Token A</dt>
          <dd>
            <code>{state.tokenA}</code>
          </dd>
          {state.expiresAt && (
            <>
              <dt>Token A expires</dt>
              <dd>{state.expiresAt}</dd>
            </>
          )}
        </dl>
      )}
      {state.peer && <PeerFacts peer={state.peer} />}
      {state.peers?.map((p) => (
        <div key={p.id} className="peer">
          <PeerFacts peer={p} />
          {p.demo && (
            <p className="muted">
              Built in: its sample data is never pulled over the network.
            </p>
          )}
          {p.sync && <SyncTable peer={p.label} sync={p.sync} />}
        </div>
      ))}
    </>
  );
}

function PeerCard(
  props: Omit<ComponentProps<typeof ActionCard<ActionState>>, "details">,
) {
  return (
    <ActionCard<ActionState>
      {...props}
      details={(state) => <Details state={state} />}
    />
  );
}

export function PeerAdmin() {
  return (
    <>
      <PeerCard
        id="list"
        title="Peers and their status"
        action={listPeersAction}
        submit={<button type="submit">Show peers</button>}
      >
        <p className="muted">
          Each peer&apos;s status, and the last pull of its locations, tariffs,
          sessions and CDRs, with the error of a failed one.
        </p>
      </PeerCard>

      <PeerCard
        id="connect"
        title="Connect to a CPO"
        action={connectPeerAction}
        submit={<button type="submit">Register at the CPO</button>}
      >
        <p className="muted">
          The CPO gave you its versions URL and a Token A. This server reads its
          versions, sends our credentials and stores the token it gets back.
        </p>
        <label>
          Name
          <input name="label" required maxLength={100} />
        </label>
        <label>
          CPO versions URL
          <input
            name="versionsUrl"
            type="url"
            required
            placeholder="https://cpo.example.com/ocpi/versions"
          />
        </label>
        <label>
          Token A
          <input
            name="tokenA"
            type="password"
            autoComplete="off"
            required
            maxLength={64}
          />
        </label>
      </PeerCard>

      <PeerCard
        id="invite"
        title="Let a CPO register with us"
        action={invitePeerAction}
        submit={<button type="submit">Create Token A</button>}
      >
        <p className="muted">
          Creates a Token A for the CPO to register with, using our versions
          URL.
        </p>
        <label>
          Name
          <input name="label" required maxLength={100} />
        </label>
      </PeerCard>

      <PeerCard
        id="manage"
        title="Rotate tokens or unregister"
        action={managePeerAction}
        submit={
          <>
            <button type="submit" name="intent" value="rotate">
              Rotate tokens
            </button>
            <button
              type="submit"
              name="intent"
              value="unregister"
              className="danger"
            >
              Unregister
            </button>
          </>
        }
      >
        <label>
          Peer ID
          <input name="peerId" required autoComplete="off" />
        </label>
      </PeerCard>

      <PeerCard
        id="sync"
        title="Pull locations and tariffs"
        action={syncPeerAction}
        submit={
          <>
            <button type="submit" name="intent" value="changes">
              Pull changes
            </button>
            <button type="submit" name="intent" value="full">
              Pull everything
            </button>
          </>
        }
      >
        <p className="muted">
          Reads a registered CPO&apos;s tariffs and locations. The first pull
          reads everything; later ones read what changed since. CPOs also push
          changes as they happen.
        </p>
        <label>
          Peer ID
          <input name="peerId" required autoComplete="off" />
        </label>
      </PeerCard>
    </>
  );
}
