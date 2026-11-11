// Generates the static mockup pages in this folder (SQD-80). Run from cpo-starter-kit:
//   node docs/mockups/build.mjs && npx prettier --write docs/mockups
// Demo data only: every name, id and figure below is invented. Not part of the app.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pages, screens } from "./content.mjs";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, "proposed"), { recursive: true });
const write = (name, html) => writeFileSync(join(here, name), html);

const ICONS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="mark" viewBox="0 0 48 48"><path d="M18 2H46V30A16 16 0 0 1 30 46H2V18A16 16 0 0 1 18 2Z" fill="var(--color-primary)"/><g fill="none" stroke="var(--color-accent)" stroke-width="4" stroke-linecap="round"><path d="M11 37 33 15"/><path d="M18 30V22M25 23V14"/></g><circle cx="35.5" cy="12.5" r="3.5" fill="var(--color-accent)"/></symbol>
<symbol id="i-dash" viewBox="0 0 24 24"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></symbol>
<symbol id="i-live" viewBox="0 0 24 24"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></symbol>
<symbol id="i-plug" viewBox="0 0 24 24"><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="m2 22 3-3M7.5 13.5 10 11M10.5 16.5 13 14M18 3l-4 4h6l-4 4"/></symbol>
<symbol id="i-tag" viewBox="0 0 24 24"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/></symbol>
<symbol id="i-chart" viewBox="0 0 24 24"><path d="M3 3v16a2 2 0 0 0 2 2h16M18 17V9M13 17V5M8 17v-3"/></symbol>
<symbol id="i-users" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.128a4 4 0 0 1 0 7.744M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/></symbol>
<symbol id="i-gear" viewBox="0 0 24 24"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></symbol>
<symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 5h16M4 12h16M4 19h16"/></symbol>
<symbol id="i-more" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></symbol>
<symbol id="i-inbox" viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>
</svg>`;
const icon = (n) =>
  `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;

const NAV = [
  [
    "Run",
    [
      ["live", "Live", "live"],
      ["chargers", "Chargers", "plug"],
    ],
  ],
  [
    "Money",
    [
      ["pricing", "Pricing", "tag"],
      ["reports", "Reports", "chart"],
    ],
  ],
  ["Workspace", [["settings", "Settings", "gear"]]],
];
const HREF = {
  live: "live",
  chargers: "chargers",
  pricing: "pricing",
  reports: "reports",
  settings: "settings",
};
const TAB = [
  ["live", "Live", "live"],
  ["chargers", "Chargers", "plug"],
  ["pricing", "Pricing", "tag"],
  ["reports", "Reports", "chart"],
  ["settings", "Settings", "gear"],
];

const head = (title, extra = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${extra ? "../" : ""}../../brand/tokens.css">
<link rel="stylesheet" href="${extra}mock.css">
</head>`;

/** The operator shell: sidebar (or Menu + tab bar on a phone), crumbs, one page header. */
function shell({ active, crumbs, title, lead, action, body }) {
  const nav = NAV.map(
    ([g, items]) =>
      `<h2>${g}</h2><ul>${items
        .map(
          ([k, l, i]) =>
            `<li><a href="${HREF[k]}.html"${k === active ? ' aria-current="page"' : ""}>${icon(i)}${l}</a></li>`,
        )
        .join("")}</ul>`,
  ).join("");
  const tabs = TAB.map(
    ([k, l, i]) =>
      `<a href="${HREF[k]}.html"${k === active ? ' aria-current="page"' : ""}>${icon(i)}${l}</a>`,
  ).join("");
  const cr = crumbs
    .map(([l, h], n) =>
      n === crumbs.length - 1
        ? `<li><span aria-current="page">${l}</span></li>`
        : `<li><a href="${h}">${l}</a></li>`,
    )
    .join("");
  return `${head(`${title} · Ampleaf mockup`, "../")}
<body>
${ICONS}
<a class="skip" href="#main">Skip to content</a>
<p class="demo" role="status"><b>Mockup</b>Demo data only. Nothing here is real or sent anywhere.</p>
<div class="menu-btn"><span class="brand"><svg viewBox="0 0 48 48" aria-hidden="true"><use href="#mark"/></svg>ampleaf</span><button class="btn sm" type="button">${icon("menu")}Menu</button></div>
<div class="shell">
<aside class="nav" aria-label="Sections"><div class="brand"><svg viewBox="0 0 48 48" aria-hidden="true"><use href="#mark"/></svg>ampleaf</div><span class="ws">Your charging network<span>Workspace</span></span><nav aria-label="Main">${nav}</nav></aside>
<main id="main"><div class="page">
<nav class="crumbs" aria-label="Breadcrumb"><ol>${cr}</ol></nav>
<div class="phead"><div><h1>${title}</h1>${lead ? `<p>${lead}</p>` : ""}</div>${action ? `<div class="actions">${action}</div>` : ""}</div>
${body}
</div></main>
</div>
<nav class="tabbar" aria-label="Main">${tabs}</nav>
<script src="../mock.js"></script>
</body></html>`;
}

const plain = (title, body) => `${head(`${title} · Ampleaf mockup`, "../")}
<body>${ICONS}<a class="skip" href="#main">Skip to content</a><p class="demo" role="status"><b>Mockup</b>Demo data only. Nothing here is real or sent anywhere.</p>
<div id="main">${body}</div><script src="../mock.js"></script></body></html>`;

for (const [id, build] of Object.entries(pages)) {
  const html = build({ shell, plain, icon });
  write(`proposed/${id}.html`, html);
}

// Per-screen review pages: current beside proposed, with the notes.
const li = (a) => a.map((x) => `<li>${x}</li>`).join("");
for (const s of screens) {
  const cur = s.current
    ? `<img data-current="../screens/${s.current}-{size}-{theme}.png" src="../screens/${s.current}-desktop-light.png" alt="Current ${s.title} screen in the shipped template">`
    : `<div class="card"><p>${s.noCurrent}</p></div>`;
  write(
    `${s.id}.html`,
    `${head(`${s.title} · Ampleaf mockups`)}
<body class="review-body"><a class="skip" href="#main">Skip to content</a>
<div class="review" id="main">
<header><nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="index.html">Mockups</a></li><li><span aria-current="page">${s.n}. ${s.title}</span></li></ol></nav>
<h1>${s.n}. ${s.title}</h1><p>${s.summary}</p></header>
<div class="controls" role="group" aria-label="Preview options">
<span class="seg" role="group" aria-label="Theme"><button type="button" data-set="theme" data-value="light" aria-pressed="true">Light</button><button type="button" data-set="theme" data-value="dark" aria-pressed="false">Dark</button></span>
<span class="seg" role="group" aria-label="Width"><button type="button" data-set="size" data-value="desktop" aria-pressed="true">Desktop 1440</button><button type="button" data-set="size" data-value="phone" aria-pressed="false">Phone 390</button></span>
<a class="btn" href="proposed/${s.files[0]}.html">Open proposed screen${s.files.length > 1 ? "s" : ""} full size</a>
${s.files
  .slice(1)
  .map((f) => `<a class="btn" href="proposed/${f}.html">${f}</a>`)
  .join("")}
</div>
<div class="pair">
<figure><figcaption>Current (shipped template)</figcaption>${cur}</figure>
<figure><figcaption>Proposed</figcaption><div class="frame"><iframe data-proposed="proposed/${s.files[0]}.html" title="Proposed ${s.title} mockup"></iframe></div>
<noscript><p><a href="proposed/${s.files[0]}.html">Open the proposed screen</a></p></noscript></figure>
</div>
<div class="notes">
<section class="card"><h2>What changes and why</h2><ul>${li(s.changes)}</ul></section>
<section class="card"><h2>Follows</h2><ul>${li(s.follows)}</ul></section>
<section class="card"><h2>Accessibility</h2><ul>${li(s.a11y)}</ul></section>
<section class="card"><h2>Brand tokens</h2><ul>${li(s.tokens)}</ul></section>
<section class="card"><h2>Build size</h2><p><span class="size">${s.size}</span> ${s.sizeNote}</p></section>
</div>
<p class="muted sm" style="margin-top:var(--space-5)">Demo data only. Current screens are the shipped template's own screenshots (docs/screens).</p>
</div>
<script src="compare.js"></script></body></html>`,
  );
}

write(
  "index.html",
  `${head("Ampleaf polish mockups")}
<body><a class="skip" href="#main">Skip to content</a>
<div class="review" id="main">
<header><h1>Ampleaf polish: mockups</h1>
<p>Static, clickable mockups for owner review (SQD-80). Nothing here is built into the template: pick what you want and build work is filed per screen. Every screen shows the current screen beside the proposal, desktop 1440 and phone 390, light and dark, with what changes, which Squid screen it follows, accessibility, brand tokens and a rough build size. All names, ids and figures are invented demo data.</p></header>
<section class="card" aria-labelledby="rules"><h2 id="rules">Design rules used across every screen</h2>
<ul><li><b>Shell:</b> grouped sidebar (Menu and five tabs on a phone), breadcrumbs, one page width (<code>--content-max</code>), one primary action per page header.</li>
<li><b>Tables:</b> sticky header, numbers right-aligned in tabular figures, sortable heads with <code>aria-sort</code>, filter bar above, one row density, an empty state with a next step; on a phone rows stack.</li>
<li><b>Status:</b> one chip set (shape + word + colour): Charging, Available, Offline, Faulted, Idle. Never colour alone.</li>
<li><b>Forms:</b> label above, help beneath, inline error beside the field with text, a visible “Saved” state.</li>
<li><b>Detail pages:</b> summary strip first, tabs beneath, destructive actions in their own bordered zone at the bottom.</li>
<li><b>Ampleaf stays Ampleaf:</b> palette v2, Manrope and Fraunces, Lucide icons and the leaf corner. Every colour, size and radius is read from <code>brand/tokens.css</code>, so an operator's rebrand carries through.</li></ul></section>
<h2 style="margin:var(--space-5) 0 var(--space-3)">Screens</h2>
<div class="cards">${screens.map((s) => `<a class="card" href="${s.id}.html"><h3>${s.n}. ${s.title}</h3><p class="muted sm">${s.blurb}</p><span class="sm">Build size: <b>${s.size}</b></span></a>`).join("")}</div>
<section class="card" style="margin-top:var(--space-5)"><h2>Overall build size</h2><p>${screens.map((s) => `${s.n} ${s.size}`).join(" · ")}. The shared pieces (shell, table, chip set, form field, tabs, empty/loading/error) are built once first (M) and every screen reuses them.</p></section>
<p class="muted sm" style="margin-top:var(--space-5)">Demo data only. These files live in <code>docs/mockups/</code>, are not imported by the app and are staged into a preview deployment only (see README in this folder).</p>
</div></body></html>`,
);
console.log(
  `wrote ${Object.keys(pages).length} proposed pages, ${screens.length} review pages and the index`,
);
