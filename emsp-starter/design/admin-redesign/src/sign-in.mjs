import { copy, head, icon, message, state, tile } from "./shell.mjs";

const SQL = `insert into public.emsp_admins (user_id, role)
select id, 'admin' from auth.users
where email = '<mark>ana@example.com</mark>';`;

const codeField = (n) => `
<div class="field">
  <label for="code${n}">6-digit code</label>
  <input class="code" id="code${n}" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" aria-describedby="code-hint${n}">
  <span class="hint" id="code-hint${n}">Sent to <strong>ana@example.com</strong>. Look for the six digits in the email.</span>
</div>`;

const noLink = `
<div class="msg" role="note">
  <p class="t">${icon("mail")}<span>Type the code. Do not click the link in the email.</span></p>
  <p>The link opens a different page and does not sign you in here. Only the six digits work on this page.</p>
  <details>
    <summary><strong>The email has a link but no code</strong></summary>
    <div class="stack tight" style="margin-top:0.625rem">
      <p>Then the sign-in email template of your project is missing the code. Add it once:</p>
      <ol class="steps">
        <li><p>In Supabase, open Authentication, then Emails, then the Magic Link template.</p></li>
        <li><p>Put this where the code should appear, and save:</p>${copy("{{ .Token }}", "Template variable")}</li>
        <li><p>Ask for a new code here.</p></li>
      </ol>
    </div>
  </details>
</div>`;

export const signIn = {
  file: "sign-in",
  nav: "",
  title: "Sign in",
  states: [
    ["email", "Email"],
    ["code", "Code sent"],
    ["limit", "Limit: ours"],
    ["limit-mail", "Limit: email service"],
    ["first", "No admin yet"],
    ["not-admin", "Not an admin"],
    ["secret", "Admin secret"],
    ["signed-in", "Signed in"],
  ],
  signedOut: [
    "email",
    "code",
    "limit",
    "limit-mail",
    "first",
    "not-admin",
    "secret",
  ],
  setupCount: { first: 3 },
  body: `
<div style="max-width:30rem;margin:0 auto" class="stack">

  <div data-show="email" class="stack">
    ${head(["Admin"], "Sign in", "No password. We email you a 6-digit code.")}
    <form class="card form" data-submit-go="code">
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" value="ana@example.com" required>
      </div>
      <button class="btn wide" type="submit">Email me a code</button>
    </form>
    <p class="small muted">Only people on the admin list can sign in. Nobody on it yet? <a href="setup.html#mid">Setup, stop 5</a> shows how to add the first admin.</p>
    <p class="small muted">This deployment also has an admin secret set, for demos: <a href="#secret">use the admin secret instead</a>.</p>
  </div>

  <div data-show="code" class="stack">
    ${head(["Admin", "Sign in"], "Type the code from the email")}
    <form class="card form" data-submit-go="signed-in">
      ${codeField("")}
      <button class="btn wide" type="submit">Sign in</button>
      <div class="row between small">
        <a href="#email">Use another email</a>
        <span class="muted">New code possible in <span data-countdown="52">0:52</span></span>
      </div>
    </form>
    ${noLink}
  </div>

  <div data-show="limit" class="stack">
    ${head(["Admin", "Sign in"], "Too many codes for this email")}
    <div class="msg wait" role="alert">
      <p class="label">You can ask again in</p>
      <p class="big" data-countdown="2292">38:12</p>
      <p><strong>Whose limit:</strong> this server's. It sends at most 5 codes per email address per hour, so that nobody can flood an inbox.</p>
      <p><strong>Until then:</strong> the codes already sent still work. Check the spam folder for the newest one.</p>
      <dl class="help"><dt>Code</dt><dd><code>sign_in_limited</code></dd><dt>Next step</dt><dd>Type a code you already have, or wait until 14:52 and ask once.</dd></dl>
    </div>
    <a class="btn wide" href="#code">Type a code I already have</a>
    <a class="btn ghost wide" href="#email">Use another email</a>
  </div>

  <div data-show="limit-mail" class="stack">
    ${head(["Admin", "Sign in"], "The email service is holding back sign-in emails")}
    <div class="msg wait" role="alert">
      <p class="label">Try again in about</p>
      <p class="big">1 hour</p>
      <p><strong>Whose limit:</strong> your email service's (Supabase Auth), not this server's. Its built-in mail sender allows only a few sign-in emails per hour for the whole project, drivers included.</p>
      <dl class="help"><dt>Code</dt><dd><code>email_service_limited</code></dd><dt>Next step</dt><dd>Wait, then ask once. To lift the limit for good, connect your own mail provider in Supabase (Authentication, then Emails, then SMTP) and raise the email rate limit there.</dd></dl>
    </div>
    <a class="btn wide" href="#code">Type a code I already have</a>
  </div>

  <div data-show="first" class="stack">
    ${head(["Admin", "Sign in"], "No admin exists yet", "This is a new deployment. The first admin is added by hand, once.")}
    <section class="card stack">
      <div class="row">${tile("todo", "0", "admins")}<p style="flex:1;min-width:0">We emailed a code to <strong>ana@example.com</strong>. Before it can sign you in, put that address on the admin list:</p></div>
      <ol class="steps">
        <li class="done"><p>Ask for a code. This created your user.</p></li>
        <li><p>Run this once in your database's SQL editor:</p>${copy(SQL, "SQL statement")}</li>
        <li><p>Then type the code from the email here.</p></li>
      </ol>
      <form class="form" data-submit-go="signed-in">
        ${codeField("-first")}
        <button class="btn wide" type="submit">Sign in</button>
      </form>
      <p class="small muted">Code expired while you were in the SQL editor? <a href="#email">Ask for a new one</a>: the statement only needs to run once.</p>
    </section>
    ${noLink}
  </div>

  <div data-show="not-admin" class="stack">
    ${head(["Admin", "Sign in"], "Not on the admin list")}
    ${message("bad", "The code was right, but ana@example.com is not an admin. You have been signed out again.", { code: "not_an_admin", next: "Ask an admin of this network to add you, or sign in with the address that is on the list." })}
    <a class="btn wide" href="#email">Use another email</a>
  </div>

  <div data-show="secret" class="stack">
    ${head(["Admin", "Sign in"], "Sign in with the admin secret", "For demo deployments, and for the time before the first admin exists.")}
    <form class="card form" data-submit-go="signed-in">
      <div class="field">
        <label for="secret">Admin secret</label>
        <input id="secret" name="secret" type="password" autocomplete="off" aria-describedby="secret-hint">
        <span class="hint" id="secret-hint">The value of <code>ADMIN_SECRET</code> on this server. Asked once here, not on every form. It is kept in this browser tab only and forgotten when the tab closes.</span>
      </div>
      <button class="btn wide" type="submit">Continue</button>
      <a class="small" href="#email">Sign in by email instead</a>
    </form>
    <p class="small muted">This choice is offered only on deployments where the secret is set. Remove the secret once your admins sign in by email.</p>
  </div>

  <div data-show="signed-in" class="stack">
    ${head(["Admin"], "Account")}
    <section class="card stack">
      <div class="row">${tile("brand", "A")}<div><h2 class="h3">ana@example.com</h2><p>${state("ok", "Admin")}</p></div></div>
      <dl class="facts small">
        <dt>Can</dt><dd>See everything and make changes</dd>
        <dt>Signed in until</dt><dd>15:20 today. Sessions last one hour, then you sign in again.</dd>
      </dl>
      <div class="row">
        <a class="btn" href="setup.html#health">Go to Health ${icon("arrow")}</a>
        <a class="btn ghost" href="#email">Sign out</a>
      </div>
    </section>
  </div>
</div>`,
};
