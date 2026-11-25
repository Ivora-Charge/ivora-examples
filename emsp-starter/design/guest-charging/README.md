# eMSP Starter: guest charging, design brief and mockups

A driver starts and pays for a charge **without an account and without signing in**, on the web build and on phones.

**Status: design only, waiting for the owner.** Nothing here is part of the shipped app: no page, route, migration or test uses these files, and none of what is described is built. It touches payments and sign-in, so the owner agrees it, and the owner merges the builds. Builds are filed only after that. Sample data only; every name, address, price and ID is invented.

The design follows the repository's [neutrality policy](../../../docs/neutrality.md): standard OCPI and the deployer's own Stripe account only, deployed and branded by whoever forks it, no fee added by the template, and no account with Ivora or anyone else for the driver.

Open [`index.html`](index.html) in a browser. Each screen is one self-contained file that asks the network for nothing, so it opens offline, from a phone or a file share. Keep the eight `.html` files in one folder. The dark strip at the top is the mockup's own control (states, light and dark) and is not part of the design. The "Show the next step" buttons stand in for what happens by itself.

Contents: [Summary](#summary) · [Decisions](#decisions-for-the-owner) · [Today](#what-a-start-needs-today) · [Guest](#the-guest) · [Card step](#the-card-step) · [Start states](#start-states) · [Wording](#wording-before-the-card) · [Session and link](#the-session-page-and-finding-it-again) · [Token](#token-type) · [Limits](#limits-blocks-and-abuse) · [Retention](#retention) · [Server changes](#what-changes-on-the-server) · [Builds](#proposed-builds) · [Open questions](#open-questions) · [Screens](#screens)

## Summary

1. **A guest is a server-made principal**, not a hidden account: a row, a hashed secret that stays on the device, and one OCPI token for each charge. It can start, follow and stop its own charges, read their receipts, share a link and report a problem.
2. **The card is authorised on-session, on Stripe's own surface**: the hosted Checkout page on the web, the PaymentSheet the app already has on phones. Same manual-capture hold, same amount allow-list, 3-D Secure handled by Stripe. No card is saved.
3. **The start becomes two steps**: claim the command, open the card page, and only when Stripe reports the hold send START_SESSION, once, as today.
4. **Capture, refunds, review and reconciliation do not change.** A guest payment is an ordinary `emsp_payments` row, settled from the CDR, never above the hold.
5. **Stricter than accounts where there is no card on file**: no raises of the hold, a stop as the cost nears it, no start without a published price, and limits on card tries.
6. **A "keep this link"** (URL, QR code, optional email) follows, stops and shows the receipt of one charge, and nothing else.
7. **Off by default** for every deployment until its operator switches it on.
8. The browser card step also lets **signed-in web drivers add a card**, which ends today's "save a card in the phone app" dead end. It is independent and can ship first.

## Decisions for the owner

Each has a recommendation; the mockups show the recommended answer.

| #   | Decision                               | Recommendation                                                                                                   | Alternative, and its cost                                                                                                                                                  |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Card step on the web                   | Stripe-hosted Checkout (a redirect)                                                                              | Payment Element inside our page: email stays optional and the driver never leaves, but the app's Content-Security-Policy must admit Stripe's script and frames. See below. |
| 2   | Card step on phones                    | PaymentSheet in payment mode (already a dependency)                                                              | Open Checkout in the browser: one server path, but a worse return to the app.                                                                                              |
| 3   | Guest secret on the web                | `httpOnly` cookie. Needs the app and the API on one site (one domain, or two subdomains of your domain)          | A secret in `localStorage`: works on any hosting, but page script can read it.                                                                                             |
| 4   | OCPI token                             | `AD_HOC_USER`, one for each charge, `whitelist: NEVER`, sent in START_SESSION. **Confirm with the roaming hub.** | `APP_USER`, one for each charge, pushed with `NEVER`.                                                                                                                      |
| 5   | Hold amount                            | The same `HOLD_AMOUNTS` as accounts                                                                              | A separate, higher guest list: less uncollected cost, more refused cards.                                                                                                  |
| 6   | Cost above the hold                    | No raises for guests; ask the charger to stop at 90% of the hold                                                 | Raise the hold as for accounts (incremental authorization): longer charges, but the "never more than €25.00" promise goes.                                                 |
| 7   | No published price                     | Refuse the guest start (sign in instead)                                                                         | Allow it, as accounts can today: a stranger agrees to a price nobody told them.                                                                                            |
| 8   | Card page time limit                   | 10 minutes                                                                                                       | Shorter frees the charger's start sooner; longer suits slow bank apps.                                                                                                     |
| 9   | What a link may do                     | View, stop, receipt; the emailed link is the same link                                                           | Emailed link without stop: a mistyped address then cannot stop a charge, and a driver with a dead phone cannot stop from the email.                                        |
| 10  | Link lifetime                          | 30 days after settlement, never over 90 days from the start (longer only while a payment is under review)        | 7 days: less exposure, more support for expense claims.                                                                                                                    |
| 11  | Guest or sign in                       | "Charge here" opens the guest confirm screen; "Sign in instead" sits below it                                    | Two equal buttons first: one more tap for everyone.                                                                                                                        |
| 12  | Automatic card blocks                  | Block a card from guest charging after a bill above its hold, or a dispute                                       | Manual blocks only.                                                                                                                                                        |
| 13  | Limits and retention                   | The [tables below](#limits-blocks-and-abuse)                                                                     | Change the numbers; they are defaults, not promises.                                                                                                                       |
| 14  | Extras for guests in the first version | "Report a problem" from their own charge: yes. Push notifications and favourites: no.                            | Add push on phones later (the token table is keyed by driver reference already).                                                                                           |

## What a start needs today

| Step                                                | Where (`server/lib/`)                                                               | For a guest                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A signed-in driver                                  | `accounts/api.ts` ~121-136 (`withDriver`)                                           | A guest principal, on separate guest routes                |
| An active account                                   | `payments/hold.ts` ~113-116                                                         | A guest that is not blocked                                |
| Payments set up, sweep under 5 min                  | `payments/hold.ts` ~117-126                                                         | **The same**, checked before the card page and again after |
| A saved card and Stripe Customer                    | `payments/hold.ts` ~127-128, `payments/cards.ts` ~86-131 (native PaymentSheet only) | None: the card is given on-session                         |
| An `APP_USER` token from sign-in                    | `commands/manage.ts` ~699-710                                                       | The charge's own token                                     |
| A hold amount for the currency                      | `payments/hold.ts` (`HOLD_AMOUNTS`)                                                 | **The same**                                               |
| Off-session manual-capture hold, then START_SESSION | `payments/stripe.ts` ~308-343                                                       | On-session manual-capture hold, then START_SESSION         |

## The guest

**Principal.** The server makes a guest when the driver presses "Continue to card" for the first time on a device. Its driver reference is `guest:<uuid>`, so every module can tell a guest from an account without a lookup, and **fails closed** if the guest row is gone. It is not a row in `emsp_drivers`, has no Supabase user and never becomes an account by itself.

**Secret.** 256 random bits; only a SHA-256 hash is stored.

- **Web:** cookie `__Secure-emsp_guest` (no prefix and no `Secure` in local development), `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api/v1/guest`, 30 days. The secret is never in a response body to a browser.
- **Requests that change something** with the cookie must carry an allowed `Origin` and a JSON content type. CORS allows credentials only on guest routes and only for `APP_ORIGINS`.
- **Same site needed.** One domain works, and so do `drive.example.com` with `emsp.example.com`. Two unrelated sites (two `*.vercel.app` addresses, say) do not: browsers drop the cookie. The app creates the guest, reads it back, and shows the [no storage](start.html#storage) state **before** any card page if it did not stick.
- **Phones:** the secret is returned once, to a request with no `Origin`, kept in the keychain or keystore (`expo-secure-store`) and sent as `Authorization: Guest <secret>`.

**Who may do what.** Another guest's or driver's charge is a `404`.

| Action                           | Account | Guest, on its device            | Holder of a charge link   |
| -------------------------------- | ------- | ------------------------------- | ------------------------- |
| Start a charge                   | yes     | yes, one open at a time         | no                        |
| Follow it, stop it, receipt      | own     | own                             | that one charge           |
| Add or change the email          | account | own charge                      | no                        |
| Show, replace or turn off a link | n/a     | own charge                      | no                        |
| Email the receipt again          | own     | own, to the saved address       | to the saved address only |
| Saved cards, history, favourites | yes     | no (this device's charges only) | no                        |
| Report a problem                 | yes     | own charge, 3 a charge          | no                        |

**Guest or sign in.** The charger page's action becomes "Charge here" for a signed-out driver ([mockup](start.html#charger)). The confirm screen is the guest's, with "Sign in instead" under it. A signed-in driver sees today's screen. Signing in later does not move guest charges into the account in this version.

**Rescanning resumes.** Scanning or typing a charger's ID where **this device** has an open charge opens it ([mockup](charging.html#resume)). On any other device the code shows only that the connector is in use ([mockup](charging.html#other)): a code printed on a charger is public and never grants anything.

## The card step

| Question                | Checkout, hosted (web, recommended)                                                    | Payment Element (web)                                                                                        | PaymentSheet (phones, recommended)              |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Content-Security-Policy | Unchanged: the browser navigates away                                                  | Must admit Stripe's script, frames and API on the origin that holds sessions (and, on one domain, the admin) | Not a web page                                  |
| Card data and our code  | Never on our pages                                                                     | In Stripe's frames on our page                                                                               | Never in app code                               |
| 3-D Secure and retries  | Stripe's page                                                                          | Ours to handle                                                                                               | The sheet                                       |
| Card-testing defences   | Stripe's; it recommends Checkout for its automated CAPTCHA                             | Stripe's; add our own CAPTCHA                                                                                | Stripe's (confirm what covers the sheet)        |
| Email                   | **The page requires one** when we pass none                                            | Optional                                                                                                     | Optional                                        |
| Time limit              | At least 30 minutes at Stripe; we expire it by API at 10                               | Ours                                                                                                         | Ours                                            |
| The button              | Stripe's word ("Pay"), with our message saying it is a hold ([mockup](card.html#page)) | Ours                                                                                                         | Ours: "Hold €25.00" ([mockup](card.html#sheet)) |

The hosted page's required email is the real cost of decision 1. We do not copy it: only an address typed on our screen is kept, and our screen says so. If that is not acceptable, choose the Payment Element and accept the policy change.

**What is asked of Stripe.** Web: a Checkout Session in `payment` mode, cards only, one line "Hold for charging at <place>" for the hold amount, `payment_intent_data[capture_method]=manual` with `payment_id` and `command_id` in its metadata, no Customer, no `setup_future_usage`, `custom_text` for the hold message, `customer_email` only if typed, `expires_at` a little over the 30-minute minimum. Phones: a PaymentIntent with the same capture method and metadata, unconfirmed, whose client secret the app hands to the sheet. Both use the idempotency key `emsp:<command>:card-step`, so a retried request gets the same card step.

**Return addresses** are built by the server from one configured app address (`DRIVER_APP_URL`; on one domain, the public base URL), never taken from the request.

**Two steps, one start.**

1. `POST /api/v1/guest/charges { requestId, locationId, evseUid, connectorId, email? }`: all the checks of today's start, the guest limits and blocks, the price; then claim the command (`claimed`, deadline 10 minutes and a minute's grace), insert the payment (`pending`), open the card step. Answers the Checkout URL or the client secret. The same `requestId` replays it; a guest with an open charge gets that one (`busy`).
2. **Confirm**, from whichever comes first: the webhook (`payment_intent.amount_capturable_updated`, already subscribed), the app after returning (`POST …/card-step/confirm`), or the minute sweep. All call one function, which trusts only what it reads from Stripe, never the return address:
   - the PaymentIntent is `requires_capture`, manual capture, for exactly the payment's amount and currency, with its two IDs; the card is not blocked;
   - the command is still `claimed` and inside its deadline, the sweep is fresh, the location is still published and its CPO still trusted;
   - payment `pending` → `held`, then command `claimed` → `sending`. That compare-and-swap has one winner, which sends START_SESSION once. A retry that finds `held` and `claimed` carries on from there.
   - A failed check ends the start without sending anything: it moves the command `claimed` → `hold_failed`, and **only the winner of that compare-and-swap cancels the hold**. So a late or failing confirm can never cancel the hold of a start that another one has already sent. The same rule covers every way a card step ends.
   - Declines are counted from `payment_intent.payment_failed`, also already subscribed.
3. **Ending a card step.** A driver's cancel never starts a charge: it ends the command, then expires the Checkout Session or cancels the PaymentIntent, releasing any hold; once START_SESSION has gone, only a stop applies. A timeout first asks Stripe, and confirms if the hold is there and the command still inside its deadline. A hold that arrives after the end is cancelled by the existing orphan rule in `payments/webhook.ts`. Today's expiry of an overdue `claimed` command (`commands/manage.ts`) must end a card step this way, as `hold_failed`, and the release hook must close a card step whose payment is still `pending`.

**Signed-in web drivers: add a card.** The wallet and the confirm screen get "Add a card", which opens Checkout in `setup` mode for the driver's existing Customer ([mockups](account.html#nocard)). The existing `setup_intent.succeeded` handling makes it the default when there is none, and the return page checks too, in case the webhook is late. The phone-app notices and their strings go. To check in test mode: that Checkout's setup mode raises that event for this account. A bank that asks to confirm an off-session hold still refuses it as today; offering an on-session hold there is a follow-up.

## Start states

| State the driver sees ([screen](status.html#waiting))                                                                  | Command                   | Payment                                        | What happens next                                       |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| [Refused before the card](start.html#paused): off, paused, currency, no price, limit, blocked, open charge, no storage | none                      | none                                           | Nothing is created or held                              |
| [Card page open](status.html#waiting) (also after "Back")                                                              | `claimed`                 | `pending`                                      | Return to the page, or cancel                           |
| [3-D Secure](card.html#bank)                                                                                           | `claimed`                 | `pending`                                      | Stripe's surface; a failure counts as a decline         |
| [Declined](card.html#declined), may retry                                                                              | `claimed`                 | `pending`                                      | Stays on Stripe's surface                               |
| [Declined three times](status.html#declined)                                                                           | `hold_failed`             | `failed`                                       | Card step closed. Reason `card_declined`                |
| [Abandoned](status.html#expired)                                                                                       | `hold_failed`             | `failed`                                       | The minute sweep expires it. Reason `card_step_expired` |
| [Cancelled](status.html#cancelled)                                                                                     | `hold_failed`             | `failed`                                       | Reason `card_step_cancelled`                            |
| [Checking](status.html#confirming): returned before we know                                                            | `claimed`                 | `pending`                                      | The page confirms; the webhook and sweep back it up     |
| [Held, starting](status.html#starting)                                                                                 | `sending`, `accepted`     | `held`                                         | As today                                                |
| [Held, then not startable](status.html#late): late, blocked card, sweep stale, location gone                           | `hold_failed`             | `released`, or `failed` and the hold cancelled | Nothing sent                                            |
| [Charger refused](status.html#refused), occupied, no app starts                                                        | `failed`, `not_supported` | `released`                                     | Hold released at once, as today                         |
| [No answer](status.html#noanswer)                                                                                      | `timed_out`               | `held`                                         | Kept 30 minutes for a session, then released, as today  |
| [Accepted, not plugged in](status.html#plugin)                                                                         | `succeeded`               | `held`                                         | The same 30 minutes                                     |
| [Charging](session.html#charging), [stopping](session.html#stopping)                                                   | `succeeded`               | `held`                                         | Live figures from the session                           |
| [Stopped near the hold](session.html#capped)                                                                           | `succeeded`               | `held`                                         | Stop reason `hold_limit_reached`                        |
| [Waiting for the bill](session.html#finished)                                                                          | `succeeded`               | `held`                                         | Settled from the CDR                                    |
| [Receipt](receipt.html#paid), [nothing charged](receipt.html#zero), [above the hold](receipt.html#above)               | `succeeded`               | `captured`, `released`                         | As today, with review where today has it                |

Also: Stripe not answering when the card step is opened ends the start (`hold_failed`, nothing held) and the next tap is a new request; a return in [another browser](status.html#elsewhere) shows no charge, while the webhook still starts it. Two guests may have card pages open for one connector; the first to finish gets it, the other gets the charger's "occupied" and its hold back. The server does not gate on the connector's status, as today, because a plugged-in car may already show as in use.

**One open charge per guest** means a card step, an open start, or a running session. The one-open-start index covers the first two; a running session is checked before the claim and again after it. A finished session whose CDR has not come does not block the next charge.

**Same strictness as accounts:** hold before start; `HOLD_AMOUNTS` allow-list; sweep freshness; every step audited with the actor `guest:<id>` or `guest-link:<charge>`; request-ID idempotency for start and stop; one open charge; capture only from the start's own CDR.

## Wording before the card

Everything below is on screen **before** "Continue to card" ([mockup](start.html#ready)). Strings go in `app/src/i18n/en.json`.

| Part             | Words                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Price            | Every price element of the tariff, with VAT stated and **all its decimals** (today's screens round €0.7139 to €0.71)                                  |
| Price time       | "The operator's price as listed at {time} on {date}. You pay what the operator bills for your session."                                               |
| Hold             | "{amount} held on your card now, in {currency name} ({code})"                                                                                         |
| Ceiling          | "You pay the operator's bill for this session, never more than {amount}. The rest is released."                                                       |
| Stop             | "We ask the charger to stop as the cost nears {amount}, where the operator reports it live."                                                          |
| Card             | "Your card is not saved."                                                                                                                             |
| Email            | "For your receipt and a link to this charge. Stripe's card page asks for an email too; we keep one only if you type it here."                         |
| Under the button | "Nothing is held until your bank approves. The card page stays open for 10 minutes. By continuing you accept the network's terms and privacy notice." |

The price shown, the amount, the currency and the time of the tap are stored with the charge, as evidence for support and disputes. The deployer supplies the terms, privacy notice and support address. Price display and consumer rules differ by country; checking them is the deployer's job, and the README of the build will say so.

## The session page and finding it again

**One page per charge**, at `/c/<charge id>`: today's live card plus the cost against the hold, then the receipt in the same place ([session](session.html#charging), [receipt](receipt.html#paid)). It asks the server every 3 seconds while the charge runs. The Charging tab lists this device's charges ([mockup](charging.html#open)).

**Ways back:** the same device (stored secret; the tab, or rescanning the charger); the link; support.

**The link** is `DRIVER_APP_URL/c/<charge id>#<token>`.

- The token is in the **fragment**, which browsers send to no server and no referrer. The page sends it as `Authorization: Guest-Link <token>`.
- It is an HMAC over the charge ID and a version number, with a key derived (HKDF, its own label) from `OCPI_TOKEN_ENCRYPTION_KEY`. Nothing secret is stored, the device can show it again, the receipt email can carry it, and **Turn the link off** raises the version. Changing that variable ends all links.
- A network with no web build has no address for the link: its phones then offer none, and the receipt email carries none.
- View, stop and receipt of that one charge. Opening it does nothing by itself, so a mail scanner stops nothing ([mockup](session.html#linked)).
- Stop works while the session is open. The link ends as in decision 10 ([expired](receipt.html#expired)).

**Keep this link** is offered once the hold is placed, as a QR code (useful from a desktop to a phone), a copy button and email ([mockup](session.html#keep)).

**Email** is optional and unverified. It is sent **only after a hold exists**, so no one can use the form to send mail without a card that authorised. One address at a time, at most two link emails a charge, fixed text, no words typed by the driver. The receipt email goes to it when the payment settles, with the link.

**Lost both** ([mockup](receipt.html#lost)): the driver gives support the charger ID, time, amount and the card's last 4 digits. We store no card details, so the admin finds the charge by charger and time and compares the digits in the Stripe Dashboard. Support may resend the link only to the saved address, may send a receipt after that check, and gets a **Stop this session** action in the admin web for a driver who cannot stop. The driver can always stop at the charger.

## Token type

OCPI 2.2.1 says ([Tokens](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_tokens.asciidoc) and [Commands](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_commands.asciidoc) modules):

- `AD_HOC_USER` is a one-time token that binds a session to a customer; `APP_USER` identifies an app's user, the same token for every session.
- The eMSP may use tokens in START_SESSION that it never pushed, and must have authorised them before sending: our hold is that authorisation. Pushing either type, with `whitelist: NEVER`, is recommended, not required.
- For both types the CPO is not to ask real-time authorization for a START_SESSION's token on an OCPP charger.

So the recommendation is `AD_HOC_USER`, one for each charge, `NEVER`, expiring with the charge, **not pushed and not listed** by the Tokens Sender, unless the roaming hub needs it. Questions for the roaming hub before the foundations are built:

1. Does it, and do its CPOs, accept `AD_HOC_USER` in START_SESSION without a push? If a push is needed, to the hub's party or to each CPO?
2. Does anyone call real-time authorization for such a token while handling a start?
3. Do sessions and CDRs come back with our `authorization_reference`? A guest charge is captured only from a CDR linked to its start.
4. Do running sessions carry `total_cost`? The stop near the hold depends on it.
5. Any contract rule for guest or ad-hoc users, and how long does it keep tokens?

**A gap to close first.** Real-time authorization today answers from the token's own status when the driver reference has no account (`driverStanding`, `tokens/authorize.ts`). A guest token must instead answer `NOT_ALLOWED`: otherwise a CPO asking about an `APP_USER` guest token would be told `ALLOWED` with no hold. `AD_HOC_USER` gets `Unknown Token` today (`authorize.ts` ~147-153), which stays. If the hub does call during a start (question 2), the only `ALLOWED` is while that token's own start is open with a held payment, returning that start's `authorization_reference`.

## Limits, blocks and abuse

Counts that protect money are kept **in the database**, so they hold across server instances. The client address is used only from a trusted header ([convention](../../../docs/conventions.md#client-address-for-rate-limits)); every per-client limit has a total cap beside it. Addresses and card fingerprints are stored only as keyed hashes.

| Limit                                           | Default                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Open charge per guest                           | 1                                                                                                     |
| New guests                                      | 10 an hour per client, 200 in total                                                                   |
| Card steps per guest (device)                   | 5 an hour, 10 a day                                                                                   |
| Card steps per client                           | 10 an hour, 30 a day                                                                                  |
| Card steps per connector that ended unpaid      | 10 an hour                                                                                            |
| Card steps in total                             | 100 an hour                                                                                           |
| Declines in one card step                       | 3, then it closes                                                                                     |
| Declined or abandoned steps per guest or client | 5 a day, then 24 hours' pause                                                                         |
| Declines across all guests (circuit breaker)    | 30 in 15 minutes pauses guest starts and shows on Health; accounts unaffected                         |
| Link emails                                     | 2 a charge, 3 per address a day, 50 an hour in total                                                  |
| Wrong guest secrets or link tokens              | 20 per client and 500 in total per 15 minutes, counting failures only: a right one is always accepted |
| Quotes read                                     | 60 a minute per client, 1,000 in total                                                                |

Shared addresses (a car park's Wi-Fi) share the per-client counts, so the numbers are settings.

| Abuse or failure                | Answer                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card testing                    | Stripe's defences on its own surfaces (recommended setup: Checkout, plus Radar rules); a card step needs a chargeable connector, a €25.00 authorisation and the limits above                                                                            |
| No identity                     | Blocks by card fingerprint, client or guest, by an admin on a payment, and automatically per decision 12. A card is known only after Stripe authorises it, so a block releases the hold at once; use Radar to refuse earlier. Accounts are not affected |
| Cost above the hold             | Never charged automatically (as today); reviewed as `cdr_above_hold`; no raises, a stop at 90%. **Residual risk:** operators that report no running cost, and parking or idle fees billed after charging. The network carries that shortfall            |
| Starting for someone else's car | The hold pays for it, so the person harmed is the payer; the connector code grants no control                                                                                                                                                           |
| Holding a connector             | A card step reserves nothing. Several clients together could use up a connector's guest limit for an hour; signed-in drivers are not counted                                                                                                            |
| Abandoned card pages            | The minute sweep asks Stripe about each pending one and confirms or expires it                                                                                                                                                                          |
| A leaked link                   | One charge, no money to gain; can be turned off                                                                                                                                                                                                         |
| A mistyped email                | A stranger can view and stop that charge (decision 9); the screen says to check the address                                                                                                                                                             |
| Lost link and device            | Support, above                                                                                                                                                                                                                                          |

## Retention

Payments, commands, sessions, CDRs and the audit log are records of money and chargers and are kept as today. What a guest adds:

| Data                                   | Kept                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Guest row with **no hold ever placed** | Deleted 7 days after it was made                                                                                                 |
| Guest secret hash                      | Until 30 days after the guest's last charge settled, then cleared                                                                |
| Link                                   | Decision 10                                                                                                                      |
| Email address                          | 30 days after settlement, longer only while the payment is under review or disputed; 7 days for a charge that ended with no hold |
| Client address hash                    | 30 days                                                                                                                          |
| Card fingerprint hash on a charge      | 180 days, to cover the usual dispute window (confirm yours)                                                                      |
| A block                                | Until an admin lifts it; reviewed after 12 months                                                                                |
| Guest row with money                   | Personal fields cleared as above; the bare ID stays so the records still join                                                    |
| Token                                  | Expired when its charge ends; kept, like every token                                                                             |

A daily pass in the existing cron job does this. The deployer's privacy notice has to say the same.

## What changes on the server

An outline for the builds, not a contract.

**Migration** (additive, service-only under the 10-30 rule, named like the others): `emsp_guests` (ID, secret hash, client hash, times); `emsp_guest_charges` (command, guest, email and send count, link version, price shown, consent time, card step ID and end, declines, fingerprint and client hashes, end reason); `emsp_guest_blocks`. `emsp_tokens` accepts `AD_HOC_USER`, and the two functions that queue token pushes skip it. `emsp_payments` is unchanged.

**Every place that looks up an account** must say what it does for `guest:`: `driverStanding`; the start's token lookup; `placeHold` (a guest never takes the saved-card path); the session's token match (`sessions/record.ts` ~171-181, which knows `APP_USER` and `RFID` only); the Tokens Sender; receipts; push; the admin's driver and token lists (guest ones behind a filter, labelled "Guest" on sessions and payments).

**API:** new routes under `/api/v1/guest`, an explicit list, so no account route ever accepts a guest by accident: `GET` and `POST /guest`, `GET /guest/quote`, `GET` and `POST /guest/charges`, and per charge `GET`, `…/card-step/confirm`, `…/card-step/cancel`, `…/session`, `…/stop`, `…/receipt`, `…/receipt/email`, `…/email`, `…/link`, `…/problems`. `GET /api/v1/status` says whether guest charging is on.

**Settings:** `GUEST_CHARGING` (off by default), `DRIVER_APP_URL`; in the app, the support address and the terms and privacy links. No new Stripe webhook event is required. Setup shows one more check: guest charging is on and payments, the webhook, the sweep and the app address are in order.

**Demo mode** shows the whole flow with no Stripe: a labelled demo card step with Approve, Decline, Bank check and Leave. The offline app demo does the same.

## Proposed builds

Five pull requests, in order. All are money or sign-in changes, so the owner merges each. Guest charging stays off until the last is in and the checklist is done.

| Build | What                                                                                                                            | Needs         | Proof                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **Add a card on the web** for accounts (server and app); remove the dead end                                                    | Decision 1    | Payment tests, a second driver cannot reach the first's card step, web e2e                                                        |
| 2     | **Guest foundations**: migration, principal, secret and cookie, link tokens, tokens, the fail-closed account lookups, retention | Hub's answers | PGlite migration tests; authorization answers; every account route refuses a guest; a second guest gets 404                       |
| 3     | **Guest start and payment**: two steps, confirm, webhook, sweep, cancel, limits, blocks, stop near the hold, demo card step     | Build 2       | Every row of the start states; races between webhook, return and sweep send one START; no start without a hold; all payment tests |
| 4     | **After the start, server side**: session, stop, receipt, link, email, admin support (lookup, block, stop)                      | Build 3       | Link scope; email caps; expiry; admin roles                                                                                       |
| 5     | **Driver app**: guest flow on web and phones, keep this link, receipts, strings, docs, Setup check                              | Builds 1 to 4 | Web e2e in demo mode, accessibility, phone and desktop, light and dark                                                            |

**Before switching it on:** the hub's answers acted on; in Stripe test mode a normal card, a declined card, a 3-D Secure card, an abandoned page and a late approval; the sweep running every minute; the app address, terms, privacy notice and support address set.

## Open questions

- The [hub questions](#token-type), and the [decisions](#decisions-for-the-owner).
- To verify in Stripe test mode before build 3: the hosted page's wording for a manual capture with our message under it; that no other payment method or one-click sign-up appears; that a decline there raises `payment_intent.payment_failed` with our IDs; the setup-mode event (build 1).
- Whether guests who typed an email should later be offered an account that takes over their charges (not designed).
- Receipts here are not tax invoices. A network that must issue one needs its own step.

## Screens

Phone (390 wide) and desktop (1280), light and dark. The main path is shown in all four; every other state once on each size, and all states in both themes in the HTML files. The card step pictures are drawings of Stripe's surfaces, not designs of them.

### The main path

| Screen                                 | Phone, light                                                                            | Phone, dark                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Confirm and pay](start.html#ready)    | ![Confirm and pay as a guest, phone, light](screens/start-ready-phone-light.png)        | ![Confirm and pay as a guest, phone, dark](screens/start-ready-phone-dark.png)        |
| [Card page open](status.html#waiting)  | ![Waiting for the card, phone, light](screens/status-waiting-phone-light.png)           | ![Waiting for the card, phone, dark](screens/status-waiting-phone-dark.png)           |
| [Held, starting](status.html#starting) | ![Held and starting, phone, light](screens/status-starting-phone-light.png)             | ![Held and starting, phone, dark](screens/status-starting-phone-dark.png)             |
| [Charging](session.html#charging)      | ![A guest's live charge, phone, light](screens/session-charging-phone-light.png)        | ![A guest's live charge, phone, dark](screens/session-charging-phone-dark.png)        |
| [Keep this link](session.html#keep)    | ![Keep this link, phone, light](screens/session-keep-phone-light.png)                   | ![Keep this link, phone, dark](screens/session-keep-phone-dark.png)                   |
| [Receipt](receipt.html#paid)           | ![A guest's receipt, phone, light](screens/receipt-paid-phone-light.png)                | ![A guest's receipt, phone, dark](screens/receipt-paid-phone-dark.png)                |
| [Charging tab](charging.html#open)     | ![Charging tab without an account, phone, light](screens/charging-open-phone-light.png) | ![Charging tab without an account, phone, dark](screens/charging-open-phone-dark.png) |

| Screen                                 | Desktop, light                                                                              | Desktop, dark                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Confirm and pay](start.html#ready)    | ![Confirm and pay as a guest, desktop, light](screens/start-ready-desktop-light.png)        | ![Confirm and pay as a guest, desktop, dark](screens/start-ready-desktop-dark.png)        |
| [Card page open](status.html#waiting)  | ![Waiting for the card, desktop, light](screens/status-waiting-desktop-light.png)           | ![Waiting for the card, desktop, dark](screens/status-waiting-desktop-dark.png)           |
| [Held, starting](status.html#starting) | ![Held and starting, desktop, light](screens/status-starting-desktop-light.png)             | ![Held and starting, desktop, dark](screens/status-starting-desktop-dark.png)             |
| [Charging](session.html#charging)      | ![A guest's live charge, desktop, light](screens/session-charging-desktop-light.png)        | ![A guest's live charge, desktop, dark](screens/session-charging-desktop-dark.png)        |
| [Keep this link](session.html#keep)    | ![Keep this link, desktop, light](screens/session-keep-desktop-light.png)                   | ![Keep this link, desktop, dark](screens/session-keep-desktop-dark.png)                   |
| [Receipt](receipt.html#paid)           | ![A guest's receipt, desktop, light](screens/receipt-paid-desktop-light.png)                | ![A guest's receipt, desktop, dark](screens/receipt-paid-desktop-dark.png)                |
| [Charging tab](charging.html#open)     | ![Charging tab without an account, desktop, light](screens/charging-open-desktop-light.png) | ![Charging tab without an account, desktop, dark](screens/charging-open-desktop-dark.png) |

### The other states

| Screen                                       | Phone                                                                            | Desktop                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Charger page](start.html#charger)           | ![Charger page without an account, phone](screens/start-charger-phone-light.png) | ![Charger page without an account, desktop](screens/start-charger-desktop-dark.png)  |
| [No price](start.html#noprice)               | ![No published price, phone](screens/start-noprice-phone-dark.png)               | ![No published price, desktop](screens/start-noprice-desktop-light.png)              |
| [Payments paused](start.html#paused)         | ![Payments paused, phone](screens/start-paused-phone-light.png)                  | ![Payments paused, desktop](screens/start-paused-desktop-dark.png)                   |
| [Already charging](start.html#open)          | ![One open charge per guest, phone](screens/start-open-phone-dark.png)           | ![One open charge per guest, desktop](screens/start-open-desktop-light.png)          |
| [Card page](card.html#page)                  | ![Drawing of the hosted card page, phone](screens/card-page-phone-light.png)     | ![Drawing of the hosted card page, desktop](screens/card-page-desktop-dark.png)      |
| [Declined](card.html#declined)               | ![Drawing of a declined card, phone](screens/card-declined-phone-dark.png)       | ![Drawing of a declined card, desktop](screens/card-declined-desktop-light.png)      |
| [3-D Secure](card.html#bank)                 | ![Drawing of the bank's check, phone](screens/card-bank-phone-light.png)         | ![Drawing of the bank's check, desktop](screens/card-bank-desktop-dark.png)          |
| [PaymentSheet](card.html#sheet), phones only | ![Drawing of the PaymentSheet, light](screens/card-sheet-phone-light.png)        | ![Drawing of the PaymentSheet, dark phone](screens/card-sheet-phone-dark.png)        |
| [Checking](status.html#confirming)           | ![Checking with the bank, phone](screens/status-confirming-phone-dark.png)       | ![Checking with the bank, desktop](screens/status-confirming-desktop-light.png)      |
| [Card not approved](status.html#declined)    | ![Card not approved, phone](screens/status-declined-phone-light.png)             | ![Card not approved, desktop](screens/status-declined-desktop-dark.png)              |
| [Timed out](status.html#expired)             | ![Card page timed out, phone](screens/status-expired-phone-dark.png)             | ![Card page timed out, desktop](screens/status-expired-desktop-light.png)            |
| [Plug in](status.html#plugin)                | ![Plug in your car, phone](screens/status-plugin-phone-light.png)                | ![Plug in your car, desktop](screens/status-plugin-desktop-dark.png)                 |
| [Charger refused](status.html#refused)       | ![Hold placed, charger refused, phone](screens/status-refused-phone-dark.png)    | ![Hold placed, charger refused, desktop](screens/status-refused-desktop-light.png)   |
| [No answer](status.html#noanswer)            | ![The charger did not answer, phone](screens/status-noanswer-phone-light.png)    | ![The charger did not answer, desktop](screens/status-noanswer-desktop-dark.png)     |
| [Stopped near the hold](session.html#capped) | ![Stopped near the hold, phone](screens/session-capped-phone-dark.png)           | ![Stopped near the hold, desktop](screens/session-capped-desktop-light.png)          |
| [Opened by link](session.html#linked)        | ![Charge opened by link, phone](screens/session-linked-phone-light.png)          | ![Charge opened by link, desktop](screens/session-linked-desktop-dark.png)           |
| [Above the hold](receipt.html#above)         | ![Receipt above the hold, phone](screens/receipt-above-phone-dark.png)           | ![Receipt above the hold, desktop](screens/receipt-above-desktop-light.png)          |
| [Lost charge](receipt.html#lost)             | ![Ways back to a lost charge, phone](screens/receipt-lost-phone-light.png)       | ![Ways back to a lost charge, desktop](screens/receipt-lost-desktop-dark.png)        |
| [Rescan](charging.html#resume)               | ![Rescanning resumes the charge, phone](screens/charging-resume-phone-dark.png)  | ![Rescanning resumes the charge, desktop](screens/charging-resume-desktop-light.png) |
| [Add a card, signed in](account.html#nocard) | ![Add a card on the web, phone](screens/account-nocard-phone-light.png)          | ![Add a card on the web, desktop](screens/account-nocard-desktop-dark.png)           |

## Rebuilding

The HTML files are generated; edit `src/`, never the output.

```sh
node build.mjs     # writes the eight .html files from src/ and the brand tokens
node check.mjs     # checks them in a browser, offline (needs `npm ci` in ../../server)
node shoot.mjs     # retakes the pictures above and removes any other PNG from screens/
```

`build.mjs` refuses a state name that its screen does not have. `check.mjs` opens every state on a phone and at 1280, light and dark, and fails on a WCAG 2.1 A or AA violation found by axe, a state without exactly one `h1`, a button or field under 44px, a state wider than its window, a link or state control that leads nowhere, or any network request.

Requires Node.js 22. `build.mjs` reads `../../server/brand/tokens.json` and the fonts in `../../server/brand/fonts/`, so a change of brand restyles the mockups too; the fonts inside each HTML file are under the SIL Open Font License 1.1, whose texts are in that folder. The committed pictures are reduced to 256 colours after capture (for example with `pngquant`, or Pillow's `quantize`) to keep them small.
