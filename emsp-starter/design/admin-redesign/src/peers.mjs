import { copy, gate, head, icon, message, state, tile } from "./shell.mjs";

const OUR_URL = "https://charge.example.com/ocpi/versions";
const HUB_URL = "https://hub.example.net/ocpi/versions";

const connectButton = `<a class="btn" href="connect.html" data-hide="out">${icon("plus")}Connect a peer</a>`;

const row = ({ href, kind, big, small, name, tag, st, meta, below = "" }) => `
<li>
  <a class="item" href="${href ?? "#"}"${href ? "" : ' aria-disabled="true" title="Not in this mockup"'}>
    ${tile(kind, big, small)}
    <div class="what">
      <h2 class="h3">${name} <span class="tag${tag === "Hub" ? " hub" : ""}">${tag}</span></h2>
      <p>${st}</p>
      <p class="meta">${meta}</p>
    </div>
    <span class="go">${icon("arrow")}</span>
  </a>
  ${below}
</li>`;

export const peers = {
  file: "peers",
  nav: "peers",
  title: "Peers",
  states: [
    ["list", "Signed in"],
    ["out", "Not signed in"],
    ["empty", "No peers yet"],
  ],
  signedOut: ["out"],
  body: `
${head(["Network"], "Peers", "The charging operators and roaming hubs this network is connected to over OCPI.", connectButton)}

<div data-show="out">${gate("see your peers")}</div>

<div data-show="empty" class="card flat stack">
  <div class="row">${tile("off", "0", "peers")}<div style="flex:1;min-width:0"><h2>No peers yet</h2><p class="muted">Drivers see chargers once a CPO or a roaming hub is connected and its locations are pulled.</p></div></div>
  <div><a class="btn" href="connect.html">${icon("plus")}Connect the first peer</a></div>
</div>

<div data-show="list" class="cols">
  <ul class="list" aria-label="Peers">
    ${row({
      href: "hub.html",
      kind: "ok",
      big: "2",
      small: "of 5",
      name: "Example Roaming Hub",
      tag: "Hub",
      st: state("ok", "Registered"),
      meta: "2 of 5 parties trusted · 61 locations · pulled 3 min ago",
    })}
    ${row({
      kind: "ok",
      big: "42",
      small: "sites",
      name: "Northside Charging",
      tag: "CPO",
      st: state("ok", "Registered"),
      meta: "<span class='mono'>NL-NSC</span> · 42 locations · pulled 3 min ago",
    })}
    ${row({
      kind: "bad",
      big: "!",
      name: "Harbour Street Charge",
      tag: "CPO",
      st: state("bad", "Sessions pull failing"),
      meta: "<span class='mono'>NL-HSC</span> · 17 locations · failed 12 min ago, 4 times in a row",
      below: `<div style="margin-top:0.5rem">${message("bad", "Harbour Street Charge answered the sessions pull with an error of its own.", { code: "OCPI 3000", next: "The CPO failed on a valid request. Nothing is lost: the next pull resumes where this one stopped. If it still fails in an hour, send the CPO the time (14:01) and the request ID <code>req_5d0c41</code>." })}</div>`,
    })}
    ${row({
      kind: "off",
      big: icon("clock"),
      name: "Old Mill Charging",
      tag: "CPO",
      st: state("todo", "Waiting for them to register"),
      meta: "One-time token created yesterday · works for 6 more days",
    })}
  </ul>
  <aside class="card stack">
    <h2 class="h3">Our side</h2>
    <p class="small muted">A peer that registers with us asks for this address. It is public and safe to share; tokens are not.</p>
    ${copy(OUR_URL, "Our versions URL")}
    <dl class="facts small"><dt>Party</dt><dd><code>NL-KLO</code></dd><dt>Role</dt><dd>eMSP, OCPI 2.2.1</dd></dl>
  </aside>
</div>`,
};

const progress = (now, fail = false) => {
  const cls = (i) =>
    i < now ? "done" : i === now ? (fail ? "fail" : "now") : "";
  const cur = (i) => (i === now ? ' aria-current="step"' : "");
  return `<ol class="progress" aria-label="Steps">${["Token", "Handshake", "Registered"].map((s, i) => `<li class="${cls(i + 1)}"${cur(i + 1)}>${i + 1}. ${s}</li>`).join("")}</ol>`;
};

const hubForm = (retry) => `
<form class="card form" data-submit-go="hub-working">
  <div class="field">
    <label for="name${retry}">Name</label>
    <input id="name${retry}" name="label" value="Example Roaming Hub" maxlength="100" required aria-describedby="name-h${retry}">
    <span class="hint" id="name-h${retry}">What you call this hub. Only admins see it.</span>
  </div>
  <div class="field">
    <label for="url${retry}">Hub versions URL</label>
    <input id="url${retry}" name="versionsUrl" type="url" value="${HUB_URL}" required aria-describedby="url-h${retry}">
    <span class="hint" id="url-h${retry}">From the hub's portal. It starts with https:// and usually ends in /versions.</span>
  </div>
  <div class="field">
    <label for="tok${retry}">One-time token</label>
    <input id="tok${retry}" name="tokenA" type="password" autocomplete="off" maxlength="64" required aria-describedby="tok-h${retry}"${retry ? "" : ' value="sample-token-0001"'}>
    <span class="hint" id="tok-h${retry}">${retry ? "Paste the new token from the hub's portal." : "The hub's portal may call it a registration token, credentials token or Token A."} It works once: the handshake trades it for permanent tokens.</span>
  </div>
  <button class="btn wide" type="submit">${retry ? "Try again with the new token" : "Start the handshake"}</button>
</form>`;

const next = `
<aside class="card stack">
  <h2 class="h3">What happens</h2>
  <ol class="steps small">
    <li><p>We read the hub's versions and choose OCPI 2.2.1.</p></li>
    <li><p>We send our credentials, signed with the one-time token.</p></li>
    <li><p>The hub answers with a permanent token. Each side stores its own, encrypted. The one-time token is now spent.</p></li>
    <li><p>The hub shows as <strong>Registered</strong>. Nothing flows yet: you accept the parties you trade with next.</p></li>
  </ol>
  <p class="small muted">Which CPOs the hub sends you, and what from them, is a <strong>subscription you set in the hub's own portal</strong>, not here.</p>
</aside>`;

const step = (kind, text) =>
  `<li class="row" style="flex-wrap:nowrap">${kind === "now" ? '<span class="spin" aria-hidden="true"></span>' : kind === "done" ? `<span class="state ok"><span class="sr">Done:</span></span>` : `<span class="state off"><span class="sr">Not yet:</span></span>`}<span${kind === "wait" ? ' class="muted"' : ""}>${text}</span></li>`;

export const connect = {
  file: "connect",
  nav: "peers",
  title: "Connect a peer",
  states: [
    ["choose", "Choose"],
    ["hub-form", "Hub: token"],
    ["hub-working", "Hub: handshake"],
    ["hub-done", "Hub: registered"],
    ["hub-refused", "Hub: token refused"],
  ],
  body: `
<div data-show="choose">
  ${head(['<a href="peers.html">Network</a>', "Connect"], "Connect a peer", "Start from what you were given.")}
  <ul class="choice">
    <li><a class="item" href="#hub-form">${tile("brand", icon("hub"))}<div class="what"><h2 class="h3">A roaming hub gave me a one-time token</h2><p class="meta">Register once at the hub, then choose which of the CPOs behind it you trust.</p></div><span class="go">${icon("arrow")}</span></a></li>
    <li><a class="item" href="#" aria-disabled="true" title="Not in this mockup">${tile("brand", icon("bolt"))}<div class="what"><h2 class="h3">A CPO gave me a token</h2><p class="meta">Register directly at one charging operator with its versions URL and Token A.</p></div><span class="go">${icon("arrow")}</span></a></li>
    <li><a class="item" href="#" aria-disabled="true" title="Not in this mockup">${tile("brand", icon("out"))}<div class="what"><h2 class="h3">They will register with us</h2><p class="meta">Create a one-time token here and send it to them with our versions URL.</p></div><span class="go">${icon("arrow")}</span></a></li>
  </ul>
</div>

<div data-show="hub-form hub-working hub-done hub-refused" class="stack">
  ${head(['<a href="peers.html">Network</a>', '<a href="#choose">Connect</a>', "Roaming hub"], "Connect a roaming hub")}
  <div data-show="hub-form">${progress(1)}</div>
  <div data-show="hub-working">${progress(2)}</div>
  <div data-show="hub-refused">${progress(2, true)}</div>
  <div data-show="hub-done">${progress(4)}</div>

  <div class="cols" data-show="hub-form">
    ${hubForm("")}
    ${next}
  </div>

  <div class="cols" data-show="hub-working">
    <section class="card stack" data-auto="hub-done" aria-live="polite">
      <h2>Handshake with Example Roaming Hub</h2>
      <ul class="stack tight">
        ${step("done", "Read the hub's versions: OCPI 2.2.1 found")}
        ${step("done", "Read its endpoints: 7 modules")}
        ${step("now", "Sending our credentials with the one-time token")}
        ${step("wait", "Store the permanent token")}
      </ul>
      <p class="small muted">This takes a few seconds. Keep the page open.</p>
    </section>
    ${next}
  </div>

  <div class="cols" data-show="hub-done">
    <div class="stack">
      ${message("ok", "Registered with Example Roaming Hub.", {
        body: `<dl class="facts">
          <dt>Status</dt><dd>${state("ok", "Registered")}</dd>
          <dt>It is a</dt><dd>Roaming hub <span class="mono">NL-ERH</span></dd>
          <dt>Offers</dt><dd>Locations, tariffs, sessions, CDRs, commands, tokens, client list</dd>
          <dt>Since</dt><dd>24 Nov 2026, 14:07</dd>
          <dt>One-time token</dt><dd>Spent. It is not kept anywhere.</dd>
        </dl>`,
      })}
      <section class="gate">
        ${tile("todo", "0", "of 5")}
        <h2>Next: accept parties</h2>
        <p>The hub is connected but idle. It lists 5 CPOs; none is trusted yet, so nothing is pulled or pushed. Accept the ones you have an agreement with.</p>
        <a class="btn" href="hub.html#offered">Accept parties ${icon("arrow")}</a>
      </section>
    </div>
    <aside class="card stack">
      <h2 class="h3">Subscriptions live at the hub</h2>
      <p class="small">Accepting a party here says <strong>you trust it</strong>. Whether the hub <strong>sends you its data</strong> is a subscription you set in the hub's own portal. You need both.</p>
    </aside>
  </div>

  <div class="cols" data-show="hub-refused">
    <div class="stack">
      ${message(
        "bad",
        "The hub refused the one-time token. Nothing was stored on either side.",
        {
          code: "HTTP 401",
          next: "Get a new one-time token in the hub's portal and paste it below. Rotating tokens does not help here: there is no registration to rotate yet.",
          body: `<p class="label">Usual reasons</p>
        <ul class="bullets">
          <li><strong>Already used.</strong> The first handshake that reaches the hub spends the token, even one that failed later. If the hub's portal shows this network as registered, ask the hub to reset the registration, then issue a new token.</li>
          <li><strong>Expired, or from the other environment.</strong> Test and production have different tokens and different versions URLs.</li>
          <li><strong>Copied with a space or a line break</strong> at either end.</li>
        </ul>`,
        },
      )}
      ${hubForm("-2")}
    </div>
    <aside class="card stack">
      <h2 class="h3">If the hub asks for our address</h2>
      <p class="small muted">Some portals want your versions URL before they issue a token.</p>
      ${copy(OUR_URL, "Our versions URL")}
    </aside>
  </div>
</div>`,
};

const party = ({ kind, big, small, name, id, meta, trusted, show }) => `
<li class="item acts"${show ? ` data-show="${show}"` : ""}>
  ${tile(kind, big, small)}
  <div class="what"><h3>${name} <span class="mono muted">${id}</span></h3><p class="meta">${meta}</p></div>
  <span class="end">${trusted ? `<button class="btn danger sm" type="button">Remove<span class="sr"> ${name}</span></button>` : `<button class="btn sm" type="button" data-go="trusted">Accept<span class="sr"> ${name}</span></button>`}</span>
</li>`;

const P = {
  rve: { name: "Riverside EV", id: "DE-RVE" },
  hte: { name: "Hilltop Energy", id: "AT-HTE" },
  lvp: { name: "Lakeview Power", id: "NL-LVP" },
  msq: { name: "Market Square EV", id: "BE-MSQ" },
  nfc: { name: "Northfield Charge", id: "DK-NFC" },
};
const offered = (p, show) =>
  party({
    ...p,
    show,
    kind: "off",
    big: "?",
    meta: "Offered by the hub's client list. Not trusted: nothing is sent or accepted.",
  });

export const hub = {
  file: "hub",
  nav: "peers",
  title: "Example Roaming Hub",
  states: [
    ["trusted", "2 of 5 trusted"],
    ["offered", "Just registered"],
    ["out", "Not signed in"],
  ],
  signedOut: ["out"],
  body: `
${head(['<a href="peers.html">Network</a>', '<a href="peers.html">Peers</a>'], 'Example Roaming Hub <span class="tag hub">Hub</span>', "One connection, several CPOs behind it. You decide which of them this network trusts.")}

<div data-show="out">${gate("manage this hub")}</div>

<div class="cols" data-hide="out">
  <div class="stack">
    <div data-show="offered">${message("wait", "Connected, but idle: no party is trusted yet.", { next: "Accept the CPOs you have an agreement with. Pulls and token pushes start with the first one." })}</div>

    <section class="stack" aria-labelledby="trusted-h" data-show="trusted">
      <div class="row between"><h2 id="trusted-h">Trusted <span class="muted">2</span></h2></div>
      <ul class="list">
        ${party({ ...P.rve, kind: "ok", big: "38", small: "sites", trusted: true, meta: "Trusted since 12 Nov · pulled 3 min ago · tokens pushed" })}
        ${party({ ...P.hte, kind: "ok", big: "23", small: "sites", trusted: true, meta: "Trusted since 19 Nov · pulled 3 min ago · tokens pushed" })}
      </ul>
    </section>

    <section class="stack" aria-labelledby="offered-h">
      <div class="row between">
        <h2 id="offered-h">Offered <span class="muted" data-show="trusted">3</span><span class="muted" data-show="offered">5</span></h2>
        <button class="btn ghost sm" type="button">${icon("refresh")}Read the hub's list again</button>
      </div>
      <p class="muted">The hub lists these CPOs. Offered is not trusted: we send them nothing and refuse what arrives in their name until you accept.</p>
      <ul class="list">
        ${offered(P.rve, "offered")}${offered(P.hte, "offered")}
        ${offered(P.lvp)}${offered(P.msq)}${offered(P.nfc)}
      </ul>
      <details class="card flat">
        <summary><strong>Add a party the hub does not list</strong></summary>
        <form class="form" style="margin-top:1rem">
          <div class="row" style="align-items:start">
            <div class="field" style="width:7rem"><label for="cc">Country</label><input id="cc" maxlength="2" placeholder="NL"></div>
            <div class="field" style="width:7rem"><label for="pid">Party ID</label><input id="pid" maxlength="3" placeholder="ABC"></div>
            <div class="field" style="flex:1;min-width:10rem"><label for="pname">Name (optional)</label><input id="pname" maxlength="100"></div>
          </div>
          <div><button class="btn sm" type="submit">Accept this party</button></div>
        </form>
      </details>
    </section>

    <div class="msg" role="note">
      <p class="t">${icon("hub")}<span>Accepted a party but see none of its chargers?</span></p>
      <p>Check your subscription in the hub's own portal. The hub decides which CPOs send to you; accepting here only says this network trusts them. You need both.</p>
    </div>
  </div>

  <aside class="stack">
    <section class="card stack">
      <h2 class="h3">Connection</h2>
      <dl class="facts small">
        <dt>Status</dt><dd>${state("ok", "Registered")}</dd>
        <dt>Direction</dt><dd>We registered at the hub</dd>
        <dt>Hub party</dt><dd><code>NL-ERH</code></dd>
        <dt>Since</dt><dd><span data-show="trusted">12 Nov 2026</span><span data-show="offered">Today, 14:07</span></dd>
        <dt>Address</dt><dd><code>hub.example.net</code></dd>
      </dl>
    </section>
    <section class="card stack" data-show="trusted">
      <h2 class="h3">Last pulls</h2>
      <dl class="facts small">
        <dt>Locations</dt><dd>${state("ok", "3 min ago")} · 61 stored</dd>
        <dt>Tariffs</dt><dd>${state("ok", "3 min ago")} · 14 stored</dd>
        <dt>Sessions</dt><dd>${state("ok", "1 min ago")}</dd>
        <dt>CDRs</dt><dd>${state("ok", "1 min ago")}</dd>
      </dl>
      <button class="btn ghost sm" type="button">${icon("refresh")}Pull changes now</button>
    </section>
    <section class="card stack">
      <h2 class="h3">Tokens and removal</h2>
      <p class="small muted">Rotating swaps both permanent tokens for new ones. Do it after a leak or on your own schedule. It does not repair a refused one-time token.</p>
      <div class="row">
        <button class="btn ghost sm" type="button">Rotate tokens</button>
        <button class="btn danger sm" type="button">Unregister</button>
      </div>
    </section>
  </aside>
</div>`,
};
