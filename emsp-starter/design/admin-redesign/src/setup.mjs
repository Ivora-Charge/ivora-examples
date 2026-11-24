import { copy, head, icon, message, state, tile } from "./shell.mjs";

const STATE = {
  ok: ["ok", "Done"],
  todo: ["todo", "Needs you"],
  bad: ["bad", "Broken"],
  off: ["off", "Waiting"],
};

/**
 * One stop of the lane: a tile, a sentence, and the fix when it is not done.
 * On day one a done stop folds to one line (`fold`), and a stop that needs you but is
 * not the next one keeps its fix behind "Show the fix" on a phone (`later`); a wide
 * screen opens those (kit.js). A `note` such as a hosting limit always shows.
 */
const stop = (n, name, s) => {
  const label = (tag) =>
    `<${tag} class="n row between"><span>${n} · ${name.toUpperCase()}</span>${state(...STATE[s.kind])}</${tag}>`;
  if (s.fold)
    return `
<li class="stop folded">
  <details>
    <summary class="top">
      ${tile(s.kind, s.big, s.small, "sm")}
      <span class="what">${label("span")}<span class="h3">${s.title}</span></span>
    </summary>
    <p class="more">${s.text}</p>
  </details>
</li>`;
  const note = s.note ?? "";
  const fix = !s.fix
    ? ""
    : s.later
      ? `<div class="fix">${note}<details class="later"><summary>Show the fix</summary><div class="in">${s.fix}</div></details></div>`
      : `<div class="fix">${note}${s.fix}</div>`;
  return `
<li class="stop${s.next ? " next" : ""}">
  <div class="top">
    ${tile(s.kind, s.big, s.small)}
    <div class="what">
      ${label("p")}
      <h3>${s.title}</h3>
      <p>${s.text}</p>
    </div>
  </div>
  ${fix}
</li>`;
};

const NAMES = [
  "Environment",
  "Database",
  "Payments webhook",
  "Scheduled job",
  "First admin",
  "First peer",
];
const lane = (id, stops) =>
  `<ol class="lane" data-show="${id}" aria-label="Setup checklist">${stops.map((s, i) => stop(i + 1, NAMES[i], s)).join("")}</ol>`;

const fold = (s) => ({ ...s, fold: true });
const later = (s) => ({ ...s, next: false, later: true });
const again = (to) =>
  `<p><a class="btn sm ghost" href="#${to}" data-go="${to}">${icon("refresh")}Check again</a></p>`;
const waits = (title, on = "the database") => ({
  kind: "off",
  big: "–",
  title,
  text: `Waits for ${on}.`,
});

// 1 · Environment
const env = {
  kind: "ok",
  big: "6",
  small: "of 6",
  title: "Environment complete",
  text: "All six live-mode settings are present and well formed. This page only ever shows their names, never their values.",
};
const envMissing = {
  kind: "todo",
  big: "4",
  small: "of 6",
  next: true,
  title: "Two settings need you",
  text: "Until all six are right, this server runs in demo mode with sample data and stores nothing. Names only are shown here, never values.",
  fix: `
    <ul class="found">
      <li>${state("bad", "Missing")}<span><code>OCPI_TOKEN_ENCRYPTION_KEY</code> is not set.</span></li>
      <li>${state("todo", "Malformed")}<span><code>PUBLIC_BASE_URL</code> must be an <code>https://</code> origin.</span></li>
    </ul>
    <p class="label">Fix</p>
    <ol class="steps">
      <li><p>Make the key on your machine. Keep it: losing or changing it later locks out every stored peer token.</p>${copy("openssl rand -base64 32", "Command")}</li>
      <li><p>In your hosting project's environment variables, set <code>OCPI_TOKEN_ENCRYPTION_KEY</code> to that key, and <code>PUBLIC_BASE_URL</code> to this deployment's public address:</p>${copy("https://charge.example.com", "Public address")}</li>
      <li><p>Redeploy. A changed variable only reaches a new deployment.</p>${again("blank")}</li>
    </ol>`,
};

// 2 · Database
const db = {
  kind: "ok",
  big: "13",
  small: "of 13",
  title: "Database migrated",
  text: "13 of 13 migrations applied. Newest: <code>202611160002_peer_rev</code>.",
};
const dbEmpty = {
  kind: "bad",
  big: "0",
  small: "of 13",
  next: true,
  title: "The database has no tables",
  text: "Nothing can be stored, so this deployment is not live, whatever its settings say. Sign-in, peers and payments all need this first.",
  fix: `
    <p class="label">Fix</p>
    <ol class="steps">
      <li><p>From your machine, in <code>server/</code>, with <code>SUPABASE_DB_URL</code> in <code>.env.local</code>:</p>${copy("npm run db:migrate", "Command")}</li>
      <li><p>No database URL? Run the 13 files in <code>supabase/migrations</code> in the SQL editor, in file-name order.</p></li>
      <li><p>Come back here. This page counts the applied migrations each time it opens.</p>${again("webhook")}</li>
    </ol>`,
};

// 3 · Payments webhook
const HOOK = "https://charge.example.com/api/webhooks/stripe";
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
const hook = {
  kind: "ok",
  big: icon("check"),
  small: "2 min",
  title: "Payments webhook verified",
  text: "The last signed event from the payment provider arrived 2 minutes ago and its signature matched (<code>payment_intent.succeeded</code>, test mode).",
};
const hookMissing = {
  kind: "todo",
  big: "0",
  small: "events",
  next: true,
  title: "No signed payment event has arrived",
  text: "The payment provider has not reached this server yet, so a hold, capture or refund it reports would go unnoticed here. Do not take card payments until one signed event has arrived.",
  fix: `
    <p class="label">Fix</p>
    <ol class="steps">
      <li><p>In the Stripe Dashboard of the network's account, add a webhook endpoint with this address:</p>${copy(HOOK.replace("/api", "<wbr>/api"), "Webhook endpoint address")}</li>
      <li><p>Subscribe it to these 11 events:</p>${copy(EVENTS.replaceAll(".", ".<wbr>"), "Events")}</li>
      <li><p>Copy the endpoint's signing secret (it starts with <code>whsec_</code>) into <code>STRIPE_WEBHOOK_SECRET</code> and redeploy.</p></li>
      <li><p>Send a test event from the Dashboard, then check here.</p>${again("mid")}</li>
    </ol>
    <p class="small muted">Events arrive but are refused? Then the signing secret is from another endpoint or from the other mode (test or live). Copy it again from this endpoint.</p>`,
};

// 4 · Scheduled job
const CRON = `GET https://charge.example.com/api/cron/ocpi-sync
Authorization: Bearer &lt;CRON_SECRET&gt;`;
const jobDaily = {
  kind: "todo",
  big: "24",
  small: "hours",
  title: "The scheduled job runs once a day",
  text: "Last run: today, 04:00. That is enough to pull locations, but not for payments.",
  note: `
    <div class="msg limit" role="note">
      <p class="t">${icon("alert")}<span>Free hosting limit: drivers cannot start a paid charge on this schedule.</span></p>
      <p>A card hold is refused when the payment sweep is older than 5 minutes. Free plans on most hosts run scheduled jobs once a day at most, so holds are refused nearly all day.</p>
    </div>`,
  fix: `
    <p class="label">Fix: run it every minute</p>
    <ol class="steps">
      <li><p>On a paid hosting plan: set the schedule in <code>vercel.json</code> to <code class="nw">* * * * *</code> and redeploy.</p></li>
      <li><p>Or keep free hosting and call the job from any scheduler, every minute:</p>${copy(CRON, "Request")}</li>
    </ol>`,
};
const jobOk = {
  kind: "ok",
  big: "1",
  small: "min",
  title: "The scheduled job runs every minute",
  text: "Last run 25 seconds ago. The payment sweep is 25 seconds old, so card holds are accepted.",
};

// 5 · First admin
const SQL = `insert into public.emsp_admins (user_id, role)
select id, 'admin' from auth.users
where email = '<mark>ana@example.com</mark>';`;
const adminNone = {
  kind: "todo",
  big: "0",
  small: "admins",
  next: true,
  title: "No admin exists yet",
  text: "Nobody can sign in until one does. The first admin is added by hand, once, in this order.",
  fix: `
    <p class="label">Fix</p>
    <ol class="steps">
      <li class="done"><p>Ask for a sign-in code with your email. This creates your user. Done for <strong>ana@example.com</strong>, 4 minutes ago.</p></li>
      <li><p>Run this once in your database's SQL editor:</p>${copy(SQL, "SQL statement")}</li>
      <li><p>Sign in with the code from the email. If the code has expired by then, ask for a new one.</p><p><a class="btn sm" href="sign-in.html#first">Go to sign-in ${icon("arrow")}</a></p></li>
    </ol>
    <p class="small muted">Used a different address? Ask for a code with it on the sign-in page and the statement here follows.</p>`,
};
const admins = {
  kind: "ok",
  big: "1",
  small: "admin",
  title: "First admin added",
  text: "ana@example.com (admin), signed in now.",
};

// 6 · First peer
const peerNone = {
  kind: "todo",
  big: "0",
  small: "peers",
  next: true,
  title: "No peer yet",
  text: "A peer is a CPO or a roaming hub you exchange data with. Until one is connected, the drivers' map is empty and nobody can charge.",
  fix: `
    <p class="label">Fix</p>
    <ol class="steps">
      <li><p>Ask the CPO or the hub for two things: its <strong>versions URL</strong> and a <strong>one-time token</strong>. A hub shows both in its portal.</p></li>
      <li><p>Connect. The form first asks who gave you the token, a hub or a CPO, and uses the right words for each.</p><p><a class="btn sm" href="connect.html#choose">Connect a peer ${icon("arrow")}</a></p></li>
      <li><p>For a hub, accept the parties you trade with afterwards. This stop turns to Done when the first peer shows as Registered.</p></li>
    </ol>
    <p class="small muted">A CPO that wants to register with you instead? <a href="connect.html#choose">Connect</a> also makes a one-time token to send to them.</p>`,
};

const envState = [
  envMissing,
  waits("Not checked yet", "the environment"),
  waits("Payments webhook not checked yet"),
  waits("Scheduled job not checked yet"),
  waits("No admin yet"),
  waits("No peer yet", "the first admin"),
];
const blank = [
  fold(env),
  dbEmpty,
  waits("Payments webhook not checked yet"),
  waits("Scheduled job not checked yet"),
  waits("No admin yet"),
  waits("No peer yet", "the first admin"),
];
const webhook = [
  fold(env),
  fold(db),
  hookMissing,
  later(jobDaily),
  later(adminNone),
  waits("No peer yet", "the first admin"),
];
const mid = [
  fold(env),
  fold(db),
  fold(hook),
  later(jobDaily),
  adminNone,
  waits("No peer yet", "the first admin"),
];
const peer = [
  fold(env),
  fold(db),
  fold({
    ...hook,
    small: "40 s",
    text: "The last signed event arrived 40 seconds ago and its signature matched (<code>setup_intent.succeeded</code>, live mode).",
  }),
  fold(jobOk),
  fold(admins),
  peerNone,
];

const health = (job) => [
  env,
  db,
  {
    kind: "ok",
    big: icon("check"),
    small: "40 s",
    title: "Payments webhook verified",
    text: "Last signed event 40 seconds ago (<code>payment_intent.amount_capturable_updated</code>, live mode).",
  },
  job,
  {
    kind: "ok",
    big: "2",
    small: "admins",
    title: "Admins",
    text: "ana@example.com (admin) and sam@example.com (read only).",
  },
  {
    kind: "ok",
    big: "3",
    small: "peers",
    title: "Peers",
    text: 'Two CPOs and one roaming hub with 2 trusted parties. <a href="peers.html">See peers</a>',
  },
];
const late = health({
  kind: "bad",
  big: "12",
  small: "min ago",
  next: true,
  title: "The scheduled job has stopped",
  text: "Last run 12 minutes ago; it should run every minute. Card holds have been refused since 14:12, so drivers cannot start a paid charge.",
  fix: `
    ${message("bad", "Card holds refused: the payment sweep has not run in the last 5 minutes.", { code: "payment_sweep_stale", next: "Open your scheduler and check that the request below still runs every minute and gets a 200. Holds resume by themselves after the next run." })}
    ${copy(CRON, "Request")}`,
});

const hero = (show, cls, big, small, title, text) => `
<section class="hero ${cls}" data-show="${show}" aria-label="Overall state">
  ${tile("", big, small, "lg")}
  <div><h2>${title}</h2><p>${text}</p></div>
</section>`;

const side = `
<aside class="stack" aria-label="About this deployment">
  <section class="card">
    <h3>This deployment</h3>
    <dl class="facts small" style="margin-top:0.75rem">
      <dt>Mode</dt>
      <dd><span data-show="env">${state("off", "Demo")}</span><span data-show="blank webhook mid peer">${state("todo", "Setting up")}</span><span data-show="health late">${state("ok", "Live")}</span></dd>
      <dt>Role</dt><dd>eMSP, OCPI 2.2.1</dd>
      <dt>Party</dt><dd><code>NL-KLO</code></dd>
      <dt>Address</dt><dd><code>charge.example.com</code></dd>
    </dl>
  </section>
  <section class="card">
    <h3>Limits here</h3>
    <ul class="stack tight small" style="margin-top:0.75rem">
      <li data-show="env blank"><strong>Scheduled job: not checked yet.</strong> Card holds need it every minute.</li>
      <li data-show="webhook mid"><strong>Scheduled job: once a day.</strong> Card holds need it every minute.</li>
      <li data-show="peer health"><strong>Scheduled job: every minute.</strong> Holds are refused if it is more than 5 minutes late.</li>
      <li data-show="late"><strong>Scheduled job: 12 minutes late.</strong> Holds are refused until it runs.</li>
      <li><strong>Sign-in codes:</strong> 5 per email address per hour.</li>
      <li><strong>Admin sessions:</strong> one hour, then sign in again.</li>
      <li><strong>Hold per charge:</strong> €25.00, captured from the CDR, never above the hold.</li>
    </ul>
  </section>
</aside>`;

export const setup = {
  file: "setup",
  nav: "setup",
  title: "Setup",
  states: [
    ["mid", "Day one: setting up"],
    ["env", "1 Settings missing"],
    ["blank", "2 Empty database"],
    ["webhook", "3 No webhook yet"],
    ["peer", "6 No peer yet"],
    ["health", "Day thirty: healthy"],
    ["late", "Day thirty: job stopped"],
  ],
  signedOut: ["env", "blank", "webhook", "mid"],
  setupCount: { env: 6, blank: 5, webhook: 4, mid: 3, peer: 1, late: 1 },
  body: `
<div data-show="env blank webhook mid peer">${head(["Setup"], "Get this network live", "Six stops, in order. Each one shows what it found and, when something is missing, exactly what to do.")}</div>
<div data-show="health late">${head(["Health"], "Health", "The same six checks as on day one, run again each time this page opens.", `<a class="btn ghost sm" href="#health" data-go="health">${icon("refresh")}Check again</a>`)}</div>
<div class="cols">
  <div class="stack">
    ${hero("blank", "", "1", "of 6", "Not live: 1 of 6 done", "The server is running but has nowhere to store anything yet. Start at stop 2.")}
    ${hero("env", "", "0", "of 6", "Demo mode: 0 of 6 done", "Two settings are missing or malformed, so nothing is stored yet. Start at stop 1.")}
    ${hero("webhook", "", "2", "of 6", "Setting up: 2 of 6 done", "Not live yet. Next: the payments webhook, at stop 3.")}
    ${hero("peer", "", "5", "of 6", "Almost live: 5 of 6 done", "Everything on this server is ready. Next: connect the first peer, at stop 6.")}
    ${hero("mid", "", "3", "of 6", "Setting up: 3 of 6 done", "Not live yet. Next: add the first admin, at stop 5.")}
    ${hero("health", "live", "6", "of 6", "Live", "Every check passes. Checked 20 seconds ago.")}
    ${hero("late", "", "5", "of 6", "Live, but card holds are refused", "The scheduled job stopped 12 minutes ago. See stop 4.")}
    ${lane("blank", blank)}
    ${lane("env", envState)}
    ${lane("webhook", webhook)}
    ${lane("mid", mid)}
    ${lane("peer", peer)}
    ${lane("health", health(jobOk))}
    ${lane("late", late)}
  </div>
  ${side}
</div>`,
};
