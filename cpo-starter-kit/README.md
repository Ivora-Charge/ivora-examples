# CPO Starter Kit

> **In progress.** This is part 1 of the kit: the app shell, demo mode and the Ivora client. Sections marked "Coming soon" are filled in by later parts.

An operations app for small charging operators (CPOs) with no developers on staff. You fork it, put your own name on it, connect your Ivora project and go live: onboarding, chargers, live sessions, pricing, reports and your team in one place, on your own domain.

![Demo: overview with sample sites and chargers](docs/screenshot.png)

## What it does today

- **App shell:** dark, phone-first and keyboard accessible (skip link, labelled navigation, visible focus, 44 px tap targets). On a phone the sections are behind a Menu button; on a wide screen they are a sidebar.
- **Overview:** sites, chargers online, connectors, sessions charging now and recent energy, read from Ivora (or from sample data in demo mode).
- **Sections:** Onboarding, Chargers, Live, Pricing, Reports, Team and Settings are placeholders marked "Coming soon".
- **Ivora client:** a server-only client interface with a live implementation and a demo implementation (see [Security](#security)).

## Run locally

Requires Node.js 22.13 or later.

```sh
npm ci
npm run dev
```

With no credentials it starts in **demo mode**, with a persistent "Demo" banner and sample sites and chargers named `Sample Site: …` and `DEMO-…`. Demo mode never sends anything to Ivora, chargers, payment providers, email or any other service. Every module must work end to end in demo mode.

## Connect real services

Copy `.env.example` to `.env.local` and fill it in.

| Variable             | Purpose                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `IVORA_API_KEY`      | Tenant-scoped Ivora API key. Server-side only. Setting it and the tenant ID turns demo mode off.        |
| `IVORA_TENANT_ID`    | Numeric tenant (project) ID, part of every API path. Server-side only.                                  |
| `IVORA_API_BASE_URL` | Optional; defaults to `https://api.ivoracharge.com`. An empty value counts as unset.                    |
| `OPERATOR_NAME`      | Your business name, shown in the header and page titles (default "Your charging network").              |
| `DEMO_MODE`          | Set to `true` to force demo mode even when credentials are set (for example on a public demo instance). |

Use **one Ivora project and API key per deployment**, and a test project for previews and local development.

> **Before going live:** this part has no sign-in yet. Staff sign-in and roles arrive in a later part. Until then, run live mode only on a private deployment (for example behind your host's deployment protection).

### Security

- **Server-only:** the Ivora client and configuration import `server-only`, so importing them from a client component fails the build. The API key and tenant ID are never sent to the browser, logged or shown in errors.
- **Demo mode in one place:** `getIvora()` in `lib/server/ivora/index.ts` returns the demo client whenever demo mode is on, and the live client also refuses to send while demo mode is on. A test stubs `fetch` to fail and runs every client method in demo mode.
- **Idempotency:** every write sends an `Idempotency-Key` derived from our own record and action (`idempotencyKey("location", id, "create")` gives `cpo-location-<id>-create`). The client refuses a write without one.
- **Retries:** `409 request_in_progress`, `503 outcome_unknown`, a lost connection and gateway errors are retried with the same key and body, with backoff. `429` waits for `Retry-After` (seconds or a date), up to 30 seconds; a longer wait goes back to the caller. Other `4xx` errors, including `401`, are never retried.
- **Duplicates:** a create that may already have happened (`external_reference_taken`, or `request_in_progress` / `outcome_unknown` after the last retry) is looked up by our `external_reference`.
- **Errors:** API errors show their code, the request ID and a link to [Errors and statuses](https://ivoracharge.com/developers/guides/reference/errors). Logs carry the code and request ID only.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIvora-Charge%2Fivora-examples&root-directory=cpo-starter-kit&project-name=cpo-starter-kit&repository-name=cpo-starter-kit)

The button deploys the kit in demo mode. To go live, add the variables above in the project's environment settings and redeploy. Point your own domain at the deployment before printing any QR codes.

## What it uses from the Ivora API

All paths are under `/v1/tenants/{tenant_id}` and follow the [published OpenAPI](https://api.ivoracharge.com/openapi.json) and the [developer guides](https://ivoracharge.com/developers/guides).

| Module   | Use                        | Endpoint                                      | Permission       |
| -------- | -------------------------- | --------------------------------------------- | ---------------- |
| Overview | Sites                      | `GET /locations`                              | `stations:read`  |
| Overview | Chargers and connectors    | `GET /stations`, `GET /stations/{station_id}` | `stations:read`  |
| Overview | Recent and active sessions | `GET /transactions`                           | `billing:read`   |
| Client   | Create a site (used later) | `POST /locations` (with `Idempotency-Key`)    | `stations:write` |

Later parts add their endpoints and permissions to this table.

## Limits and next steps

- No database, sign-in or roles yet; the Overview only reads.
- The Overview counts at most 100 sites and chargers and the latest 50 sessions (one page each).
- Next parts: Supabase with staff sign-in and roles, onboarding, chargers, live sessions, pricing, reports, team and settings.

## Checks

```sh
npm run format:check && npm run typecheck && npm test && npm run build
npx playwright install chromium && npm run test:e2e   # offline demo run, desktop and mobile
```

Tests never need credentials or network access: the Ivora API is replaced by a fake `fetch`.
