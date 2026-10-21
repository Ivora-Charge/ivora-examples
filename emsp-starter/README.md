# eMSP Starter

> **In progress.** This is part 1 of 13: the scaffold. The server and the driver app have an app shell, a demo mode and brand tokens; the database has its migration baseline. OCPI modules, the mock CPO, payments and the driver flows arrive in later parts.

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
- **App:** on when `EXPO_PUBLIC_API_URL` is empty or `EXPO_PUBLIC_DEMO_MODE=true`. The switch lives in `app/src/lib/config.ts`, and `app/src/lib/api.ts` is the only file that makes requests. A test stubs `fetch` to fail and checks the demo sends nothing.

## Make it yours in 5 minutes

The brand is a neutral **placeholder** (greys, the system font, "Your Charging Network") until the template gets its own design. Every colour, font and size in both packages is a token, so restyling never means editing components.

1. Edit [`server/brand/tokens.json`](server/brand/tokens.json): `name`, `shortName`, the `color` palette, `font` names, sizes, spacing and radii.
2. Run `npm run brand:sync` in `server/`. It copies the file to `app/brand/tokens.json`; CI fails if the two differ.
3. Set the app's display name in [`app/app.json`](app/app.json) (`expo.name`), and its `slug` and `scheme`.
4. For a custom font, set its name in `font`, then load it with `expo-font` in the app and with `@font-face` or `next/font` in the server. `system` means each platform's own UI font.
5. Restart both dev servers and check contrast: text on `background`, `surface` and `demoBackground` should meet WCAG AA.

## Data

Supabase Postgres, migrated with `npm run db:migrate` in `server/` (see its README). Migrations follow the **10-30 rule**: row-level security on every public table, no default grants, and grants to the Data API roles only on tables with a policy. The app never reads the database directly, so tables are service-only. A CI check enforces the rule, and every migration runs in tests on PGlite.

## Parts

1. **Scaffold** (this part): app shells, demo mode, brand tokens, Supabase baseline, CI.
2. to 13. OCPI versions and credentials, locations and tariffs, tokens and real-time authorization, sessions and commands, CDRs, payments, the optional live-data adapter, the driver flows and the admin web. Each part updates this README.

## License

[Apache-2.0](../LICENSE)
