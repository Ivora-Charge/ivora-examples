import { icon, when } from "./parts.mjs";
import { connectors, place, price } from "./start.mjs";

const note = (text) =>
  `<p class="illustration">${icon("lock")}<span>${text}</span></p>`;

const field = (id, label, value) => `
<div class="s-field"><label for="${id}">${label}</label><input id="${id}" value="${value}" readonly></div>`;

const hosted = (state, name) => `
<div class="stripe">
  <p class="s-url mono">checkout.stripe.com</p>
  <div class="s-cols">
    <div>
      <p class="s-merchant">${name}</p>
      <p class="s-muted">Hold for charging at Station Square</p>
      <p class="s-amount">€25.00</p>
    </div>
    <div class="stack">
      ${field(`${state}-email`, "Email", "driver@example.com")}
      ${field(`${state}-number`, "Card information", state === "declined" ? "4000 0000 0000 0002" : "4242 4242 4242 4242")}
      ${state === "declined" ? '<p class="s-error" role="alert">Your card was declined. Try a different card.</p>' : ""}
      <div class="s-row">${field(`${state}-expiry`, "Expiry", "12 / 29")}${field(`${state}-cvc`, "CVC", "123")}</div>
      ${field(`${state}-name`, "Name on card", "A. Driver")}
      <p class="s-message">This places a <strong>€25.00 hold</strong>. You pay only what the operator bills for your session, never more.</p>
      <a class="s-pay" href="status.html#confirming">Pay</a>
      <p class="s-muted s-back"><a href="status.html#waiting">Back to ${name}</a></p>
    </div>
  </div>
</div>`;

export const card = {
  file: "card",
  title: "The card step",
  states: [
    ["page", "Web: card page"],
    ["declined", "Declined"],
    ["bank", "3-D Secure"],
    ["sheet", "Phones: sheet"],
  ],
  body: (brand) => `
<div class="page wide">
  <h1 class="sr">The card step (illustration)</h1>
  ${when("page declined bank", note("Drawn to show the step, not the design: this is Stripe's hosted page, in Stripe's layout. This server sets the name, the amount and the message under the card."))}
  ${when("page", hosted("page", brand.name))}
  ${when("declined", hosted("declined", brand.name))}
  ${when(
    "bank",
    `<div class="stripe">
      <p class="s-url mono">checkout.stripe.com</p>
      <div class="s-bank" role="group" aria-labelledby="bank-h">
        <p class="s-muted">Your bank · 3-D Secure</p>
        <h2 id="bank-h">Confirm €25.00 to ${brand.name}</h2>
        <p>Approve this in your banking app, or enter the code your bank sends you.</p>
        <a class="s-pay" href="status.html#confirming">I've approved it</a>
        <p class="s-muted s-back"><a href="#declined">Cancel</a></p>
      </div>
    </div>`,
  )}
  ${when(
    "sheet",
    `${note("Phones: Stripe's PaymentSheet, already in the app, drawn to show the step. The button's words are set by the app.")}
    <div class="sheet-stage">
      <div class="behind stack" aria-hidden="true" inert>${place}${connectors}${price}</div>
      <section class="sheet" aria-labelledby="sheet-h">
        <span class="grip" aria-hidden="true"></span>
        <h2 id="sheet-h">Add your card</h2>
        ${field("sheet-number", "Card information", "4242 4242 4242 4242")}
        <div class="s-row">${field("sheet-expiry", "Expiry", "12 / 29")}${field("sheet-cvc", "CVC", "123")}</div>
        <a class="btn primary" href="status.html#confirming"><span>Hold €25.00</span></a>
        <a class="btn secondary" href="status.html#waiting"><span>Close</span></a>
      </section>
    </div>`,
  )}
</div>`,
};
