"use client";

import Link from "next/link";
import { useAdmin } from "../ui/admin-context";
import { Head, Icon, Message, Result, State, Tile } from "../ui/kit";
import { ago, Copy, Gated } from "../ui/parts";
import { useList } from "../ui/use-action";
import { listPeersAction, type PeerSummary } from "./actions";
import { moduleName, viewOf } from "./peer-view";

/** A peer is a row you open; its actions are on its own page. */
function PeerRow({ peer }: { peer: PeerSummary }) {
  const v = viewOf(peer);
  const total = v.trusted + v.offered;
  const tile =
    v.state.kind === "bad" ? (
      <Tile kind="bad" big="!" />
    ) : peer.status !== "registered" ? (
      <Tile
        kind="off"
        big={peer.status === "pending" ? <Icon name="clock" /> : "–"}
      />
    ) : peer.hub ? (
      <Tile
        kind={v.trusted ? "ok" : "todo"}
        big={String(v.trusted)}
        small={`of ${total}`}
      />
    ) : (
      <Tile kind="ok" big={<Icon name="check" />} />
    );
  const meta = [
    peer.hub
      ? `${v.trusted} of ${total} parties trusted`
      : peer.parties.join(", "),
    peer.demo
      ? "built in, never pulled over the network"
      : peer.status === "registered"
        ? v.lastPullAt
          ? `pulled ${ago(v.lastPullAt)}`
          : "not pulled yet"
        : "",
  ].filter(Boolean);
  return (
    <li>
      <Link className="item" href={`/admin/peers/${peer.id}`}>
        {tile}
        <div className="what">
          <h2 className="h3">
            {peer.label}{" "}
            <span className={v.tag === "Hub" ? "tag hub" : "tag"}>{v.tag}</span>
          </h2>
          <p>
            <State kind={v.state.kind}>{v.state.text}</State>
          </p>
          {meta.length > 0 && <p className="meta">{meta.join(" · ")}</p>}
        </div>
        <span className="go">
          <Icon name="arrow" />
        </span>
      </Link>
      {v.failing.map((m) => (
        <div key={m.module} style={{ marginTop: "0.5rem" }}>
          <Message
            kind="bad"
            title={`${moduleName(m.module)} pull from ${peer.label} failed ${ago(m.lastPullAt)}: ${m.error}`}
            code={m.code}
            nextStep={m.nextStep}
          />
        </div>
      ))}
    </li>
  );
}

export function PeerList({
  versionsUrl,
  party,
  version,
}: {
  versionsUrl: string;
  party: string;
  version: string;
}) {
  const { signedIn, demo } = useAdmin();
  const list = useList(listPeersAction);
  const peers = list.state.peers;
  return (
    <>
      <Head
        crumbs={["Network"]}
        title="Peers"
        lead="The charging operators and roaming hubs this network is connected to over OCPI."
        action={
          signedIn && (
            <Link className="btn" href="/admin/peers/connect">
              <Icon name="plus" />
              Connect a peer
            </Link>
          )
        }
      />
      <Gated what="see your peers">
        <div className="cols">
          <div className="stack">
            {demo && (
              <p className="muted">
                Demo mode: peers are kept in memory only, and nothing is sent to
                a CPO, so registering at one is refused.
              </p>
            )}
            {list.loading && (
              <p className="muted" role="status">
                Loading…
              </p>
            )}
            {list.done && !peers && <Result state={list.state} />}
            {peers && peers.length === 0 && (
              <div className="card flat stack">
                <div className="row">
                  <Tile kind="off" big="0" small="peers" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h2>No peers yet</h2>
                    <p className="muted">
                      Drivers see chargers once a CPO or a roaming hub is
                      connected and its locations are pulled.
                    </p>
                  </div>
                </div>
                <div>
                  <Link className="btn ghost" href="/admin/peers/connect">
                    <Icon name="plus" />
                    Connect the first peer
                  </Link>
                </div>
              </div>
            )}
            {peers && peers.length > 0 && (
              <ul className="list" aria-label="Peers">
                {peers.map((p) => (
                  <PeerRow key={p.id} peer={p} />
                ))}
              </ul>
            )}
          </div>
          <aside className="card stack">
            <h2 className="h3">Our side</h2>
            <p className="small muted">
              A peer that registers with us asks for this address. It is public
              and safe to share; tokens are not.
            </p>
            <Copy text={versionsUrl} label="Our versions URL" />
            <dl className="facts small">
              <dt>Party</dt>
              <dd>
                <code>{party}</code>
              </dd>
              <dt>Role</dt>
              <dd>eMSP, OCPI {version}</dd>
            </dl>
          </aside>
        </div>
      </Gated>
    </>
  );
}
