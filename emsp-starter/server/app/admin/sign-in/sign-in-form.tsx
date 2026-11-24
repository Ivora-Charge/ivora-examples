"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { SignInLimit } from "@/lib/accounts/sign-in";
import { useAdmin } from "../ui/admin-context";
import {
  Head,
  Help,
  Icon,
  Message,
  Result,
  State,
  Tile,
  type ActionResult,
} from "../ui/kit";
import { ActionForm, Copy } from "../ui/parts";
import {
  adminSecretSignInAction,
  dropStaleSecretSessionAction,
  requestAdminCodeAction,
  signOutAdminAction,
  verifyAdminCodeAction,
  verifyAdminLinkAction,
  type SignInState,
} from "./actions";
import { clock, firstAdminSql, limitWords, type Limits } from "./states";

type Step =
  "email" | "code" | "link" | "limit" | "first-admin" | "not-admin" | "secret";

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** Seconds left until `until` (a time in ms), counted down once a second. */
function useSecondsLeft(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * Asks for another code for the same address. It waits out the time the server gave
 * (`until`), so a press never ends as "too many attempts".
 */
function Resend({
  until,
  onSend,
  className = "btn ghost sm",
}: {
  until: number | null;
  onSend: () => Promise<unknown>;
  className?: string;
}) {
  const left = useSecondsLeft(until);
  const [busy, setBusy] = useState(false);
  if (left > 0)
    return (
      <span className="muted">
        New code possible in <span className="mono">{clock(left)}</span>
      </span>
    );
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onSend();
        } finally {
          setBusy(false);
        }
      }}
    >
      Email me a new code
    </button>
  );
}

/** The first admin is added by hand, once: the statement for the address just used. */
function FirstAdmin({
  email,
  asked,
  last,
}: {
  email: string;
  asked: boolean;
  /** The last step, when it is not "sign in with a code from the email". */
  last?: ReactNode;
}) {
  const sql = firstAdminSql(email || "you@example.com");
  return (
    <ol className="steps">
      <li className={asked ? "done" : undefined}>
        <p>
          Ask for a code with your email. This creates your user
          {asked ? "." : ", so do it before the next step."}
        </p>
      </li>
      <li>
        <p>Run this once in your database&apos;s SQL editor:</p>
        <Copy text={sql} label="SQL statement" />
      </li>
      <li>
        {last ?? (
          <p>
            Then sign in with a code from the email. If the code has expired by
            then, ask for a new one: the statement only needs to run once.
          </p>
        )}
      </li>
    </ol>
  );
}

function CodeOrLink() {
  return (
    <div className="msg" role="note">
      <p className="t">
        <Icon name="mail" />
        <span>Type the code from the email.</span>
      </p>
      <p>
        A link in the email signs you in too, if it leads back to this page:
        open it in this browser and press the button it shows. A link that opens
        any other page does not sign you in here.
      </p>
      <details>
        <summary>
          <strong>The email has a link but no code</strong>
        </summary>
        <div className="stack tight">
          <p>
            Then the sign-in email template of your project is missing the code.
            Add it once:
          </p>
          <ol className="steps">
            <li>
              <p>
                In Supabase, open Authentication, then Emails, then the Magic
                Link template.
              </p>
            </li>
            <li>
              <p>Put this where the code should appear, and save:</p>
              <Copy text="{{ .Token }}" label="Template variable" />
            </li>
            <li>
              <p>
                For a link that signs in on this page as well, make the
                template&apos;s link this, and add this page&apos;s address to
                the project&apos;s redirect URLs:
              </p>
              <Copy
                text="{{ .RedirectTo }}?token_hash={{ .TokenHash }}"
                label="Template link"
              />
            </li>
            <li>
              <p>Ask for a new code here.</p>
            </li>
          </ol>
        </div>
      </details>
    </div>
  );
}

/**
 * A limit, explained: how long it lasts, whose it is and what still works. `left` is
 * the seconds until it lifts; null when the email service did not say.
 */
export function LimitNotice({
  limit,
  limits,
  left,
  code,
}: {
  limit: SignInLimit;
  limits: Limits;
  left: number | null;
  code?: string;
}) {
  const words = limitWords(limit, limits);
  const again = limit.on === "code" ? "ask again" : "try again";
  return (
    <div className="msg wait" role="alert">
      {left === null ? (
        <p className="t">
          <Icon name="clock" />
          <span>
            Wait a while, then {again} once. The email service did not say for
            how long.
          </span>
        </p>
      ) : left > 0 ? (
        <>
          <p className="label">You can {again} in</p>
          <p className="big">{clock(left)}</p>
        </>
      ) : (
        <p className="t">
          <Icon name="check" />
          <span>The wait is over: you can {again} now.</span>
        </p>
      )}
      <p>
        <strong>Whose limit:</strong> {words.whose}
      </p>
      <p>
        <strong>Until then:</strong> {words.until}
      </p>
      <Help code={code} nextStep={words.nextStep} />
    </div>
  );
}

/** A right code or link for an address that is not an admin: what to do about it. */
export function NotAdmin({
  email,
  noAdmins,
  proof = "code",
  resend,
}: {
  email: string;
  /** What was right: the code typed, or the email's link. */
  proof?: "code" | "link";
  /** From the server: true, the admin list is empty; false, it is not; undefined, unknown. */
  noAdmins: boolean | undefined;
  /** The control that asks for a new code. */
  resend: ReactNode;
}) {
  const id = useId();
  if (noAdmins)
    return (
      <>
        <Head
          crumbs={["Admin", "Sign in"]}
          title="No admin exists yet"
          lead="This is a new deployment. The first admin is added by hand, once."
        />
        <section className="card stack" aria-label="Add the first admin">
          <div className="row">
            <Tile kind="todo" big="0" small="admins" />
            <p style={{ flex: 1, minWidth: 0 }}>
              The {proof} was right, so <strong>{email}</strong> is yours.
              Before it can sign you in, put that address on the admin list:
            </p>
          </div>
          <FirstAdmin
            email={email}
            asked
            last={
              <p>
                Then ask for a new code and sign in with it: the {proof} you
                just used works once. The statement only needs to run once.
              </p>
            }
          />
          <div className="row">{resend}</div>
        </section>
      </>
    );
  return (
    <>
      <Head crumbs={["Admin", "Sign in"]} title="Not on the admin list" />
      <Message
        kind="bad"
        title={`The ${proof} was right, but ${email} is not an admin. You have been signed out again.`}
        code="not_an_admin"
        nextStep="Ask an admin of this network to add you, or sign in with the address that is on the list."
      />
      {noAdmins === undefined && (
        <section className="card stack" aria-labelledby={`${id}-first`}>
          <h2 className="h3" id={`${id}-first`}>
            No admin exists yet?
          </h2>
          <p className="small muted">
            The server did not say whether the admin list is empty. If this is a
            new deployment, add yourself as the first admin:
          </p>
          <FirstAdmin email={email} asked />
        </section>
      )}
    </>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="stack" style={{ maxWidth: "30rem", margin: "0 auto" }}>
      {children}
    </div>
  );
}

/** Who is signed in, and the way out. */
function Account() {
  const { admin } = useAdmin();
  const router = useRouter();
  const [out, setOut] = useState<SignInState>({});
  const signOut = (
    <ActionForm
      className=""
      onSend={async () => {
        setOut(await signOutAdminAction());
        router.refresh();
      }}
    >
      <button className="btn ghost" type="submit">
        Sign out
      </button>
    </ActionForm>
  );
  return (
    <Frame>
      <Head crumbs={["Admin"]} title="Account" />
      {admin ? (
        <section className="card stack" aria-label="Signed in">
          <div className="row">
            <Tile kind="brand" big={admin.email.slice(0, 1).toUpperCase()} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="h3" style={{ overflowWrap: "anywhere" }}>
                {admin.email}
              </h2>
              <p>
                {admin.role === "admin" ? (
                  <State kind="ok">Admin</State>
                ) : (
                  <State kind="todo">Read only</State>
                )}
              </p>
            </div>
          </div>
          <dl className="facts small">
            <dt>Can</dt>
            <dd>
              {admin.role === "admin"
                ? "See everything and make changes"
                : "Nothing yet: every list and action of the admin web needs the admin role today. Ask an admin to change your role."}
            </dd>
            <dt>Signed in for</dt>
            <dd>
              About an hour from sign-in (the life of the session). Then you
              sign in again.
            </dd>
          </dl>
          <div className="row">
            <Link className="btn" href="/">
              Go to Setup <Icon name="arrow" />
            </Link>
            {signOut}
          </div>
        </section>
      ) : (
        <section className="card stack" aria-label="Signed in">
          <div className="row">
            <Tile kind="brand" big={<Icon name="lock" />} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="h3">Admin secret</h2>
              <p>
                <State kind="ok">Session in use</State>
              </p>
            </div>
          </div>
          <dl className="facts small">
            <dt>Can</dt>
            <dd>See everything and make changes</dd>
            <dt>Signed in for</dt>
            <dd>An hour from sign-in. Then you type the secret again.</dd>
            <dt>Kept</dt>
            <dd>
              As a session cookie that page scripts cannot read. It holds a
              signed expiry time, never the secret, and no form sends the
              secret.
            </dd>
          </dl>
          <div className="row">
            <Link className="btn" href="/">
              Go to Setup <Icon name="arrow" />
            </Link>
            {signOut}
          </div>
          <p className="small muted">
            Remove <code>ADMIN_SECRET</code> from the server once your admins
            sign in by email. Changing or removing it ends every admin-secret
            session.
          </p>
        </section>
      )}
      <Result state={out} />
    </Frame>
  );
}

export function SignIn({
  limits,
  secretEnabled,
  link = null,
  staleSession = false,
}: {
  /** The code's own limits, for the sentences that explain one. */
  limits: Limits;
  /** ADMIN_SECRET is set on this deployment, so this page offers it. */
  secretEnabled: boolean;
  /** The token hash of the emailed link that opened this page, if one did. */
  link?: string | null;
  /** The browser holds an admin-secret session cookie that no longer works. */
  staleSession?: boolean;
}) {
  const { signedIn, demo, renew, ...ctx } = useAdmin();
  const router = useRouter();
  const id = useId();
  const [step, setStep] = useState<Step>(link ? "link" : "email");
  const [email, setEmail] = useState(ctx.lastEmail ?? "");
  const [asked, setAsked] = useState(false);
  const [problem, setProblem] = useState<ActionResult>({});
  /** The limit that refused the last request, and when it lifts (ms; null: unknown). */
  const [limited, setLimited] = useState<{
    limit: SignInLimit;
    code?: string;
    until: number | null;
  } | null>(null);
  /** When another code may be asked for `email` (ms). */
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [noAdmins, setNoAdmins] = useState<boolean | undefined>(undefined);
  const [byLink, setByLink] = useState(false);
  const limitLeft = useSecondsLeft(limited?.until ?? null);
  // A page cannot delete a cookie while it renders, so an action does it, once.
  useEffect(() => {
    if (staleSession) void dropStaleSecretSessionAction().catch(() => {});
  }, [staleSession]);

  // `signedIn`, not `admin`: once the server stops accepting the session (it ran
  // out), the cookie's admin is stale and this page asks to sign in again.
  if (signedIn) return <Account />;

  const go = (to: Step) => {
    setProblem({});
    setStep(to);
  };

  /** Shows a limit's own step; false when the answer was not a limit. */
  const refusedByLimit = (r: SignInState) => {
    if (!r.limit) return false;
    const until =
      r.limit.retryAfter === null
        ? null
        : Date.now() + r.limit.retryAfter * 1000;
    setLimited({ limit: r.limit, code: r.code, until });
    // The same wait holds the "new code" button of the other steps.
    if (r.limit.on === "code" && until !== null) setResendAt(until);
    go("limit");
    return true;
  };

  const askFor = async (address: string) => {
    const form = new FormData();
    form.set("email", address);
    const r = await requestAdminCodeAction({}, form);
    if (r.ok) {
      setEmail(r.email ?? address);
      ctx.setLastEmail(r.email ?? address);
      setResendAt(Date.now() + (r.resendAfter ?? 0) * 1000);
      setAsked(true);
      go("code");
    } else if (!refusedByLimit(r)) setProblem(r);
    return r;
  };

  const askCode = (form: FormData) => {
    const typed = field(form, "email");
    setEmail(typed);
    return askFor(typed);
  };

  const signedInNow = () => {
    renew();
    setProblem({});
    router.refresh();
  };

  const answer = (r: SignInState) => {
    if (r.ok) signedInNow();
    else if (r.code === "not_an_admin") {
      if (r.email) setEmail(r.email);
      setNoAdmins(r.noAdmins);
      go(r.noAdmins ? "first-admin" : "not-admin");
    } else if (!refusedByLimit(r)) setProblem(r);
    return r;
  };

  const verify = async (form: FormData) => {
    setByLink(false);
    form.set("email", email);
    return answer(await verifyAdminCodeAction({}, form));
  };

  // The link's token works once: whatever the answer, it leaves the address bar.
  const signInWithLink = async () => {
    const form = new FormData();
    form.set("tokenHash", link ?? "");
    const r = await verifyAdminLinkAction({}, form);
    router.replace("/admin/sign-in");
    setByLink(true);
    if (r.ok || r.code === "not_an_admin" || r.limit) return answer(r);
    // A refused link cannot be tried again: back to asking for an email.
    setStep("email");
    setProblem({
      ...r,
      nextStep:
        "Ask for a new email below. A link works once, and only for a short time.",
    });
    return r;
  };

  const trySecret = async (form: FormData) => {
    const r = await adminSecretSignInAction({}, form);
    if (r.ok) signedInNow();
    else setProblem(r);
    return r;
  };

  const resend = (className?: string) => (
    <Resend
      until={resendAt}
      onSend={() => askFor(email)}
      className={className}
    />
  );

  const secretLink = secretEnabled && (
    <p className="small muted">
      This deployment also has an admin secret set, for demos and for the time
      before the first admin exists.{" "}
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => go("secret")}
      >
        Use the admin secret instead
      </button>
    </p>
  );

  return (
    <Frame>
      {step === "email" && (
        <>
          <Head
            crumbs={["Admin"]}
            title="Sign in"
            lead="No password. We email you a 6-digit code."
          />
          {demo && (
            <Message
              kind="wait"
              title="Demo mode: no email is sent and there are no admin accounts."
              nextStep={
                secretEnabled
                  ? "Use the admin secret instead, below."
                  : "ADMIN_SECRET is not set on this server, so the admin pages show nothing. Set it (at least 32 characters) to try them in demo mode."
              }
            />
          )}
          <ActionForm className="card form" onSend={askCode}>
            <div className="field">
              <label htmlFor={`${id}-email`}>Email</label>
              <input
                id={`${id}-email`}
                name="email"
                type="email"
                autoComplete="email"
                defaultValue={email}
                required
              />
            </div>
            <button className="btn wide" type="submit">
              Email me a code
            </button>
          </ActionForm>
          <Result state={problem} />
          <p className="small muted">
            Only people on the admin list can sign in. Nobody on it yet?{" "}
            <Link href="/#stop-5">Setup, stop 5</Link> shows how to add the
            first admin.
          </p>
          {secretLink}
        </>
      )}

      {step === "code" && (
        <>
          <Head
            crumbs={["Admin", "Sign in"]}
            title="Type the code from the email"
          />
          <ActionForm className="card form" onSend={verify}>
            <div className="field">
              <label htmlFor={`${id}-code`}>6-digit code</label>
              <input
                className="code"
                id={`${id}-code`}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6,10}"
                maxLength={10}
                placeholder="000000"
                required
                aria-describedby={`${id}-code-hint`}
              />
              <span className="hint" id={`${id}-code-hint`}>
                {asked ? (
                  <>
                    If <strong>{email}</strong> can sign in, a code is on its
                    way to it.
                  </>
                ) : (
                  <>
                    The newest code sent to <strong>{email}</strong>.
                  </>
                )}{" "}
                Look for the digits in the email.
              </span>
            </div>
            <button className="btn wide" type="submit">
              Sign in
            </button>
            <div className="row between small">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => go("email")}
              >
                Use another email
              </button>
              {resend()}
            </div>
          </ActionForm>
          <Result state={problem} />
          <CodeOrLink />
          <details className="card flat fold">
            <summary>First admin of this deployment?</summary>
            <div className="stack tight">
              <p>
                The first admin is added by hand, once. Until then a right code
                answers &quot;no admin exists yet&quot; with these steps.
              </p>
              <FirstAdmin email={email} asked={asked} />
            </div>
          </details>
        </>
      )}

      {step === "link" && (
        <>
          <Head
            crumbs={["Admin", "Sign in"]}
            title="Sign in with the link from the email"
            lead="You opened the sign-in link. One press signs you in, in this browser."
          />
          <ActionForm className="card form" onSend={signInWithLink}>
            <button className="btn wide" type="submit">
              Sign in
            </button>
            <p className="small muted">
              Opening the link alone signs nobody in: programs that scan or
              preview email open links too, and a link works once.
            </p>
            <div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => go("email")}
              >
                Ask for a code instead
              </button>
            </div>
          </ActionForm>
          <Result state={problem} />
        </>
      )}

      {step === "limit" && limited && (
        <>
          <Head
            crumbs={["Admin", "Sign in"]}
            title={limitWords(limited.limit, limits).title}
          />
          <LimitNotice
            limit={limited.limit}
            limits={limits}
            left={limited.until === null ? null : limitLeft}
            code={limited.code}
          />
          {email && (
            <button
              className="btn wide"
              type="button"
              onClick={() => {
                setAsked(false);
                go("code");
              }}
            >
              Type a code I already have
            </button>
          )}
          <button
            className="btn ghost wide"
            type="button"
            onClick={() => go("email")}
          >
            Use another email
          </button>
        </>
      )}

      {(step === "first-admin" || step === "not-admin") && (
        <>
          <NotAdmin email={email} noAdmins={noAdmins} resend={resend("btn")} />
          <button
            className={step === "first-admin" ? "btn ghost wide" : "btn wide"}
            type="button"
            onClick={() => go("email")}
          >
            Use another email
          </button>
        </>
      )}

      {step === "secret" && (
        <>
          <Head
            crumbs={["Admin", "Sign in"]}
            title="Sign in with the admin secret"
            lead="For demo deployments, and for the time before the first admin exists."
          />
          <ActionForm className="card form" onSend={trySecret} clearOnOk>
            <div className="field">
              <label htmlFor={`${id}-secret`}>Admin secret</label>
              <input
                id={`${id}-secret`}
                name="secret"
                type="password"
                autoComplete="off"
                required
                aria-describedby={`${id}-secret-hint`}
              />
              <span className="hint" id={`${id}-secret-hint`}>
                The value of <code>ADMIN_SECRET</code> on this server. Asked
                once here, not on every form: the server answers with a session
                that lasts an hour, and the secret is not kept in the browser.
              </span>
            </div>
            <button className="btn wide" type="submit">
              Continue
            </button>
            <div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => go("email")}
              >
                Sign in by email instead
              </button>
            </div>
          </ActionForm>
          <Result state={problem} />
          <p className="small muted">
            This choice is offered only on deployments where the secret is set.
            Remove the secret once your admins sign in by email.
          </p>
        </>
      )}
    </Frame>
  );
}
