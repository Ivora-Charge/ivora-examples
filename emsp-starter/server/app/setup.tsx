"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import {
  HOLD_SWEEP_MAX_AGE_MS,
  intervalWords,
  jobInterval,
  STOP_NAMES,
  sweepAge,
  type PublicStop,
  type SetupStatus,
} from "@/lib/setup/checks";
import { firstAdminSql } from "./admin/sign-in/states";
import { useAdmin } from "./admin/ui/admin-context";
import {
  Head,
  Icon,
  Result,
  State,
  Tile,
  utc,
  type Kind,
} from "./admin/ui/kit";
import { Copy, Gate, Later, OurParty } from "./admin/ui/parts";
import { allPass, useSetup } from "./admin/ui/setup-context";

/**
 * What every visitor's page carries: the mode, which the banner shows, and two
 * constants of the code (the sign-in code limit, the OCPI version). Nothing here says
 * which setting is set, unset or malformed, or who this deployment is.
 *
 * Before the first admin exists, and only then, it also carries `publicView`: the six
 * stops' fixed names and whether each passes (lib/setup/status.ts, publicSetupView).
 *
 * What the stops found is not in the page at all: a signed-in admin's page asks for it
 * (the setup status read, app/admin/setup/actions.ts).
 */
export type SetupFacts = {
  demo: boolean;
  codesPerHour: number;
  /** The OCPI version this code implements: a constant. */
  version: string;
  /** Our OCPI party, sent by the server only to an admin signed in by email. */
  party: string | null;
  /**
   * Sent by the server only to an admin signed in by email (the session cookie), and
   * null for everyone else. An admin-secret sign-in lives in the page's memory, which
   * the server cannot see when it renders, so the fixes then show a placeholder for
   * the address.
   */
  settings: SetupSettings | null;
  /** Null for a signed-in admin, and for everyone once an admin exists. */
  publicView: PublicStop[] | null;
};

export type SetupSettings = {
  /** PUBLIC_BASE_URL, when it is set. */
  baseUrl: string | null;
  /** The hold per charge, per currency, as text. */
  holds: string[];
};

/**
 * A stop is Done, Needs you, Broken or Waiting, or its facts could not be read just
 * now ("Could not check": its fix is shown either way).
 */
type StopKind = "ok" | "todo" | "bad" | "off" | "unknown";
export type Stop = {
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
  unknown: ["off", "off", "Could not check"],
};

const NAMES: readonly string[] = STOP_NAMES;

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

function StopItem({
  n,
  stop,
  next,
  open,
}: {
  n: number;
  stop: Stop;
  next: boolean;
  /** Health: a done stop stays open. */
  open: boolean;
}) {
  const [tile, state, word] = LABEL[stop.kind];
  const label = (
    <>
      <span>
        {n} · {NAMES[n - 1].toUpperCase()}
      </span>
      <State kind={state}>{word}</State>
    </>
  );
  // A done stop is one line on day one; open it for the detail.
  if (stop.kind === "ok")
    return (
      <li className="stop folded" id={`stop-${n}`}>
        <details open={open}>
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

/** "40 seconds", "12 minutes", "3 hours", "2 days". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const of = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (s < 90) return of(s, "second");
  if (s < 90 * 60) return of(Math.round(s / 60), "minute");
  if (s < 36 * 3600) return of(Math.round(s / 3600), "hour");
  return of(Math.round(s / 86_400), "day");
}

/** When something happened: how long before the status was read, and the time. */
const when = (iso: string, now: number) =>
  `${span(now - Date.parse(iso))} ago (${utc(iso)})`;

const unread = (title: string, what: string, fix?: ReactNode): Stop => ({
  kind: "unknown",
  big: "?",
  title,
  text: `${what} could not be read just now. Reload the page; if it stays, the server log has the error name.`,
  fix,
});

function environment(s: SetupStatus): Stop {
  const e = s.environment;
  const of = `of ${e.required}`;
  if (!s.demo)
    return {
      kind: "ok",
      big: String(e.required),
      small: of,
      title: "Environment complete",
      text: "All live-mode settings are present and well formed. This page only ever shows their names, never their values.",
    };
  if (!e.missing.length && !e.malformed.length)
    return {
      kind: "todo",
      big: String(e.required),
      small: of,
      title: "Demo mode is switched on",
      text: (
        <>
          Every live-mode setting is present and well formed, but{" "}
          <code>DEMO_MODE</code> is set, so this server runs on sample data and
          stores nothing.
        </>
      ),
      fix: (
        <Fix>
          <ol className="steps">
            <li>
              <p>
                Remove <code>DEMO_MODE</code> from your hosting project&apos;s
                environment variables.
              </p>
            </li>
            <li>
              <p>Redeploy. A changed variable only reaches a new deployment.</p>
            </li>
          </ol>
        </Fix>
      ),
    };
  const count = e.missing.length + e.malformed.length;
  const key =
    e.missing.includes("OCPI_TOKEN_ENCRYPTION_KEY") ||
    e.malformed.some((m) => m.startsWith("OCPI_TOKEN_ENCRYPTION_KEY"));
  return {
    kind: "todo",
    big: String(
      Math.max(0, e.required - e.missing.length - e.malformedRequired),
    ),
    small: of,
    title: count === 1 ? "One setting needs you" : `${count} settings need you`,
    text: "Until every live-mode setting is right, this server runs in demo mode with sample data and stores nothing. Names only are shown here, never values.",
    fix: (
      <>
        <ul className="found">
          {e.missing.map((name) => (
            <li key={name}>
              <State kind="bad">Missing</State>
              <span>
                <code>{name}</code> is not set.
              </span>
            </li>
          ))}
          {e.malformed.map((m) => {
            const [name, ...rest] = m.split(" ");
            return (
              <li key={m}>
                <State kind="todo">Malformed</State>
                <span>
                  <code>{name}</code> {rest.join(" ")}.
                </span>
              </li>
            );
          })}
          {e.demoForced && (
            <li>
              <State kind="todo">Switched on</State>
              <span>
                <code>DEMO_MODE</code> is set: remove it to leave demo mode.
              </span>
            </li>
          )}
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

const migrateFix = (
  <Fix>
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
          No database URL? Run the files in <code>supabase/migrations</code> in
          the SQL editor, in file-name order.
        </p>
      </li>
    </ol>
  </Fix>
);

function database(s: SetupStatus): Stop {
  const d = s.database;
  if (!d)
    return {
      kind: "off",
      big: "–",
      title: "No database in demo mode",
      text: "Waits for the environment. Demo mode keeps its sample data in memory and stores nothing.",
    };
  const of = `of ${d.shipped}`;
  if (d.state === "ok")
    return {
      kind: "ok",
      big: String(d.applied),
      small: of,
      title: "Migrations applied",
      text: (
        <>
          All {d.shipped} migrations this build ships are applied. The newest is{" "}
          <code>{d.newest}</code>.
        </>
      ),
    };
  if (d.state === "unreachable")
    return {
      kind: "bad",
      big: "?",
      small: of,
      title: "The database did not answer",
      text: "The check got no answer, or an answer that was not about the tables. Nothing here works until it does: sign-in, peers and payments all need the database.",
      fix: (
        <Fix>
          <ol className="steps">
            <li>
              <p>
                Check that <code>SUPABASE_URL</code> is this project&apos;s URL
                and <code>SUPABASE_SERVICE_ROLE_KEY</code> its service role (or
                secret) key, not the anon key, and that the project is not
                paused.
              </p>
            </li>
            <li>
              <p>
                Redeploy after a change, then open this page again. The server
                log has the name of the error.
              </p>
            </li>
          </ol>
        </Fix>
      ),
    };
  if (d.state === "empty")
    return {
      kind: "bad",
      big: "0",
      small: of,
      title: "The database has no tables",
      text: `None of the ${d.shipped} migrations is applied. Sign-in, peers and payments all need the tables first.`,
      fix: migrateFix,
    };
  return {
    kind: "todo",
    big: String(d.applied),
    small: of,
    title:
      d.pending.length === 1
        ? "One migration is pending"
        : `${d.pending.length} migrations are pending`,
    text: "The database is behind this build. Parts of the server fail until the pending files are applied.",
    fix: (
      <>
        <ul className="found">
          {d.pending.map((file) => (
            <li key={file}>
              <State kind="todo">Pending</State>
              <code>{file}</code>
            </li>
          ))}
        </ul>
        {migrateFix}
      </>
    ),
  };
}

function webhook(s: SetupStatus, f: SetupFacts): Stop {
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
  if (s.demo)
    return {
      kind: "off",
      big: "–",
      title: "No payment events in demo mode",
      text: "Waits for the environment. Demo mode never charges a card and takes no webhook.",
    };
  const unset = [
    !s.environment.stripeKey && "STRIPE_SECRET_KEY",
    !s.environment.webhookSecret && "STRIPE_WEBHOOK_SECRET",
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
  const w = s.webhook;
  if (!w) return unread("Payments webhook", "The payment events", fix);
  const now = Date.parse(s.checkedAt);
  const signed = w.lastSigned;
  const refused = w.lastRefused;
  if (signed?.result === "handled")
    return {
      kind: "ok",
      big: <Icon name="check" />,
      small: "signed",
      title: "Signed payment events arrive",
      text: (
        <>
          The last signed event was handled {when(signed.at, now)}.
          {refused && Date.parse(refused.at) > Date.parse(signed.at) && (
            <>
              {" "}
              Since then a request with a wrong signature was refused,{" "}
              {when(refused.at, now)}. Anyone can send one; if Stripe&apos;s
              Dashboard shows failed deliveries, the signing secret is wrong.
            </>
          )}
        </>
      ),
    };
  if (signed)
    return {
      kind: "bad",
      big: "!",
      title: "The last signed event could not be handled",
      text: `A signed payment event arrived ${when(signed.at, now)} and failed on this server. Stripe delivers it again; the server log has the event and the error name. If it keeps failing, check the database stop above.`,
    };
  if (refused)
    return {
      kind: "bad",
      big: "0",
      small: "signed",
      title: "Events arrive, but the signature does not match",
      text: `No signed payment event has arrived, and a request was refused for its signature ${when(refused.at, now)}. Do not take card payments until one signed event has arrived.`,
      fix,
    };
  return {
    kind: "todo",
    big: "0",
    small: "events",
    title: "No signed payment event has arrived",
    text: "The payment settings are present, but until a signed event arrives, a hold, capture or refund the payment provider reports would go unnoticed here. Do not take card payments yet.",
    fix,
  };
}

function job(s: SetupStatus, f: SetupFacts): Stop {
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
        {!s.environment.cronSecret && (
          <li>
            <p>
              Set <code>CRON_SECRET</code> (at least 32 characters) and
              redeploy. The job answers only with it.
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
  if (s.demo)
    return {
      kind: "off",
      big: "–",
      title: "No scheduled job in demo mode",
      text: "Waits for the environment. In demo mode the job answers but pulls and sweeps nothing.",
    };
  if (!s.environment.cronSecret)
    return {
      kind: "todo",
      big: "0",
      small: "runs",
      title: "The scheduled job is off",
      text: (
        <>
          <code>CRON_SECRET</code> is not set, so the job never runs: no pulls,
          no token push retries, no payment sweep.
        </>
      ),
      note,
      fix,
    };
  if (!s.job) return unread("Scheduled job", "The job's runs", fix);
  const now = Date.parse(s.checkedAt);
  const age = sweepAge(s, now);
  const every = jobInterval(s.job.runs);
  const last = s.job.runs[0];
  const pace =
    every === null
      ? "How often it runs is not known yet: that shows after its second run."
      : `It runs about ${intervalWords(every)}.`;
  if (age === null && !last)
    return {
      kind: "todo",
      big: "0",
      small: "runs",
      title: "The job has not run yet",
      text: "Its secret is set, but no run and no payment sweep has been recorded. Until it runs every minute, every card hold is refused.",
      note,
      fix,
    };
  if (last && !last.ok)
    return {
      kind: "bad",
      big: "!",
      title: "The job runs, but a part of it fails",
      text: `The run ${when(last.at, now)} did not get through everything, and none since is recorded as good (a recovery shows here within 10 minutes). The server log names the part that failed. ${
        age === null
          ? "The payment sweep has never finished."
          : `The payment sweep last finished ${span(age)} ago.`
      }`,
      note,
      fix,
    };
  const slow = every !== null && every * 1000 > HOLD_SWEEP_MAX_AGE_MS;
  if (age === null || age > HOLD_SWEEP_MAX_AGE_MS)
    return slow || every === null
      ? {
          kind: "todo",
          big: every === null ? "?" : span(every * 1000).split(" ")[0],
          small: every === null ? undefined : span(every * 1000).split(" ")[1],
          title:
            every === null
              ? "The job is late"
              : `The job runs ${intervalWords(every)}: card holds are refused`,
          text: `Card holds refused: the payment sweep has not run in the last 5 minutes${
            age === null ? "" : ` (it last finished ${span(age)} ago)`
          }. ${pace}`,
          note,
          fix,
        }
      : {
          kind: "bad",
          big: "!",
          title:
            age === null
              ? "The payment sweep has never finished"
              : `The job stopped ${span(age)} ago`,
          text: `Card holds refused: the payment sweep has not run in the last 5 minutes (code payment_sweep_stale). ${pace} Check that the scheduler still calls the job every minute and gets a 200. Holds resume after the next run.`,
          fix,
        };
  if (slow)
    return {
      kind: "todo",
      big: span(every * 1000).split(" ")[0],
      small: span(every * 1000).split(" ")[1],
      title: `The job runs ${intervalWords(every)}: too rarely for card holds`,
      text: `The payment sweep finished ${span(age)} ago, so holds work right now, but they are refused whenever it is older than 5 minutes.`,
      note,
      fix,
    };
  return {
    kind: "ok",
    big: <Icon name="check" />,
    small: every !== null && every <= 90 ? "1 min" : undefined,
    title:
      every === null ? "The job runs" : `The job runs ${intervalWords(every)}`,
    text: `The payment sweep finished ${span(age)} ago${
      last ? `; its outcome last changed ${when(last.at, now)}` : ""
    }. ${every === null ? pace : "A run is recorded only when the job starts or stops failing, and every 10 minutes while it fails."}`,
  };
}

export function firstAdmin(
  s: SetupStatus,
  admin: ReturnType<typeof useAdmin>["admin"],
  lastEmail: string | null,
  hasSecret: boolean,
): Stop {
  if (s.demo)
    return {
      kind: "off",
      big: "–",
      title: "No admin accounts in demo mode",
      // The admin secret is named only to whoever signed in with it.
      text: hasSecret
        ? "Waits for the environment. Demo mode has no admin list; the admin pages take the admin secret instead."
        : "Waits for the environment. Demo mode has no admin list.",
    };
  const fix = (
    <Fix>
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
  );
  if (s.admins === null) return unread("First admin", "The admin list", fix);
  if (s.admins > 0)
    return {
      kind: "ok",
      big: String(s.admins),
      small: s.admins === 1 ? "admin" : "admins",
      title: s.admins === 1 ? "An admin exists" : "Admins exist",
      text: `${s.admins === 1 ? "One user is" : `${s.admins} users are`} on the admin list.${
        admin
          ? ` You are signed in as ${admin.email} (${admin.role === "admin" ? "admin" : "read only"}).`
          : ""
      }`,
    };
  return {
    kind: "todo",
    big: "0",
    small: "admins",
    title: "No admin exists yet",
    text: "Nobody can sign in by email until one exists; the first is added by hand, once, in this order. Until then, this address shows any visitor the six stops' names and whether each is done, and nothing else.",
    fix,
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

function firstPeer(s: SetupStatus): Stop {
  if (s.demo)
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
  const p = s.peers;
  if (!p) return unread("First peer", "The peer list", peerFix);
  if (p.registered)
    return {
      kind: "ok",
      big: String(p.registered),
      small: p.registered === 1 ? "peer" : "peers",
      title: p.registered === 1 ? "First peer connected" : "Peers",
      text: (
        <>
          {p.registered - p.hubs} CPO(s) and {p.hubs} roaming hub(s) registered
          {p.hubs > 0 && `, with ${p.trustedParties} trusted party(ies)`}.{" "}
          <Link href="/admin/peers">See peers</Link>
        </>
      ),
    };
  return {
    kind: "todo",
    big: "0",
    small: "peers",
    title: p.total ? "No peer is registered yet" : "No peer yet",
    text: p.total
      ? "A peer was started but none shows as Registered. Until one is, the drivers' map is empty and nobody can charge."
      : "A peer is a CPO or a roaming hub you exchange data with. Until one is connected, the drivers' map is empty and nobody can charge.",
    fix: peerFix,
  };
}

/** The six stops of a status, in the order of STOP_NAMES. */
export function buildStops(
  s: SetupStatus,
  f: SetupFacts,
  who: {
    admin: ReturnType<typeof useAdmin>["admin"];
    lastEmail: string | null;
    hasSecret: boolean;
  },
): Stop[] {
  return [
    environment(s),
    database(s),
    webhook(s, f),
    job(s, f),
    firstAdmin(s, who.admin, who.lastEmail, who.hasSecret),
    firstPeer(s),
  ];
}

/** The one line that sums the six up. */
export function heroLine(s: SetupStatus, stops: Stop[]): string {
  const done = stops.filter((x) => x.kind === "ok").length;
  const of = `${done} of ${stops.length} done`;
  if (s.demo) return `Demo mode: ${of}`;
  if (done === stops.length) return "Live";
  if (stops[1].kind !== "ok") return `Not live: ${of}`;
  if (done === stops.length - 1)
    return stops[3].kind === "ok"
      ? `Almost live: ${of}`
      : "Live, but card holds are refused";
  return `Setting up: ${of}`;
}

/**
 * What a visitor sees before the first admin exists: the six stops by name, each Done
 * or Not done, and the sign-in prompt. What a stop found and its fix are for a
 * signed-in admin. Once an admin exists the server sends no `publicView`, and this is
 * the sign-in prompt alone.
 */
function Visitor({ stops }: { stops: PublicStop[] | null }) {
  return (
    <>
      <Head crumbs={["Setup"]} title="Get this network live" />
      <div className="stack">
        {stops && (
          <section className="stack" aria-labelledby="progress-h">
            <h2 className="h3" id="progress-h">
              Setup so far: {stops.filter((x) => x.pass).length} of{" "}
              {stops.length} done
            </h2>
            <ol className="lane" aria-label="Setup progress">
              {stops.map((stop, i) => (
                <li className="stop" key={stop.name}>
                  <div className="top">
                    <Tile
                      kind={stop.pass ? "ok" : "todo"}
                      big={stop.pass ? <Icon name="check" /> : "–"}
                      size="sm"
                    />
                    <p className="what n row between">
                      <span>
                        {i + 1} · {stop.name.toUpperCase()}
                      </span>
                      <State kind={stop.pass ? "ok" : "todo"}>
                        {stop.pass ? "Done" : "Not done"}
                      </State>
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="small muted">
              No admin exists yet, so this page shows anyone these six names and
              whether each is done, and nothing else. What each stop found and
              how to fix it is for a signed-in admin; the server README walks
              through the same six steps. This list is gone once the first admin
              exists.
            </p>
          </section>
        )}
        <Gate what="see this deployment's setup" />
      </div>
    </>
  );
}

export function Setup({ facts }: { facts: SetupFacts }) {
  const { signedIn } = useAdmin();
  return signedIn ? (
    <Stops facts={facts} />
  ) : (
    <Visitor stops={facts.publicView} />
  );
}

/** A status older than this is read again when the page is opened. */
const STALE_MS = 10_000;

function Stops({ facts }: { facts: SetupFacts }) {
  const { state, loading, reload } = useSetup();
  const s = state.status;
  const health = allPass(s);
  const checkedAt = s?.checkedAt;
  // The menu read it when the tab loaded; opening the page later reads it again.
  useEffect(() => {
    if (checkedAt && Date.now() - Date.parse(checkedAt) > STALE_MS) reload();
    // Only when the page is opened: a newer status does not ask again.
  }, []); // eslint-disable-line
  // The tab's title follows the page's name.
  useEffect(() => {
    if (health) document.title = document.title.replace(/^Setup\b/, "Health");
  }, [health]);

  if (s) return <StatusView facts={facts} status={s} />;
  return (
    <>
      <Head crumbs={["Setup"]} title="Get this network live" />
      {loading ? (
        <p role="status">Reading the setup status…</p>
      ) : (
        <div className="stack">
          <Result state={state} />
          <p>
            <button type="button" className="btn sm" onClick={reload}>
              Read it again
            </button>
          </p>
        </div>
      )}
    </>
  );
}

/** The page for one status: Setup, or Health when all six checks pass. */
export function StatusView({
  facts: f,
  status: s,
}: {
  facts: SetupFacts;
  status: SetupStatus;
}) {
  const { admin, lastEmail, hasSecret } = useAdmin();
  const health = allPass(s);
  const stops = buildStops(s, f, { admin, lastEmail, hasSecret });
  const done = stops.filter((x) => x.kind === "ok").length;
  const unknown = stops.filter((x) => x.kind === "unknown").length;
  // One stop at a time is next: the first that is known to need you.
  const next = stops.findIndex((x) => x.kind === "todo" || x.kind === "bad");
  return (
    <>
      {health ? (
        <Head
          crumbs={["Health"]}
          title="Everything is working"
          lead="The same six checks as during setup, read again each time this page opens."
        />
      ) : (
        <Head
          crumbs={["Setup"]}
          title="Get this network live"
          lead="Six stops, in order. Each one shows what it found and, when something is missing, exactly what to do."
        />
      )}
      <div className="cols">
        <div className="stack">
          <section
            className={health ? "hero live" : "hero"}
            aria-label="Overall state"
          >
            <Tile
              kind=""
              big={String(done)}
              small={`of ${stops.length}`}
              size="lg"
            />
            <div>
              <h2>{heroLine(s, stops)}</h2>
              <p>
                {next >= 0
                  ? `Next: ${NAMES[next].toLowerCase()}, at stop ${next + 1}.`
                  : health
                    ? `All six checks pass, as of ${utc(s.checkedAt)}.`
                    : "No stop is known to need you."}
              </p>
              {unknown > 0 && (
                <p>
                  {unknown === 1
                    ? "One stop could not be checked just now."
                    : `${unknown} stops could not be checked just now.`}
                </p>
              )}
            </div>
          </section>
          <ol
            className="lane"
            aria-label={health ? "Health checks" : "Setup checklist"}
          >
            {stops.map((stop, i) => (
              <StopItem
                key={i}
                n={i + 1}
                stop={stop}
                next={i === next}
                open={health}
              />
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
                ) : health ? (
                  <State kind="ok">Live</State>
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
              <dt>Checked</dt>
              <dd>{utc(s.checkedAt)}</dd>
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
