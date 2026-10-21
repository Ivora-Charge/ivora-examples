# CPO Starter Kit

> **In progress.** This is part 2 of the kit: the app shell, demo mode, the Ivora client, and the team (staff sign-in and roles on Supabase). Sections marked "Coming soon" are filled in by later parts.

An operations app for small charging operators (CPOs) with no developers on staff. You fork it, put your own name on it, connect your Ivora project and go live: onboarding, chargers, live sessions, pricing, reports and your team in one place, on your own domain.

![Demo: overview with sample sites and chargers](docs/screenshot.png)

## Make it yours in 5 minutes

The kit ships as **Ampleaf**, a placeholder brand you are meant to replace. Everything about it lives in [`brand/`](brand), and components use only its tokens.

1. **Name and copy:** `brand/brand.ts` (product name, tagline, support line). A rename is the one `name` line. Your business name is `OPERATOR_NAME` (below); it shows as the workspace in the sidebar and in page titles.
2. **Colours, type scale, radius, spacing:** `brand/tokens.css`. Each colour is `light-dark(<light>, <dark>)`. If you change `--color-bg`, change `lib/theme.ts` to match (a test checks it). Run `npm test`: `tests/contrast.test.ts` fails if a text pair drops below WCAG AA (4.5:1) in either mode.
3. **Logo:** `brand/logo.svg` (standalone file) and `brand/Logo.tsx` (the same shapes inline, so it follows the theme). Keep both in step.
4. **Fonts:** put woff2 files in `brand/fonts/` and point `brand/fonts.ts` at them. Use open-licensed fonts and keep their license files next to them.
5. **Icons:** `brand/icons.tsx`, one entry per section slug from `lib/modules.ts`.

**Lime marks what is current or live** (the current page, the demo chip). `--color-accent` is a fill only, always with `--color-on-accent` text on it, and never a text colour on the page or a card: it is unreadable there. `tests/contrast.test.ts` fails if a stylesheet or component uses it as text. If you change the accent, keep that rule.

The design brief, the approved mock and the palette are `brand/BRIEF.md`, `brand/mock.html` and `docs/brief/`. Screenshots of the main screens in light and dark, desktop and phone, are in `docs/screens/`.

### Fonts and icons

- [Manrope](https://github.com/sharanda/manrope), Copyright 2019 The Manrope Project Authors, SIL Open Font License 1.1 (`brand/fonts/OFL-Manrope.txt`).
- [Fraunces](https://github.com/undercasetype/Fraunces), Copyright 2020 The Fraunces Project Authors, SIL Open Font License 1.1 (`brand/fonts/OFL-Fraunces.txt`).
- Section, menu and theme icons: [Lucide](https://lucide.dev), ISC License, Copyright (c) Lucide Contributors.
- The Ampleaf mark is original, Apache-2.0 with this template.

## What it does today

- **App shell:** phone-first and keyboard accessible (skip link, labelled navigation, visible focus, 44 px tap targets). On a phone the sections are behind a Menu button; on a wide screen they are a sidebar. Light and dark mode follow the system setting, with a toggle. Every colour, font, size, radius and spacing is a token in [`brand/tokens.css`](brand/tokens.css) (see "Make it yours in 5 minutes" below).
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

| Variable                    | Purpose                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `IVORA_API_KEY`             | Tenant-scoped Ivora API key. Server-side only. Required for live mode.                                         |
| `IVORA_TENANT_ID`           | Numeric tenant (project) ID, part of every API path. Required for live mode.                                   |
| `IVORA_API_BASE_URL`        | Optional; defaults to `https://api.ivoracharge.com`. An empty value counts as unset.                           |
| `OPERATOR_NAME`             | Your business name, shown in the header, page titles and emails (default "Your charging network").             |
| `DEMO_MODE`                 | Set to `true` to force demo mode even when credentials are set (for example on a public demo instance).        |
| `SUPABASE_URL`              | Your Supabase project URL. Required for live mode.                                                             |
| `SUPABASE_ANON_KEY`         | The project's anon (or publishable) key. Used on the server only, with RLS. Required for live mode.            |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key, for writes the server has already authorized. Server-only. Required for live mode.           |
| `SUPABASE_DB_URL`           | Postgres connection string, used only by `npm run db:migrate`.                                                 |
| `SETUP_SECRET`              | One-time secret that unlocks the setup screen for the first owner. At least 32 characters, or setup stays off. |
| `APP_URL`                   | Public origin for invite and sign-in links, e.g. `https://ops.example.com`. Defaults to the Vercel URL.        |
| `TRUSTED_PROXY_HEADER`      | Optional, off Vercel: the header your proxy sets to the client address. See [Security](#security).             |
| `RESEND_API_KEY`            | Optional. Sends invite and sign-in emails through Resend. Without it, see [Email](#email).                     |
| `EMAIL_FROM`                | Sender for those emails, for example `Team <team@example.com>`. Needed with `RESEND_API_KEY`.                  |

Use **one Ivora project and API key per deployment**, and a test project for previews and local development. The same goes for Supabase: one project per deployment.

### Set up Supabase

1. Create a Supabase project. In **Authentication → Sign In / Providers**, turn off **Allow new users to sign up**: the kit never signs people up publicly, and logins are only created by the setup screen and by invites.
2. In **Authentication → URL Configuration**, set the Site URL to your `APP_URL` and add `<APP_URL>/auth/callback` to the redirect URLs. Vercel preview deployments put their own URL in links (never production's), so if a preview uses Supabase sign-in links, add its URL (or a wildcard for your preview domain) too, against a separate test Supabase project.
3. Apply the migrations: `npm run db:migrate` (reads `SUPABASE_DB_URL` from `.env.local`). It runs every file in `supabase/migrations` in filename order, in one transaction, and records each in the `cpo_schema_migrations` ledger table, so running it again applies only new files. Or paste the files, in order, into the SQL editor.
4. Set `SETUP_SECRET` to at least 32 random characters (for example `openssl rand -base64 32`; setup refuses to start with a shorter one), deploy, open `/setup` and create the first owner with the secret. Setup works once: after that everyone joins by invite, and you can remove `SETUP_SECRET`.

### Email

- With `RESEND_API_KEY` and `EMAIL_FROM`, invites and sign-in links are sent by the kit through Resend, each with an idempotency key so a retry never sends twice.
- Without them, an invite shows its link once to the person who created it, to send themselves, and sign-in links are sent by Supabase's own email (configure custom SMTP in Supabase for production; that link must be opened in the same browser).
- Links carry their token in the URL fragment (`/invite#…`, `/auth/confirm#…`), which browsers never send to servers, so tokens stay out of request logs. Opening a sign-in link does not sign in by itself: you press a button, so email scanners cannot use it up.

### Security

- **Server-only:** the Ivora client, Supabase clients and configuration import `server-only`, so importing them from a client component fails the build. Keys are never sent to the browser, logged or shown in errors. The Supabase session lives in HTTP-only cookies managed by the Supabase SSR client; the browser holds no Supabase key or token.
- **Roles on the server:** every server action that changes something calls `requireRole()` and the team rules in [`lib/server/team/service.ts`](lib/server/team/service.ts) before touching data. Role changes and removals then run in one database function (`cpo_set_staff_role`, `cpo_remove_staff`) that locks the actor's and the target's rows and refuses if either role changed since the server checked it, so a manager can't demote or remove someone an owner promoted in between; the page asks to reload instead. A database trigger also refuses to remove or demote the last owner, locking the operator row so two owners cannot demote each other at the same time. Demoting or removing someone revokes the pending invites they may no longer send.
- **Database (the 10-30 rule):** RLS is on for every table, and every migration revokes all privileges from `anon` and `authenticated` (older Supabase projects grant them everything by default). Only `cpo_operators` and `cpo_staff` are read through the Data API with the staff member's own session, so only they get column-level `SELECT` for `authenticated`, matching RLS policies that show a staff member their own operator and team only. `anon` reads nothing. Invites, rate limits and the migration ledger are service-role only, and invites store a SHA-256 of their token, never the token. Every function revokes `EXECUTE` from `public`, `anon` and `authenticated`; only `cpo_my_operator_ids`, which the RLS policies call, is granted back to `authenticated`. `npm run check:migrations` (run in CI) runs the repository's shared checker, [`tools/check-migrations`](../tools/check-migrations/README.md), on `supabase/migrations`. PGlite tests in `tests/database.test.ts` run the migrations with Supabase's default privileges on tables and functions and check the policies and grants; `tests/concurrency.test.ts` runs concurrent role changes against a real Postgres when `TEST_DATABASE_URL` points at a local throwaway server (CI starts one).
- **Rate limits:** password sign-in (30 per source and 10 per account per 10 minutes), sign-in links (10 per source per 10 minutes, 1 per address per minute), setup (10 per source per 10 minutes), invite acceptance, and invites (20 per inviter and 3 per recipient per hour). Quotas are shared by all server instances through the database, keyed by HMAC digests, never plain addresses, and long-expired windows are purged as it goes. Per-source quotas need a client address callers can't fake: on Vercel, Vercel's own header; elsewhere, set `TRUSTED_PROXY_HEADER` to the header your proxy or CDN sets (for example `cf-connecting-ip`, or `x-forwarded-for` from a proxy that appends to it; the kit takes its last entry). Without one, per-source quotas are skipped rather than shared, so one client can't lock everyone out, and the per-account quotas still apply. Setup has no account to limit, so there it falls back to one quota shared by every caller (10 tries per 10 minutes): guessing the setup secret stays slow, and at worst setup has to wait a few minutes. A sign-in link request gets the same answer for any address, including an invitee who has no login yet (they join with their invite link).
- **Logs:** never passwords, tokens or email addresses; record IDs and error codes only.
- **Demo mode in one place:** `getIvora()` in `lib/server/ivora/index.ts` and `getTeam()` in `lib/server/team/index.ts` return demo implementations whenever demo mode is on, and the live Ivora and Supabase clients also refuse to run while demo mode is on. Tests stub `fetch` to fail and run every Ivora method and every team flow in demo mode.
- **Idempotency:** every Ivora write sends an `Idempotency-Key` derived from our own record and action (`idempotencyKey("location", id, "create")` gives `cpo-location-<id>-create`). The client refuses a write without one.
- **Retries:** `409 request_in_progress`, `503 outcome_unknown`, a lost connection and gateway errors are retried with the same key and body, with backoff. `429` waits for `Retry-After` (seconds or a date). One call takes at most 20 seconds in total, tries and waits together (each try times out within what is left), so a request stays inside a serverless time limit; a wait or try past it is not started, and the last error goes back to the caller with its `Retry-After`. The Overview's paged lists share one such budget and show what they read so far, marked as partial. Other `4xx` errors, including `401`, are never retried.
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

- The Overview follows the API's `next_cursor` pagination up to 20 pages (2,000 sites and 2,000 chargers), or 20 seconds, and says so when there are more; it shows the latest 50 sessions.
- One staff login belongs to one operator. Removing someone also deletes their login. Deleting the last owner's login in Supabase is refused by the database.
- A login that exists but is not on the team (for example if deleting it failed after a removal) can still join by invite: with its password on the invite page, or by signing in (password or emailed link) and opening the invite again.
- No password reset screen yet: staff without a password use an emailed sign-in link.
- Next parts: onboarding, chargers, live sessions, pricing, reports and settings.

## Checks

```sh
npm run format:check && npm run typecheck && npm run check:migrations && npm test && npm run build
npx playwright install chromium && npm run test:e2e   # offline demo run, desktop and mobile
```

Tests never need credentials or network access: the Ivora API, Supabase and the email provider are replaced by fakes at the HTTP or client boundary, and the migrations run in an in-process Postgres ([PGlite](https://pglite.dev)).

`npm run check:migrations` runs `node ../tools/check-migrations supabase/migrations`, the 10-30 checker shared by this repository's templates. **If you fork only this kit,** copy [`tools/check-migrations`](../tools/check-migrations) into your repository too, next to the kit folder (so `../tools/check-migrations` still resolves), or change the path in `package.json` and the workflow. It needs no install.
