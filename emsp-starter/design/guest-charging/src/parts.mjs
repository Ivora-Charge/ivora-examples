// The pieces every mockup screen shares: the mockup strip, the driver app's frame (a
// tab bar on a phone, a rail on a wide screen, on tab screens only) and the small parts
// the screens reuse. Names, icons and layout follow the app (app/src/components).

// The app's own line icons (app/src/components/Icon.tsx), and a few the design adds.
const PATHS = {
  back: ["M15 5l-7 7 7 7"],
  bolt: ["M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z"],
  card: ["M3.5 6h17v12h-17z", "M3.5 10h17", "M7 15h4"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 2"],
  directions: ["M5 20v-7a4 4 0 0 1 4-4h10", "m15 5 4 4-4 4"],
  flag: ["M5 21V4", "M5 4h11l-2 4 2 4H5"],
  link: [
    "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1",
    "M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1",
  ],
  lock: ["M5 11h14v9.500H5z", "M8 11V7.500a4 4 0 0 1 8 0V11"],
  mail: ["M3.5 6.5h17v11h-17z", "m4 7 8 6 8-6"],
  map: [
    "M9 4 3 6.5v13.5L9 17.5l6 2.5 6-2.5V4l-6 2.5L9 4Z",
    "M9 4v13.5",
    "M15 6.5V20",
  ],
  plug: [
    "M9 3v5",
    "M15 3v5",
    "M6.5 8h11v3a5.5 5.5 0 0 1-11 0V8Z",
    "M12 16.5V21",
  ],
  receipt: [
    "M6 3.5h12v17l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5v-17Z",
    "M9 8h6",
    "M9 12h6",
    "M9 16h3",
  ],
  scan: [
    "M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8",
    "M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8",
    "M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16",
    "M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16",
    "M8 8h3v3H8z",
    "M13 13h3v3h-3z",
    "M13 8h3",
    "M8 16h3",
  ],
  stop: ["M7 7h10v10H7z"],
  user: [
    "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    "M4.5 20.5c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5",
  ],
  wallet: [
    "M4 7.5h15a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5h11",
    "M16 13.5h.01",
  ],
};

export const icon = (name) =>
  `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name].map((d) => `<path d="${d}"/>`).join("")}</svg>`;

/** The Kilolane mark (app/src/components/Logo.tsx). */
const MARK =
  '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><g transform="rotate(-12 24 24)"><path fill="var(--c-primary)" fill-rule="evenodd" d="M24 2.5c-9.7 0-17.5 7.6-17.5 17.1 0 12.2 15.1 24.6 16.4 25.6a1.8 1.8 0 0 0 2.2 0c1.3-1 16.4-13.4 16.4-25.6C41.5 10.1 33.7 2.5 24 2.5ZM17.6 12.4a2.4 2.4 0 0 1 2.4 2.4v7.4a2.4 2.4 0 0 1-4.8 0v-7.4a2.4 2.4 0 0 1 2.4-2.4Zm12.8 0a2.4 2.4 0 0 1 2.4 2.4v7.4a2.4 2.4 0 0 1-4.8 0v-7.4a2.4 2.4 0 0 1 2.4-2.4Z"/></g><circle cx="40.5" cy="40.5" r="5" fill="var(--c-flare)"/></svg>';

export const logo = (brand) =>
  `<span class="logo" role="img" aria-label="${brand.name}">${MARK}<span class="word" aria-hidden="true">${brand.name.toLowerCase()}</span></span>`;

/** Content shown only in the named states of a screen. */
export const when = (states, html, tag = "div", cls = "stack") =>
  `<${tag} class="${cls}" data-show="${states}">${html}</${tag}>`;

export const button = (
  label,
  { href, go, icon: ic, variant = "primary" } = {},
) => {
  const inner = `${ic ? icon(ic) : ""}<span>${label}</span>`;
  if (href) return `<a class="btn ${variant}" href="${href}">${inner}</a>`;
  return `<button type="button" class="btn ${variant}"${go ? ` data-go="${go}"` : ' aria-disabled="true" title="Not in this mockup"'}>${inner}</button>`;
};

export const card = (body, { title, icon: ic, cls = "" } = {}) => `
<section class="card ${cls}">
  ${title ? `<div class="card-head">${ic ? `<span class="chip-icon">${icon(ic)}</span>` : ""}<h2>${title}</h2></div>` : ""}
  ${body}
</section>`;

/** `error` and `warning` are alerts; `info` and `success` are read politely. */
export const notice = (kind, title, body = "") => `
<div class="notice ${kind}" role="${kind === "error" || kind === "warning" ? "alert" : "status"}">
  <p class="t">${title}</p>
  ${body ? `<p>${body}</p>` : ""}
</div>`;

export const facts = (rows) =>
  `<dl class="facts">${rows.map(([k, v, strong]) => `<div><dt>${k}</dt><dd${strong ? ' class="strong"' : ""}>${v}</dd></div>`).join("")}</dl>`;

/** Where a guest is in the two-step start: price, card, charge. */
export const lane = (current) => {
  const steps = ["Price", "Card", "Charge"];
  return `<ol class="lane" aria-label="Steps">${steps
    .map((s, i) => {
      const k = i < current ? "done" : i === current ? "now" : "next";
      return `<li class="${k}"${k === "now" ? ' aria-current="step"' : ""}><span class="n">${k === "done" ? icon("check") : i + 1}</span><span>${s}${k === "done" ? '<span class="sr">, done</span>' : ""}</span></li>`;
    })
    .join("")}</ol>`;
};

/** The back button and the page's one h1; on a wide screen, the network's name too. */
export const head = (brand, title, back) => `
<header class="head">
  ${back ? `<a class="back" href="${back}" aria-label="Back">${icon("back")}</a>` : ""}
  <h1>${title}</h1>
  ${back === false ? "" : logo(brand)}
</header>`;

/** The violet head of a charge, as on the app's live screen, with its body. */
export const charge = (phase, body, place = "Station Square") => `
<section class="charge">
  <div class="charge-head">
    <h2>${place}</h2>
    <p role="status">${phase}</p>
  </div>
  <div class="charge-body">${body}</div>
</section>`;

/**
 * What the cost is against the hold. `at` is where the server asks the charger to stop,
 * in percent of the hold.
 */
export const meter = (cost, hold, percent, at = 90) => `
<div class="meter">
  <p><strong>${cost}</strong> of the <strong>${hold}</strong> held</p>
  <div class="bar" role="meter" aria-label="Cost against the hold" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${cost} of ${hold}">
    <span class="fill" style="width:${percent}%"></span><span class="mark" style="left:${at}%"></span>
  </div>
  <p class="small muted">We ask the charger to stop at the mark, where the operator reports the cost live.</p>
</div>`;

/** A drawing that looks like a QR code and encodes nothing. */
export const sampleCode = () => {
  const n = 29;
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const finder = (x, y) =>
    [0, n - 7].some((fx) =>
      [0, n - 7].some(
        (fy) =>
          !(fx && fy) &&
          x >= fx - 1 &&
          x <= fx + 7 &&
          y >= fy - 1 &&
          y <= fy + 7,
      ),
    );
  let d = "";
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1)
      if (!finder(x, y) && random() > 0.52) d += `M${x} ${y}h1v1h-1z`;
  for (const [x, y] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ])
    d += `M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}v5h5v-5zM${x + 2} ${y + 2}h3v3h-3z`;
  return `<figure class="qr"><svg viewBox="-3 -3 ${n + 6} ${n + 6}" role="img" aria-label="Sample QR code of the charge link (not scannable)"><rect x="-3" y="-3" width="${n + 6}" height="${n + 6}" fill="#fff"/><path d="${d}" fill="#000" fill-rule="evenodd"/></svg><figcaption class="small muted">Sample code</figcaption></figure>`;
};

const TABS = [
  ["map", "Map", "map"],
  ["charging", "Charging", "bolt", "charging.html"],
  ["wallet", "Wallet", "wallet", "account.html#wallet"],
  ["account", "Account", "user"],
];

const nav = (current, cls, label) => `
<nav class="${cls}" aria-label="${label}">
  ${TABS.map(([id, text, ic, href]) =>
    href
      ? `<a href="${href}"${id === current ? ' aria-current="page"' : ""}><span class="ic">${icon(ic)}</span>${text}</a>`
      : `<a href="#" aria-disabled="true" title="Not in this mockup"><span class="ic">${icon(ic)}</span>${text}</a>`,
  ).join("")}
</nav>`;

export const mockStrip = (links) => `
<div class="mock" role="region" aria-label="Mockup controls, not part of the design">
  <b>MOCKUP</b>
  ${links}
  <span class="gap"></span>
  <button type="button" data-theme-set="auto">Auto</button>
  <button type="button" data-theme-set="light">Light</button>
  <button type="button" data-theme-set="dark">Dark</button>
</div>`;

/**
 * One screen. `states` are what the mockup strip switches between (the first is the
 * default). `tabs` maps a state to the app tab it belongs to: those states have the
 * tab bar or rail; the others are pushed pages, as in the app.
 */
export function shell({ states, tabs = {}, body }, brand) {
  const links = `<a href="index.html">All screens</a>
  ${states.map(([id, label]) => `<a href="#${id}" data-state="${id}">${label}</a>`).join("")}`;
  const frames = Object.entries(
    Object.entries(tabs).reduce((by, [state, tab]) => {
      (by[tab] ??= []).push(state);
      return by;
    }, {}),
  );
  return `
${mockStrip(links)}
<div class="app">
  ${frames.map(([tab, list]) => `<div data-show="${list.join(" ")}" class="rail-wrap">${nav(tab, "rail", "Main")}</div>`).join("")}
  <main>${body(brand)}</main>
  ${frames.map(([tab, list]) => `<div data-show="${list.join(" ")}" class="tabs-wrap">${nav(tab, "tabs", "Main, phone")}</div>`).join("")}
</div>`;
}
