"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { useAdmin } from "../../ui/admin-context";
import { Head, Icon, Message, Result, State, Tile, utc } from "../../ui/kit";
import { ActionForm, Copy, Gated, OurVersionsUrl } from "../../ui/parts";
import { useAction } from "../../ui/use-action";
import {
  connectPeerAction,
  invitePeerAction,
  type ActionState,
  type PeerSummary,
} from "../actions";
import { tokenRefused } from "../refused";

type Given = "hub" | "cpo" | "invite";

/** The words of each path: a hub's portal and a CPO do not call things the same. */
const WORDS = {
  hub: {
    crumb: "Roaming hub",
    title: "Connect a roaming hub",
    them: "the hub",
    urlLabel: "Hub versions URL",
    urlHint:
      "From the hub's portal. It starts with https:// and usually ends in /versions.",
    tokenLabel: "One-time token",
    tokenHint:
      "The hub's portal may call it a registration token, credentials token or Token A.",
    nameHint: "What you call this hub. Only admins see it.",
    placeholder: "https://hub.example.net/ocpi/versions",
  },
  cpo: {
    crumb: "CPO",
    title: "Connect a CPO",
    them: "the CPO",
    urlLabel: "CPO versions URL",
    urlHint:
      "The CPO sends it with the token. It starts with https:// and usually ends in /versions.",
    tokenLabel: "Token A",
    tokenHint:
      "The one-time token the CPO gave you. It may call it a registration or credentials token.",
    nameHint: "What you call this CPO. Only admins see it.",
    placeholder: "https://cpo.example.com/ocpi/versions",
  },
} as const;

function Progress({ now, fail }: { now: 1 | 2 | 4; fail?: boolean }) {
  return (
    <ol className="progress" aria-label="Steps">
      {["Token", "Handshake", "Registered"].map((s, i) => {
        const n = i + 1;
        return (
          <li
            key={s}
            className={
              n < now ? "done" : n === now ? (fail ? "fail" : "now") : undefined
            }
            aria-current={n === now ? "step" : undefined}
          >
            {n}. {s}
          </li>
        );
      })}
    </ol>
  );
}

function WhatHappens({ given }: { given: "hub" | "cpo" }) {
  const them = WORDS[given].them;
  const Them = them[0].toUpperCase() + them.slice(1);
  return (
    <aside className="card stack">
      <h2 className="h3">What happens</h2>
      <ol className="steps small">
        <li>
          <p>We read {them}&apos;s versions and choose OCPI 2.2.1.</p>
        </li>
        <li>
          <p>Our credentials are sent with the one-time token.</p>
        </li>
        <li>
          <p>
            {Them} answers with a permanent token. We keep {them}&apos;s token
            encrypted and ours only as a hash. The one-time token is now spent.
          </p>
        </li>
        <li>
          <p>
            {Them} shows as <strong>Registered</strong>.
            {given === "hub"
              ? " Nothing flows yet: you accept the parties you trade with next."
              : " Its locations and tariffs are pulled from its own page."}
          </p>
        </li>
      </ol>
      {given === "hub" && (
        <p className="small muted">
          Which CPOs the hub sends you, and what from them, is a{" "}
          <strong>subscription you set in the hub&apos;s own portal</strong>,
          not here.
        </p>
      )}
    </aside>
  );
}

/** What Registered looks like, and what comes next. */
function Registered({ peer }: { peer: PeerSummary }) {
  const parties = peer.hub?.parties ?? [];
  const trusted = parties.filter((p) => p.status === "trusted").length;
  return (
    <div className="cols">
      <div className="stack">
        <Message kind="ok" title={`Registered with ${peer.label}.`}>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <State kind="ok">Registered</State>
            </dd>
            <dt>It is a</dt>
            <dd>{peer.hub ? "Roaming hub" : "CPO"}</dd>
            {peer.parties.length > 0 && (
              <>
                <dt>Its roles</dt>
                <dd>{peer.parties.join(", ")}</dd>
              </>
            )}
            <dt>Offers</dt>
            <dd>{peer.modules.join(", ") || "no modules"}</dd>
            {peer.registeredAt && (
              <>
                <dt>Since</dt>
                <dd>{utc(peer.registeredAt)}</dd>
              </>
            )}
            <dt>One-time token</dt>
            <dd>Spent. It is not kept anywhere.</dd>
          </dl>
        </Message>
        {peer.hub ? (
          <section className="gate" aria-labelledby="next-h">
            <Tile
              kind="todo"
              big={String(trusted)}
              small={`of ${parties.length}`}
            />
            <h2 id="next-h">Next: accept parties</h2>
            <p>
              The hub is connected but idle.{" "}
              {parties.length
                ? `It lists ${parties.length} ${parties.length === 1 ? "CPO" : "CPOs"}; none is trusted yet, so nothing is pulled or pushed.`
                : "No party is trusted yet, so nothing is pulled or pushed."}{" "}
              Accept the ones you have an agreement with.
            </p>
            <Link className="btn" href={`/admin/peers/${peer.id}`}>
              Accept parties <Icon name="arrow" />
            </Link>
          </section>
        ) : (
          <section className="gate" aria-labelledby="next-h">
            <Tile kind="brand" big={<Icon name="refresh" />} />
            <h2 id="next-h">Next: pull its locations</h2>
            <p>
              The CPO is connected. Drivers see its chargers once its tariffs
              and locations are pulled, from its own page or by the scheduled
              job.
            </p>
            <Link className="btn" href={`/admin/peers/${peer.id}`}>
              Open {peer.label} <Icon name="arrow" />
            </Link>
          </section>
        )}
      </div>
      {peer.hub && (
        <aside className="card stack">
          <h2 className="h3">Subscriptions live at the hub</h2>
          <p className="small">
            Accepting a party here says <strong>you trust it</strong>. Whether
            the hub <strong>sends you its data</strong> is a subscription you
            set in the hub&apos;s own portal. You need both.
          </p>
        </aside>
      )}
    </div>
  );
}

/**
 * The refused-token state. In this flow the token that was refused is the one-time
 * token, so the next step is a new one, not a rotation. Today's answer cannot tell a
 * first registration from a peer the hub already has registered, so the second next
 * step is shown too.
 */
export function Refused({
  state,
  given,
}: {
  state: ActionState;
  given: "hub" | "cpo";
}) {
  const them = WORDS[given].them;
  const Them = them[0].toUpperCase() + them.slice(1);
  const where = given === "hub" ? "in the hub's portal" : "from the CPO";
  return (
    <Message
      kind="bad"
      title={`${Them} refused the one-time token. Nothing was stored on either side.`}
      code={state.code}
      nextStep={
        <>
          Get a new one-time token {where} and paste it below. Rotating tokens
          does not help here: there is no registration to rotate yet. If {them}{" "}
          already shows as Registered under{" "}
          <Link href="/admin/peers">Peers</Link>, open it there and rotate its
          tokens instead.
        </>
      }
    >
      <p className="small muted">{state.message}</p>
      <p className="label">Usual reasons</p>
      <ul className="bullets">
        <li>
          <strong>Already used.</strong> The first handshake that reaches {them}{" "}
          may spend the token, even if it failed later. If {them} shows this
          network as registered, ask it to reset the registration, then issue a
          new token.
        </li>
        <li>
          <strong>Expired, or from the other environment.</strong> Test and
          production have different tokens and different versions URLs.
        </li>
        <li>
          <strong>Copied with a space or a line break</strong> at either end.
        </li>
      </ul>
    </Message>
  );
}

function Register({
  given,
  versionsUrl,
  back,
}: {
  given: "hub" | "cpo";
  versionsUrl: string | null;
  back: () => void;
}) {
  const w = WORDS[given];
  const id = useId();
  const connect = useAction(connectPeerAction);
  const { state, pending } = connect;
  // What was typed, kept for the next try: a new token is all that changes.
  const [typed, setTyped] = useState({ label: "", versionsUrl: "" });
  const refused = tokenRefused(state);
  const failed = connect.done && state.ok === false;
  const crumbs = [
    <Link key="n" href="/admin/peers">
      Network
    </Link>,
    <button key="c" type="button" className="crumb-link" onClick={back}>
      Connect
    </button>,
    w.crumb,
  ];
  if (state.ok && state.peer)
    return (
      <div className="stack">
        <Head crumbs={crumbs} title={w.title} />
        <Progress now={4} />
        <Registered peer={state.peer} />
      </div>
    );
  return (
    <div className="stack">
      <Head crumbs={crumbs} title={w.title} />
      <Progress now={pending || failed ? 2 : 1} fail={failed && !pending} />
      <div className="cols">
        <div className="stack">
          {pending && (
            <section className="card stack" aria-live="polite">
              <h2>Handshake with {typed.label || w.them}</h2>
              <p className="row" style={{ flexWrap: "nowrap" }}>
                <span className="spin" aria-hidden="true" />
                <span>
                  Reading its versions and endpoints, sending our credentials
                  with the one-time token, storing the permanent token.
                </span>
              </p>
              <p className="small muted">
                This takes a few seconds. Keep the page open.
              </p>
            </section>
          )}
          {!pending &&
            failed &&
            (refused ? (
              <Refused state={state} given={given} />
            ) : (
              <Result state={state} />
            ))}
          <ActionForm
            className="card form"
            hidden={pending}
            onSend={(form) => {
              setTyped({
                label: String(form.get("label") ?? ""),
                versionsUrl: String(form.get("versionsUrl") ?? ""),
              });
              return connect.run(form);
            }}
          >
            <div className="field">
              <label htmlFor={`${id}-name`}>Name</label>
              <input
                id={`${id}-name`}
                name="label"
                maxLength={100}
                required
                defaultValue={typed.label}
                aria-describedby={`${id}-name-h`}
              />
              <span className="hint" id={`${id}-name-h`}>
                {w.nameHint}
              </span>
            </div>
            <div className="field">
              <label htmlFor={`${id}-url`}>{w.urlLabel}</label>
              <input
                id={`${id}-url`}
                name="versionsUrl"
                type="url"
                required
                placeholder={w.placeholder}
                defaultValue={typed.versionsUrl}
                aria-describedby={`${id}-url-h`}
              />
              <span className="hint" id={`${id}-url-h`}>
                {w.urlHint}
              </span>
            </div>
            <div className="field">
              <label htmlFor={`${id}-tok`}>{w.tokenLabel}</label>
              <input
                id={`${id}-tok`}
                name="tokenA"
                type="password"
                autoComplete="off"
                maxLength={64}
                required
                aria-describedby={`${id}-tok-h`}
              />
              <span className="hint" id={`${id}-tok-h`}>
                {refused ? "Paste the new token." : w.tokenHint} It works once:
                the handshake trades it for permanent tokens.
              </span>
            </div>
            <button className="btn wide" type="submit">
              {refused ? "Try again with the new token" : "Start the handshake"}
            </button>
          </ActionForm>
        </div>
        {refused ? (
          <aside className="card stack">
            <h2 className="h3">If {w.them} asks for our address</h2>
            <p className="small muted">
              Some portals want your versions URL before they issue a token.
            </p>
            <OurVersionsUrl url={versionsUrl} />
          </aside>
        ) : (
          <WhatHappens given={given} />
        )}
      </div>
    </div>
  );
}

function Invite({
  versionsUrl,
  back,
}: {
  versionsUrl: string | null;
  back: () => void;
}) {
  const id = useId();
  const invite = useAction(invitePeerAction);
  const { state } = invite;
  const crumbs = [
    <Link key="n" href="/admin/peers">
      Network
    </Link>,
    <button key="c" type="button" className="crumb-link" onClick={back}>
      Connect
    </button>,
    "They register with us",
  ];
  return (
    <div className="stack">
      <Head
        crumbs={crumbs}
        title="Let them register with us"
        lead="Create a one-time token here and send it to them with our versions URL."
      />
      <div className="cols">
        <div className="stack">
          {state.ok && state.tokenA ? (
            <>
              <Message
                kind="ok"
                title={`One-time token for ${state.peer?.label ?? "the peer"} created.`}
              >
                <p>
                  Send them both of these over a secure channel. The token is
                  shown only this once (we keep only its hash) and works until{" "}
                  {utc(state.expiresAt)}.
                </p>
                <p className="label">Our versions URL</p>
                <OurVersionsUrl url={state.versionsUrl ?? versionsUrl} />
                <p className="label">One-time token (Token A)</p>
                <Copy text={state.tokenA} label="One-time token" />
              </Message>
              <p>
                It shows under Peers as{" "}
                <State kind="todo">Waiting for them to register</State> until
                they do.
              </p>
              <div className="row">
                <Link className="btn" href="/admin/peers">
                  See peers <Icon name="arrow" />
                </Link>
              </div>
            </>
          ) : (
            <>
              <Result state={state} />
              <ActionForm className="card form" onSend={invite.run}>
                <div className="field">
                  <label htmlFor={`${id}-name`}>Name</label>
                  <input
                    id={`${id}-name`}
                    name="label"
                    maxLength={100}
                    required
                    aria-describedby={`${id}-name-h`}
                  />
                  <span className="hint" id={`${id}-name-h`}>
                    What you call this CPO or hub. Only admins see it.
                  </span>
                </div>
                <button className="btn wide" type="submit">
                  Create the one-time token
                </button>
              </ActionForm>
            </>
          )}
        </div>
        <aside className="card stack">
          <h2 className="h3">What happens</h2>
          <ol className="steps small">
            <li>
              <p>
                We create a one-time token (OCPI calls it Token A) and keep only
                its hash.
              </p>
            </li>
            <li>
              <p>You send them the token and our versions URL.</p>
            </li>
            <li>
              <p>
                They register with it. The token is then spent, and the peer
                shows as <strong>Registered</strong>.
              </p>
            </li>
          </ol>
        </aside>
      </div>
    </div>
  );
}

const CHOICES: [Given, "hub" | "bolt" | "out", string, string][] = [
  [
    "hub",
    "hub",
    "A roaming hub gave me a one-time token",
    "Register once at the hub, then choose which of the CPOs behind it you trust.",
  ],
  [
    "cpo",
    "bolt",
    "A CPO gave me a token",
    "Register directly at one charging operator with its versions URL and Token A.",
  ],
  [
    "invite",
    "out",
    "They will register with us",
    "Create a one-time token here and send it to them with our versions URL.",
  ],
];

export function Connect({
  versionsUrl,
}: {
  /** Our versions URL: null unless an admin is signed in by email. */
  versionsUrl: string | null;
}) {
  const { demo } = useAdmin();
  const [given, setGiven] = useState<Given | null>(null);
  const back = () => setGiven(null);
  return (
    <Gated what="connect a peer">
      {given === null && (
        <>
          <Head
            crumbs={[
              <Link key="n" href="/admin/peers">
                Network
              </Link>,
              "Connect",
            ]}
            title="Connect a peer"
            lead="Start from what you were given."
          />
          {demo && (
            <p className="muted" style={{ marginBottom: "1rem" }}>
              Demo mode: nothing is sent to a CPO or a hub, so registering at
              one is refused. A one-time token for them to register with us is
              created in memory only.
            </p>
          )}
          <ul className="choice">
            {CHOICES.map(([id, icon, title, text]) => (
              <li key={id}>
                <button
                  type="button"
                  className="item"
                  onClick={() => setGiven(id)}
                >
                  <Tile kind="brand" big={<Icon name={icon} />} />
                  <span className="what">
                    <span className="h3">{title}</span>
                    <span className="meta">{text}</span>
                  </span>
                  <span className="go">
                    <Icon name="arrow" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {(given === "hub" || given === "cpo") && (
        // A new form (and a new answer) for each path.
        <Register
          key={given}
          given={given}
          versionsUrl={versionsUrl}
          back={back}
        />
      )}
      {given === "invite" && <Invite versionsUrl={versionsUrl} back={back} />}
    </Gated>
  );
}
