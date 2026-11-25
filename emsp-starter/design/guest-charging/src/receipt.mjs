import { button, card, facts, head, notice, when } from "./parts.mjs";

const trip = (energy, duration, ended) =>
  card(
    facts([
      ["Where", "Station Square, 1 Station Square, Sample City"],
      ["Charger", "<span class='mono'>ZZ*MCK*E11</span>"],
      ["Connector", "CCS · DC"],
      ["Started", "25 Nov 2026, 14:16"],
      ["Ended", `25 Nov 2026, ${ended}`],
      ["Duration", duration],
      ["Energy", energy],
    ]),
    { title: "Charging session", icon: "bolt" },
  );

const payment = (rows, after) =>
  card(`${facts(rows)}${after}`, { title: "Payment", icon: "card" });

const actions = card(
  `${button("Email me this receipt", { icon: "mail" })}
  ${button("Copy link", { icon: "link", variant: "secondary" })}
  <p class="small muted">This link works until 25 Dec 2026. Save or email the receipt to keep it longer.</p>
  ${button("Report a problem", { icon: "flag", variant: "secondary" })}
  <p class="small muted">Reference <span class="mono">3F9A-2C71</span></p>`,
  { title: "Keep your receipt" },
);

const receiptOf = (session, pay) =>
  `<div class="cols"><div class="stack">${pay}${session}</div><div class="stack">${actions}</div></div>`;

export const receipt = {
  file: "receipt",
  title: "Receipt and lost links",
  states: [
    ["paid", "Charged"],
    ["zero", "Nothing charged"],
    ["above", "Above the hold"],
    ["expired", "Link expired"],
    ["lost", "Lost charge"],
  ],
  body: (brand) => `
<div class="page wide">
  ${when("paid zero above expired", head(brand, "Receipt", "charging.html#open"))}
  ${when("lost", head(brand, "Find your charge", "charging.html#empty"))}
  ${when(
    "paid",
    receiptOf(
      trip("28.6 kWh", "31 min", "14:47"),
      payment(
        [
          ["Session cost", "€20.42 incl. VAT"],
          ["Held on your card", "€25.00"],
          ["Charged to your card", "€20.42", true],
        ],
        "<p class='small muted'>The rest of the hold, €4.58, is released. Your bank may show it for a few days.</p>",
      ),
    ),
  )}
  ${when(
    "zero",
    receiptOf(
      trip("0 kWh", "2 min", "14:18"),
      payment(
        [
          ["Session cost", "€0.00 incl. VAT"],
          ["Held on your card", "€25.00"],
          ["Charged to your card", "€0.00", true],
        ],
        notice(
          "success",
          "Nothing was charged",
          "The hold on your card has been released.",
        ),
      ),
    ),
  )}
  ${when(
    "above",
    receiptOf(
      trip("34.1 kWh", "1 h 02 min", "15:18"),
      payment(
        [
          ["Session cost", "€27.10 incl. VAT"],
          ["Held on your card", "€25.00"],
          ["Charged to your card", "€25.00", true],
        ],
        notice(
          "warning",
          "The session cost more than the hold",
          "Only €25.00 was charged; the rest is not charged automatically. Our team is checking this payment.",
        ),
      ),
    ),
  )}
  ${when(
    "expired",
    card(
      `${notice("info", "This link has expired", "Charge links stop working 30 days after the receipt.")}
      <p>Need the receipt again? Write to <strong>support@example.com</strong> with the charger's ID, the date and time, the amount and your card's last 4 digits.</p>
      ${button("Find a charger", { icon: "map", variant: "secondary" })}`,
    ),
  )}
  ${when(
    "lost",
    card(
      `<ul class="ways">
        <li><strong>Same device:</strong> open Charging, or scan the charger's code again.</li>
        <li><strong>Another device:</strong> open the link you kept or the one we emailed.</li>
        <li><strong>Neither:</strong> write to <strong>support@example.com</strong> with the charger's ID, the date and time, the amount held and your card's last 4 digits.</li>
      </ul>
      <p class="small muted">Support sends a link only to an address already saved with the charge.</p>`,
      { title: "Three ways back", icon: "link" },
    ) +
      notice(
        "warning",
        "Still charging?",
        "Stop at the charger, or unplug if your car allows it. You are never charged more than the hold.",
      ),
  )}
</div>`,
};
