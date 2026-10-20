# Fleet depot

Depot charging for fleets (vans, buses, company cars) on the Ivora API. It is for operators who want every vehicle ready by its departure time, the site's power limit respected, and a monthly energy and cost figure per vehicle and per driver.

![Demo: six simulated vehicles on their connectors within the 60 kW site cap](docs/screenshot.png)

## Features

- **Vehicles and drivers** live in the template's own database: SQLite by default (`SQLITE_PATH`, using Node's built-in `node:sqlite`), Postgres when `DATABASE_URL` is set, and in memory in demo mode. The single `docs` table is created on first use.
- **RFID cards** use the Ivora tokens API:
  - Add a driver with a card.
  - Import a CSV of `idTag,driverName[,email]` (header optional, `,` or `;`). It is sent to `POST …/tokens/import` with only the card value and our `external_reference`; names and emails stay in your database.
  - Block a card when a driver leaves (`PATCH …/tokens/{token_id}`, with the token ID looked up by our reference).
- **Departure-time charging**: each vehicle has a departure time and the energy it needs, either in kWh or as a target battery percent.
  - The app picks the slowest constant power that finishes by departure, limited by the vehicle, the connector rating and the site allowance.
  - It sends that plan as a `session` charging profile in W for the running transaction, then asks the station for its composite schedule.
  - The board shows the station's answer from the `charging_profile.accepted` and `charging_profile.rejected` webhooks.
- **Site power cap** (`SITE_CAP_KW`): split across active sessions, earliest departure first, and recomputed when a vehicle plugs in or leaves, or a departure changes. This is app-side logic. Server-side site load balancing is planned in the Ivora API, and when it ships this split can move there.
- **Reports**: energy and cost per vehicle and per driver per month. They use Wh meter registers and the transaction's `energy_wh`, with the site tariff in integer cents (`TARIFF_CENTS_PER_KWH`). The CSV export is at `/api/reports?by=driver&format=csv&month=YYYY-MM` and guards against spreadsheet formula injection.
- **Live board**: which vehicle is on which connector, the state of charge (the charger's `soc_percent` when it reports one, otherwise an estimate labelled "est."), ready-by status, and profile status with the composite schedule.
- **Webhooks** arrive at `/api/webhooks`, verified with `Ivora-Signature` (see below).

## Run locally

Requires Node.js 22.13 or later.

```sh
npm ci
npm run dev
```

With no credentials it starts in **demo mode**, with a persistent "Demo" banner. Six simulated vehicles arrive between 17:00 and 21:00 and leave between 05:30 and 08:00 on a simulated clock (use "Advance 1 h" and "Advance 8 h"). Earlier sessions are seeded so the report has data. Demo mode never calls the Ivora API or any other service: the client refuses to send in demo mode, and a test checks this.

## Connect real services

| Variable                                  | Purpose                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `IVORA_API_KEY`                           | Tenant-scoped API key. Server-side only. Setting it and the tenant ID turns demo mode off.                                  |
| `IVORA_TENANT_ID`                         | Numeric tenant ID (part of every API path). Server-side only.                                                               |
| `IVORA_API_BASE_URL`                      | Optional; defaults to `https://api.ivoracharge.com`. An empty value counts as unset.                                        |
| `IVORA_WEBHOOK_SECRET`                    | The signing secret returned once when you register the webhook endpoint                                                     |
| `OPERATOR_PASSWORD`                       | **Required in live mode.** Protects the dashboard and every API route except webhooks. Without it live mode refuses to run. |
| `DATABASE_URL` / `SQLITE_PATH`            | Postgres connection string, or SQLite file (default `./data/depot.db`)                                                      |
| `SITE_CAP_KW`                             | Depot limit in kW (default 60)                                                                                              |
| `DEFAULT_CONNECTOR_KW`                    | Power reserved for a session whose card matches no vehicle, when the station reports no rating (default 11)                 |
| `TARIFF_CENTS_PER_KWH`, `TARIFF_CURRENCY` | Site tariff for reports (integer cents)                                                                                     |
| `DEMO_MODE=true`                          | Force demo mode                                                                                                             |

1. Use **one Ivora project and API key per deployment**, and a test project for previews.
2. Register the webhook endpoint (`POST /v1/tenants/{tenant_id}/webhooks`) with the URL `https://<your-domain>/api/webhooks`. Subscribe to these events:
   - `meter.sampled`
   - `connector.status_changed`
   - `charging_profile.accepted`, `charging_profile.rejected` and `charging_profile.cleared`
   - `token.updated`

   Optionally limit it to your depot's stations with `stations`. Put the returned secret in `IVORA_WEBHOOK_SECRET`.

3. Add drivers with their card values and assign each vehicle a driver. Sessions are matched to vehicles by the card's last four characters, which is all the transactions API returns. A card that matches no driver, or more than one, shows under "Sessions without a vehicle" for you to assign.

### Security

- **Operator gate:** live mode can send charging profiles to real stations and block cards.
  - Every route except `/api/webhooks` needs a signed, httpOnly, `SameSite=Strict` session cookie issued after a constant-time `OPERATOR_PASSWORD` check.
  - Every write also needs a same-origin `Origin` header.
  - Changing the password signs everyone out.
  - Without `OPERATOR_PASSWORD`, live mode shows a setup message and the API answers `503 operator_password_missing`.
- **Webhooks:**
  - The app verifies `Ivora-Signature: t=<unix>,v1=<hex>`, where `v1` is the HMAC-SHA256 of `<t>.<raw body>`, before parsing.
  - The comparison is constant-time, and deliveries more than 5 minutes off our clock are rejected.
  - The event's `tenant_id` must be ours. Event IDs are stored so redeliveries are acknowledged without being processed twice.
  - The handler acknowledges at once and does the work after the response.
- **Idempotency:**
  - Every write sends an `Idempotency-Key` derived from our record and action, for example `fd-profile-<session>-<plan number>` and `fd-token-create-<driver>`.
  - The plan number only changes when the allocation changes, and the key and body are stored before sending. A retry after a timeout, `429`, `409 request_in_progress` or `503 outcome_unknown` therefore reuses the same key and body.
  - `Retry-After` is honoured. Other `4xx` errors are not retried.
- **Errors:** API errors are shown with their code, the request ID and a link to [Errors and statuses](https://ivoracharge.com/developers/guides/reference/errors).
- **Server-only code:** the Ivora client, configuration and database code import `server-only`, and card values reach the browser masked (`****1234`).

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIvora-Charge%2Fivora-examples&root-directory=fleet-depot&env=IVORA_API_KEY,IVORA_TENANT_ID,IVORA_WEBHOOK_SECRET,OPERATOR_PASSWORD,DATABASE_URL)

SQLite needs a writable disk, so on Vercel set `DATABASE_URL` to a Postgres database. State changes are serialized within one process, so run a single instance per depot.

## What it uses from the Ivora API

All paths are under `/v1/tenants/{tenant_id}` and follow the [published OpenAPI](https://api.ivoracharge.com/openapi.json) and the [developer guides](https://ivoracharge.com/developers/guides).

| Use                      | Endpoint                                                                                                        | Permission                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Register a card          | `POST /tokens`                                                                                                  | `tokens:write`                  |
| Import cards             | `POST /tokens/import` (CSV)                                                                                     | `tokens:write`                  |
| Find and block a card    | `GET /tokens?external_reference=…`, `PATCH /tokens/{token_id}`                                                  | `tokens:write`                  |
| Session details          | `GET /transactions/{id}`, `GET /stations/{id}`                                                                  | `billing:read`, `stations:read` |
| Charging plan            | `POST /stations/{id}/charging-profiles`, `DELETE /stations/{id}/charging-profiles/{profile_id}` (OCPP 2.x only) | `stations:control`              |
| What the station applies | `POST /stations/{id}/composite-schedule`, `GET /operations/{id}`                                                | `stations:read`                 |
| Events                   | Webhooks: `meter.sampled`, `connector.status_changed`, `charging_profile.*`, `token.updated`                    | `stations:read`, `tokens:read`  |

`tokens:write` can only be granted by a tenant admin. Setting profiles goes through the usage fee gate (`402 payment_method_required`).

## Limits and next steps

- **Sessions come from webhooks.** Ivora has no transaction start or stop event. A session starts with a transaction's first `meter.sampled`, and ends when its connector leaves Charging and the transaction reads inactive. If a delivery fails after it is acknowledged, the event is logged and not retried; a reconcile job reading `GET …/events?after=` would close that gap.
- **Matching uses the last four characters** of the card. Keep those unique across drivers, or assign sessions by hand.
- **One process per depot.** Planning is serialized with an in-process lock, not a database lock.
- **The plan is one constant rate until done.** There is no time-of-use optimisation, and the tariff is a flat per-kWh price from the environment rather than read from Ivora tariffs.
- **Reports bucket by UTC month.**
- **Next:** server-side site load balancing once the Ivora API offers it, time-of-use windows, event-log reconciliation, and per-site time zones.

## Checks

```sh
npm run format:check && npm run typecheck && npm test && npm run build
npx playwright install chromium && npm run test:e2e   # offline demo run in a browser
```

Tests never need credentials or network access: the Ivora API is replaced by a fake `fetch`.
