# Template conventions

Every template in this repository follows these conventions, the same ones used by the [Squid](https://github.com/Ivora-Charge/squid) reference app. The API reference is the [Ivora developer portal](https://ivoracharge.com/developers/guides) and the published [OpenAPI schema](https://api.ivoracharge.com/openapi.json). They keep templates safe to fork, easy to review, and consistent for people who run more than one.

If a template needs to break a convention, say why in its README and in the pull request.

## Stack and layout

- Node.js 22, Next.js App Router, TypeScript and npm.
- One top-level folder per template, with its own `package.json`, `package-lock.json`, `README.md` and `.env.example`. Templates do not share code or dependencies with each other.
- One workflow per template at `.github/workflows/<folder>.yml`, with a `paths` filter on that folder and on the workflow file itself.
- npm scripts named `format:check`, `typecheck`, `test` and `build`. CI runs all four and each must pass locally first.
- Tests must not need real credentials or network access. Mock the Ivora API, payment providers and email at the HTTP or client boundary.

## API keys and tenant ID stay on the server

The Ivora API key and tenant ID grant control over real chargers and money. Treat them like a database password.

- Read them only in server code: route handlers, server actions, server components and scripts. Never put them in a `NEXT_PUBLIC_` variable, a client component, a URL, logs or error messages.
- Keep the Ivora client in a server-only module (`import "server-only"`) so an accidental client import fails the build.
- The browser talks to your own routes; your routes talk to Ivora. Check that the signed-in user may act on the station or session before calling Ivora on their behalf.
- Ask for the smallest set of API key permissions the template needs and list them in the README.
- `.env.example` lists every variable with an empty or placeholder value and a comment. Real `.env*` files are never committed; the root `.gitignore` blocks them.

## One Ivora project per deployment

Each deployment of a template uses its own Ivora project and API key. Do not share a project between two templates, or between production and preview deployments of the same template.

- Separate projects keep stations, sessions, webhooks and rate limits apart, so a test deployment cannot start a charger that a production deployment owns.
- Use test resources (an Ivora test project, payment provider test mode) for previews and local development.
- When registering records in Ivora, set an `external_reference` derived from your own record ID. A retry then finds the existing record instead of creating a duplicate or matching on names.

## Demo mode

Every template has a demo mode that runs with no credentials and no network access, so anyone can try it with `npm ci && npm run dev`.

- Demo mode is on whenever the required credentials are missing. It can also be forced with an explicit variable, documented in `.env.example`.
- Demo data is clearly labelled in the UI, for example with a persistent "Demo" banner and sample names that cannot be mistaken for real sites or people.
- Demo mode never sends payment requests, charger commands, emails or any other request to a real service. Keep this in one place in code (for example a demo implementation of the same client interface) and cover it with a test.
- Demo mode covers the main flows end to end, so the README screenshot and the deployed demo show what the template does.

## Webhooks

- Verify the `Ivora-Signature` header on every webhook request before parsing or acting on it. The header has the form `t=<unix>,v1=<hex>`, where `v1` is the HMAC-SHA256 of `<t>.<raw body>` with the endpoint's signing secret. Compute it over the raw body bytes, compare in constant time, and reject old timestamps. Reject unsigned or invalid requests with `400` or `401`.
- Deliveries are at least once and retried with backoff. Store each event ID and acknowledge redeliveries without processing them twice.
- Acknowledge quickly with `2xx`, then do slower work. Treat the webhook as a signal and read the current state from the API rather than trusting event order.
- Keep the webhook secret server-side, one per deployment.
- Unit-test signature verification with fixed secrets and payloads; never call the real API in tests.

## Idempotency and retries

- Send an `Idempotency-Key` header on every write to the Ivora API (creating locations, stations, bills and sessions, sending commands). Derive the key from your own record and action, so a retry after a timeout or lost response reuses the same key.
- If the API answers `409 request_in_progress` or `503 outcome_unknown`, retry later with the same key; do not create a new key, or the action may happen twice.
- Apply the same rule to payment providers: one idempotency key per logical payment action.
- Respect rate limits. On `429`, wait for the time in `Retry-After`, then retry with backoff. Do not retry other `4xx` errors automatically, and never loop on `401`.
- Make background jobs and webhook handlers safe to run twice.

## Units

| Quantity                 | Unit                                                         |
| ------------------------ | ------------------------------------------------------------ |
| OCPP 1.6 meter registers | Wh (watt-hours), as reported by the charger                  |
| Session energy           | kWh                                                          |
| Power                    | kW                                                           |
| Money                    | Integer minor units (cents), with an ISO 4217 currency       |
| Timestamps               | ISO 8601 in UTC; convert to the site's time zone for display |

- Convert Wh to kWh in one helper and test it. Never mix the two in a calculation.
- Never use floating-point numbers for money. Store and compute in integer cents, round once at a documented point, and format only for display.
- Name fields and variables with their unit when it is not obvious, for example `energyWh`, `energyKwh`, `amountCents`.

## Errors

- Show the API's error code and a short message to the operator, with a link to the developer portal's [Errors and statuses](https://ivoracharge.com/developers/guides/reference/errors) page. Do not hide errors behind a generic "something went wrong".
- Never show API keys, tenant IDs, raw stack traces or other customers' data in error messages or logs.
- Distinguish errors the user can fix (validation, charger offline, card declined) from errors they cannot (configuration, outage), and say what to do next.
- Log enough to debug (error code, request ID, your own record ID) without logging secrets or personal data.

## QR codes on your own domain

QR codes printed on stickers and signs outlive any single app version or platform. Every QR code a template generates points to a URL on the deployer's own domain, for example `https://charge.example.com/s/<code>`.

- Never encode an Ivora URL, a hosting provider's default domain (such as a `*.vercel.app` preview URL) or a third-party shortener.
- The path uses a stable code you control, not an internal database or Ivora ID, so you can move hosting, change providers or re-map a station without reprinting stickers.
- Read the public base URL from a server-side variable and refuse to generate printable codes until it is set to a stable HTTPS origin. Demo mode may generate codes, clearly marked as demo.

## README

Each template README covers, in this order:

1. Who it is for and what it does.
2. A screenshot of the demo.
3. Run locally (demo mode first).
4. Connect real services, with a table of environment variables.
5. Deploy, with a Deploy to Vercel button.
6. What it uses from the Ivora API, including required API key permissions.
7. Limits and next steps.
