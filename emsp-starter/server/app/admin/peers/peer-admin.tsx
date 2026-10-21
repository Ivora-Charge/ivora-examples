"use client";

import { useActionState, type ReactNode } from "react";
import {
  connectPeerAction,
  invitePeerAction,
  listPeersAction,
  managePeerAction,
  type ActionState,
  type PeerSummary,
} from "./actions";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

function SecretField() {
  return (
    <label>
      Admin secret
      <input
        name="adminSecret"
        type="password"
        autoComplete="current-password"
        required
      />
    </label>
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
    </dl>
  );
}

function Result({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return (
    <div
      className={state.ok ? "result" : "result error"}
      role={state.ok ? "status" : "alert"}
    >
      <p>{state.message}</p>
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
        </div>
      ))}
    </div>
  );
}

function ActionCard({
  id,
  title,
  action,
  children,
  submit,
}: {
  id: string;
  title: string;
  action: Action;
  children?: ReactNode;
  submit: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <section className="card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <form action={formAction} className="form">
        {children}
        <SecretField />
        <div className="actions" aria-busy={pending}>
          {submit}
        </div>
      </form>
      <Result state={state} />
    </section>
  );
}

export function PeerAdmin() {
  return (
    <>
      <ActionCard
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
      </ActionCard>

      <ActionCard
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
      </ActionCard>

      <ActionCard
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
      </ActionCard>

      <ActionCard
        id="list"
        title="Peers"
        action={listPeersAction}
        submit={<button type="submit">Show peers</button>}
      />
    </>
  );
}
