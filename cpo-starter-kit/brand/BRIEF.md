# SQD-32 brief: cpo-starter-kit brand

Brief stage only. No app code is changed; the mock is a static page (`mock.html`) and the screenshots are in `docs/brief/`.

## Name

Lead: **Currant** (current, plus the small bright berry). Coined as a product name; a rename is one line in `brand/brand.ts` once the build starts.
Alternates: **Kilowell**, **Ampleaf**.
No trademark or collision search was done; the release manager's quick check is still needed. The shipped name is only a placeholder: operators replace it (the mock shows the workspace chip "Your charging network" and a setup step "Make it yours").

## Mood, users

Mood: **calm, confident, clear**.
A small operator's owner and staff at a laptop, running chargers, pricing and reports; drivers on a phone see the operator's own brand through the same tokens. Tone is plain and reassuring: "2 of 4 steps done. Connect a charger next."

## Palette (7 tokens plus derived hairlines; contrast measured with the WCAG 2.x formula)

| Token       | Light     | Dark      | Use                                          |
| ----------- | --------- | --------- | -------------------------------------------- |
| `bg`        | `#F6F5FA` | `#0F0E15` | Page (soft lavender grey / ink night)        |
| `surface`   | `#FFFFFF` | `#181722` | Cards, sidebar, tables                       |
| `ink`       | `#17151F` | `#EEECF6` | Text                                         |
| `muted`     | `#5A5670` | `#A29FB8` | Secondary text, column heads                 |
| `accent`    | `#5B3FD9` | `#A593FF` | The one accent: primary action, current page |
| `on-accent` | `#FFFFFF` | `#14102B` | Text on accent                               |
| `ok`        | `#17703F` | `#5FD39A` | Available, positive change                   |
| `warn`      | `#9A4A06` | `#F2B25C` | Needs attention                              |
| `danger`    | `#B3261E` | `#FF8F85` | Offline, errors                              |

Lines are `ink` at 11% alpha; tints are `accent` at 9% on surface. Status is never colour alone: a dot for charging and available, a square for offline, always with a word.

AA pairs the unit test will check (light / dark), all at least 4.5:1:

- ink on bg: 16.6 / 16.4
- ink on surface: 18.0 / 15.2
- muted on bg: 6.5 / 7.5
- muted on surface: 7.0 / 6.9
- accent on bg: 6.1 / 7.5
- accent on surface: 6.7 / 6.9
- on-accent on accent: 6.7 / 7.2
- ok on bg: 5.7 / 10.3
- ok on surface: 6.1 / 9.5
- warn on surface: 6.3 / 9.5
- danger on bg: 6.0 / 8.7
- danger on surface: 6.5 / 8.0

## Type (SIL OFL 1.1, self-hosted via `next/font`)

- UI, body, tables, buttons: **Manrope** 400 / 600 / 800, tabular figures in tables.
- Page titles, the wordmark and big numbers: **Fraunces** 600 (a soft serif, so the numbers feel like a ledger, not a dashboard toy).

Scale (px, 15 px base): 12 labels and column heads (uppercase, tracked), 13 secondary, 15 body, 21 wordmark, 28 phone title, 34 desktop title and KPI numbers.

## Layout idea

A **ledger-style back office**: grouped left sidebar (Run: Overview, Live, Chargers; Money: Pricing, Reports; Workspace: Onboarding, Team, Settings) with the operator's workspace chip on top; a page header with a range switch; four KPI cards with sparklines; an energy chart beside a setup checklist with progress; then a crisp, borderless-row table of chargers. Surfaces are white cards with a 1 px hairline and a soft shadow, 12 px radius, no thick borders and no hard offset shadows. On a phone the sidebar becomes a Menu button plus a five-item bottom tab bar, and table rows become stacked rows with the status on the right.

## Logo concept

Original mark (`logo.svg`): a rounded accent tile holding a heavy open ring (a "C") with a dot at its opening, a charge entering the circle. Tile uses `--accent`, the ring `--on-accent`, so it follows the theme and prints in one colour.

## Mocks

`mock.html` shows the kit Overview in the demo: banner, grouped nav, range switch, KPI cards, energy chart, setup checklist and the chargers table (sample names only, figures invented). Captured in `docs/brief/`: `desktop-light.png`, `desktop-dark.png` (1440 px) and `phone-light.png`, `phone-dark.png` (390 px). `scrollWidth` equals the viewport width in all four, so no sideways scroll. Fonts the mock uses are in `brand/fonts/` with their OFL texts.
