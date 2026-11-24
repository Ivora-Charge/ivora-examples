"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import {
  listAdaptersAction,
  removeAdapterAction,
  setAdapterAction,
  type LiveDataActionState,
} from "../../live-data/actions";
import {
  Head,
  Icon,
  Message,
  Result,
  State,
  Tile,
  utc,
  type ActionResult,
} from "../../ui/kit";
import { ActionForm, ago, ConfirmButton, Gated } from "../../ui/parts";
import { fields, oneAtATime, useList, useRun } from "../../ui/use-action";
import {
  hubPartyAction,
  listPeersAction,
  managePeerAction,
  syncPeerAction,
  type ActionState,
  type PeerSummary,
} from "../actions";
import { moduleName, viewOf } from "../peer-view";

type HubParty = NonNullable<PeerSummary["hub"]>["parties"][number];
type Send = (
  action: (prev: ActionState, form: FormData) => Promise<ActionState>,
  values: Record<string, string>,
) => Promise<ActionState>;

const code = (p: { countryCode: string; partyId: string }) =>
  `${p.countryCode}-${p.partyId}`;
const SOURCE: Record<HubParty["source"], string> = {
  admin: "Added by an admin.",
  hubclientinfo: "Offered by the hub's client list.",
  credentials: "Declared by the hub when it registered.",
};

/** How our token pushes reach the hub: one push to its own party, or one per party. */
function PushMode({ peer, send }: { peer: PeerSummary; send: Send }) {
  const id = useId();
  const mode = peer.hub?.pushMode ?? "hub";
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <h2 className="h3" id={`${id}-h`}>
        Token pushes
      </h2>
      <p className="small muted">
        Some hubs expect our tokens addressed to the hub itself and hand them on
        to the CPOs; others want one push for each CPO party. Use the one your
        hub documents.
      </p>
      <div className="field">
        <label htmlFor={`${id}-mode`}>Send tokens</label>
        <select
          id={`${id}-mode`}
          value={mode}
          onChange={(e) =>
            send(hubPartyAction, {
              peerId: peer.id,
              intent: "push_mode",
              mode: e.target.value,
            })
          }
        >
          <option value="hub">One push to the hub&apos;s own party</option>
          <option value="per_party">One push per trusted party</option>
        </select>
      </div>
    </section>
  );
}

/** The parties behind a hub: trusted and offered, with Accept and Remove on each row. */
export function HubParties({ peer, send }: { peer: PeerSummary; send: Send }) {
  const id = useId();
  const parties = peer.hub?.parties ?? [];
  const trusted = parties.filter((p) => p.status === "trusted");
  const offered = parties.filter((p) => p.status === "offered");
  const act = (intent: string, p?: HubParty | Record<string, string>) =>
    send(hubPartyAction, {
      peerId: peer.id,
      intent,
      ...(p && {
        countryCode: p.countryCode,
        partyId: p.partyId,
        name: p.name ?? "",
      }),
    });
  const row = (p: HubParty) => {
    const name = p.name || code(p);
    return (
      <li className="item acts" key={code(p)}>
        {p.status === "trusted" ? (
          <Tile kind="ok" big={<Icon name="check" />} />
        ) : (
          <Tile kind="off" big="?" />
        )}
        <div className="what">
          <h3>
            {name} <span className="mono muted">{code(p)}</span>
          </h3>
          <p className="meta">
            {p.status === "trusted"
              ? `Trusted: pulled from, and tokens pushed to when pushing per party. ${SOURCE[p.source]}`
              : `${SOURCE[p.source]} Not trusted: nothing is sent or accepted.`}
          </p>
        </div>
        <span className="end">
          {p.status === "trusted" ? (
            <ConfirmButton
              ask={`Stop trusting ${name}? Its locations and tariffs are removed.`}
              yes="Yes, remove"
              onConfirm={() => act("remove", p)}
            >
              Remove<span className="sr"> {name}</span>
            </ConfirmButton>
          ) : (
            <button
              className="btn sm"
              type="button"
              onClick={() => act("accept", p)}
            >
              Accept<span className="sr"> {name}</span>
            </button>
          )}
        </span>
      </li>
    );
  };
  return (
    <>
      {trusted.length === 0 && (
        <Message
          kind="wait"
          title="Connected, but idle: no party is trusted yet."
          nextStep="Accept the CPOs you have an agreement with. Pulls start with the first one; token pushes go to the hub itself unless you chose one push per party."
        />
      )}
      {trusted.length > 0 && (
        <section className="stack" aria-labelledby={`${id}-t`}>
          <h2 id={`${id}-t`}>
            Trusted <span className="muted">{trusted.length}</span>
          </h2>
          <ul className="list">{trusted.map(row)}</ul>
        </section>
      )}
      <section className="stack" aria-labelledby={`${id}-o`}>
        <div className="row between">
          <h2 id={`${id}-o`}>
            Offered <span className="muted">{offered.length}</span>
          </h2>
          <button
            className="btn ghost sm"
            type="button"
            onClick={() => act("offer")}
          >
            <Icon name="refresh" />
            Read the hub&apos;s list again
          </button>
        </div>
        <p className="muted">
          The hub lists these CPOs. Offered is not trusted: we send them nothing
          and refuse what arrives in their name until you accept.
        </p>
        {offered.length > 0 ? (
          <ul className="list">{offered.map(row)}</ul>
        ) : (
          <p className="card flat muted">
            No offered party. Read the hub&apos;s list again, or add one below.
          </p>
        )}
        <details className="card flat fold">
          <summary>Add a party the hub does not list</summary>
          <ActionForm
            onSend={(form) =>
              act("accept", {
                countryCode: String(form.get("countryCode") ?? ""),
                partyId: String(form.get("partyId") ?? ""),
                name: String(form.get("name") ?? ""),
              })
            }
          >
            <div className="fields">
              <div className="field">
                <label htmlFor={`${id}-cc`}>Country</label>
                <input
                  id={`${id}-cc`}
                  name="countryCode"
                  maxLength={2}
                  placeholder="NL"
                  autoComplete="off"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor={`${id}-pid`}>Party ID</label>
                <input
                  id={`${id}-pid`}
                  name="partyId"
                  maxLength={3}
                  placeholder="ABC"
                  autoComplete="off"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor={`${id}-name`}>Name (optional)</label>
                <input id={`${id}-name`} name="name" maxLength={100} />
              </div>
            </div>
            <div>
              <button className="btn ghost sm" type="submit">
                Accept this party
              </button>
            </div>
          </ActionForm>
        </details>
      </section>
      <div className="msg" role="note">
        <p className="t">
          <Icon name="hub" />
          <span>Accepted a party but see none of its chargers?</span>
        </p>
        <p>
          Check your subscription in the hub&apos;s own portal. The hub decides
          which CPOs send to you; accepting here only says this network trusts
          them. You need both.
        </p>
      </div>
    </>
  );
}

/** The last pull of each module, and a failed one's error with its code and next step. */
function Pulls({ peer }: { peer: PeerSummary }) {
  const sync = peer.sync ?? [];
  if (!sync.length) return <p className="small muted">Nothing to pull yet.</p>;
  return (
    <>
      <dl className="facts small">
        {sync.map((m) => (
          <div key={m.module} style={{ display: "contents" }}>
            <dt>{moduleName(m.module)}</dt>
            <dd>
              {m.ok === null ? (
                <State kind="off">Not pulled yet</State>
              ) : m.ok ? (
                <State kind="ok">{ago(m.lastPullAt)}</State>
              ) : (
                <State kind="bad">Failed {ago(m.lastPullAt)}</State>
              )}
              {m.ok !== null && ` · ${m.items} stored`}
              {m.invalid > 0 && `, ${m.invalid} invalid skipped`}
              {m.running && " · part way: the next pull resumes it"}
              {m.ok !== null && (
                <span className="muted">
                  {" "}
                  · {utc(m.lastPullAt)}
                  {m.lastFullSyncAt &&
                    `, everything last on ${utc(m.lastFullSyncAt)}`}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {sync
        .filter((m) => m.ok === false)
        .map((m) => (
          <Message
            key={m.module}
            kind="bad"
            title={`${moduleName(m.module)}: ${m.error}`}
            code={m.code}
            nextStep={m.nextStep}
          />
        ))}
    </>
  );
}

/** The peer's optional live-data adapter: state of charge from the CPO's own API. */
function LiveData({ peer }: { peer: PeerSummary }) {
  const id = useId();
  const run = useRun();
  const list = useList(listAdaptersAction);
  const [last, setLast] = useState<LiveDataActionState>({});
  const adapter = list.state.adapters?.find((a) => a.peerId === peer.id);
  const send = async (
    action: (
      prev: LiveDataActionState,
      form: FormData,
    ) => Promise<LiveDataActionState>,
    form: FormData,
  ) => {
    form.set("peerId", peer.id);
    const r = await run(action, form);
    setLast(r);
    await list.reload();
    return r;
  };
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <h2 className="h3" id={`${id}-h`}>
        Live data
      </h2>
      <p className="small muted">
        OCPI 2.2.1 has no state of charge. A peer can have a read-only adapter
        that reads it from the CPO&apos;s own API; the app shows it when the
        adapter returns one. Without an adapter the peer shows OCPI data only.
      </p>
      <Result state={last as ActionResult} />
      {list.loading ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : adapter ? (
        <>
          <dl className="facts small">
            <dt>Adapter</dt>
            <dd>{adapter.kindLabel}</dd>
            <dt>API URL</dt>
            <dd>
              <code>{adapter.baseUrl}</code>
            </dd>
            <dt>Account</dt>
            <dd>
              <code>{adapter.accountId}</code>
            </dd>
            <dt>API key</dt>
            <dd>Stored encrypted</dd>
            <dt>Last changed</dt>
            <dd>{utc(adapter.updatedAt)}</dd>
          </dl>
          <div>
            <ConfirmButton
              ask="Remove the adapter? The peer goes back to OCPI data only: no state of charge."
              yes="Yes, remove"
              onConfirm={() => send(removeAdapterAction, new FormData())}
            >
              Remove adapter
            </ConfirmButton>
          </div>
        </>
      ) : (
        <p className="small">
          <State kind="off">No adapter</State>
        </p>
      )}
      <details className="fold">
        <summary>
          {adapter
            ? "Replace the adapter"
            : "Read live data from the Ivora API"}
        </summary>
        <ActionForm clearOnOk onSend={(form) => send(setAdapterAction, form)}>
          <input type="hidden" name="kind" value="ivora" />
          <p className="small muted">
            For a CPO peer that runs on Ivora. Ask the CPO for its tenant ID and
            an API key with the <code>billing:read</code> scope only. The key is
            encrypted at once and never shown again.
          </p>
          <div className="field">
            <label htmlFor={`${id}-url`}>API URL</label>
            <input
              id={`${id}-url`}
              name="baseUrl"
              type="url"
              required
              maxLength={255}
              defaultValue="https://api.ivoracharge.com"
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-acct`}>Tenant ID</label>
            <input
              id={`${id}-acct`}
              name="accountId"
              required
              inputMode="numeric"
              pattern="[0-9]{1,18}"
              maxLength={18}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-key`}>Read-only API key</label>
            <input
              id={`${id}-key`}
              name="apiKey"
              type="password"
              required
              maxLength={512}
              autoComplete="off"
            />
          </div>
          <div>
            <button className="btn ghost sm" type="submit">
              Save adapter
            </button>
          </div>
        </ActionForm>
      </details>
    </section>
  );
}

function PeerBody({
  peer,
  reload,
}: {
  peer: PeerSummary;
  reload: () => Promise<unknown>;
}) {
  const run = useRun();
  const router = useRouter();
  const [last, setLast] = useState<ActionState>({});
  const [busy, setBusy] = useState(false);
  const v = viewOf(peer);
  const registered = peer.status === "registered";
  // One action of this peer at a time: a second press of Rotate, Pull, Accept or
  // Remove while the first is still on its way sends nothing (oneAtATime). The
  // buttons also show as waiting meanwhile (aria-busy).
  const [once] = useState(() =>
    oneAtATime((job: () => Promise<ActionState>) => job(), {} as ActionState),
  );
  const send: Send = (action, values) =>
    once(async () => {
      setBusy(true);
      try {
        const r = await run(action, fields(values));
        setLast(r);
        await reload();
        return r;
      } finally {
        setBusy(false);
      }
    });
  const host = (() => {
    try {
      return peer.versionsUrl ? new URL(peer.versionsUrl).host : null;
    } catch {
      return null;
    }
  })();
  return (
    <div className="cols" aria-busy={busy}>
      <div className="stack">
        <Result state={last} />
        {peer.demo && (
          <Message
            kind="wait"
            title="Built in: the demo's mock CPO."
            nextStep="Its sample data is never pulled over the network, and it has no tokens to rotate. Connect a real peer in live mode."
          />
        )}
        {peer.status === "pending" && peer.direction === "inbound" && (
          <Message
            kind="wait"
            title="Waiting for them to register."
            nextStep="They register with the one-time token and our versions URL you sent them. The token was shown once; if it is lost or has expired, remove this peer and create a new one under Connect."
          />
        )}
        {peer.hub ? (
          <>
            <PushMode peer={peer} send={send} />
            <HubParties peer={peer} send={send} />
          </>
        ) : (
          !peer.demo &&
          registered && (
            <section className="card stack" aria-label="Parties">
              <h2 className="h3">Parties</h2>
              <p>{peer.parties.join(", ") || "None declared."}</p>
            </section>
          )
        )}
        {!peer.demo && <LiveData peer={peer} />}
      </div>

      <aside className="stack">
        <section className="card stack" aria-label="Connection">
          <h2 className="h3">Connection</h2>
          <dl className="facts small">
            <dt>Status</dt>
            <dd>
              <State kind={v.state.kind}>{v.state.text}</State>
            </dd>
            <dt>Direction</dt>
            <dd>
              {peer.direction === "outbound"
                ? `We registered at the ${peer.hub ? "hub" : "CPO"}`
                : "They register with us"}
            </dd>
            {peer.hub && peer.parties.length > 0 && (
              <>
                <dt>Its roles</dt>
                <dd>{peer.parties.join(", ")}</dd>
              </>
            )}
            {peer.registeredAt && (
              <>
                <dt>Since</dt>
                <dd>{utc(peer.registeredAt)}</dd>
              </>
            )}
            {host && (
              <>
                <dt>Address</dt>
                <dd>
                  <code>{host}</code>
                </dd>
              </>
            )}
            {peer.modules.length > 0 && (
              <>
                <dt>Modules</dt>
                <dd>{peer.modules.join(", ")}</dd>
              </>
            )}
          </dl>
        </section>
        {!peer.demo && registered && (
          <section className="card stack" aria-label="Last pulls">
            <h2 className="h3">Last pulls</h2>
            <Pulls peer={peer} />
            <p className="small muted">
              Pulls read the tariffs and locations: what changed since the last
              pull, or everything. Peers also push changes as they happen.
            </p>
            <div className="row">
              <button
                className="btn ghost sm"
                type="button"
                onClick={() =>
                  send(syncPeerAction, { peerId: peer.id, intent: "changes" })
                }
              >
                <Icon name="refresh" />
                Pull changes now
              </button>
              <button
                className="btn ghost sm"
                type="button"
                onClick={() =>
                  send(syncPeerAction, { peerId: peer.id, intent: "full" })
                }
              >
                Pull everything
              </button>
            </div>
          </section>
        )}
        {!peer.demo && peer.status !== "unregistered" && (
          <section className="card stack" aria-label="Tokens and removal">
            <h2 className="h3">Tokens and removal</h2>
            {registered && (
              <p className="small muted">
                Rotating swaps both permanent tokens for new ones. Do it after a
                leak or on your own schedule. It does not repair a refused
                one-time token.
              </p>
            )}
            <div className="row">
              {registered && (
                <button
                  className="btn ghost sm"
                  type="button"
                  onClick={() =>
                    send(managePeerAction, {
                      peerId: peer.id,
                      intent: "rotate",
                    })
                  }
                >
                  Rotate tokens
                </button>
              )}
              <ConfirmButton
                ask={`Unregister ${peer.label}? Both sides stop accepting each other's tokens.`}
                yes="Yes, unregister"
                onConfirm={async () => {
                  const r = await send(managePeerAction, {
                    peerId: peer.id,
                    intent: "unregister",
                  });
                  if (r.ok) router.refresh();
                }}
              >
                Unregister
              </ConfirmButton>
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}

export function PeerPage({ id }: { id: string }) {
  const list = useList(listPeersAction);
  const peer = list.state.peers?.find((p) => p.id === id);
  const crumbs = [
    <Link key="n" href="/admin/peers">
      Network
    </Link>,
    <Link key="p" href="/admin/peers">
      Peers
    </Link>,
  ];
  return (
    <>
      <Head
        crumbs={crumbs}
        title={
          peer ? (
            <>
              {peer.label}{" "}
              <span className={peer.hub ? "tag hub" : "tag"}>
                {viewOf(peer).tag}
              </span>
            </>
          ) : (
            "Peer"
          )
        }
        lead={
          peer?.hub
            ? "One connection, several CPOs behind it. You decide which of them this network trusts."
            : undefined
        }
      />
      <Gated what={peer?.hub ? "manage this hub" : "manage this peer"}>
        {list.loading && (
          <p className="muted" role="status">
            Loading…
          </p>
        )}
        {list.done && !list.state.peers && <Result state={list.state} />}
        {list.state.peers && !peer && (
          <Message
            kind="bad"
            title="No such peer."
            code="not_found"
            nextStep={
              <>
                It may have been removed. Choose one from{" "}
                <Link href="/admin/peers">Peers</Link>.
              </>
            }
          />
        )}
        {peer && <PeerBody peer={peer} reload={list.reload} />}
      </Gated>
    </>
  );
}
