# CPO Starter Kit

> **In progress.** This is part 2 of the kit: the app shell, demo mode, the Ivora client, and the team (staff sign-in and roles on Supabase). Sections marked "Coming soon" are filled in by later parts.

An operations app for small charging operators (CPOs) with no developers on staff. You fork it, put your own name on it, connect your Ivora project and go live: onboarding, chargers, live sessions, pricing, reports and your team in one place, on your own domain.

![Demo: overview with sample sites and chargers](docs/screenshot.png)

## What it does today

- **App shell:** phone-first and keyboard accessible (skip link, labelled navigation, visible focus, 44 px tap targets). On a phone the sections are behind a Menu button; on a wide screen they are a sidebar. Every colour, font, size, radius and spacing is a token in [`app/tokens.css`](app/tokens.css); the tokens are neutral placeholders, so a brand restyles the kit by editing that one file.
- **Overview:** sites, chargers online, connectors, sessions charging now and recent energy, read from Ivora (or from sample data in demo mode).
- **Team:** staff sign in with email and password or an emailed sign-in link. Owners and managers invite staff by email (a link that works once and expires in 72 hours), change roles and remove people. The last owner can't be removed or demoted.
- **Sections:** Onboarding, Chargers, Live, Pricing, Reports and Settings are placeholders marked "Coming soon".

### Roles

| Role       | May                                                                               |
| ---------- | --------------------------------------------------------------------------------- |
| Owner      | Everything, including inviting, promoting and removing owners.                    |
| Manager    | Invite, change and remove technicians and viewers (only to technician or viewer). |
| Technician | Work on chargers (later parts). Cannot change the team.                           |
| Viewer     | Read the overview and reports. Cannot change anything.                            |

Nobody can remove themselves; ask another owner. Roles are stored in the `cpo_staff` table and checked on the server, never read from user metadata. Every page and every server action starts with `requireRole(min)` from [`lib/server/auth.ts`](lib/server/auth.ts), which later modules use too.

## Run locally

Requires Node.js 22.13 or later.

```sh
npm ci
npm run dev
```

With no credentials it starts in **demo mode**, with a persistent banner: "Demo mode: add your Ivora API key in settings to go live". _Settings_ means your deployment's environment variables (for example Vercel Project Settings → Environment Variables, or `.env.local` locally); the kit has no in-app key entry. Live mode also needs Supabase (below).

In demo mode you are signed in as a labelled demo owner (`demo-owner@example.com`), with sample sites and chargers named `Sample Site: …` and `DEMO-…` and a sample team at `@example.com`. You can invite (the email is shown instead of sent, with a link to open), accept, change roles and remove staff; the demo team is kept in your own browser's cookie and a button resets it. Demo mode never sends anything to Ivora, Supabase, chargers, payment providers, email or any other service.

## Connect real services

Copy `.env.example` to `.env.local` and fill it in. Live mode needs **both** Ivora and Supabase, so live charger data is never served without staff sign-in; if any of the required values is missing the app stays in demo mode.

| Variable                    | Purpose                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `IVORA_API_KEY`             | Tenant-scoped Ivora API key. Server-side only. Required for live mode.                                  |
| `IVORA_TENANT_ID`           | Numeric tenant (project) ID, part of every API path. Required for live mode.                            |
| `IVORA_API_BASE_URL`        | Optional; defaults to `https://api.ivoracharge.com`. An empty value counts as unset.                    |
| `OPERATOR_NAME`             | Your business name, shown in the header, page titles and emails (default "Your charging network").      |
| `DEMO_MODE`                 | Set to `true` to force demo mode even when credentials are set (for example on a public demo instance). |
| `SUPABASE_URL`              | Your Supabase project URL. Required for live mode.                                                      |
| `SUPABASE_ANON_KEY`         | The project's anon (or publishable) key. Used on the server only, with RLS. Required for live mode.     |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key, for writes the server has already authorized. Server-only. Required for live mode.    |
| `SUPABASE_DB_URL`           | Postgres connection string, used only by `npm run db:migrate`.                                          |
| `SETUP_SECRET`              | One-time secret (16+ characters) that unlocks the setup screen for the first owner.                     |
| `APP_URL`                   | Public origin for invite and sign-in links, e.g. `https://ops.example.com`. Defaults to the Vercel URL. |
| `RESEND_API_KEY`            | Optional. Sends invite and sign-in emails through Resend. Without it, see [Email](#email).              |
| `EMAIL_FROM`                | Sender for those emails, for example `Team <team@example.com>`. Needed with `RESEND_API_KEY`.           |

Use **one Ivora project and API key per deployment**, and a test project for previews and local development. The same goes for Supabase: one project per deployment.

### Set up Supabase

1. Create a Supabase project. In **Authentication → Sign In / Providers**, turn off **Allow new users to sign up**: the kit never signs people up publicly, and logins are only created by the setup screen and by invites.
2. In **Authentication → URL Configuration**, set the Site URL to your `APP_URL` and add `<APP_URL>/auth/callback` to the redirect URLs.
3. Apply the migrations: `npm run db:migrate` (reads `SUPABASE_DB_URL` from `.env.local`). It runs every file in `supabase/migrations` in filename order, in one transaction, and records each in the `cpo_schema_migrations` ledger table, so running it again applies only new files. Or paste the files, in order, into the SQL editor.
4. Set `SETUP_SECRET`, deploy, open `/setup` and create the first owner with the secret. Setup works once: after that everyone joins by invite, and you can remove `SETUP_SECRET`.

### Email

- With `RESEND_API_KEY` and `EMAIL_FROM`, invites and sign-in links are sent by the kit through Resend, each with an idempotency key so a retry never sends twice.
- Without them, an invite shows its link once to the person who created it, to send themselves, and sign-in links are sent by Supabase's own email (configure custom SMTP in Supabase for production; that link must be opened in the same browser).
- Links carry their token in the URL fragment (`/invite#…`, `/auth/confirm#…`), which browsers never send to servers, so tokens stay out of request logs. Opening a sign-in link does not sign in by itself: you press a button, so email scanners cannot use it up.

### Security

- **Server-only:** the Ivora client, Supabase clients and configuration import `server-only`, so importing them from a client component fails the build. Keys are never sent to the browser, logged or shown in errors. The Supabase session lives in HTTP-only cookies managed by the Supabase SSR client; the browser holds no Supabase key or token.
- **Roles on the server:** every server action that changes something calls `requireRole()` and the team rules in [`lib/server/team/service.ts`](lib/server/team/service.ts) before touching data. A database trigger also refuses to remove or demote the last owner, locking the operator row so two owners cannot demote each other at the same time.
- **Database (the 10-30 rule):** RLS is on for every table, and every migration revokes all privileges from `anon` and `authenticated` (older Supabase projects grant them everything by default). Only `cpo_operators` and `cpo_staff` are read through the Data API with the staff member's own session, so only they get column-level `SELECT` for `authenticated`, matching RLS policies that show a staff member their own operator and team only. `anon` reads nothing. Invites, rate limits and the migration ledger are service-role only, and invites store a SHA-256 of their token, never the token. `npm run check:migrations` (run in CI) fails a migration that creates a public table without RLS or without revoking default grants, grants `anon`/`authenticated` anything without a matching policy, grants `ALL` or default privileges, or leaves a function executable by `PUBLIC`. PGlite tests in `tests/database.test.ts` run the migrations and check the policies.
- **Rate limits:** password sign-in (30 per source and 10 per account per 10 minutes), sign-in links (10 per source per 10 minutes, 1 per address per minute), setup, invite acceptance, and invites (20 per inviter and 3 per recipient per hour). Quotas are shared by all server instances through the database, keyed by HMAC digests, never plain addresses. Per-source quotas trust only Vercel's client address header; on other hosts all callers share one source bucket and the per-account quotas do the work.
- **Logs:** never passwords, tokens or email addresses; record IDs and error codes only.
- **Demo mode in one place:** `getIvora()` in `lib/server/ivora/index.ts` and `getTeam()` in `lib/server/team/index.ts` return demo implementations whenever demo mode is on, and the live Ivora and Supabase clients also refuse to run while demo mode is on. Tests stub `fetch` to fail and run every Ivora method and every team flow in demo mode.
- **Idempotency:** every Ivora write sends an `Idempotency-Key` derived from our own record and action (`idempotencyKey("location", id, "create")` gives `cpo-location-<id>-create`). The client refuses a write without one.
- **Retries:** `409 request_in_progress`, `503 outcome_unknown`, a lost connection and gateway errors are retried with the same key and body, with backoff. `429` waits for `Retry-After` (seconds or a date). All waits in one call share a budget of 20 seconds, so a request stays inside a serverless time limit; a wait past it goes back to the caller with its `Retry-After`. Other `4xx` errors, including `401`, are never retried.
- **Duplicates:** a create that may already have happened (`external_reference_taken`, or `request_in_progress` / `outcome_unknown` after the last retry) is looked up by our `external_reference`.
- **Errors:** API errors show their code, the request ID and a link to [Errors and statuses](https://ivoracharge.com/developers/guides/reference/errors). Logs carry the code and request ID only.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIvora-Charge%2Fivora-examples&root-directory=cpo-starter-kit&project-name=cpo-starter-kit&repository-name=cpo-starter-kit)

The button deploys the kit in demo mode. To go live, set up Supabase as above, add the variables in Vercel Project Settings → Environment Variables, redeploy, and create the first owner at `/setup`. Point your own domain at the deployment (and set `APP_URL` to it) before inviting staff or printing any QR codes.

## What it uses from the Ivora API

All paths are under `/v1/tenants/{tenant_id}` and follow the [published OpenAPI](https://api.ivoracharge.com/openapi.json) and the [developer guides](https://ivoracharge.com/developers/guides).

| Module   | Use                        | Endpoint                                      | Permission       |
| -------- | -------------------------- | --------------------------------------------- | ---------------- |
| Overview | Sites (every page)         | `GET /locations`                              | `stations:read`  |
| Overview | Chargers and connectors    | `GET /stations`, `GET /stations/{station_id}` | `stations:read`  |
| Overview | Recent and active sessions | `GET /transactions`                           | `billing:read`   |
| Client   | Create a site (used later) | `POST /locations` (with `Idempotency-Key`)    | `stations:write` |
| Team     | None                       | Staff and roles live in Supabase              | None             |

Later parts add their endpoints and permissions to this table.

## Limits and next steps

- The Overview follows the API's `next_cursor` pagination up to 20 pages (2,000 sites and 2,000 chargers) and says so when there are more; it shows the latest 50 sessions.
- One staff login belongs to one operator. Removing someone also deletes their login. Deleting the last owner's login in Supabase is refused by the database.
- No password reset screen yet: staff without a password use an emailed sign-in link.
- Next parts: onboarding, chargers, live sessions, pricing, reports and settings.

## Checks

```sh
npm run format:check && npm run typecheck && npm run check:migrations && npm test && npm run build
npx playwright install chromium && npm run test:e2e   # offline demo run, desktop and mobile
```

Tests never need credentials or network access: the Ivora API, Supabase and the email provider are replaced by fakes at the HTTP or client boundary, and the migrations run in an in-process Postgres ([PGlite](https://pglite.dev)).
