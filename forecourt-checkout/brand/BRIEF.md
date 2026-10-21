# SQD-30 brief: forecourt-checkout brand

## Name

**Kerbly** (the kerb is where you pull up at a stop). Coined; a rename is one line in `brand/brand.ts` once built.
Alternates: **Tallybay**, **Fillbay**.
Name searches for EV, charging and fuel-retail companies were not exhaustive (no trademark search done); a collision check is needed before the full build.

## Mood, users

Mood: **bright, bold, brisk**.
Drivers at a fuel or convenience stop, on a phone, in bright sun, in a hurry. Cashiers and staff read across a counter on a tablet or desktop. Tone is friendly and short: "Pick a way to pay. Then plug in."

## Palette (8 tokens; AA contrast measured with the WCAG 2.x formula)

| Token       | Light     | Dark      | Use                                                      |
| ----------- | --------- | --------- | -------------------------------------------------------- |
| `bg`        | `#FFF4C2` | `#0C1016` | Page (butter / night forecourt)                          |
| `surface`   | `#FFFFFF` | `#1A212B` | Cards                                                    |
| `ink`       | `#101828` | `#F8F5E6` | Text, borders                                            |
| `muted`     | `#47505F` | `#B4BCC8` | Secondary text                                           |
| `accent`    | `#FFC700` | `#FFD60A` | Fill only: primary action, state pill (forecourt yellow) |
| `on-accent` | `#101828` | `#101828` | Text on accent                                           |
| `ok`        | `#0A6A32` | `#4ADE80` | Ready / paid                                             |
| `danger`    | `#B3261E` | `#FF8F85` | Errors, move your car                                    |

Plus a pump-board pair, `pump` (`#0B0F14` / `#000000`) and `pump-ink` (`#FFD60A` both modes), for the charger number display.
`accent` is never used as text colour on `bg` or `surface`; text on it is `on-accent`.

Contrast pairs the unit test will check (light / dark), all at least 4.5:1:

- ink on bg: 16.0 / 17.4
- ink on surface: 17.7 / 14.8
- muted on bg: 7.4 / 10.0
- muted on surface: 8.1 / 8.5
- on-accent on accent: 11.3 / 12.6
- ok on surface: 6.7 / 9.3
- danger on surface: 6.5 / 7.3
- pump-ink on pump: 13.6 / 14.9

## Type (SIL OFL 1.1, self-hosted via `next/font`)

- Headings, prices, charger numbers, buttons: **Archivo Black** 400.
- Body and labels: **Atkinson Hyperlegible** 400 / 700 (designed for low-vision legibility, suited to sun glare).

Numbers use tabular figures. Scale (rem, 18 px base): 0.8 label caps, 1.125 body, 1.5 section title, 1.35 buttons, 3 to 4.5 price, 5 to 9 charger number (fluid). Body never below 16 px on phones.

## Layout idea

A **pump board**: one near-black display panel with the charger number in huge yellow digits and a state pill (Ready, Charging, Move your car) beside the price card; thick 3 px ink borders and hard offset shadows keep it readable in glare. Phone: panel, price, then big stacked pay buttons (68 px tall). Desktop and the cashier tablet: the board and price side by side, the cashier console as a grid of pump boards, one per charger.

## Logo concept

Original mark (`logo.svg`): a rounded forecourt-yellow tile holding a heavy "K" whose upper arm ends in two small plug prongs. The K is `currentColor` and the tile uses `--accent`.

## Mocks

`mock.html` is a static page (no app code) showing the charger page: demo banner, pump board with state, price and estimate, the two pay choices and a 3-step strip. Captured as `docs/brief/desktop-light.png`, `desktop-dark.png` (1440 px) and `phone-light.png`, `phone-dark.png` (390 px). `scrollWidth` equals the viewport width in all four (no sideways scroll). Amounts in the mock are placeholders for layout only. Fonts used are in `brand/fonts/` with their OFL texts.
