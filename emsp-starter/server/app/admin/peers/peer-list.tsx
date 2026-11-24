"use client";

import Link from "next/link";
import { useAdmin } from "../ui/admin-context";
import { listAdaptersAction } from "../live-data/actions";
import { Head, Icon, Message, Result, State, Tile, utc } from "../ui/kit";
import { ago, Gated, OurParty, OurVersionsUrl } from "../ui/parts";
import { useList } from "../ui/use-action";
import { listPeersAction, type PeerSummary } from "./actions";
import { inARow, moduleName, sendTheCpo, viewOf } from "./peer-view";

/** A peer is a row you open; its actions are on its own page. */
export function PeerRow({ peer }: { peer: PeerSummary }) {
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
            title={`${moduleName(m.module)} pull from ${peer.label} failed ${ago(m.lastPullAt)}${inARow(m) ? `, ${inARow(m)}` : ""}: ${m.error}`}
            code={m.code}
            nextStep={[m.nextStep, sendTheCpo(m)].filter(Boolean).join(" ")}
          />
        </div>
      ))}
    </li>
  );
}

/**
 * Every live-data adapter in one place, each with a link to its peer's page, where it
 * is set, replaced and removed.
 */
function Adapters() {
  const list = useList(listAdaptersAction);
  const adapters = list.state.adapters ?? [];
  return (
    <section className="stack" id="live-data" aria-labelledby="adapters-h">
      <h2 id="adapters-h">Live-data adapters</h2>
      <p className="muted">
        OCPI 2.2.1 has no state of charge. A peer can have a read-only adapter
        that reads it from the CPO&apos;s own API; set, replace or remove it on
        the peer&apos;s page.
      </p>
      {list.loading ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : list.state.ok === false ? (
        <Result state={list.state} />
      ) : adapters.length === 0 ? (
        <p className="card flat muted" role="status">
          No peer has an adapter: every peer shows OCPI data only.
        </p>
      ) : (
        <div className="card tablecard">
          <table className="data">
            <caption className="sr">Live-data adapters, by peer</caption>
            <thead>
              <tr>
                <th scope="col">Peer</th>
                <th scope="col">Adapter</th>
                <th scope="col">API URL</th>
                <th scope="col">Account</th>
                <th scope="col">API key</th>
                <th scope="col">Last changed</th>
              </tr>
            </thead>
            <tbody>
              {adapters.map((a) => (
                <tr key={a.peerId}>
                  <th scope="row" className="c-main">
                    <Link href={`/admin/peers/${a.peerId}`}>{a.peerLabel}</Link>
                    <span className="sub mono">{a.peerId}</span>
                  </th>
                  <td className="c-kv" data-l="Adapter">
                    {a.kindLabel}
                  </td>
                  <td className="c-kv" data-l="API URL">
                    <span className="mono">{a.baseUrl}</span>
                  </td>
                  <td className="c-kv" data-l="Account">
                    <span className="mono">{a.accountId}</span>
                  </td>
                  <td className="c-kv" data-l="API key">
                    Stored encrypted
                  </td>
                  <td className="c-kv" data-l="Last changed">
                    {utc(a.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="foot">
            <span>{list.state.message}</span>
          </div>
        </div>
      )}
    </section>
  );
}

export function PeerList({
  versionsUrl,
  party,
  version,
}: {
  /** Our versions URL and party: null unless an admin is signed in by email. */
  versionsUrl: string | null;
  party: string | null;
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
            <Adapters />
          </div>
          <aside className="card stack">
            <h2 className="h3">Our side</h2>
            <p className="small muted">
              A peer that registers with us asks for this address. It is public
              and safe to share; tokens are not.
            </p>
            <OurVersionsUrl url={versionsUrl} />
            <dl className="facts small">
              <dt>Party</dt>
              <dd>
                <OurParty party={party} />
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
