# Forecourt checkout

Pay-at-the-charger checkout for fuel stations, convenience stores and retail sites with DC fast chargers.

A driver scans the QR code on the charger with their phone, sees the price, pays with a card, Apple Pay or Google Pay, watches the session live and gets a receipt. No app, no account. When the car is full, the page asks the driver to move it and counts down to the idle fee. Site staff get password-protected pages for prices per charger, today's sessions and revenue, and recent faults.

It is built on the [Ivora API](https://ivoracharge.com/developers/guides) and Stripe, and it follows the shared [template conventions](../docs/conventions.md).

## Demo

| Charger page                                               | Move your car                                           | Receipt                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| ![Charger page with prices and estimate](docs/charger.png) | ![Idle-fee countdown after charging](docs/move-car.png) | ![Receipt with idle grace and hold release](docs/receipt.png) |

![Operator page: today's sessions, revenue and application fee](docs/operator.png)

All screenshots are demo mode: sample data, nothing charged, no charger contacted.

## Run locally

Demo mode needs no credentials and works offline. Use Node.js 22.

```sh
cd forecourt-checkout
npm ci
npm run dev
```

Open http://localhost:3000 and pick a demo charger, as if you had scanned its QR code. The demo runs a whole session from scan to receipt: the hold, charging with live kWh, power and running cost, the "move your car" countdown, and the receipt. Demo time runs 30 times faster, so the simulated car is full after about 50 seconds. The operator pages are at `/operator`; the demo password is `demo`.

Demo mode is on whenever a required live variable is missing, or when `DEMO_MODE=1`. It never sends payment requests or charger commands: demo sessions are answered by `src/lib/demo.ts`, which has no network code, and a unit test fails if demo mode calls `fetch`.

Checks, as CI runs them:

```sh
npm run format:check
npm run typecheck
npm test            # unit tests, no network or credentials
npm run build
npm run test:e2e    # Playwright, demo end to end
```

## Connect real services

1. Create an Ivora project for this deployment (one project per deployment; a separate test project for previews) and an API key with the permissions listed under [What it uses from the Ivora API](#what-it-uses-from-the-ivora-api). The new `settlement:write` scope needs explicit opt-in.
2. For each charger, set the station's `external_reference` to your own short code, such as `PUMP-3`. QR codes encode `https://<your domain>/c/<code>/<connector number>`, so you can move hosting or replace a charger without reprinting stickers.
3. Give every connector a tariff in Ivora. The tariff's `authorization_minor` is the card hold for that charger. Prices can then be changed on the operator Prices page.
4. In Stripe, enable Apple Pay and Google Pay under payment methods. Stripe-hosted Checkout shows them to drivers whose phone supports them; no domain verification is needed for hosted Checkout.
5. Set the environment variables below. Add webhooks: an Ivora webhook to `https://<your domain>/api/webhooks/ivora` for `charging_session.status_changed` and `bill.finalized`, and a Stripe webhook to `https://<your domain>/api/webhooks/stripe` for `checkout.session.completed` and `checkout.session.expired` (a Connect webhook if you use a connected account).

| Variable                      | Required | What it is                                                                                                                           |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `IVORA_API_KEY`               | Live     | Ivora API key for this deployment's project. Server-side only.                                                                       |
| `IVORA_TENANT_ID`             | Live     | Ivora tenant (project) ID, numeric.                                                                                                  |
| `STRIPE_SECRET_KEY`           | Live     | Stripe secret key. Use test mode outside production.                                                                                 |
| `SESSION_SECRET`              | Live     | Signs operator and driver cookies. `openssl rand -hex 32`.                                                                           |
| `OPERATOR_PASSWORD`           | Live     | Password for `/operator`.                                                                                                            |
| `PUBLIC_BASE_URL`             | Live     | Your own HTTPS origin, used in Stripe return URLs and QR codes.                                                                      |
| `IVORA_WEBHOOK_SECRET`        | Advised  | Verifies the `Ivora-Signature` header on `/api/webhooks/ivora`.                                                                      |
| `STRIPE_WEBHOOK_SECRET`       | Advised  | Verifies Stripe's signature on `/api/webhooks/stripe`.                                                                               |
| `CRON_SECRET`                 | Advised  | Protects `/api/cron/reconcile`, the safety sweep that settles sessions nobody is watching.                                           |
| `STRIPE_CONNECTED_ACCOUNT_ID` | No       | The site operator's Stripe account. With it, payments are direct charges on that account and the deployer takes the application fee. |
| `APPLICATION_FEE_BPS`         | No       | Deployer's application fee in basis points. Default `1000` (10%). `0` to `10000`.                                                    |
| `DEFAULT_HOLD_CENTS`          | No       | Hold when a tariff has no authorization amount. Default `5000` ($50). `50` to `50000`.                                               |
| `IDLE_GRACE_MINUTES`          | No       | Free idle minutes after charging ends. Default `10`.                                                                                 |
| `SITE_NAME`                   | No       | Shown on the operator pages.                                                                                                         |
| `SITE_TIME_ZONE`              | No       | IANA zone for "today" and for tariff time rules. Default `UTC`.                                                                      |
| `TYPICAL_SESSION_KWH`         | No       | The typical session quoted on the charger page. Default `30`.                                                                        |
| `TYPICAL_SESSION_MINUTES`     | No       | Default `25`.                                                                                                                        |
| `IVORA_API_URL`               | No       | Default `https://api.ivoracharge.com`.                                                                                               |
| `DEMO_MODE`                   | No       | `1` forces demo mode.                                                                                                                |

`.env.example` lists them all. Never commit a real `.env` file.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIvora-Charge%2Fivora-examples&root-directory=forecourt-checkout&project-name=forecourt-checkout&env=IVORA_API_KEY,IVORA_TENANT_ID,STRIPE_SECRET_KEY,SESSION_SECRET,OPERATOR_PASSWORD,PUBLIC_BASE_URL)

The deploy runs in demo mode until every live variable is set. Point your own domain at it before printing QR codes; the Prices page refuses to show QR codes for a non-HTTPS or `*.vercel.app` URL. `vercel.json` runs the safety sweep once a day, which works on every Vercel plan; on a paid plan, run it every few minutes.

## How a payment works

This template uses Ivora's **externally funded charging sessions** (application-managed payments), the same path as Squid.

The settlement guides on the developer portal describe two ways to take a driver's money. The ticket asked to prefer **Ivora bills with a payment service** (Ivora-managed payments, `/payment/{service}/...`), so this template would show the path Squid does not use, unless that path cannot carry the site operator's own fee. It cannot today:

- The managed path's documented limits list application fees and marketplace payouts as unsupported, and Ivora takes no application fee on those direct charges.
- The payment request takes only a bill ID and return options, and capture "captures exactly the immutable bill amount" with no amount or fee field. There is nowhere to put the deployer's basis-point fee.
- The hold comes from the tariff with a $0.50 to $100 range, and there is no payment webhook.

With externally funded sessions the app owns the processor integration, so it can place the hold through Stripe Checkout, capture with `application_fee_amount`, and still use Ivora's immutable bill for the amount. If the managed path gains application fees, switching is mostly a matter of replacing `src/lib/server/stripe.ts` and the capture step.

The flow, in `src/lib/server/sessions.ts`:

1. **Pay.** The app reads the station and tariff, then creates a Stripe Checkout Session with manual capture for the hold. Nothing is sent to the charger yet. The Checkout Session ID becomes the app's session ID.
2. **Start.** Once the hold is authorized, the app creates an Ivora externally funded session (`application_reference` = `forecourt:<session id>`, `payment_reference` = the PaymentIntent), starts it with `funding_confirmed: true`, and records an optional `authorization` settlement report.
3. **Charge.** The driver's page polls; each poll reconciles. The app shows Ivora's live `energy_wh`, `power_w` and `estimated_minor`, and stops the session when the running cost reaches 85% of the hold.
4. **Finished.** When the connector reports `SuspendedEV`, `SuspendedEVSE` or `Finishing`, or power falls below 100 W, the page shows "Please move your car" with the idle-fee countdown.
5. **Receipt.** When the transaction ends, the app finalizes the bill, applies the idle grace credit, and captures the amount with the application fee, or releases the hold. It records a `capture` or `release` settlement report.

Every write uses an idempotency key derived from the session ID and the action (`forecourt:<id>:start`, `:capture` and so on), for both Ivora and Stripe. Reconciling is therefore safe to repeat from a poll, a webhook or the cron sweep, on any server instance. No database is needed: the state lives in Stripe (the Checkout Session and PaymentIntent metadata) and in Ivora (the session and its bill).

### Money rules

All amounts are integer cents. Every rounding is half up, once, at a documented point. The code is in `src/lib/money.ts`, with tests in `tests/money.test.ts`.

- **Hold:** the tariff's `authorization_minor`, or `DEFAULT_HOLD_CENTS` when that is not between 50 and 50,000 cents.
- **Bill:** Ivora's final bill, `total_minor`, from the same calculation as the tariff quote.
- **Idle grace:** Ivora bills every idle minute (PARKING_TIME), and the API has no grace-period setting. The app waives the first `IDLE_GRACE_MINUTES` at the bill's lowest idle rate, capped at what the bill charged for idle time. If the car left inside the grace period, the whole idle charge is waived. The receipt shows the credit as its own line.
- **Capture:** `min(bill − grace credit, hold)`. If that is under 50 cents (Stripe's minimum), nothing is charged and the whole hold is released. If it is above the hold, only the hold is charged and the receipt shows the uncollected rest. Charging stops at 85% of the hold, so this should be rare.
- **Application fee:** `captured × APPLICATION_FEE_BPS / 10000`, rounded half up, sent as Stripe's `application_fee_amount` on direct charges to `STRIPE_CONNECTED_ACCOUNT_ID`. Without a connected account there is no fee. The driver's receipt never shows it.

### Units

OCPP 1.6 meter registers are Wh. The app does arithmetic on Ivora's integer `energy_wh` and converts to kWh only for display, in one helper (`src/lib/units.ts`). Power arrives in W and is shown in kW.

## What it uses from the Ivora API

| Endpoint                                                                             | Used for                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `GET /v1/tenants/{tenant_id}/stations?external_reference=`                           | Resolve a QR code to a station and connector      |
| `GET /v1/tenants/{tenant_id}/stations`, `GET .../stations/{station_id}`              | Connector status, idle detection, operator list   |
| `GET /v1/tenants/{tenant_id}/tariffs/{tariff_id}`, `PATCH` the same                  | Price breakdown; operator price changes           |
| `POST /v1/tenants/{tenant_id}/tariffs/{tariff_id}/quote`                             | Typical-session estimate on the charger page      |
| `POST /v1/tenants/{tenant_id}/charging-sessions`, `GET` with `application_reference` | Create and recover externally funded sessions     |
| `POST .../charging-sessions/{id}/start`, `/stop`, `/cancel`, `/finalize`             | Start, stop, cancel and bill a session            |
| `POST .../charging-sessions/{id}/settlement-reports`                                 | Optional audit of authorization, capture, release |
| `GET /v1/tenants/{tenant_id}/stats`                                                  | Today's sessions, energy and billed revenue       |
| `GET /v1/tenants/{tenant_id}/stations/{station_id}/faults`                           | Recent faults                                     |
| Webhooks: `charging_session.status_changed`, `bill.finalized`                        | Settle a session as soon as it changes            |

API key permissions documented on the portal: `stations:read`, `stations:control` (start and stop), `billing:read` (sessions, quotes, revenue), `billing:write` (create, finalize and cancel sessions) and `settlement:write` (create sessions and reports). Editing prices also writes tariffs; check the portal for the permission your key needs. The app sends `Ivora-Version: 2026-10-15` so tariff elements and bill breakdowns are present.

Errors show the API's code and request ID with a link to [Errors and statuses](https://ivoracharge.com/developers/guides/reference/errors). On `429` the client waits once for a short `Retry-After` and otherwise reports `rate_limited`. `request_in_progress` and `outcome_unknown` are retried on the next poll with the same key.

## Card terminals (planned)

Payment terminals are out of scope for now. `src/lib/terminal.ts` defines the `CardTerminalAdapter` interface a terminal integration would implement (present a hold, capture, release, show a receipt), so a card tap can drive the same session flow as the phone. The included `PlannedTerminalAdapter` refuses every call, so a half-wired terminal can never take money.

## Limits and next steps

- **USD only**, like Ivora bills today.
- **No database.** Session state lives in Stripe and Ivora. The operator "today" view reads the latest 100 sessions, and the webhook de-duplicates per server instance (reconciling is idempotent, so a duplicate on another instance is harmless).
- **Idle after the transaction ends is not billed.** Ivora prices idle time inside the charging transaction. If the driver presses "End session" while still parked, the idle fee stops too.
- **Idle detection while charging is approximate.** The countdown starts when the app first sees the connector idle; the final idle fee comes from Ivora's bill, which uses the charger's own reports.
- **Holds expire.** Card authorizations last about 7 days with most issuers. The daily sweep settles abandoned sessions well before that; run it more often on a paid plan.
- **Conditional prices** (time of day, power or energy bands) are priced correctly by Ivora but can't be edited on the Prices page; edit them through the API.
- **Refunds** are not in the UI; issue them in the Stripe Dashboard.
- **Next steps:** card terminal adapter, partial refunds, a database for longer history, per-site multi-tenant operator accounts, and switching to Ivora-managed payments once that path supports application fees.

## License

[Apache-2.0](../LICENSE)
