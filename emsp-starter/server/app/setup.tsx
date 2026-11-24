"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { listPeersAction, type ActionState } from "./admin/peers/actions";
import { firstAdminSql } from "./admin/sign-in/states";
import { useAdmin } from "./admin/ui/admin-context";
import { Head, Icon, Result, State, Tile, type Kind } from "./admin/ui/kit";
import { Copy, Gate, Later, OurParty } from "./admin/ui/parts";
import { useList } from "./admin/ui/use-action";

/**
 * What every visitor's page carries: the mode, which the banner shows, and three
 * constants of the code (how many live-mode settings there are, the sign-in code
 * limit, the OCPI version). Nothing here says which setting is set, unset or
 * malformed, or who this deployment is. The page shows none of it until an admin is
 * signed in.
 */
export type SetupFacts = {
  demo: boolean;
  /** How many live-mode settings there are: a constant, not this deployment's state. */
  required: number;
  codesPerHour: number;
  /** The OCPI version this code implements: a constant. */
  version: string;
  /** Our OCPI party, sent by the server only to an admin signed in by email. */
  party: string | null;
  /**
   * Read by the server only for an admin signed in by email (the session cookie), and
   * null for everyone else: a visitor's page never carries the name of an unset or
   * malformed setting, nor whether the payment or job secrets are set. An admin-secret
   * sign-in lives in the page's memory, which the server cannot see when it renders,
   * so the stops that need these say "cannot check".
   */
  settings: SetupSettings | null;
};

export type SetupSettings = {
  /** Names of the unset live-mode settings. */
  missing: string[];
  /** What is wrong with a set value, live-mode or optional: "<NAME> must ...". */
  errors: string[];
  /** How many live-mode settings are set but malformed. */
  malformed: number;
  /** PUBLIC_BASE_URL, when it is set. */
  baseUrl: string | null;
  stripeKey: boolean;
  webhookSecret: boolean;
  cronSecret: boolean;
  /** The hold per charge, per currency, as text. */
  holds: string[];
};

const SECRET_ONLY =
  "This page reads these settings only for an admin signed in by email, not for the admin secret.";

/**
 * A stop is Done, Needs you, Broken or Waiting, or the page cannot tell yet: "Cannot
 * check from here" (the server read for it comes later; its fix is shown either way).
 */
type StopKind = "ok" | "todo" | "bad" | "off" | "unknown";
type Stop = {
  kind: StopKind;
  big: ReactNode;
  small?: string;
  title: string;
  text: ReactNode;
  /** Always shown: a limit of the deployment. */
  note?: ReactNode;
  fix?: ReactNode;
};

const LABEL: Record<StopKind, [Kind, "ok" | "todo" | "bad" | "off", string]> = {
  ok: ["ok", "ok", "Done"],
  todo: ["todo", "todo", "Needs you"],
  bad: ["bad", "bad", "Broken"],
  off: ["off", "off", "Waiting"],
  unknown: ["off", "off", "Cannot check from here"],
};

const NAMES = [
  "Environment",
  "Database",
  "Payments webhook",
  "Scheduled job",
  "First admin",
  "First peer",
];

const EVENTS = `payment_intent.amount_capturable_updated
payment_intent.canceled
payment_intent.succeeded
payment_intent.payment_failed
charge.refunded
charge.expired
charge.dispute.created
refund.created
refund.updated
refund.failed
setup_intent.succeeded`;

function StopItem({ n, stop, next }: { n: number; stop: Stop; next: boolean }) {
  const [tile, state, word] = LABEL[stop.kind];
  const label = (
    <>
      <span>
        {n} · {NAMES[n - 1].toUpperCase()}
      </span>
      <State kind={state}>{word}</State>
    </>
  );
  // A done stop is one line; open it for the detail.
  if (stop.kind === "ok")
    return (
      <li className="stop folded" id={`stop-${n}`}>
        <details>
          <summary className="top">
            <Tile kind={tile} big={stop.big} small={stop.small} size="sm" />
            <span className="what">
              <span className="n row between">{label}</span>
              <span className="h3">{stop.title}</span>
            </span>
          </summary>
          <p className="more">{stop.text}</p>
        </details>
      </li>
    );
  return (
    <li className={next ? "stop next" : "stop"} id={`stop-${n}`}>
      <div className="top">
        <Tile kind={tile} big={stop.big} small={stop.small} />
        <div className="what">
          <p className="n row between">{label}</p>
          <h3>{stop.title}</h3>
          <p>{stop.text}</p>
        </div>
      </div>
      {(stop.note || stop.fix) && (
        <div className="fix">
          {stop.note}
          {/* The next stop's fix is open; the others wait behind one line on a phone. */}
          {stop.fix && (next ? stop.fix : <Later>{stop.fix}</Later>)}
        </div>
      )}
    </li>
  );
}

const Fix = ({
  label = "Fix",
  children,
}: {
  label?: string;
  children: ReactNode;
}) => (
  <>
    <p className="label">{label}</p>
    {children}
  </>
);

const KEY_COMMAND = "openssl rand -base64 32";

function environment(facts: SetupFacts): Stop {
  const f = facts.settings;
  // Live mode means every setting is right: the server is in demo mode otherwise.
  if (!f && !facts.demo)
    return {
      kind: "ok",
      big: String(facts.required),
      small: `of ${facts.required}`,
      title: "Environment complete",
      text: "This server is out of demo mode, so all live-mode settings are present and well formed.",
    };
  if (!f)
    return {
      kind: "unknown",
      big: "?",
      small: `of ${facts.required}`,
      title: "Environment",
      text: (
        <>
          This server runs in demo mode with sample data and stores nothing:
          either <code>DEMO_MODE</code> is set, or a setting is unset or
          malformed. Which one, this page says only to an admin signed in by
          email, not for the admin secret, and demo mode has no admin accounts.
        </>
      ),
      fix: (
        <Fix label="Check by hand">
          <ol className="steps">
            <li>
              <p>
                Compare your hosting project&apos;s environment variables with
                the list in the server README (Connect real services): every
                live-mode setting set and well formed, no malformed optional
                one, and <code>DEMO_MODE</code> removed.
              </p>
            </li>
            <li>
              <p>
                No <code>OCPI_TOKEN_ENCRYPTION_KEY</code> yet? Make the key on
                your machine. Keep it: losing or changing it later locks out
                every stored peer token.
              </p>
              <Copy text={KEY_COMMAND} label="Command" />
            </li>
            <li>
              <p>
                Redeploy, then open this page again. A changed variable only
                reaches a new deployment.
              </p>
            </li>
          </ol>
        </Fix>
      ),
    };
  const good = facts.required - f.missing.length - f.malformed;
  if (!f.missing.length && !f.errors.length)
    return facts.demo
      ? {
          kind: "todo",
          big: String(facts.required),
          small: `of ${facts.required}`,
          title: "Demo mode is switched on",
          text: (
            <>
              Every live-mode setting is present and well formed, but{" "}
              <code>DEMO_MODE</code> is set, so this server runs on sample data
              and stores nothing.
            </>
          ),
          fix: (
            <Fix>
              <ol className="steps">
                <li>
                  <p>
                    Remove <code>DEMO_MODE</code> from your hosting
                    project&apos;s environment variables.
                  </p>
                </li>
                <li>
                  <p>
                    Redeploy. A changed variable only reaches a new deployment.
                  </p>
                </li>
              </ol>
            </Fix>
          ),
        }
      : {
          kind: "ok",
          big: String(facts.required),
          small: `of ${facts.required}`,
          title: "Environment complete",
          text: "All live-mode settings are present and well formed. This page only ever shows their names, never their values.",
        };
  const count = f.missing.length + f.errors.length;
  const key =
    f.missing.includes("OCPI_TOKEN_ENCRYPTION_KEY") ||
    f.errors.some((e) => e.startsWith("OCPI_TOKEN_ENCRYPTION_KEY"));
  return {
    kind: "todo",
    big: String(Math.max(0, good)),
    small: `of ${facts.required}`,
    title: count === 1 ? "One setting needs you" : `${count} settings need you`,
    text: "Until every live-mode setting is right, this server runs in demo mode with sample data and stores nothing. Names only are shown here, never values.",
    fix: (
      <>
        <ul className="found">
          {f.missing.map((name) => (
            <li key={name}>
              <State kind="bad">Missing</State>
              <span>
                <code>{name}</code> is not set.
              </span>
            </li>
          ))}
          {f.errors.map((e) => {
            const [name, ...rest] = e.split(" ");
            return (
              <li key={e}>
                <State kind="todo">Malformed</State>
                <span>
                  <code>{name}</code> {rest.join(" ")}.
                </span>
              </li>
            );
          })}
        </ul>
        <Fix>
          <ol className="steps">
            {key && (
              <li>
                <p>
                  Make the key for <code>OCPI_TOKEN_ENCRYPTION_KEY</code> on
                  your machine. Keep it: losing or changing it later locks out
                  every stored peer token.
                </p>
                <Copy text={KEY_COMMAND} label="Command" />
              </li>
            )}
            <li>
              <p>
                Set each variable above in your hosting project&apos;s
                environment variables. The server README lists what each one
                takes (Connect real services).
              </p>
            </li>
            <li>
              <p>
                Redeploy, then open this page again. A changed variable only
                reaches a new deployment.
              </p>
            </li>
          </ol>
        </Fix>
      </>
    ),
  };
}

const database: Stop = {
  kind: "unknown",
  big: "?",
  title: "Database migrations",
  text: "This page cannot count the applied migrations yet. Sign-in, peers and payments all need the tables first, so check by hand if any of them fails.",
  fix: (
    <Fix label="Fix, if the tables are missing">
      <ol className="steps">
        <li>
          <p>
            From your machine, in <code>server/</code>, with{" "}
            <code>SUPABASE_DB_URL</code> in <code>.env.local</code>:
          </p>
          <Copy text="npm run db:migrate" label="Command" />
        </li>
        <li>
          <p>
            No database URL? Run the files in <code>supabase/migrations</code>{" "}
            in the SQL editor, in file-name order.
          </p>
        </li>
      </ol>
    </Fix>
  ),
};

function webhook(f: SetupFacts): Stop {
  const address = `${f.settings?.baseUrl ?? "https://<this deployment>"}/api/webhooks/stripe`;
  const fix = (
    <Fix>
      <ol className="steps">
        <li>
          <p>
            In the Stripe Dashboard of the network&apos;s account, add a webhook
            endpoint with this address:
          </p>
          <Copy text={address} label="Webhook endpoint address" />
        </li>
        <li>
          <p>Subscribe it to these 11 events:</p>
          <Copy text={EVENTS} label="Events" />
        </li>
        <li>
          <p>
            Copy the endpoint&apos;s signing secret (it starts with{" "}
            <code>whsec_</code>) into <code>STRIPE_WEBHOOK_SECRET</code> and
            redeploy.
          </p>
        </li>
        <li>
          <p>
            Send a test event from the Dashboard. Stripe shows there whether
            this server answered it with a 200.
          </p>
        </li>
      </ol>
      <p className="small muted">
        Events arrive but are refused? Then the signing secret is from another
        endpoint or from the other mode (test or live). Copy it again from this
        endpoint.
      </p>
    </Fix>
  );
  if (!f.settings)
    return {
      kind: "unknown",
      big: "?",
      title: "Payments webhook",
      text: `${SECRET_ONLY} Until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set and one signed event has arrived, do not take card payments.`,
      fix,
    };
  const unset = [
    !f.settings.stripeKey && "STRIPE_SECRET_KEY",
    !f.settings.webhookSecret && "STRIPE_WEBHOOK_SECRET",
  ].filter((v): v is string => Boolean(v));
  if (unset.length)
    return {
      kind: "todo",
      big: "0",
      small: "events",
      title: "Payments are not set up",
      text: (
        <>
          {unset.map((name, i) => (
            <span key={name}>
              {i > 0 && " and "}
              <code>{name}</code>
            </span>
          ))}{" "}
          {unset.length === 1 ? "is" : "are"} not set, so no signed payment
          event can arrive and every paid start is refused. Do not take card
          payments until one signed event has arrived.
        </>
      ),
      fix,
    };
  return {
    kind: "unknown",
    big: "?",
    title: "Payments webhook",
    text: "The payment settings are present. This page cannot see yet whether a signed event has arrived: until one has, a hold, capture or refund the payment provider reports would go unnoticed here.",
    fix,
  };
}

function job(f: SetupFacts): Stop {
  const request = `GET ${f.settings?.baseUrl ?? "https://<this deployment>"}/api/cron/ocpi-sync
Authorization: Bearer <CRON_SECRET>`;
  const note = (
    <div className="msg limit" role="note">
      <p className="t">
        <Icon name="alert" />
        <span>
          Free hosting limit: on a once-a-day schedule drivers cannot start a
          paid charge.
        </span>
      </p>
      <p>
        A card hold is refused when the payment sweep is older than 5 minutes.
        Free plans on most hosts run scheduled jobs once a day at most, and the
        template&apos;s <code>vercel.json</code> ships with once a day.
      </p>
    </div>
  );
  const fix = (
    <Fix label="Fix: run it every minute">
      <ol className="steps">
        {!f.settings?.cronSecret && (
          <li>
            <p>
              Set <code>CRON_SECRET</code> (at least 32 characters)
              {f.settings ? "" : ", if it is not set yet,"} and redeploy. The
              job answers only with it.
            </p>
          </li>
        )}
        <li>
          <p>
            On a paid hosting plan: set the schedule in <code>vercel.json</code>{" "}
            to <code className="nw">* * * * *</code> and redeploy.
          </p>
        </li>
        <li>
          <p>
            Or keep free hosting and call the job from any scheduler, every
            minute:
          </p>
          <Copy text={request} label="Request" />
        </li>
      </ol>
    </Fix>
  );
  if (!f.settings)
    return {
      kind: "unknown",
      big: "?",
      title: "Scheduled job",
      text: `${SECRET_ONLY} Without CRON_SECRET the job never runs: no pulls, no token push retries, no payment sweep.`,
      note,
      fix,
    };
  return f.settings.cronSecret
    ? {
        kind: "unknown",
        big: "?",
        title: "Scheduled job",
        text: "The job's secret is set. This page cannot see yet how often the job really runs, or when it last ran.",
        note,
        fix,
      }
    : {
        kind: "todo",
        big: "0",
        small: "runs",
        title: "The scheduled job is off",
        text: (
          <>
            <code>CRON_SECRET</code> is not set, so the job never runs: no
            pulls, no token push retries, no payment sweep.
          </>
        ),
        note,
        fix,
      };
}

export function firstAdmin(
  f: SetupFacts,
  admin: ReturnType<typeof useAdmin>["admin"],
  lastEmail: string | null,
  hasSecret: boolean,
): Stop {
  if (admin)
    return {
      kind: "ok",
      big: <Icon name="check" />,
      small: "admin",
      title: "An admin exists",
      text: `${admin.email} (${admin.role === "admin" ? "admin" : "read only"}), signed in now.`,
    };
  if (f.demo)
    return {
      kind: "off",
      big: "–",
      title: "No admin accounts in demo mode",
      // The admin secret is named only to whoever signed in with it.
      text: hasSecret
        ? "Waits for the environment. Demo mode has no admin list; the admin pages take the admin secret instead."
        : "Waits for the environment. Demo mode has no admin list.",
    };
  return {
    kind: "unknown",
    big: "?",
    small: "admins",
    title: "First admin",
    text: "This page cannot count the admins yet. Nobody can sign in until one exists; the first is added by hand, once, in this order.",
    fix: (
      <Fix label="Fix, if no admin exists yet">
        <ol className="steps">
          <li className={lastEmail ? "done" : undefined}>
            <p>
              Ask for a sign-in code with your email. This creates your user.
              {lastEmail && (
                <>
                  {" "}
                  Done for <strong>{lastEmail}</strong> in this tab.
                </>
              )}
            </p>
          </li>
          <li>
            <p>Run this once in your database&apos;s SQL editor:</p>
            <Copy
              text={firstAdminSql(lastEmail ?? "you@example.com")}
              label="SQL statement"
            />
          </li>
          <li>
            <p>
              Sign in with the code from the email. If the code has expired by
              then, ask for a new one.
            </p>
            <p>
              <Link className="btn sm" href="/admin/sign-in">
                Go to sign-in <Icon name="arrow" />
              </Link>
            </p>
          </li>
        </ol>
        {!lastEmail && (
          <p className="small muted">
            Ask for a code on the sign-in page first and the statement here
            carries your address.
          </p>
        )}
      </Fix>
    ),
  };
}

const peerFix = (
  <Fix>
    <ol className="steps">
      <li>
        <p>
          Ask the CPO or the hub for two things: its{" "}
          <strong>versions URL</strong> and a <strong>one-time token</strong>. A
          hub shows both in its portal.
        </p>
      </li>
      <li>
        <p>
          Connect. The form first asks who gave you the token, a hub or a CPO,
          and uses the right words for each.
        </p>
        <p>
          <Link className="btn sm" href="/admin/peers/connect">
            Connect a peer <Icon name="arrow" />
          </Link>
        </p>
      </li>
      <li>
        <p>
          For a hub, accept the parties you trade with afterwards. This stop
          turns to Done when the first peer shows as Registered.
        </p>
      </li>
    </ol>
    <p className="small muted">
      A CPO that wants to register with you instead?{" "}
      <Link href="/admin/peers/connect">Connect</Link> also makes a one-time
      token to send to them.
    </p>
  </Fix>
);

function firstPeer(
  f: SetupFacts,
  list: { state: ActionState; loading: boolean },
): Stop {
  if (list.loading)
    return {
      kind: "off",
      big: "…",
      title: "Reading the peers",
      text: "One moment.",
    };
  if (!list.state.ok || !list.state.peers)
    return {
      kind: "unknown",
      big: "?",
      small: "peers",
      title: "First peer",
      text: "The peer list could not be read.",
      note: <Result state={list.state} />,
      fix: peerFix,
    };
  const peers = list.state.peers.filter((p) => !p.demo);
  const registered = peers.filter((p) => p.status === "registered");
  const hubs = registered.filter((p) => p.hub);
  const trusted = hubs.reduce(
    (n, p) => n + p.hub!.parties.filter((h) => h.status === "trusted").length,
    0,
  );
  if (registered.length)
    return {
      kind: "ok",
      big: String(registered.length),
      small: registered.length === 1 ? "peer" : "peers",
      title: registered.length === 1 ? "First peer connected" : "Peers",
      text: (
        <>
          {registered.length - hubs.length} CPO(s) and {hubs.length} roaming
          hub(s) registered
          {hubs.length > 0 && `, with ${trusted} trusted party(ies)`}.{" "}
          <Link href="/admin/peers">See peers</Link>
        </>
      ),
    };
  if (f.demo)
    return {
      kind: "off",
      big: "–",
      title: "The mock CPO stands in",
      text: (
        <>
          Waits for the environment. Demo mode shows a built-in mock CPO and
          never contacts a real one. <Link href="/admin/peers">See peers</Link>
        </>
      ),
    };
  return {
    kind: "todo",
    big: "0",
    small: "peers",
    title: peers.length ? "No peer is registered yet" : "No peer yet",
    text: peers.length
      ? "A peer was started but none shows as Registered. Until one is, the drivers' map is empty and nobody can charge."
      : "A peer is a CPO or a roaming hub you exchange data with. Until one is connected, the drivers' map is empty and nobody can charge.",
    fix: peerFix,
  };
}

/**
 * Setup shows nothing but the sign-in prompt until an admin is signed in: what a
 * visitor may see before the first admin exists is decided separately (the public
 * pre-admin view), with its own security review.
 */
export function Setup({ facts }: { facts: SetupFacts }) {
  const { signedIn } = useAdmin();
  return signedIn ? (
    <Stops facts={facts} />
  ) : (
    <>
      <Head crumbs={["Setup"]} title="Get this network live" />
      <Gate what="see this deployment's setup" />
    </>
  );
}

function Stops({ facts: f }: { facts: SetupFacts }) {
  const { admin, lastEmail, hasSecret } = useAdmin();
  const peers = useList(listPeersAction);
  const stops = [
    environment(f),
    database,
    webhook(f),
    job(f),
    firstAdmin(f, admin, lastEmail, hasSecret),
    firstPeer(f, peers),
  ];
  const done = stops.filter((s) => s.kind === "ok").length;
  const unknown = stops.filter((s) => s.kind === "unknown").length;
  // One stop at a time is next: the first that is known to need you.
  const next = stops.findIndex((s) => s.kind === "todo" || s.kind === "bad");
  const hero = f.demo
    ? "Demo mode: sample data, nothing stored"
    : `Setting up: ${done} of ${stops.length} confirmed`;
  return (
    <>
      <Head
        crumbs={["Setup"]}
        title="Get this network live"
        lead="Six stops, in order. Each one shows what it found and, when something is missing, exactly what to do."
      />
      <div className="cols">
        <div className="stack">
          <section className="hero" aria-label="Overall state">
            <Tile
              kind=""
              big={String(done)}
              small={`of ${stops.length}`}
              size="lg"
            />
            <div>
              <h2>{hero}</h2>
              <p>
                {next >= 0
                  ? `Next: ${NAMES[next].toLowerCase()}, at stop ${next + 1}.`
                  : "No stop is known to need you."}
              </p>
              {unknown > 0 && (
                <p>
                  {unknown === 1
                    ? "One stop cannot be checked from this page yet: it says how to check by hand."
                    : `${unknown} stops cannot be checked from this page yet: each says how to check by hand.`}
                </p>
              )}
            </div>
          </section>
          <ol className="lane" aria-label="Setup checklist">
            {stops.map((stop, i) => (
              <StopItem key={i} n={i + 1} stop={stop} next={i === next} />
            ))}
          </ol>
        </div>
        <aside className="stack" aria-label="About this deployment">
          <section className="card">
            <h2 className="h3">This deployment</h2>
            <dl className="facts small" style={{ marginTop: "0.75rem" }}>
              <dt>Mode</dt>
              <dd>
                {f.demo ? (
                  <State kind="off">Demo</State>
                ) : (
                  <State kind="todo">Setting up</State>
                )}
              </dd>
              <dt>Role</dt>
              <dd>eMSP, OCPI {f.version}</dd>
              <dt>Party</dt>
              <dd>
                <OurParty party={f.party} />
              </dd>
              {f.settings?.baseUrl && (
                <>
                  <dt>Address</dt>
                  <dd>
                    <code>
                      {f.settings.baseUrl.replace(/^https?:\/\//, "")}
                    </code>
                  </dd>
                </>
              )}
            </dl>
          </section>
          <section className="card">
            <h2 className="h3">Limits here</h2>
            <ul className="stack tight small" style={{ marginTop: "0.75rem" }}>
              <li>
                <strong>Scheduled job:</strong> card holds need it every minute,
                and are refused when it is more than 5 minutes late.
              </li>
              <li>
                <strong>Sign-in codes:</strong> {f.codesPerHour} per email
                address per hour.
              </li>
              <li>
                <strong>Admin sessions:</strong> about one hour, then sign in
                again.
              </li>
              {f.settings && f.settings.holds.length > 0 && (
                <li>
                  <strong>Hold per charge:</strong>{" "}
                  {f.settings.holds.join(", ")}, captured from the CDR, never
                  above the hold.
                </li>
              )}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
