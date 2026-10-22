# eMSP Starter: driver app (Kilolane)

> **In progress** (part 10 of 13). See the [template README](../README.md) for what the eMSP Starter is and how the server and the app fit together.

The driver app of the eMSP Starter, built with Expo and expo-router: iOS, Android and a web build from one codebase. It talks only to your eMSP Starter server's API; it holds no keys and never reads the database. Its brand, **Kilolane**, comes from the [design brief](../docs/brief/BRIEF.md) and lives in `brand/tokens.json`.

| Phone, light                                                             | Phone, dark                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| ![Map and list of chargers on a phone, light mode](docs/phone-light.png) | ![Map and list of chargers on a phone, dark mode](docs/phone-dark.png) |

![Desktop, light mode: list panel, map, and a charger's detail card](docs/desktop-light.png)
![Desktop, dark mode: list panel, map, and a charger's detail card](docs/desktop-dark.png)

## What it does today

- **Shell:** four tabs (Map, Charging, Wallet, Account), at the bottom on phones and in a rail on wide screens. Charging and Wallet say what arrives in later parts.
- **Map first:** a map of chargers with clusters, and the same places in a list. On phones the list, search and filters sit in a bottom sheet in thumb reach (drag the handle, or tap it); on wide screens they sit in a panel beside the map.
- **Search:** one box for a place, a charger's reference (for example `A1`) or an EVSE ID (for example `ZZ*MCK*E11`; separators and case do not matter). **Filters:** open now, available, minimum power (22, 50, 150 kW), connector (CCS, Type 2, CHAdeMO), step-free access, and no fee or paid. "Show chargers near me" sorts by distance.
- **Charger page:** connectors with their EVSE IDs and status, the price from the CPO's tariff (with VAT when the CPO gives the rate, and every other component and condition), opening hours with "open now", directions in the device's maps app, and **Charge here** (sign in first; starting a charge arrives in the next part).
- **Passwordless sign-in** with the server's email code ([server README](../server/README.md#driver-accounts-and-sign-in)): the same answer for every address, so the app never tells who has an account; rate limits are the server's, and a `429` shows how long to wait. Sessions are kept in the keychain or keystore on phones and in `sessionStorage` on the web.
- **Light and dark mode**, following the device.
- **Demo strip:** on every screen while the app runs its offline demo or the server reports demo mode. It cannot be dismissed and wraps on narrow screens.

## Accessibility

- Every control has a screen-reader label and role; filter chips are checkboxes, tabs are tabs, a charger in the list or on the map is read as one sentence ("Station Square. 1 of 2 free. Up to 150 kW. €0.7139 per kWh. 400 m").
- Status is never colour alone: free is a filled tile and dot, in use an outlined tile and half dot, out of order a hatched tile and a cross, unknown a dashed outline, and the word is always printed.
- Text follows the driver's text size: Dynamic Type and font scale on phones, rem on the web (browser font size and zoom). Status tiles grow with it. No text is under 12 px.
- Text pairs meet WCAG AA (4.5:1) in both modes, and the focus ring is at least 3:1 against everything it touches (ink in light mode, flare in dark). `tests/brand.test.ts` checks every pair.
- Tap targets are 44 px or more; the search field and the primary button are 56 to 60 px. No sideways scroll at 390 px (only the chip row scrolls, inside itself).

## Languages and formats

Every string is in `src/i18n/en.json`. Numbers, prices, distances, times and weekdays are formatted for the device's locale (`Intl`), so a German phone sees `0,7139 €` and `2,4 km` even before there are German strings. To add a language, copy `en.json` to `<language>.json`, translate the values and list it in `src/i18n/index.ts`; English fills any key it lacks. Plurals use `_one` / `_other` keys (and `_few`, `_many` where a language needs them).

Two kinds of text still come from the server in English: a tariff's conditions (for example "Mon–Fri, 07:00–21:00") and the CPO's own price description.

## Run locally

Requires Node.js 22.13 or later.

```sh
npm ci
npm run web       # in a browser
npm run dev       # Expo dev server; press i or a for a simulator (development build, see below)
```

With no `EXPO_PUBLIC_API_URL` the app runs its **offline demo**: the mock CPO's sample chargers (made by the server's own code; `npm run app:demo-data` in `server/` refreshes them), sign-in with the code `000000`, and no request to any server. "Near me" puts you beside the sample chargers instead of asking for your location. The map's tiles are the one thing it loads from outside the device (public map data from OpenFreeMap, below).

The map needs MapLibre Native on iOS and Android, so the native app runs as a [development build](https://docs.expo.dev/develop/development-builds/introduction/) (`npx expo run:ios`, `npx expo run:android`, or EAS Build), not in Expo Go.

## Connect to your server

Copy `.env.example` to `.env.local`.

| Variable                         | Purpose                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_API_URL`            | Origin of your eMSP Starter server, for example `http://localhost:3000`. Empty: offline demo.              |
| `EXPO_PUBLIC_DEMO_MODE`          | Set to `true` (or `1`, `yes`, `on`) to force the offline demo even when the URL is set.                    |
| `EXPO_PUBLIC_MAP_STYLE_URL`      | Optional. Your map provider's style JSON URL (see "Map" below). Empty: the app's own style on OpenFreeMap. |
| `EXPO_PUBLIC_MAP_STYLE_URL_DARK` | Optional. A dark style for dark mode. Default: the same style.                                             |
| `EXPO_PUBLIC_MAP_ATTRIBUTION`    | Optional. The attribution your provider requires, shown on the map.                                        |

`EXPO_PUBLIC_` values are built into the app and readable by anyone who has it. Never put a secret in one; secrets stay on the server. For the web build, add its origin to the server's `APP_ORIGINS` so the browser may read sign-in answers.

## Map

MapLibre everywhere: [MapLibre GL JS](https://maplibre.org/) on the web (through `react-map-gl`) and [MapLibre Native](https://github.com/maplibre/maplibre-react-native) on iOS and Android. One style JSON works on all three, and the chargers, clusters and your position are the app's own markers.

**Demo and default: no key, no account, no cost.** The app draws its own style (`src/lib/map-style.ts`), coloured from the `map*` brand tokens in light and dark, on [OpenFreeMap](https://openfreemap.org/)'s vector tiles of OpenStreetMap data. The attribution "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors" stays visible on the map, above the sheet and the tab bar. OpenFreeMap is free and asks for no key, but it is a volunteer-run service with no uptime guarantee; read its terms before you rely on it in production.

**Production.** For an SLA, use a commercial provider (for example MapTiler, Stadia Maps or Protomaps on your own hosting) and set `EXPO_PUBLIC_MAP_STYLE_URL` to its style JSON. The key then sits in the app, where anyone can read it, so restrict it at the provider:

| Platform | Key requirement                                                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web      | A public key restricted to your site's domains (HTTP referrer / allowed origins).                                                                               |
| iOS      | A key restricted to your bundle identifier, where the provider supports it; otherwise a separate key per app you can rotate. MapLibre Native sends no referrer. |
| Android  | A key restricted to your package name and signing certificate, where the provider supports it; otherwise a separate key per app you can rotate.                 |

Usually that means one key per platform, each with its own usage limits. Keep the provider's attribution in `EXPO_PUBLIC_MAP_ATTRIBUTION`. `EXPO_PUBLIC_MAP_STYLE_URL=none` draws no tiles at all, only the chargers on a plain background.

On the web, MapLibre runs its tile work in a Web Worker from its own file; `npm ci` (and `npm run build`) copy it to `public/maplibre-gl-worker.mjs`.

## Deploy

- **Web:** `npm run build` writes a static single-page site to `dist/`. Host it anywhere that serves static files, with a rewrite of unknown paths to `/index.html` so links such as `/account` open the app.
- **iOS and Android:** build with [EAS Build](https://docs.expo.dev/build/introduction/) from your own Expo account. CI makes no native store builds.

## Limits and next steps

- Starting and stopping a charge, the Charging tab, cards and receipts arrive in parts 11 to 13.
- Search finds places by the words of their name, street, postcode and city. Searching any address (geocoding) needs a geocoder service and is not included.
- RFID cards still cannot charge (owner decision): the app is the only way to charge.

## Checks

```sh
npm run format:check && npm run typecheck && npm test && npm run build
npx playwright install chromium && npm run test:e2e        # serves dist/ offline, desktop 1440 px and phone 390 px
SCREENSHOT=1 npm run test:e2e -- screenshots              # redraws docs/*.png (needs the network for map tiles)
```

Tests never need credentials. The e2e tests block the map tiles, so they need no network either.
