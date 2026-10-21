# CPO Starter Kit

> **In progress.** This is part 4 of the kit: the app shell, demo mode, the Ivora client, the team (staff sign-in and roles on Supabase), onboarding (company details, brand, Stripe status) and chargers (add, test, QR stickers). Sections marked "Coming soon" are filled in by later parts.

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
- **Onboarding and Settings:** a three-step setup wizard (Company, Brand, Payments) and a Settings page with the same forms. See [Onboarding](#onboarding) below.
- **Chargers:** add a charger (site, station and a random connection password), run a connection test and an optional remote start and stop test, print a QR sticker per connector, edit and remove. See [Chargers](#chargers) below.
- **Setup checklist** on the Overview, for owners and managers: company details, brand, Stripe ready, first charger and first price (pricing comes in a later part).
- **Sections:** Live, Pricing and Reports are placeholders marked "Coming soon".

### Onboarding

Owners and managers only: technicians and viewers see a short note instead, and every server action checks the role on the server (and again in the database, in the same statement as the write).

- **Company details:** name (what drivers see), support email, an optional https support URL, an optional https website, time zone (IANA; times are stored in UTC and shown in it) and currency (ISO 4217; money stays in integer minor units). Saved in Supabase (`cpo_company_profiles`).
- **Brand:** a colour (`#rrggbb`) and an optional logo. Saving pushes the name, colour and support contacts to Ivora's driver payment pages with `PUT /branding`, then uploads the logo with `PUT /branding/logo`. The driver pages fill buttons and headings with the colour on white, so a colour below 3:1 against white (for example `#ffff00`, about 1.1:1) goes to them as the lightest darker shade of itself that reaches 3:1; the form shows that shade and its ratio as you type, and the kit keeps your own colour for its theme. The logo is checked in the browser first (type and size, so a large file gets a clear message rather than a generic upload error) and again on the server from its own bytes, with the API's limits: PNG, JPEG or WebP (never SVG), at most 512 KB, 32 to 2048 px a side, not animated. Ivora stores and serves the image; the kit keeps only its URL. If a push fails, the details stay saved, the page says so with the API's error, and **Push to Ivora again** retries. The card form itself is Stripe Checkout, whose look comes from your Stripe account's branding settings.
- **The brand colour themes the kit**, with a contrast check: it replaces the kit's primary colour (buttons, links, focus) only in the modes where links reach 4.5:1 on the page and on cards and button text reaches 4.5:1 on it (WCAG AA). Otherwise that mode keeps the kit's own colour. The form shows the ratios as you type, including the colour against white for the driver pages. The rules are in [`lib/brand-colors.ts`](lib/brand-colors.ts) and `tests/brand-colors.test.ts`.
- **Payments (Stripe via Ivora Checkout):** the kit reads `GET /payment/stripe/v1/tenants/{id}/account` and shows **Not connected** (`none` or `disconnected`), **Pending** (connected, but Stripe can't take charges yet), **Awaiting Ivora approval** (`pending_review`) or **Ready** (`active` with `charges_enabled`), plus Stripe's open requirements, the disabled reason and test or live mode. API keys can't create Stripe onboarding links (the API refuses them), so the kit links to your Ivora dashboard (`IVORA_DASHBOARD_URL`, plus `IVORA_DASHBOARD_STRIPE_PATH` if your dashboard has a deep link to the project's payment settings; without it the link opens the dashboard home) to connect Stripe there, and **Check status again** re-reads it. **The kit stores no Stripe keys.**
- **Idempotency:** a branding push uses `cpo-branding-<operator>-put-<pushes so far>-<content hash>`, and a logo upload `cpo-logo-<operator>-put-<uploads so far>-<image hash>`. A retry of the same push reuses its key; going back to an earlier brand later gets a new key, so it isn't answered with the stored reply to the first push.
- **Demo mode** keeps the demo company in your browser's cookie, never uploads the logo (it is only checked), and has a **Demo: simulate a Stripe status** switch for every state. Nothing is sent to Ivora, Stripe or Supabase.

### Chargers

Everyone on the team sees the chargers; technicians, managers and owners add, test, edit them and print stickers; only managers and owners remove a charger that is registered in Ivora. Every server action checks the role on the server, and the database checks it again in the same statement as the write.

- **List:** every station in your Ivora project, with its site, connectors and online status. Stations added elsewhere (for example with the installer kit) show too; the kit starts its own record for one the first time someone tests it, prints its stickers or edits it.
- **Add:** a connection name (the OCPP identity, 3 to 36 letters, digits, `-` or `_`), an optional display name, 1 to 8 connectors, and an existing site or a new one. The kit saves its own record first, then creates the site (if new) and the station with `external_reference` `cpo-site-<record>` and `cpo-charger-<record>`, and sets a random 24-character password with `PUT /stations/{id}/credentials`. The page then shows the OCPP connection URL, the charge point ID and the password, with copy buttons. **The password is shown once**: it is never stored, logged or shown again (you can set a new one).
- **Uncertain outcomes:** each step has an `Idempotency-Key` derived from the record (`cpo-site-<record>-create`, `cpo-charger-<record>-create`, `cpo-credentials-<record>-set-<n>`). If a step's outcome is unknown (a lost response, `503 outcome_unknown`), the charger stays "Not registered yet" and **Finish adding** repeats the same steps with the same keys; a create that already happened is found by its `external_reference`. If Ivora refuses outright (for example `station_name_taken`), nothing was created, so the record is dropped and you can send the form again.
- **Connected chargers and limits:** an offline station stores the password for its next connection, and a connected OCPP 2.0.1 or 2.1 station receives it. A connected OCPP 1.6 station is refused by Ivora (`station_online`): the kit says to disconnect it first or change the password in the charger's own settings. Ivora limits how often a password can change; a long `Retry-After` is not waited out, and the kit says in how many minutes to try again. `password_unconfirmed` is never retried: set a new password before the charger connects.
- **Connection test:** reads the station and checks it is **online**, has **booted** (sent its BootNotification, so vendor or model is known) and sent a message in the last 5 minutes (**heartbeat**; Ivora asks for a 60-second heartbeat interval). It sends nothing to the charger.
- **Remote start and stop test (optional):** behind a required "I understand this starts the charger" box. It sends `start` on the chosen connector (ID tag `CPO-KIT-TEST`, an operator command that authorizes no payment), follows the session in `GET /transactions`, and `stop` ends it, with keys `cpo-charger-<record>-test-<n>-start` and `-stop`. It passes when the charger accepts both and reports the session; energy (kWh) is 0 without a vehicle.
- **QR stickers:** one per connector, each with a random eight-character code (no 0, O, 1 or I) on your own domain: `<PUBLIC_BASE_URL>/c/<code>`. The code is the kit's own, never a database or Ivora ID, so you can move hosting or replace a charger without reprinting. See [QR codes](#qr-codes-on-your-own-domain). The sticker page prints black on white from the browser.
- **Edit:** the display name (the kit's own) and the site (`PATCH /stations/{id}` with `location_id`, key `cpo-charger-<record>-move-<n>`). The connection name can't change once a charger has connected; add it again under a new name instead.
- **Remove:** asks for confirmation and explains what happens in Ivora. `DELETE /stations/{id}` deletes a station that never charged (disconnecting it first). One with charging history stays in Ivora (`409 station_has_history`), so its sessions stay in your records, and the kit hides it. A running session must be stopped first (`transaction_active`). Either way the kit keeps its record, marked removed, so the charger's stickers say "not in service" instead of pointing at something else.
- **Demo mode** simulates everything in your browser's cookies: a new charger "connects" two seconds after its password is set and "boots" a moment later, test sessions run at 7.4 kW, and the sample chargers behave like connected OCPP 1.6 chargers (their password can't be changed remotely). Demo stickers use the demo's own address and say "Demo, not for printing". Nothing is sent to Ivora or a charger.

### QR codes on your own domain

Stickers stay on a wall for years, so their QR codes point at your own domain, read from `PUBLIC_BASE_URL` (or `APP_URL` if that is not set; never the hosting provider's default URL). Live mode refuses to show printable stickers until it is a stable `https://` origin of your own, and refuses:

- Ivora domains (`ivoracharge.com`, `ivoracharge.co` and their subdomains),
- hosting providers' default domains such as `*.vercel.app`, and link shorteners,
- `http://`, `localhost`, IP addresses, and a URL with a path, query or credentials,
- any preview deployment (`VERCEL_ENV=preview`): its codes would not exist in production.

`/c/<code>` is public (drivers are not staff) and shows the operator, the charger and the connector, or "not in service" for a removed charger. It is a placeholder for now: the driver payment flow comes with a later part, and stickers keep working because only this page decides where a code goes.

### Roles

| Role       | May                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| Owner      | Everything, including inviting, promoting and removing owners.                                           |
| Manager    | Company details, brand and payments; remove chargers; invite, change and remove technicians and viewers. |
| Technician | Add, test and edit chargers and print stickers. Cannot remove a registered charger or change the team.   |
| Viewer     | Read the overview, chargers and reports. Cannot change anything.                                         |

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

| Variable                      | Purpose                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IVORA_API_KEY`               | Tenant-scoped Ivora API key. Server-side only. Required for live mode.                                                                                                                                                 |
| `IVORA_TENANT_ID`             | Numeric tenant (project) ID, part of every API path. Required for live mode.                                                                                                                                           |
| `IVORA_API_BASE_URL`          | Optional; defaults to `https://api.ivoracharge.com`. An empty value counts as unset.                                                                                                                                   |
| `OPERATOR_NAME`               | Your business name, shown in the header, page titles and emails (default "Your charging network").                                                                                                                     |
| `DEMO_MODE`                   | Set to `true` to force demo mode even when credentials are set (for example on a public demo instance).                                                                                                                |
| `IVORA_DASHBOARD_URL`         | Optional; your Ivora dashboard, where Stripe is connected. Defaults to `https://platform.ivoracharge.com`.                                                                                                             |
| `IVORA_DASHBOARD_STRIPE_PATH` | Optional; a path on that dashboard that opens the project's payment settings, if it has one, for example `/projects/{tenant_id}/settings` (`{tenant_id}` is filled in). Without it, the link opens the dashboard home. |
| `PUBLIC_BASE_URL`             | Optional; the origin printed in QR stickers, e.g. `https://charge.example.com`. Defaults to `APP_URL`. Must be your own stable https domain.                                                                           |
| `SUPABASE_URL`                | Your Supabase project URL. Required for live mode.                                                                                                                                                                     |
| `SUPABASE_ANON_KEY`           | The project's anon (or publishable) key. Used on the server only, with RLS. Required for live mode.                                                                                                                    |
| `SUPABASE_SERVICE_ROLE_KEY`   | Service role key, for writes the server has already authorized. Server-only. Required for live mode.                                                                                                                   |
| `SUPABASE_DB_URL`             | Postgres connection string, used only by `npm run db:migrate`.                                                                                                                                                         |
| `SETUP_SECRET`                | One-time secret that unlocks the setup screen for the first owner. At least 32 characters, or setup stays off.                                                                                                         |
| `APP_URL`                     | Public origin for invite and sign-in links, e.g. `https://ops.example.com`. Defaults to the Vercel URL.                                                                                                                |
| `TRUSTED_PROXY_HEADER`        | Optional, off Vercel: the header your proxy sets to the client address. See [Security](#security).                                                                                                                     |
| `RESEND_API_KEY`              | Optional. Sends invite and sign-in emails through Resend. Without it, see [Email](#email).                                                                                                                             |
| `EMAIL_FROM`                  | Sender for those emails, for example `Team <team@example.com>`. Needed with `RESEND_API_KEY`.                                                                                                                          |

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
- **Database (the 10-30 rule):** RLS is on for every table, and every migration revokes all privileges from `anon` and `authenticated` (older Supabase projects grant them everything by default). Only `cpo_operators` and `cpo_staff` are read through the Data API with the staff member's own session, so only they get column-level `SELECT` for `authenticated`, matching RLS policies that show a staff member their own operator and team only. `anon` reads nothing. Invites, rate limits, the company profile (`cpo_company_profiles`), charger records and sticker codes (`cpo_chargers`, `cpo_sticker_codes`) and the migration ledger are service-role only, and invites store a SHA-256 of their token, never the token. Every function revokes `EXECUTE` from `public`, `anon` and `authenticated`; only `cpo_my_operator_ids`, which the RLS policies call, is granted back to `authenticated`. `npm run check:migrations` (run in CI) runs the repository's shared checker, [`tools/check-migrations`](../tools/check-migrations/README.md), on `supabase/migrations`. PGlite tests in `tests/database.test.ts` run the migrations with Supabase's default privileges on tables and functions and check the policies and grants; `tests/concurrency.test.ts` runs concurrent role changes against a real Postgres when `TEST_DATABASE_URL` points at a local throwaway server (CI starts one).
- **Rate limits:** password sign-in (30 per source and 10 per account per 10 minutes), sign-in links (10 per source per 10 minutes, 1 per address per minute), setup (10 per source per 10 minutes), invite acceptance, and invites (20 per inviter and 3 per recipient per hour). Quotas are shared by all server instances through the database, keyed by HMAC digests, never plain addresses, and long-expired windows are purged as it goes. Per-source quotas need a client address callers can't fake: on Vercel, Vercel's own header; elsewhere, set `TRUSTED_PROXY_HEADER` to the header your proxy or CDN sets (for example `cf-connecting-ip`, or `x-forwarded-for` from a proxy that appends to it; the kit takes its last entry). Without one, per-source quotas are skipped rather than shared, so one client can't lock everyone out, and the per-account quotas still apply. Setup has no account to limit, so there it falls back to one quota shared by every caller (10 tries per 10 minutes): guessing the setup secret stays slow, and at worst setup has to wait a few minutes. A sign-in link request gets the same answer for any address, including an invitee who has no login yet (they join with their invite link).
- **Logs:** never passwords, tokens or email addresses; record IDs and error codes only.
- **Demo mode in one place:** `getIvora()` in `lib/server/ivora/index.ts`, `getTeam()` in `lib/server/team/index.ts` and `getChargers()` in `lib/server/chargers/index.ts` return demo implementations whenever demo mode is on, and the live Ivora and Supabase clients also refuse to run while demo mode is on. Tests stub `fetch` to fail and run every Ivora method and every team flow in demo mode.
- **Idempotency:** every Ivora write sends an `Idempotency-Key` derived from our own record and action (`idempotencyKey("location", id, "create")` gives `cpo-location-<id>-create`). The client refuses a write without one.
- **Retries:** `409 request_in_progress`, `503 outcome_unknown`, a lost connection and gateway errors are retried with the same key and body, with backoff. `429` waits for `Retry-After` (seconds or a date). One call takes at most 20 seconds in total, tries and waits together (each try times out within what is left), so a request stays inside a serverless time limit; a wait or try past it is not started, and the last error goes back to the caller with its `Retry-After`. The Overview's paged lists share one such budget and show what they read so far, marked as partial. Other `4xx` errors, including `401`, are never retried.
- **Duplicates:** a create that may already have happened (`external_reference_taken`, or `request_in_progress` / `outcome_unknown` after the last retry) is looked up by our `external_reference`.
- **Errors:** API errors show their code, the request ID and a link to [Errors and statuses](https://ivoracharge.com/developers/guides/reference/errors). Logs carry the code and request ID only.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIvora-Charge%2Fivora-examples&root-directory=cpo-starter-kit&project-name=cpo-starter-kit&repository-name=cpo-starter-kit)

The button deploys the kit in demo mode. To go live, set up Supabase as above, add the variables in Vercel Project Settings → Environment Variables, redeploy, and create the first owner at `/setup`. Point your own domain at the deployment (and set `APP_URL` to it) before inviting staff or printing any QR codes.

## What it uses from the Ivora API

All paths are under `/v1/tenants/{tenant_id}` (except the Stripe account, under `/payment/stripe/v1/tenants/{tenant_id}`) and follow the [published OpenAPI](https://api.ivoracharge.com/openapi.json) and the [developer guides](https://ivoracharge.com/developers/guides).

| Module     | Use                        | Endpoint                                                                                                                        | Permission                         |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Overview   | Sites (every page)         | `GET /locations`                                                                                                                | `stations:read`                    |
| Overview   | Chargers and connectors    | `GET /stations`, `GET /stations/{station_id}`                                                                                   | `stations:read`                    |
| Overview   | Recent and active sessions | `GET /transactions`                                                                                                             | `billing:read`                     |
| Chargers   | Sites                      | `GET /locations`, `POST /locations` (with `Idempotency-Key`)                                                                    | `stations:read`, `stations:write`  |
| Chargers   | Register a charger         | `POST /stations`, `GET /stations?external_reference=` (with `Idempotency-Key`)                                                  | `stations:write`                   |
| Chargers   | Connection password        | `PUT /stations/{station_id}/credentials`, `GET /operations/{operation_id}`                                                      | `stations:write`                   |
| Chargers   | Connection test            | `GET /stations/{station_id}` (reads only)                                                                                       | `stations:read`                    |
| Chargers   | Remote start and stop test | `POST /stations/{station_id}/commands` (`start`, `stop`), `GET /transactions?station_id=`, `GET /transactions/{transaction_id}` | `stations:control`, `billing:read` |
| Chargers   | Move to another site       | `PATCH /stations/{station_id}` (with `Idempotency-Key`)                                                                         | `stations:write`                   |
| Chargers   | Remove                     | `DELETE /stations/{station_id}` (with `Idempotency-Key`)                                                                        | `stations:write`                   |
| Team       | None                       | Staff and roles live in Supabase                                                                                                | None                               |
| Onboarding | Driver-page branding       | `PUT /branding` (with `Idempotency-Key`)                                                                                        | `stations:write`                   |
| Onboarding | Logo                       | `PUT /branding/logo` (raw image, with `Idempotency-Key`)                                                                        | `stations:write`                   |
| Onboarding | Stripe account status      | `GET /payment/stripe/v1/tenants/{tenant_id}/account` (not under `/v1/…`)                                                        | `billing:read`                     |

So the kit's key needs `stations:read`, `stations:write`, `stations:control` (the remote test only) and `billing:read`. Connecting or disconnecting Stripe needs a signed-in project admin in the Ivora dashboard; API keys are refused. Later parts add their endpoints and permissions to this table.

## Limits and next steps

- The Overview follows the API's `next_cursor` pagination up to 20 pages (2,000 sites and 2,000 chargers), or 20 seconds, and says so when there are more; it shows the latest 50 sessions.
- One staff login belongs to one operator. Removing someone also deletes their login. Deleting the last owner's login in Supabase is refused by the database.
- A login that exists but is not on the team (for example if deleting it failed after a removal) can still join by invite: with its password on the invite page, or by signing in (password or emailed link) and opening the invite again.
- No password reset screen yet: staff without a password use an emailed sign-in link.
- Onboarding does not read back branding that someone changed directly in Ivora: the kit pushes what it has saved, and **Push to Ivora again** overwrites the driver pages with it.
- The time zone and currency are saved now and used by later parts (pricing, reports).
- Chargers: the connection test reads Ivora's view of the station; it does not ask the charger for a fresh heartbeat. The remote test needs `stations:control`; without it the rest of the module still works. Renaming a charger's connection name, EVSE and connector edits and charger configuration are not in the kit (use the Ivora dashboard). Sticker codes are created per connector Ivora reports; add codes for new connectors from the charger's page.
- `/c/<code>` is a placeholder until the driver payment flow lands.
- Next parts: live sessions, pricing and reports.

## Checks

```sh
npm run format:check && npm run typecheck && npm run check:migrations && npm test && npm run build
npx playwright install chromium && npm run test:e2e   # offline demo run, desktop and mobile
```

Tests never need credentials or network access: the Ivora API, Supabase and the email provider are replaced by fakes at the HTTP or client boundary, and the migrations run in an in-process Postgres ([PGlite](https://pglite.dev)).

`npm run check:migrations` runs `node ../tools/check-migrations supabase/migrations`, the 10-30 checker shared by this repository's templates. **If you fork only this kit,** copy [`tools/check-migrations`](../tools/check-migrations) into your repository too, next to the kit folder (so `../tools/check-migrations` still resolves), or change the path in `package.json` and the workflow. It needs no install.
