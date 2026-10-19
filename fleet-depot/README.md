# Fleet depot

Depot charging for fleets (vans, buses, company cars) on the Ivora API. For operators who want vehicles ready by departure, a site power limit respected, and a monthly cost per vehicle and driver.

> Screenshot: run the demo (`npm run dev`) and open <http://localhost:3000>. A screenshot will be added to `docs/` in a follow-up; none is committed yet.

## Features

- **Vehicles and drivers** in the template's own database: SQLite by default (`SQLITE_PATH`, uses Node's built-in `node:sqlite`), Postgres when `DATABASE_URL` is set, in memory in demo mode. The `docs` table is created on first use.
- **RFID cards** through the Ivora tokens API: create, import CSV (`idTag,driverName[,email]`, header optional, `,` or `;`), block when a driver leaves.
- **Departure-time charging**: per vehicle a departure time plus energy needed (kWh, or battery size and target percent). The app picks the slowest constant power that finishes by departure, caps it at the connector limit and the site allowance, sends it as a charging profile (limits in W), reads back the composite schedule and shows `charging_profile.accepted` / `rejected` events.
- **Site power cap** (`SITE_CAP_KW`): split across active sessions, earliest departure first, recomputed when a vehicle plugs in or leaves. This is app-side logic. Server-side site load balancing is planned in the Ivora API; when it ships, this split can move there.
- **Reports**: energy and cost per vehicle and per driver per month, from transactions' meter registers (Wh) and the tariff (`TARIFF_CENTS_PER_KWH`, integer cents). CSV export at `/api/reports?by=driver&format=csv&month=YYYY-MM`.
- **Live board**: vehicle, connector, state of charge (where reported; demo estimates it from delivered energy), ready-by status, profile status.
- **Webhooks** at `/api/webhooks` with HMAC-SHA256 signature verification.

## Run locally

```sh
npm ci
npm run dev
```

With no credentials it starts in **demo mode**: six simulated vehicles arrive 17:00-21:00 and leave 05:30-08:00 on a simulated clock (use "Advance 1 h / 8 h"). Nothing is sent to payment or charger APIs.

## Connect real services

| Variable                                  | Purpose                                              |
| ----------------------------------------- | ---------------------------------------------------- |
| `IVORA_API_KEY`, `IVORA_TENANT_ID`        | Server-side only. Both set turns demo mode off.      |
| `IVORA_API_BASE_URL`                      | API base URL from the developer portal               |
| `IVORA_WEBHOOK_SECRET`                    | Signing secret for `/api/webhooks`                   |
| `DATABASE_URL` / `SQLITE_PATH`            | Postgres, or SQLite file (default `./data/depot.db`) |
| `SITE_CAP_KW`                             | Depot limit in kW (default 60)                       |
| `TARIFF_CENTS_PER_KWH`, `TARIFF_CURRENCY` | Site tariff                                          |
| `DEMO_MODE=true`                          | Force demo mode                                      |

Use one Ivora project per deployment. Writes send idempotency keys; API errors are shown with their code and a link to the portal's errors and statuses page; `Retry-After` is surfaced for rate limits.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIvora-Charge%2Fivora-examples&root-directory=fleet-depot)

SQLite needs a writable disk, so on Vercel set `DATABASE_URL` to Postgres.

## What it uses from the Ivora API

Tokens (create, block), charging profiles, composite schedule, and webhooks (`transaction.*`, `charging_profile.accepted|rejected`). Endpoint paths, the signature header name and the event payload shape in `lib/ivora.ts` and `app/api/webhooks/route.ts` are written against the public docs' conventions; **check them against the published OpenAPI before going live**.

## Limits and next steps

- Session start is matched to a vehicle by the driver's card; one vehicle per driver.
- No authentication on the dashboard: put it behind your own login before exposing it.
- Reports bucket by UTC month and do not do time-of-use tariffs.
- Next: server-side site load balancing, time-of-use tariffs, per-vehicle edit forms (vehicles can be added through `POST /api/vehicles`).

## Checks

`npm run format:check && npm run typecheck && npm test && npm run build`
