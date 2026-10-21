# SQD-32 brief: cpo-starter-kit brand

Brief stage only. No app code is changed; the mock is a static page (`mock.html`) and the screenshots are in `docs/brief/`.

## Name

**Ampleaf** (ample + leaf: plenty of clean energy, growing). Chosen by the owner on 2026-10-21 after the collision check: Currant is an existing energy smart-plug company and Kilowell is close to Kilows. A rename stays one line in `brand/brand.ts` once the build starts.
The shipped name is only a placeholder: operators replace it (the mock shows the workspace chip "Your charging network" and a setup step "Make it yours").

## Mood, users

Mood: **calm, confident, clear**.
A small operator's owner and staff at a laptop, running chargers, pricing and reports; drivers on a phone see the operator's own brand through the same tokens. Tone is plain and reassuring: "2 of 4 steps done. Connect a charger next."

## Palette v2 (leaf green plus lime; contrast measured with the WCAG 2.x formula)

Swatch: `docs/brief/palette.png`.

| Token        | Light     | Dark      | Use                                                    |
| ------------ | --------- | --------- | ------------------------------------------------------ |
| `bg`         | `#F2F5EC` | `#0B130E` | Page (pale sage paper / night canopy)                  |
| `surface`    | `#FFFFFF` | `#132019` | Cards, sidebar, tables                                 |
| `ink`        | `#10241A` | `#E7F1E9` | Text                                                   |
| `muted`      | `#4A5E52` | `#9BB2A3` | Secondary text, column heads, idle icons               |
| `primary`    | `#17613A` | `#6FD394` | Deep leaf green: primary action, links, charts         |
| `on-primary` | `#FFFFFF` | `#06200F` | Text on primary                                        |
| `accent`     | `#C5F24A` | `#C9F55A` | Lime, fill only: current page, live charging, callouts |
| `on-accent`  | `#10241A` | `#10241A` | Text and icons on lime                                 |
| `ok`         | `#0B6B5C` | `#5ED6BF` | Available, positive change (teal, apart from primary)  |
| `warn`       | `#8A4B00` | `#F2B25C` | Needs attention                                        |
| `danger`     | `#B3261E` | `#FF8F85` | Offline, errors                                        |

Lines are `ink` at 11% alpha; tints are `primary` at 8% on surface. Lime is never text on a light surface; it is always a fill under `on-accent` ink. Status is never colour alone: a dot for charging and available, a square for offline, always with a word.

AA pairs the unit test will check (light / dark), all at least 4.5:1:

- ink on bg: 14.8 / 16.3
- ink on surface: 16.3 / 14.5
- muted on bg: 6.3 / 8.3
- muted on surface: 7.0 / 7.4
- primary on bg: 6.8 / 10.3
- primary on surface: 7.5 / 9.1
- on-primary on primary: 7.5 / 9.4
- on-accent on accent: 12.5 / 12.9
- ok on bg: 5.8 / 10.6
- ok on surface: 6.4 / 9.5
- warn on bg: 6.2 / 10.1
- warn on surface: 6.8 / 9.1
- danger on bg: 5.9 / 8.5
- danger on surface: 6.5 / 7.6

## Signature element: the leaf corner

One shape, used sparingly: a corner radius that is large top-left and bottom-right and nearly square on the other two (`--leaf: 18px 3px 18px 3px`). It marks what is current or live: the active nav item (lime), the active range button (green), the Demo badge and the chart callout, and it is the outline of the mark. Cards stay a plain 12 px radius, so the leaf reads as a signal, not decoration.

## Type (SIL OFL 1.1, self-hosted via `next/font`)

- UI, body, tables, buttons: **Manrope** 400 / 600 / 800, tabular figures in tables.
- Page titles, the lowercase wordmark `ampleaf` and big numbers: **Fraunces** 600 (a soft, slightly bulbous serif, so the numbers feel like a ledger, not a dashboard toy).

Scale (px, 15 px base): 12 labels and column heads (uppercase, tracked), 13 secondary, 15 body, 23 wordmark, 28 phone title, 34 desktop title and KPI numbers.

## Layout idea

A **ledger-style back office**: grouped left sidebar (Run: Overview, Live, Chargers; Money: Pricing, Reports; Workspace: Onboarding, Team, Settings) with the operator's workspace chip on top; a page header with a range switch; four KPI cards with sparklines; an energy chart beside a setup checklist with progress; then a crisp, borderless-row table of chargers. Surfaces are white cards with a 1 px hairline and a soft shadow, 12 px radius, no thick borders and no hard offset shadows. Every nav item has a real icon (Lucide, ISC licence, inlined as SVG symbols): Overview, Live, Chargers, Pricing, Reports, Onboarding, Team, Settings, plus Menu and More. On a phone the sidebar becomes a Menu button plus a five-item bottom tab bar, and table rows become stacked rows with the status on the right.

## Logo concept

Original mark (`logo.svg`): a leaf-cornered tile in `--primary` holding a lime midrib that rises to a charge-point dot, with two veins of increasing height that also read as rising bars. Colours come from `--primary` and `--accent`, so it follows the theme and still works in one colour.

## Mocks

`mock.html` (v2) shows the kit Overview in the demo: banner, grouped nav, range switch, KPI cards, energy chart, setup checklist and the chargers table (sample names only, figures invented). Captured in `docs/brief/`: `desktop-light.png`, `desktop-dark.png` (1440 px) and `phone-light.png`, `phone-dark.png` (390 px). `scrollWidth` equals the viewport width in all four, so no sideways scroll. Fonts the mock uses are in `brand/fonts/` with their OFL texts; the swatch is `docs/brief/palette.png`.
