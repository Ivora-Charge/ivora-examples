import {
  button,
  card,
  charge,
  head,
  icon,
  meter,
  notice,
  sampleCode,
  when,
} from "./parts.mjs";
import { keepRow } from "./status.mjs";

const numbers = (
  kwh,
  time,
  cost,
  label = "Cost so far, as the operator reports it",
) => `
<div class="numbers">
  <div><p class="big">${kwh}</p><p class="small muted">Energy</p></div>
  <div><p class="big">${time}</p><p class="small muted">Time</p></div>
  <div class="full"><p class="big">${cost}</p><p class="small muted">${label}</p></div>
</div>`;

const stop = button("Stop charging", { icon: "stop", go: "stopping" });

const help = card(
  `<p class="small">Reference <span class="mono">3F9A-2C71</span></p>
  <p class="small muted">You can also stop at the charger, or unplug if your car allows it.</p>
  ${button("Report a problem", { icon: "flag", variant: "secondary" })}`,
  { title: "Need help?" },
);

const keep = card(
  `<p>Open it to follow this charge, stop it and get the receipt, here or on another device.</p>
  ${sampleCode()}
  <p class="link mono small">drive.example.com/c/3f9a2c71…#q7Vd…</p>
  <button type="button" class="btn primary" data-copy="https://drive.example.com/c/sample#not-a-real-link">${icon("link")}<span>Copy link</span></button>
  <div class="field">
    <label for="mail">Email it to me</label>
    <input id="mail" type="email" autocomplete="email" placeholder="you@example.com" aria-describedby="mail-hint">
    <p id="mail-hint" class="small muted">We send this link and your receipt there. Check the address: whoever gets it can stop this charge.</p>
  </div>
  ${button("Send", { icon: "mail", variant: "secondary" })}
  <p class="small muted">Anyone with the link can see this charge, stop it and read its receipt. It can't start a charge or use your card. It stops working 30 days after the receipt.</p>
  ${button("Turn the link off", { variant: "plain" })}`,
  { title: "Keep this link", icon: "link" },
);

const side = (content) => `<div class="stack">${content}</div>`;
const two = (main, aside) =>
  `<div class="cols">${side(main)}${side(aside)}</div>`;

export const session = {
  file: "session",
  title: "A guest's charge",
  states: [
    ["charging", "Charging"],
    ["keep", "Keep this link"],
    ["stopping", "Stopping"],
    ["capped", "Stopped at the hold"],
    ["finished", "Waiting for bill"],
    ["linked", "Opened by link"],
  ],
  body: (brand) => `
<div class="page wide">
  ${head(brand, "Your charge", "charging.html#open")}
  ${when(
    "charging",
    two(
      charge(
        "Charging",
        `${numbers("12.4 kWh", "14 min", "€8.85")}
        ${meter("€8.85", "€25.00", 35)}
        ${stop}`,
      ),
      keepRow + help,
    ),
  )}
  ${when(
    "keep",
    two(
      keep,
      charge(
        "Charging",
        `${numbers("12.4 kWh", "14 min", "€8.85")}
        ${button("Back to the charge", { variant: "secondary", go: "charging" })}`,
      ),
    ),
  )}
  ${when(
    "stopping",
    two(
      charge(
        "Stopping…",
        `${numbers("18.9 kWh", "21 min", "€13.49")}
        ${meter("€13.49", "€25.00", 54)}
        <span class="spinner" aria-hidden="true"></span>
        ${button("Show the next step", { variant: "secondary", go: "finished" })}`,
      ),
      keepRow + help,
    ),
  )}
  ${when(
    "capped",
    two(
      charge(
        "Charging finished",
        `${numbers("31.6 kWh", "34 min", "€22.56", "Cost when we asked to stop, as the operator reported it")}
        ${notice("warning", "Stopped near your hold", "We asked the charger to stop as the cost neared the €25.00 held. To charge more, start a new charge.")}
        <p class="small muted">The final bill can differ a little. You are never charged more than €25.00.</p>
        ${button("Receipt", { icon: "receipt", href: "receipt.html#paid" })}`,
      ),
      keepRow + help,
    ),
  )}
  ${when(
    "finished",
    two(
      charge(
        "Charging finished",
        `${numbers("28.6 kWh", "31 min", "€20.42", "Cost, as the operator reported it")}
        ${notice("success", "Waiting for the final bill", "Your receipt appears here once the operator sends it, usually within minutes. The hold stays until then.")}
        ${button("Show the receipt", { icon: "receipt", href: "receipt.html#paid" })}`,
      ),
      keepRow + help,
    ),
  )}
  ${when(
    "linked",
    two(
      notice(
        "info",
        "Opened with a charge link",
        "You can follow this charge, stop it and get its receipt. A link can't start a charge.",
      ) +
        charge(
          "Charging",
          `${numbers("12.4 kWh", "14 min", "€8.85")}
          ${meter("€8.85", "€25.00", 35)}
          ${stop}`,
        ),
      help,
    ),
  )}
</div>`,
};
