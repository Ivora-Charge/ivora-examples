# eMSP Starter

> **In progress.** Parts 1 to 10 of 13 are in. The driver app, **Kilolane**, finds chargers on a map and in a list (search by place, charger or EVSE ID, filters, clusters), shows each charger's connectors, status, price from the tariff, opening hours and directions, and signs drivers in without a password; it is accessible, in light and dark mode, and every string is in a locale file. The server speaks the OCPI 2.2.1 versions and credentials modules with any number of CPO peers, in both directions, pulls and receives every peer's locations and tariffs, serves a location search with display prices for the app, issues drivers' app tokens and RFID cards (cards cannot charge until RFID billing lands), pushes them to every CPO and answers real-time authorization, sends START_SESSION and STOP_SESSION commands (after a payment hold, one per app request) and takes their results, and receives and pulls sessions and CDRs, linked to the driver's charge request, with reconciliation data per peer and day. Drivers sign in without a password, save cards on the network's own Stripe account, and pay from each session's CDR (a card hold before the start, capture up to the hold, refunds, admin review, email receipts). An admin web, for admins only, shows CPO peers with each module's last pull and error, live and recent sessions, refunds with a reason and an audit log, CDR reconciliation per peer with a CSV, and blocks drivers and tokens; every error shows its OCPI code and a next step. All of it is tested against a built-in mock CPO and a mock Stripe. Charging from the app, history and payments in the app arrive in parts 11 to 13.

For charging networks that want to run **their own driver app and payments**, connected over **OCPI 2.2.1** to any CPO platform. You run the eMSP (e-Mobility Service Provider) side: drivers, tokens, sessions, CDRs and payments. Each CPO you partner with is an OCPI peer. Ivora is one possible CPO peer among many; nothing here depends on it.

| Folder               | What it is                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`server/`](server/) | Next.js App Router, TypeScript. The OCPI eMSP endpoints, the REST API the app uses, the admin web, and the Supabase migrations.    |
| [`app/`](app/)       | Expo / React Native with expo-router. The driver app for iOS, Android and the web, from one codebase. It talks only to the server. |

## Why two packages

Every other template in this repository is a single Next.js app. A driver app has to ship to phones, so this template breaks that convention: the app is an Expo project next to the Next.js server. Each has its own `package.json`, lockfile, `README.md` and `.env.example`, and they share no code. One workflow, [`.github/workflows/emsp-starter.yml`](../.github/workflows/emsp-starter.yml), checks both: format, typecheck, unit tests and build (Next build for the server, `expo export` for the app's web build), then Playwright against the admin web and the app's web build. CI makes no native store builds.

## Run locally

Requires Node.js 22.13 or later. In two terminals:

```sh
cd server && npm ci && npm run dev    # http://localhost:3000, admin web and API
cd app && npm ci && npm run web       # the driver app in a browser
```

Both start in **demo mode** with no credentials, and say so in a "Demo" banner on every screen. The app runs offline on its own sample data until you point it at the server with `EXPO_PUBLIC_API_URL=http://localhost:3000` in `app/.env.local`; then it shows whatever mode the server is in.

## Demo mode

- **Server:** on whenever a live-mode variable is missing or invalid, or `DEMO_MODE=true`. The switch lives in one file, `server/lib/server/demo.ts`. Every outbound request must go through its `outboundFetch`, which refuses in demo mode, and a test fails if any other server file calls `fetch`. Demo mode never charges a card, never sends a command or request to a real CPO, and never sends email or push notifications.
- **App:** on when `EXPO_PUBLIC_API_URL` is empty or `EXPO_PUBLIC_DEMO_MODE=true`. The switch lives in `app/src/lib/config.ts`, and `app/src/lib/api.ts` is the only file that makes requests. A test stubs `fetch` to fail and checks the demo sends nothing. The only thing the app loads from outside the device is public map tiles (OpenFreeMap by default, no key); the e2e tests block them and check nothing else leaves.

## Make it yours in 5 minutes

The template ships with its own brand, **Kilolane** (see the [design brief](docs/brief/BRIEF.md)): violet, a sodium-yellow "flare", warm paper by day and indigo by night, square power tiles. It is meant to be replaced. Every colour, font and size in both packages is a token, so restyling never means editing components.

1. Edit [`server/brand/tokens.json`](server/brand/tokens.json): `name`, `shortName`, the `color` (light) and `colorDark` palettes with the same keys (including the `map*` colours of the app's map), `font` names, sizes, spacing and radii.
2. Run `npm run brand:sync` in `server/`. It copies the file to `app/brand/tokens.json`; CI fails if the two differ.
3. Set the app's display name in [`app/app.json`](app/app.json) (`expo.name`), and its `slug` and `scheme`. Replace the mark in `app/src/components/Logo.tsx` (and `docs/brief/logo.svg`).
4. For other fonts, set their names in `font` and import their files in `app/src/fonts.ts` (the app bundles them with `expo-font`); the admin web falls back to the system font unless you add `@font-face` or `next/font`.
5. Run `npm test` in `app/`: it checks every text pair for WCAG AA (4.5:1) and the focus ring for 3:1, in light and dark mode, and fails on a colour that does not pass.

## Data

Supabase Postgres, migrated with `npm run db:migrate` in `server/` (see its README). Migrations follow the **10-30 rule**: row-level security and an explicit revoke on every public table, no default grants, grants to the Data API roles only on tables with a policy, and no public function executable by those roles. The app never reads the database directly, so tables are service-only. The repository's shared checker, [`tools/check-migrations`](../tools/check-migrations/README.md), enforces the rule in CI, and every migration runs in tests on PGlite. A fork of this template alone copies `tools/check-migrations` next to it.

## Parts

1. **Scaffold**: app shells, demo mode, brand tokens, Supabase baseline, CI.
2. **OCPI core**: versions and credentials in both directions, multiple CPO peers with token rotation, the OCPI client and server middleware, the mock CPO.
3. **Locations and tariffs**: pull (full, then incremental, resumable) and push, stored per peer; the search API; display prices and a price preview.
4. **Tokens**: APP_USER tokens with eMA contract IDs and RFID cards, the Tokens Sender (paginated), pushes to every CPO's Tokens Receiver with retries, block and unblock, and real-time authorization.
5. **Commands**: START_SESSION and STOP_SESSION with the CommandResponse and the asynchronous CommandResult, one command per app request, a payment-hold hook before every start, and a clear state for chargers that refuse app starts.
6. **Sessions and CDRs**: received (PUT, PATCH in any order, CDR POST) and pulled from CPOs that only offer GET, CDRs kept as immutable records, linked to the driver's start command and token, internal events, and reconciliation data per peer and day.
7. **Accounts and payments**: passwordless sign-in for drivers and admins (Supabase Auth) with an admin role table; saved cards on the network's own Stripe account; a card hold before every start, captured from the start's own CDR (never above the hold), released when nothing charged; refunds; admin review for every case the rules cannot settle; optional incremental authorization; email receipts (Resend); a signed Stripe webhook. **Money and auth: the owner merges.**
8. **Admin web**: CPO peers (status, last pull and error per module, register, unregister, rotate tokens), sessions (live and recent, by peer, status and driver), refunds (partial or full, with a reason and an audit log), CDR reconciliation per peer (sessions vs CDRs vs captured amounts, mismatches, CSV, flagged payments), drivers and tokens (block and unblock). Every error shows its OCPI code and a next step. **Refunds move money: the owner merges.**
9. **Live-data adapter**: a pluggable, read-only adapter per CPO peer for what OCPI lacks (state of charge, power). The null adapter is the default; an Ivora API adapter is included, configured per peer with a read-only key. The app shows SoC when an adapter returns it and hides it otherwise. See [the server README](server/README.md#live-data-state-of-charge), which also explains how to write an adapter for another CPO.
10. **Driver app 1** (Kilolane): the app shell with four tabs, passwordless sign-in, the map (MapLibre, keyless OpenFreeMap tiles by default) and list of chargers with clusters, search by place, charger or EVSE ID, filters, the charger page, light and dark mode, i18n and accessibility. See the [app README](app/README.md).
11. to 13. The driver's charging flows, and an **end-to-end suite**: the whole OCPI path from handshake, locations and tariffs, token push and real-time authorization, through START_SESSION, STOP_SESSION, session updates and the CDR, to capture and refund in Stripe test mode. CI runs the suite against the mock CPO. You can run the same suite against any CPO's sandbox (never in public CI), with a switch for CPOs that disable remote start; see [End-to-end tests against a CPO](server/README.md#end-to-end-tests-against-a-cpo). Each part updates this README.

## License

[Apache-2.0](../LICENSE)
