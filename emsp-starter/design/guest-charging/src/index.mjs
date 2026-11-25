// The page the owner opens first: what this is, then every screen and state.
import { logo, mockStrip } from "./parts.mjs";

const ABOUT = {
  start:
    "From a charger to the card: guest or sign in, the price now, the hold and its currency, and every reason a guest start is refused before any card is typed.",
  card: "The step that is Stripe's: the hosted page on the web, with a declined card and 3-D Secure, and the PaymentSheet on phones. Drawn for illustration.",
  status:
    "Back from the card: open, checking, declined, timed out, cancelled, held and starting, charger refused or silent, too late, another browser.",
  session:
    "The guest's live charge: cost against the hold, stop, keep this link (QR, copy, email), stopped near the hold, opened by link.",
  receipt: "The receipt on the same link, an expired link and a lost charge.",
  charging:
    "The Charging tab without an account, and what rescanning a charger shows.",
  account:
    "A side effect for signed-in web drivers: add a card in the browser, which ends today's phone-app dead end.",
};

export function index(screens, brand) {
  const cards = screens
    .map(
      (s) => `
<li class="card">
  <h2><a href="${s.file}.html">${s.title}</a></h2>
  <p>${ABOUT[s.file]}</p>
  <p class="links small">${s.states.map(([id, label]) => `<a href="${s.file}.html#${id}">${label}</a>`).join("")}</p>
</li>`,
    )
    .join("");
  return {
    title: "All screens",
    body: `
${mockStrip("<span>Sample data. Nothing here is connected to a server.</span>")}
<main><div class="page">
  <header class="head"><h1>Guest charging: mockups</h1>${logo(brand)}</header>
  <p class="muted">A design only: none of this is built. Seven screens, each with its states in the dark strip at the top. Use Light and Dark there to switch theme. The brief, the decisions to make and the proposed builds are in this folder's README.</p>
  <ul class="stack">${cards}</ul>
</div></main>`,
  };
}
