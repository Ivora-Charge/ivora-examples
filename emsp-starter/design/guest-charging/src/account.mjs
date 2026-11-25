import { button, card, facts, head, notice, when } from "./parts.mjs";
import { connectors, place, price } from "./start.mjs";

const hold = (cardName) =>
  facts([
    ["Hold on your card", "€25.00", true],
    ["Card", cardName],
  ]);

const holdNote =
  '<p class="small muted">Before the charger starts, we hold this amount on your card. You pay what the operator bills for the session, never more than the hold; the rest is released.</p>';

const confirm = (payment) =>
  `<div class="cols"><div class="stack">${place}${connectors}${price}</div><div class="stack">${payment}</div></div>`;

export const account = {
  file: "account",
  title: "Signed in on the web: add a card",
  states: [
    ["nocard", "No card"],
    ["added", "Card saved"],
    ["wallet", "Wallet"],
  ],
  tabs: { wallet: "wallet" },
  body: (brand) => `
<div class="page wide">
  ${when("nocard added", head(brand, "Confirm and start", "start.html#charger"))}
  ${when(
    "nocard",
    confirm(
      card(
        `${hold("No card yet")}${holdNote}
        ${button("Add a card", { icon: "card", go: "added" })}
        <p class="small muted">You type it on Stripe's page and come back here. It is saved to your account.</p>`,
        { title: "Price and payment", icon: "card" },
      ),
    ),
  )}
  ${when(
    "added",
    confirm(
      notice("success", "Your card was saved") +
        card(
          `${hold("Visa •••• 4242")}${holdNote}
          ${button("Change card", { icon: "wallet", variant: "secondary", go: "wallet" })}`,
          { title: "Price and payment", icon: "card" },
        ) +
        button("Start charging", {
          icon: "bolt",
          href: "status.html#starting",
        }),
    ),
  )}
  ${when(
    "wallet",
    `<div class="narrow stack">${head(brand, "Wallet", false)}
    ${card(
      `<p class="muted">No card saved yet. Add one to charge.</p>
      ${button("Add a card", { icon: "card", go: "added" })}
      <p class="small muted">Cards are saved by Stripe for this network. The app and the network never see the full number.</p>`,
      { title: "Payment cards", icon: "card" },
    )}</div>`,
  )}
</div>`,
};
