// The page the owner opens first: what this is, then every screen and state.
const ABOUT = {
  setup:
    "The first-run checklist: environment, database, payments webhook, scheduled job, first admin, first peer. Each stop has a state and its fix. On day thirty the same page is Health.",
  "sign-in":
    "By emailed code: type the code, do not click the link. Both rate limits say whose limit it is and how long to wait. The first admin's exact SQL statement.",
  peers:
    "The list of CPOs and hubs with their state, a failing pull with its code and next step, and the not-signed-in state: a sign-in prompt, never a secret field.",
  connect:
    "The roaming hub flow in its own words: one-time token, the handshake, what Registered looks like, accept parties next, subscriptions in the hub's portal. And the refused-token state.",
  hub: "Parties behind a hub: trusted and offered, accept and remove, and where the connection's tokens are rotated.",
  sessions:
    "The table pattern for every data page: filters as chips, a table on desktop, one card per row on a phone, plain states.",
};

export function index(screens) {
  const cards = screens
    .map(
      (s) => `
<li class="card stack">
  <h2><a href="${s.file}.html">${s.title}</a></h2>
  <p>${ABOUT[s.file]}</p>
  <p class="row small">${s.states.map(([id, label]) => `<a href="${s.file}.html#${id}">${label}</a>`).join('<span aria-hidden="true" class="muted">·</span>')}</p>
</li>`,
    )
    .join("");
  return {
    title: "All screens",
    plain: true,
    body: `
<div class="mock" role="region" aria-label="Mockup controls, not part of the design">
  <b>MOCKUP</b><span>Sample data. Nothing here is connected to a server.</span>
  <span class="gap"></span>
  <button type="button" data-theme-set="auto">Auto</button>
  <button type="button" data-theme-set="light">Light</button>
  <button type="button" data-theme-set="dark">Dark</button>
</div>
<main id="main"><div class="page stack">
  <div class="prose">
    <p class="crumb">eMSP Starter · admin redesign · phase 1</p>
    <h1>Kilolane admin: mockups</h1>
    <p class="muted">Six screens, clickable, each with its states in the dark strip at the top. Made for a phone first; on a wide screen the same pages grow a side rail. Use Light and Dark in the strip to switch theme.</p>
  </div>
  <ul class="stack">${cards}</ul>
  <div class="prose">
    <h2>The idea in five lines</h2>
    <ul>
      <li><strong>Day one, the admin is a developer who has just deployed.</strong> They need to know what is still missing and the exact command, statement or setting that fixes it. The admin opens on Setup.</li>
      <li><strong>Day thirty, the admin runs a network.</strong> They need to see that it is healthy, find a session or a payment, and act on a peer. The same six checks become Health; the lists open by themselves.</li>
      <li><strong>One sign-in, in one place.</strong> No form asks for a secret. A page with nobody signed in says so and links to sign-in.</li>
      <li><strong>Things, not forms.</strong> A peer is a row you open, with its own actions. Nobody copies a peer ID from one card into another.</li>
      <li><strong>Every problem keeps its code and next step</strong>, and says whose limit or whose error it is.</li>
    </ul>
    <p>The full brief, the information architecture, what moves where and the proposed follow-up tickets are in this folder's README.</p>
  </div>
</div></main>`,
  };
}
