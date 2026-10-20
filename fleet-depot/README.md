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
- **Site power cap** (`SITE_CAP_KW`): split across active sessions in whole watts (rounded down), earliest departure first. It is recomputed when a vehicle plugs in or leaves, when a departure changes, when a station answers, and every `REPLAN_INTERVAL_SECONDS` (default 60). This is app-side logic. Server-side site load balancing is planned in the Ivora API, and when it ships this split can move there. How the app keeps the stations under the cap:
  - **No expiry.** A profile has no duration, so the station keeps its last period until the session ends. Every period is at most the session's share, and from departure on the limit is that share, so a vehicle that stays plugged in past its departure is still capped.
  - **Lower limits first.** A replan sends every decrease before any increase. Increases wait until each decrease is accepted by its charger (by answer, webhook or a status read). If a decrease fails, is refused, or its outcome is unknown, the increases wait for the next replan.
  - **Counted until gone.** A profile counts at its limit until the charger rejects, replaces or clears it. On OCPP 2.x the app alternates between stack levels 1 and 2 and clears the old profile only after the new one is accepted, so a session is never left without a limit.
  - **Only what is free.** A vehicle that just plugged in gets at most the cap minus what the other sessions may still draw; it is raised once the others have made room.
  - **Optional baseline** (`BASELINE_PROFILE=1`, live mode only, off by default): see [the plug-in gap](#the-plug-in-gap).
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
| `BASELINE_PROFILE`                        | Set to `1` (or `true`) to keep a per-charger baseline profile in live mode (default off; demo mode ignores it)              |
| `DEFAULT_CONNECTOR_KW`                    | Power reserved for a session whose card matches no vehicle, when the station reports no rating (default 11)                 |
| `REPLAN_INTERVAL_SECONDS`                 | Live mode replans on this timer as well as on events, to retry failed decreases and follow departures (default 60)          |
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
  - Blocking a card stores one key per block action (`fd-token-block-<token>-<random>`): a retry reuses it, and blocking again after the card was unblocked elsewhere is a new request.
  - A card import's key is the file's hash plus an attempt number. After `503 outcome_unknown` the next run of the same file uses a new attempt number, as the tokens guide asks.
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
| Profile state            | `GET /stations/{id}/charging-profiles/{profile_id}`                                                             | `stations:read`                 |
| What the station applies | `POST /stations/{id}/composite-schedule`, `GET /operations/{id}`                                                | `stations:read`                 |
| Events                   | Webhooks: `meter.sampled`, `connector.status_changed`, `charging_profile.*`, `token.updated`                    | `stations:read`, `tokens:read`  |

`tokens:write` can only be granted by a tenant admin. Setting profiles goes through the usage fee gate (`402 payment_method_required`).

## The plug-in gap

Set `BASELINE_PROFILE=1` (live mode only; off by default, and demo mode stays offline and ignores it) to keep a `tx_default` charging profile on every charger the app has seen. A charger applies it to each new transaction until that transaction's own `session` profile is in force, so a vehicle that just plugged in is limited from the start.

- **Share.** The cap is divided equally over all connectors of all known chargers, in whole watts rounded down. The profile is sent without a connector, so it covers every connector of the station (connector counts come from `GET /stations/{id}`; one connector is assumed when unknown), has no duration, and is relative to the start of each transaction (W).
- **When it is set.** A charger is added when the first session starts on it, and the baseline is re-checked on every replan, so a changed `SITE_CAP_KW` (read at start-up) or a new charger moves the shares. Chargers are never removed: a station that stays in the store keeps its connectors in the split.
- **Same rules as session limits.** Baseline decreases go out before any increase (session or baseline), increases wait until every decrease is in force, a baseline counts at its limit until the charger rejects, replaces or clears it, and on OCPP 2.x the app alternates between stack levels 1 and 2.
- **Cost.** Connectors without a session keep their baseline in reserve, so sessions are planned within the cap minus that reserve (and a plugged-in vehicle counts at least at its baseline until its own profile is accepted). With five known connectors and one vehicle plugged in, that vehicle gets the cap minus four shares. Without the baseline the same vehicle could get the whole cap.
- **What is still open.** When a session ends, its connector falls back to the baseline. If that session's limit was lowered to make room and the charger has not confirmed yet, a plug-in on that connector can still exceed the cap until it does, as for any pending decrease. A charger that rejects or never answers the baseline stays at its own default.

The cap property test runs with the baseline on and off, and with it on also checks the plug-in moment (when no decrease is outstanding).

## Limits and next steps

- **Sessions come from webhooks.** Ivora has no transaction start or stop event. A session starts with a transaction's first `meter.sampled`, and ends when its connector leaves Charging and the transaction reads inactive. If a delivery fails after it is acknowledged, the event is logged and not retried; a reconcile job reading `GET …/events?after=` would close that gap.
- **Matching uses the last four characters** of the card. Keep those unique across drivers, or assign sessions by hand.
- **One process per depot.** Planning is serialized with an in-process lock, not a database lock, and the replan timer runs in that process (started from `instrumentation.ts`). On a serverless host the timer only runs while an instance is alive, so prefer a long-running server for live mode.
- **Before the first profile.** Between plug-in and the charger accepting the first session profile, a charger runs at its own default, so the site cap can be exceeded briefly. The optional baseline closes that gap; see below. A charger the app has not seen yet has no baseline until its first session starts.
- **The plan is one constant rate until done.** There is no time-of-use optimisation, and the tariff is a flat per-kWh price from the environment rather than read from Ivora tariffs.
- **Reports bucket by UTC month.**
- **Next:** server-side site load balancing once the Ivora API offers it, time-of-use windows, event-log reconciliation, and per-site time zones.

## Checks

```sh
npm run format:check && npm run typecheck && npm test && npm run build
npx playwright install chromium && npm run test:e2e   # offline demo run in a browser
```

Tests never need credentials or network access: the Ivora API is replaced by a fake `fetch`.
