"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { listAdaptersAction } from "../live-data/actions";
import { useAdmin } from "../ui/admin-context";
import {
  Head,
  Icon,
  Message,
  Result,
  State,
  Tile,
  type ActionResult,
} from "../ui/kit";
import { ActionForm, Copy } from "../ui/parts";
import {
  requestAdminCodeAction,
  signOutAdminAction,
  verifyAdminCodeAction,
  type SignInState,
} from "./actions";
import { firstAdminSql, signInProblem } from "./states";

type Step = "email" | "code" | "limit" | "not-admin" | "secret";

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** The first admin is added by hand, once: the statement for the address just used. */
function FirstAdmin({ email, asked }: { email: string; asked: boolean }) {
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
        <p>
          Then sign in with a code from the email. If the code has expired by
          then, ask for a new one: the statement only needs to run once.
        </p>
      </li>
    </ol>
  );
}

function NoLink() {
  return (
    <div className="msg" role="note">
      <p className="t">
        <Icon name="mail" />
        <span>Type the code. Do not click the link in the email.</span>
      </p>
      <p>
        The link opens a different page and does not sign you in here. Only the
        digits of the code work on this page.
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
              <p>Ask for a new code here.</p>
            </li>
          </ol>
        </div>
      </details>
    </div>
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
  const { admin, hasSecret, setSecret } = useAdmin();
  const router = useRouter();
  const [out, setOut] = useState<SignInState>({});
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
          </div>
        </section>
      ) : (
        <section className="card stack" aria-label="Signed in">
          <div className="row">
            <Tile kind="brand" big={<Icon name="lock" />} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="h3">Admin secret</h2>
              <p>
                <State kind="ok">In use for this tab</State>
              </p>
            </div>
          </div>
          <dl className="facts small">
            <dt>Can</dt>
            <dd>See everything and make changes</dd>
            <dt>Kept</dt>
            <dd>
              In this page&apos;s memory only: never in a cookie or in the
              browser&apos;s storage. Reloading or closing the tab forgets it.
            </dd>
          </dl>
          <div className="row">
            <Link className="btn" href="/">
              Go to Setup <Icon name="arrow" />
            </Link>
            <button
              className="btn ghost"
              type="button"
              onClick={() => setSecret(null)}
            >
              Forget the secret
            </button>
          </div>
          <p className="small muted">
            Remove <code>ADMIN_SECRET</code> from the server once your admins
            sign in by email.
          </p>
        </section>
      )}
      {!admin && hasSecret ? null : <Result state={out} />}
    </Frame>
  );
}

export function SignIn({ codesPerHour }: { codesPerHour: number }) {
  const { signedIn, secretEnabled, demo, setSecret, renew, ...ctx } =
    useAdmin();
  const router = useRouter();
  const id = useId();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(ctx.lastEmail ?? "");
  const [asked, setAsked] = useState(false);
  const [problem, setProblem] = useState<ActionResult>({});

  // `signedIn`, not `admin`: once the server stops accepting the session (it ran
  // out), the cookie's admin is stale and this page asks to sign in again.
  if (signedIn) return <Account />;

  const go = (to: Step) => {
    setProblem({});
    setStep(to);
  };

  const askCode = async (form: FormData) => {
    const typed = field(form, "email");
    setEmail(typed);
    const r = await requestAdminCodeAction({}, form);
    if (r.ok) {
      setEmail(r.email ?? typed);
      ctx.setLastEmail(r.email ?? typed);
      setAsked(true);
      go("code");
    } else if (signInProblem(r.message) === "limited") go("limit");
    else setProblem(r);
  };

  const verify = async (form: FormData) => {
    form.set("email", email);
    const r = await verifyAdminCodeAction({}, form);
    if (r.ok) {
      renew();
      setProblem({});
      router.refresh();
      return;
    }
    const what = signInProblem(r.message);
    if (what === "limited") go("limit");
    else if (what === "not_admin") go("not-admin");
    else setProblem(r);
  };

  // The server's gate is unchanged, so the secret is checked the way every admin
  // action checks it: by sending it with one (the adapter list, which changes nothing).
  const trySecret = async (form: FormData) => {
    const secret = field(form, "secret");
    const check = new FormData();
    check.set("adminSecret", secret);
    const r = await listAdaptersAction({}, check);
    if (r.ok) {
      setProblem({});
      setSecret(secret);
    } else
      setProblem(
        "code" in r && r.code === "wrong_secret"
          ? {
              ok: false,
              message: "That is not this server's admin secret.",
              code: "wrong_secret",
              nextStep:
                "Check the value of ADMIN_SECRET in the server's settings, or sign in by email instead.",
            }
          : r,
      );
  };

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
            </div>
          </ActionForm>
          <Result state={problem} />
          <NoLink />
          <details className="card flat fold">
            <summary>First admin of this deployment?</summary>
            <div className="stack tight">
              <p>
                The first admin is added by hand, once. Until then a right code
                answers &quot;not on the admin list&quot;.
              </p>
              <FirstAdmin email={email} asked={asked} />
            </div>
          </details>
        </>
      )}

      {step === "limit" && (
        <>
          <Head
            crumbs={["Admin", "Sign in"]}
            title="Too many sign-in attempts"
          />
          <div className="msg wait" role="alert">
            <p className="t">
              <Icon name="clock" />
              <span>Wait a while, then try again once.</span>
            </p>
            <p>
              <strong>Whose limit:</strong> this server&apos;s (at most{" "}
              {codesPerHour} codes per email address per hour, so that nobody
              can flood an inbox) or your email service&apos;s (its built-in
              sender allows only a few sign-in emails per hour for the whole
              project, drivers included). Today&apos;s answer does not say
              which, or for how long.
            </p>
            <p>
              <strong>Until then:</strong> the newest code still works until it
              expires. Check the spam folder for it.
            </p>
            <dl className="help">
              <dt>Next step</dt>
              <dd>
                Type the newest code you have, or wait (an hour at most for this
                server&apos;s limit) and ask once.
              </dd>
            </dl>
          </div>
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

      {step === "not-admin" && (
        <>
          <Head crumbs={["Admin", "Sign in"]} title="Not on the admin list" />
          <Message
            kind="bad"
            title={`The code was right, but ${email} is not an admin. You have been signed out again.`}
            nextStep="Ask an admin of this network to add you, or sign in with the address that is on the list."
          />
          <section className="card stack" aria-labelledby={`${id}-first`}>
            <h2 className="h3" id={`${id}-first`}>
              No admin exists yet?
            </h2>
            <p className="small muted">
              This page cannot tell a new deployment from a full admin list. If
              this is a new deployment, add yourself as the first admin:
            </p>
            <FirstAdmin email={email} asked />
          </section>
          <button
            className="btn wide"
            type="button"
            onClick={() => go("email")}
          >
            Ask for a new code
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
          <ActionForm className="card form" onSend={trySecret}>
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
                once here, not on every form. It is kept in this browser tab
                only and forgotten when the tab closes or reloads.
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
