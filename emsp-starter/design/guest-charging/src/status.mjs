import { button, charge, head, icon, lane, notice, when } from "./parts.mjs";

const REF =
  '<p class="small muted">Reference <span class="mono">3F9A-2C71</span></p>';
const again = button("Start again", { icon: "bolt", href: "start.html#ready" });
const signIn = button("Sign in instead", {
  icon: "user",
  variant: "secondary",
});

const progress = (rows) =>
  `<ul class="progress">${rows
    .map(
      ([done, text]) =>
        `<li class="${done ? "done" : "wait"}">${icon(done ? "check" : "clock")}<span>${text}<span class="sr">${done ? ", done" : ", waiting"}</span></span></li>`,
    )
    .join("")}</ul>`;

export const keepRow = `
<div class="keep-row">
  <div><p><strong>Keep this link</strong></p><p class="small muted">It finds your charge again, on any device.</p></div>
  ${button("Show link", { icon: "link", variant: "secondary", href: "session.html#keep" })}
</div>`;

const view = (state, step, phase, body) =>
  when(state, lane(step) + charge(phase, body));

export const status = {
  file: "status",
  title: "Starting a guest charge",
  states: [
    ["waiting", "Card page open"],
    ["confirming", "Checking"],
    ["declined", "Declined"],
    ["expired", "Timed out"],
    ["cancelled", "Cancelled"],
    ["starting", "Held, starting"],
    ["plugin", "Plug in"],
    ["refused", "Charger refused"],
    ["noanswer", "No answer"],
    ["late", "Too late"],
    ["elsewhere", "Other browser"],
  ],
  body: (brand) => `
<div class="page">
  ${head(brand, "Your charge", "charging.html#empty")}
  ${view(
    "waiting",
    1,
    "Waiting for your card",
    `<p class="count"><span class="big" data-countdown="521">8:41</span> <span class="muted">left on the card page</span></p>
    <p>Finish on the card page. <strong>Nothing is held yet.</strong></p>
    ${button("Back to the card page", { icon: "card", href: "card.html#page" })}
    ${button("Cancel", { variant: "secondary", go: "cancelled" })}`,
  )}
  ${view(
    "confirming",
    1,
    "Checking with your bank",
    `<span class="spinner" aria-hidden="true"></span>
    <p>This usually takes a few seconds. The charger starts as soon as your bank confirms the hold.</p>
    ${button("Show the next step", { variant: "secondary", go: "starting" })}`,
  )}
  ${view(
    "declined",
    1,
    "Card not approved",
    `${notice("error", "Nothing was held", "Your card wasn't approved after 3 tries, so the card page closed. The charger was not started.")}
    ${again}${signIn}`,
  )}
  ${view(
    "expired",
    1,
    "The card page timed out",
    `${notice("info", "Nothing was held", "The card page was open for 10 minutes. The charger was not started.")}
    ${again}`,
  )}
  ${view(
    "cancelled",
    1,
    "Cancelled",
    `${notice("info", "Nothing was held", "You closed the card step. The charger was not started.")}
    ${again}`,
  )}
  ${view(
    "starting",
    2,
    "Starting…",
    `${progress([
      [true, "Card approved"],
      [true, "€25.00 held on your card"],
      [false, "Waiting for the charger"],
    ])}
    ${keepRow}${REF}
    ${button("Show the next step", { variant: "secondary", go: "plugin" })}`,
  )}
  ${view(
    "plugin",
    2,
    "Plug in your car",
    `${progress([
      [true, "€25.00 held on your card"],
      [true, "The charger accepted the start"],
      [false, "Waiting for charging to begin"],
    ])}
    <p class="small muted">If nothing starts within 30 minutes, the hold is released.</p>
    ${keepRow}${REF}
    ${button("Charging has begun", { variant: "secondary", href: "session.html#charging" })}`,
  )}
  ${view(
    "refused",
    2,
    "Charging didn't start",
    `${notice("error", "This charger is in use", "Nothing is charged. The €25.00 hold is being released; your bank may show it for a few days.")}
    ${button("Choose another connector", { icon: "plug", href: "start.html#ready" })}${REF}`,
  )}
  ${view(
    "noanswer",
    2,
    "The charger didn't answer",
    `${notice("warning", "Check the charger", "If it is charging, this page will show it. If not, nothing is charged and the €25.00 hold is released after 30 minutes.")}
    ${keepRow}${REF}`,
  )}
  ${view(
    "late",
    2,
    "Charging didn't start",
    `${notice("warning", "Your bank confirmed too late", "The card step had already ended, so the charger was not started. The €25.00 hold is being released.")}
    ${again}${REF}`,
  )}
  ${when(
    "elsewhere",
    `${notice("info", "Open this in the browser you started in", "This browser doesn't hold that charge, so it can't show it. If your bank approved the card, the charger still starts. Go back to the first browser, or use the link we emailed if you gave an address.")}
    ${button("Find a charger", { icon: "map", variant: "secondary" })}`,
  )}
</div>`,
};
