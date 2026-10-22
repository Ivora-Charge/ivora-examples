# SQD-46 brief: eMSP Starter brand (driver app and admin web)

This is the brief stage only. No app or server code changes here. The mock is a static page (`mock.html`), and the screenshots sit next to it. The identity covers the driver app (this part, 10/13) and the admin web (SQD-44 follows it). Building the app starts after the owner approves this brief.

## Name

Lead: **Plugroam** (plug + roam). Roaming is what an eMSP does: one app and one account, charging on any CPO's network over OCPI. It is a coined name, and lowercase in the wordmark. Renaming it means editing `name` and `shortName` in `server/brand/tokens.json`, then running `npm run brand:sync`.
Alternates: **Wattaway**, **Kilolane**.
No trademark or collision search has been done, so the release manager's quick check is still needed.

## Mood and audience

Mood: **sure, bright and roadside**. It is a wayfinding sign rather than a dashboard.
The main users are drivers on the move, often using one hand and glancing at the phone at arm's length, in full sun or at night. The answer they need comes first, big and in plain words: "150 kW, 2 of 3 free, €0.71 per kWh, 0.4 km". The admin web uses the same tokens in a denser layout for an operations back office: no hero headline, tables instead of cards, and the same status shapes.

The look is deliberately unlike existing charging apps. The brand colour is violet rather than the usual EV green, blue or orange, a sodium-lamp yellow ("flare") marks you, your selection and demo mode, and a charger is a square power tile rather than a teardrop pin.

## Palette (11 tokens, plus derived hairlines)

| Token      | Light     | Dark      | Use                                                 |
| ---------- | --------- | --------- | --------------------------------------------------- |
| `bg`       | `#F3F0E8` | `#0F0D1E` | Page (warm paper, low glare in sun / night indigo)  |
| `surface`  | `#FFFFFF` | `#1B1833` | Cards, sheet, detail                                |
| `ink`      | `#16132E` | `#F2EFFF` | Text, outlines of inputs and secondary buttons      |
| `muted`    | `#57536F` | `#AAA5C8` | Secondary text, labels                              |
| `accent`   | `#4B2ED3` | `#A597FF` | Brand violet: primary action, clusters, you, active |
| `onAccent` | `#FFFFFF` | `#160F3A` | Text on accent                                      |
| `flare`    | `#FFC83D` | `#FFC83D` | Demo strip, selected charger ring, focus ring       |
| `onFlare`  | `#16132E` | `#16132E` | Text on flare                                       |
| `free`     | `#0B6B4C` | `#5AD3A2` | Available                                           |
| `busy`     | `#8A5300` | `#FFB347` | In use / partly available                           |
| `down`     | `#B4261F` | `#FF8A7E` | Out of order, errors                                |

`onStatus` (text on a filled `free` tile) is `#FFFFFF` / `#0F0D1E`. Lines are `ink` at 14% alpha and tints are `accent` at 9%, not separate colours. `flare` is never used as text on `bg` or `surface` (1.4:1 in light). It only ever fills a shape, with `onFlare` text, or rings one.

Status is never colour alone, because the tile shape and a glyph carry it too:

- **Free:** a filled tile and a filled dot.
- **In use:** an outlined tile and a half-filled dot.
- **Out of order:** a hatched, outlined tile and a cross.
- **Unknown:** a dashed outline.

The status word is always printed next to the glyph.

These are the AA pairs the brand unit test will check. All are at least 4.5:1 (WCAG 2.x, measured), shown as light / dark:

- ink on bg: 15.8 / 16.9
- ink on surface: 18.0 / 15.2
- muted on bg: 6.4 / 8.1
- muted on surface: 7.3 / 7.3
- accent on bg: 7.0 / 7.7
- accent on surface: 8.0 / 6.9
- onAccent on accent: 8.0 / 7.3
- onFlare on flare: 11.6 / 11.6
- free on bg: 5.7 / 10.3
- free on surface: 6.5 / 9.2
- busy on bg: 5.6 / 10.8
- busy on surface: 6.3 / 9.6
- down on bg: 5.7 / 8.4
- down on surface: 6.5 / 7.5

## Type (SIL OFL 1.1, bundled with the app via `expo-font`, `next/font/local` in the admin web)

- **Bricolage Grotesque** 800 is for the wordmark, headlines, place names in the detail view, the kW figure on every power tile, the big price and the primary button. Its tight, slightly quirky letterforms carry the brand.
- **Instrument Sans** 400 / 600 is for body text, controls, lists and labels. Numbers use tabular figures, so prices and distances line up.
- **DM Mono** 500 is only for EVSE IDs and other identifiers. Its slashed zero tells `0` from `O` when a driver types an ID from a charger's sticker.

The scale is set in rem from a 16 px base, so dynamic type and browser zoom scale everything:

- 12 px: labels.
- 14 px: secondary text.
- 16 to 17 px: body and list titles.
- 22 px: tile kW.
- 34 to 40 px: headlines and the big price.

Tap targets are at least 44 px. The primary action and the search field are 56 to 60 px.

## Layout idea

**Map first, thumb first.**

- **Phone:**
  - The map fills the screen, with the wordmark pill and a "locate me" button floating on top.
  - A bottom sheet (peek, half and full) holds the search field, which sits in the thumb zone and not at the top. Below it are a single scrolling row of filter chips (open now, available, power, connector, step-free, no fee) and the results list.
  - A four-tab bar sits under the sheet: Map, Charging, Wallet and Account.
  - Choosing a charger opens its detail as the full sheet, with **Charge here** at the bottom edge.
- **Desktop:**
  - A 440 px "roadbook" panel on the left holds the greeting headline, the search, the wrapped chips and the list.
  - The map takes the rest of the width.
  - The charger detail floats as a card on the right. It has a violet header, the price from the tariff, the connectors with EVSE IDs and status, opening hours, and **Directions** and **Charge here**.
- **Both:** every charger is a rounded-square **power tile** showing its maximum kW, in the list and on the map. Clusters are violet discs with a count, and you are a violet dot. The selected charger gets a flare ring. Surfaces are flat, with a soft two-layer shadow only on floating things (pins, sheet, detail). Inputs and secondary buttons have a 2 px `ink` outline.

**Demo mode** is a full-width flare strip, "DEMO: Sample chargers from a built-in test network. Nothing charges, no card is charged." It sits on every screen and cannot be dismissed.

## Mark concept

The original mark (`logo.svg`) is a map pin tilted 12° (on the move), with the two prongs of a plug cut out of it and a flare dot at its foot (you, arriving). The pin uses `--accent` and the dot uses `--flare`, and both fall back to `currentColor`, so the mark prints in one colour. At small sizes, such as the app icon or favicon, the dot can be dropped.

## Map (for the build stage)

- **Library:** MapLibre (`react-map-gl/maplibre` on the web, `@maplibre/maplibre-react-native` on iOS and Android). It is open source, and the same style JSON works on every platform.
- **Demo mode** needs no key and no paid service: a keyless vector style (a public OpenFreeMap or MapLibre demo style), with "© OpenStreetMap contributors" attribution always visible. The map's colours are restyled from the tokens above.
- **Production:** you set the style URL and key per platform from env. The README for part 10 will cover the key requirements for each platform and the tile provider's usage policy.

## Mocks

`mock.html` shows the main screen in demo mode: the demo strip, search, filters, the list of the mock CPO's sample places, the map with power tiles, a cluster and your position, and on desktop the Station Square detail. The screenshots are in this folder:

- `desktop-light.png` and `desktop-dark.png` at 1440 × 900.
- `phone-light.png` and `phone-dark.png` at 390 × 844.

`scrollWidth` equals the viewport width in all four, so there is no sideways scroll. On the phone, only the chip row scrolls sideways, inside its own container. Prices are the mock CPO's sample tariffs including 21% VAT. Distances and counts are invented for the mock, and the map is a hand-drawn SVG, not real tiles. The fonts the mock uses are in `fonts/`, with their OFL licence texts.
