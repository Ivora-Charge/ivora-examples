import { button, card, charge, head, icon, notice, when } from "./parts.mjs";

const item = (name, when_, amount, href) => `
<li><a class="row-link" href="${href}">
  <span class="grow"><strong>${name}</strong><span class="small muted">${when_}</span></span>
  <span class="amount"><strong>${amount}</strong><span class="small muted">Receipt</span></span>
</a></li>`;

const account = card(
  `<p class="muted">Keep your cards, history and favourites on every device.</p>
  ${button("Sign in", { icon: "user", variant: "secondary" })}`,
  { title: "Have an account?" },
);

const find = (state) =>
  card(
    `<div class="field">
      <label for="code-${state}">Charger or EVSE ID</label>
      <input id="code-${state}" class="mono" value="ZZ*MCK*E11" autocapitalize="characters" autocomplete="off">
    </div>
    ${button("Find this charger", { icon: "scan", variant: "secondary" })}`,
    { title: "Enter the charger's ID", icon: "plug" },
  );

export const charging = {
  file: "charging",
  title: "Charging, without an account",
  states: [
    ["open", "Charge on this device"],
    ["empty", "Nothing here"],
    ["resume", "Rescan: yours"],
    ["other", "Rescan: not yours"],
  ],
  tabs: { open: "charging", empty: "charging" },
  body: (brand) => `
<div class="page">
  ${when("open empty", head(brand, "Charging", false))}
  ${when("resume other", head(brand, "Start charging", "#empty"))}
  ${when(
    "open",
    `${charge(
      "Charging · started as a guest",
      `<div class="numbers"><div><p class="big">12.4 kWh</p><p class="small muted">Energy</p></div><div><p class="big">€8.85</p><p class="small muted">Cost so far</p></div></div>
      ${button("Open your charge", { icon: "bolt", href: "session.html#charging" })}`,
    )}
    ${card(
      `<ul class="list">
        ${item("Market Hall", "18 Nov 2026, 09:02", "€6.12", "receipt.html#paid")}
        ${item("Harbour Front", "2 Nov 2026, 17:40", "€14.80", "receipt.html#paid")}
      </ul>
      <p class="small muted">Only this device lists these. Each leaves 30 days after its receipt.</p>`,
      { title: "Earlier on this device", icon: "clock" },
    )}${account}`,
  )}
  ${when(
    "empty",
    `${card(
      `<p class="muted">Scan the charger's QR code or enter its ID. No account needed.</p>
      ${button("Scan or enter a charger", { icon: "scan", go: "resume" })}
      ${button("Find a charger", { icon: "map", variant: "secondary" })}
      <p><a href="receipt.html#lost">Can't find a charge you started?</a></p>`,
      { title: "Nothing charging right now", icon: "bolt" },
    )}${account}`,
  )}
  ${when(
    "resume",
    `${find("resume")}
    <div class="found">
      <p class="small muted">${icon("check")} Found on this device</p>
      <p class="place">You're charging here</p>
      <p>Station Square · <span class="mono">ZZ*MCK*E11</span></p>
      ${button("Open your charge", { icon: "bolt", href: "session.html#charging" })}
    </div>`,
  )}
  ${when(
    "other",
    `${find("other")}
    ${notice("info", "Station Square: ZZ*MCK*E11 is in use", "Choose another connector. A charger's code never opens someone else's charge.")}
    ${button("See this charger", { icon: "plug", href: "start.html#charger", variant: "secondary" })}`,
  )}
</div>`,
};
