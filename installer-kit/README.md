# Installer kit

For installers and hardware sellers: connect a site's OCPP 1.6J charger to Ivora, prove it works, and hand the site a QR sticker and a one-page commissioning report. No new hardware, no payment collection (see forecourt-checkout and Squid for that).

> Screenshot: to be added after the first deployed demo.

## Flow

1. Site: name and address.
2. Add charger: creates the station, shows the OCPP URL and password (copy buttons, QR). The password is displayed **once**; afterwards only a mask is kept. Setup notes are an editable list, starting with generic OCPP 1.6J steps.
3. Wait for connection: polls every 2 s (and accepts `station.connected` / `station.booted` webhooks). Shows vendor, model, firmware and connectors, with troubleshooting hints for wrong URL, wrong password and no network.
4. Test: runs a short test session, shows energy (kWh) and the heartbeat and meter-value intervals.
5. Price (optional): per-kWh tariff in integer cents with a quote preview.
6. Hand-over: sticker PDF per connector and the commissioning report PDF.

## Run locally

```bash
npm ci
cp .env.example .env.local   # leave IVORA_API_KEY empty for demo mode
npm run dev
```

Demo mode (no credentials, works offline): a simulated charger connects about four seconds after "Add charger" and passes the test. Demo never sends charger commands or payments, and all demo data is labelled.

Checks: `npm run format:check && npm run typecheck && npm test && npm run build`.

## Connect real services

| Variable               | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `IVORA_API_KEY`        | Server-side only. Empty means demo mode.                    |
| `IVORA_TENANT_ID`      | Server-side only.                                           |
| `IVORA_API_URL`        | API base URL from the developer portal.                     |
| `IVORA_PROJECT_ID`     | One Ivora project per deployment.                           |
| `IVORA_OCPP_URL`       | OCPP WebSocket endpoint chargers connect to.                |
| `IVORA_WEBHOOK_SECRET` | Verifies webhook signatures (`POST /api/webhooks/ivora`).   |
| `IVORA_ERRORS_URL`     | Portal errors and statuses page, linked beside error codes. |
| `QR_BASE_URL`          | Base URL printed in stickers. Your own domain.              |

The API paths and webhook header in `src/lib/ivora.ts` and the webhook route are **placeholders**: confirm them against the published OpenAPI before going live. The client sends an idempotency key on writes and retries on HTTP 429 using `Retry-After`.

## Why QR_BASE_URL is your domain

Stickers point to `QR_BASE_URL/c/<charger>/<connector>` and default to `http://localhost:3000`, never an Ivora domain (a sticker route on an Ivora domain is rejected). A printed sticker lives for years on a wall; if it points at your own domain, it keeps working when the site moves to another platform, because you decide where that URL goes.

## Units

OCPP 1.6 meter registers are Wh; session energy is kWh; money is integer cents.

## Limits and next steps

- State is in memory (single instance). Use a database for production.
- Live mode is untested against a real account in this repo; tests are offline.
- Setup notes are not persisted. Add per-brand notes storage.
- Pair with forecourt-checkout for payments. The sticker landing page `/c/[id]/[connector]` is a placeholder.
- Sticker PDF code is written from scratch (Squid's was not reused, so no attribution is needed).

[Deploy to Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIvora-Charge%2Fivora-examples&root-directory=installer-kit)
