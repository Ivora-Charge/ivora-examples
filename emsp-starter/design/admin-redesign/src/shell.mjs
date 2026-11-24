// The frame every mockup screen shares: the mockup strip, the phone top bar and tab
// bar, the desktop rail, and the small pieces (icons, tiles, messages) the screens reuse.

const PATHS = {
  setup: '<path d="M4 6h3M4 12h3M4 18h3M11 6h9M11 12h9M11 18h9"/>',
  network:
    '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M12 11.5 6.5 17M12 11.5l5.5 5.5"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  wallet:
    '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V11a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2z"/><path d="M16.5 14h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  flag: '<path d="M5 21V4h13l-2.5 4.500L18 13H5"/>',
  scale:
    '<path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z"/>',
  check: '<path d="m5 12.5 4.5 4.500L19 7.5"/>',
  alert:
    '<path d="M12 9v4.500M12 17h.01"/><path d="M10.3 3.9 2.4 17.500A2 2 0 0 0 4.1 20.500h15.800a2 2 0 0 0 1.7-3L13.7 3.900a2 2 0 0 0-3.4 0z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  lock: '<rect x="4.5" y="11" width="15" height="9.5" rx="2"/><path d="M8 11V7.500a4 4 0 0 1 8 0V11"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  hub: '<circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
  refresh:
    '<path d="M20 11a8 8 0 0 0-14.5-4L4 8.500M4 4v4.500h4.500M4 13a8 8 0 0 0 14.5 4L20 15.500M20 20v-4.500h-4.5"/>',
  out: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>',
};
export const icon = (name) =>
  `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;

/** The Kilolane mark from the driver app (app/src/components/Logo.tsx). */
const MARK =
  '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><g transform="rotate(-12 24 24)"><path fill="var(--c-primary)" fill-rule="evenodd" d="M24 2.5c-9.7 0-17.5 7.6-17.5 17.1 0 12.2 15.1 24.6 16.4 25.6a1.8 1.8 0 0 0 2.2 0c1.3-1 16.4-13.4 16.4-25.600C41.5 10.1 33.7 2.5 24 2.500ZM17.6 12.400a2.4 2.4 0 0 1 2.4 2.400v7.400a2.4 2.4 0 0 1-4.8 0v-7.400a2.4 2.4 0 0 1 2.4-2.400Zm12.8 0a2.4 2.4 0 0 1 2.4 2.400v7.400a2.4 2.4 0 0 1-4.8 0v-7.400a2.4 2.4 0 0 1 2.4-2.400Z"/></g><circle cx="40.5" cy="40.5" r="5" fill="var(--c-flare)"/></svg>';
const logo = `<a class="logo" href="setup.html#health">${MARK}<span class="word">kilolane</span><span class="role">Admin</span></a>`;

/** A power tile: `kind` is ok, todo, bad, off or brand. `big` may be an icon. */
export const tile = (kind, big, small = "", extra = "") =>
  `<span class="tile ${kind} ${extra}" aria-hidden="true">${big.startsWith("<") ? big : `<b>${big}</b>`}${small ? `<small>${small}</small>` : ""}</span>`;

export const state = (kind, text) =>
  `<span class="state ${kind}">${text}</span>`;

/** What happened, then its code and next step: the lib/admin/errors.ts pattern. */
export const message = (kind, title, { code, next, body = "" } = {}) => `
<div class="msg ${kind}" role="${kind === "bad" ? "alert" : "status"}">
  <p class="t">${icon(kind === "ok" ? "check" : kind === "wait" ? "clock" : "alert")}<span>${title}</span></p>
  ${body}
  ${
    code || next
      ? `<dl class="help">${code ? `<dt>Code</dt><dd><code>${code}</code></dd>` : ""}${next ? `<dt>Next step</dt><dd>${next}</dd>` : ""}</dl>`
      : ""
  }
</div>`;

export const copy = (text, label = "") =>
  `<div class="copy"><pre${label ? ` aria-label="${label}"` : ""} tabindex="0">${text}</pre><button type="button" data-copy>Copy</button></div>`;

/** What a screen shows in place of its data when nobody is signed in. Never a secret field. */
export const gate = (what) => `
<section class="gate" aria-labelledby="gate-h">
  ${tile("brand", icon("lock"))}
  <h2 id="gate-h">Sign in as an admin to ${what}</h2>
  <p>This page shows nothing until an admin is signed in. Signing in takes an email address and the 6-digit code we send to it.</p>
  <a class="btn" href="sign-in.html">Sign in ${icon("arrow")}</a>
</section>`;

const NAV = [
  { id: "setup", href: "setup.html#health", label: "Setup", icon: "setup" },
  { group: "Network" },
  { id: "peers", href: "peers.html", label: "Peers", icon: "network" },
  { group: "Charging" },
  { id: "sessions", href: "sessions.html", label: "Sessions", icon: "bolt" },
  { id: "problems", label: "Problems", icon: "flag" },
  { group: "Money" },
  { id: "payments", label: "Payments", icon: "wallet" },
  { id: "recon", label: "Reconciliation", icon: "scale" },
  { group: "Drivers" },
  { id: "drivers", label: "Drivers and tokens", icon: "user" },
];
const counts = (setupCount) =>
  Object.entries(setupCount)
    .map(
      ([s, n]) =>
        `<span class="count" data-show="${s}">${n}<span class="sr"> to do</span></span>`,
    )
    .join("");
/** "Setup" until the six checks pass, "Health" from then on. */
const setupLabel = (setupCount) => {
  const early = ["env", "blank", "webhook", "mid", "peer", "first"]
    .filter((s) => s in setupCount)
    .join(" ");
  return early
    ? `<span data-show="${early}">Setup</span><span data-hide="${early}">Health</span>`
    : "Health";
};
const link = (n, nav, setupCount) => {
  const count = n.id === "setup" ? counts(setupCount) : "";
  if (n.id === "setup") n = { ...n, label: setupLabel(setupCount) };
  if (!n.href)
    return `<a href="#" aria-disabled="true" title="Not in this mockup">${icon(n.icon)}${n.label}</a>`;
  return `<a href="${n.href}"${n.id === nav ? ' aria-current="page"' : ""}>${icon(n.icon)}${n.label}${count}</a>`;
};

/**
 * One screen. `states` are the states of the screen the mockup strip switches between
 * (the first is the default), `signedOut` the ones where nobody is signed in.
 */
export function shell({ nav, states, signedOut = [], setupCount = {}, body }) {
  const out = signedOut.join(" ");
  const who = `
    <a class="who" href="sign-in.html#signed-in" data-hide="${out}"><span class="av" aria-hidden="true">A</span><span class="em">ana@example.com</span><span class="sr">, admin. Account</span></a>
    <a class="who out" href="sign-in.html" data-show="${out}">Sign in</a>`;
  const tab = (id, href, label, ic, count = "") =>
    `<a href="${href}"${id === nav ? ' aria-current="page"' : ""}><span class="ic">${icon(ic)}${count}</span>${label}</a>`;
  return `
<div class="mock" role="region" aria-label="Mockup controls, not part of the design">
  <b>MOCKUP</b>
  <a href="index.html">All screens</a>
  ${states.length > 1 ? states.map(([id, label]) => `<a href="#${id}" data-state="${id}">${label}</a>`).join("") : ""}
  <span class="gap"></span>
  <button type="button" data-theme-set="auto">Auto</button>
  <button type="button" data-theme-set="light">Light</button>
  <button type="button" data-theme-set="dark">Dark</button>
</div>
<nav aria-label="Skip"><a class="skip" href="#main">Skip to content</a></nav>
<div class="app">
  <header class="topbar">${logo}${who}</header>
  <header class="rail">
    ${logo}
    <nav aria-label="Admin">
      ${NAV.map((n) => (n.group ? `<p class="group">${n.group}</p>` : link(n, nav, setupCount))).join("\n      ")}
    </nav>
    <div class="foot">${who}</div>
  </header>
  <main id="main" tabindex="-1"><div class="page">${body}</div></main>
  <nav class="tabs" aria-label="Admin, phone">
    ${tab("setup", "setup.html#health", setupLabel(setupCount), "setup", counts(setupCount))}
    ${tab("peers", "peers.html", "Peers", "network")}
    ${tab("sessions", "sessions.html", "Sessions", "bolt")}
    <a href="#" aria-disabled="true" title="Not in this mockup"><span class="ic">${icon("wallet")}</span>Money</a>
    <details>
      <summary><span class="ic">${icon("more")}</span>More</summary>
      <div class="more-sheet">
        <a href="#" aria-disabled="true" title="Not in this mockup">${icon("flag")}Problems</a>
        <a href="#" aria-disabled="true" title="Not in this mockup">${icon("scale")}Reconciliation</a>
        <a href="#" aria-disabled="true" title="Not in this mockup">${icon("user")}Drivers and tokens</a>
        <a href="sign-in.html#signed-in">${icon("out")}Account and sign out</a>
      </div>
    </details>
  </nav>
</div>`;
}

export const head = (crumbs, title, lead = "", action = "") => `
<div class="head">
  <div>
    <p class="crumb">${crumbs.join(" <span aria-hidden='true'>/</span> ")}</p>
    <h1>${title}</h1>
    ${lead ? `<p class="lead">${lead}</p>` : ""}
  </div>
  ${action}
</div>`;
