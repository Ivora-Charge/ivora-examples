import {
  button,
  card,
  facts,
  head,
  icon,
  lane,
  notice,
  when,
} from "./parts.mjs";

const connector = (checked, name, detail, status, kind) => `
<button type="button" role="radio" aria-checked="${checked}" class="choice">
  <span class="dot" aria-hidden="true"></span>
  <span class="grow"><strong>${name}</strong><span class="mono small muted">${detail}</span></span>
  <span class="status ${kind}">${status}</span>
</button>`;

export const place = `
<div>
  <p class="place">Station Square</p>
  <p class="small muted">1 Station Square, Sample City · Sample Charging Operator</p>
</div>`;

export const connectors = card(
  `<div role="radiogroup" aria-label="Connector" class="choices">
  ${connector(true, "CCS · 150 kW", "ZZ*MCK*E11", "Free", "free")}
  ${connector(false, "CHAdeMO · 50 kW", "ZZ*MCK*E11", "Free", "free")}
  ${connector(false, "CCS · 150 kW", "ZZ*MCK*E12", "In use", "busy")}
</div>`,
  { title: "Connector", icon: "plug" },
);

export const price = card(
  `<p class="price"><span class="big">€0.7139</span> <span class="muted">per kWh, VAT included</span></p>
  <p>€7.26 per hour, after 45 minutes</p>
  <p class="small muted">The operator's price as listed at 14:12 on 25 Nov. You pay what the operator bills for your session.</p>`,
  { title: "Price now", icon: "receipt" },
);

const noPrice = card(
  `<p class="price"><span class="big">Price not shared</span></p>
  <p class="small muted">The operator hasn't published a price for this connector.</p>`,
  { title: "Price now", icon: "receipt" },
);

const signIn = card(
  `<p class="muted">Saved cards, history and favourites.</p>
  ${button("Sign in instead", { icon: "user", variant: "secondary" })}`,
  { title: "Have an account?" },
);

const pay = card(
  `<p class="hold"><span class="big">€25.00</span> <span>held on your card now, in euros (EUR)</span></p>
  <ul class="terms">
    <li>${icon("check")}<span>You pay the operator's bill for this session, <strong>never more than €25.00</strong>. The rest is released.</span></li>
    <li>${icon("check")}<span>We ask the charger to stop as the cost nears €25.00, where the operator reports it live.</span></li>
    <li>${icon("check")}<span>Your card is not saved.</span></li>
  </ul>
  <div class="field">
    <label for="email">Email <span class="muted">(optional)</span></label>
    <input id="email" type="email" autocomplete="email" placeholder="you@example.com" aria-describedby="email-hint">
    <p id="email-hint" class="small muted">For your receipt and a link to this charge. Stripe's card page asks for an email too; we keep one only if you type it here.</p>
  </div>
  ${button("Continue to card", { icon: "card", href: "card.html#page" })}
  <p class="small muted">Nothing is held until your bank approves. The card page stays open for 10 minutes. By continuing you accept the network's <a href="#" aria-disabled="true">terms</a> and <a href="#" aria-disabled="true">privacy notice</a>.</p>`,
  { title: "Pay as a guest", icon: "card" },
);

const blocked = [
  [
    "noprice",
    notice(
      "info",
      "Guest charging needs a price",
      "Choose another connector, or sign in to charge here.",
    ),
  ],
  [
    "currency",
    notice(
      "error",
      "No card payments in this charger's currency",
      "This network takes no app payments in CHF. Nothing was held.",
    ),
  ],
  [
    "paused",
    notice(
      "error",
      "Payments are paused right now",
      "Nothing was held. Try again in a few minutes.",
    ),
  ],
  [
    "limit",
    notice(
      "warning",
      "Too many card tries",
      "Try again in 58 minutes, or sign in to charge. Nothing was held.",
    ),
  ],
  [
    "storage",
    notice(
      "warning",
      "This browser won't remember your charge",
      "A guest needs this device to keep the charge, to stop it and get the receipt. Allow cookies for this site, or sign in.",
    ),
  ],
];

const detail = (brand) => `
<div class="detail">
  <div class="charge-head">
    <p class="small"><strong>Sample Charging Operator · 400 m</strong></p>
    <h1>Station Square</h1>
    <p>1 Station Square, Sample City · Car park</p>
  </div>
  <div class="detail-body">
    <h2 class="label">Price</h2>
    <p class="price"><span class="big">€0.7139</span> <span class="muted">per kWh, VAT included</span></p>
    <p>€7.26 per hour (after 45 min)</p>
    <h2 class="label">Connectors</h2>
    ${facts([
      [
        "CCS · 150 kW<br><span class='mono small muted'>ZZ*MCK*E11</span>",
        "Free",
      ],
      [
        "CHAdeMO · 50 kW<br><span class='mono small muted'>ZZ*MCK*E11</span>",
        "Free",
      ],
      [
        "CCS · 150 kW<br><span class='mono small muted'>ZZ*MCK*E12</span>",
        "In use",
      ],
    ])}
  </div>
  <div class="detail-foot">
    <p class="small">No account needed: pay by card as a guest, or sign in.</p>
    <div class="row">
      ${button("Directions", { icon: "directions", variant: "secondary" })}
      ${button("Charge here", { icon: "bolt", go: "ready" })}
    </div>
  </div>
</div>`;

export const start = {
  file: "start",
  title: "Confirm and pay",
  states: [
    ["ready", "Guest, ready"],
    ["charger", "Charger page"],
    ["noprice", "No price"],
    ["currency", "Currency"],
    ["paused", "Paused"],
    ["open", "Already charging"],
    ["limit", "Limit"],
    ["storage", "No storage"],
  ],
  body: (brand) => `
${when("charger", detail(brand), "div", "page")}
<div class="page wide" data-hide="charger">
  ${head(brand, "Confirm and pay", "#charger")}
  ${lane(0)}
  <div class="cols">
    <div class="stack">
      ${place}
      ${when("ready currency paused limit storage open", connectors + price)}
      ${when("noprice", connectors + noPrice)}
    </div>
    <div class="stack">
      ${when("ready", pay + signIn)}
      ${blocked.map(([id, html]) => when(id, html + (id === "currency" || id === "paused" ? "" : signIn))).join("")}
      ${when(
        "open",
        notice(
          "info",
          "You already have a charge going",
          "A guest has one charge at a time on a device. Stop it, or let it finish, before you start another.",
        ) +
          button("Open your charge", {
            icon: "bolt",
            href: "session.html#charging",
          }),
      )}
    </div>
  </div>
</div>`,
};
