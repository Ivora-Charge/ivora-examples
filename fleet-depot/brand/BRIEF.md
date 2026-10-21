# SQD-31 brief: fleet-depot brand

Approved by the owner on 2026-10-21 as **Rotabay**. The tokens now live in `brand/tokens.css` and `brand/brand.ts`; the mock is a static page (`mock.html`) and its screenshots are in `docs/brief/`. After approval the phone mini-timelines gained time labels (axis start, now, departure), as the owner asked.

## Name

Lead: **Rotabay** (a duty rota plus a charging bay). Coined; a rename is one line in `brand/brand.ts` once the build starts.
Alternates: **Dwellgrid**, **Baylight**.
No trademark or collision search was done; the release manager's quick check is still needed.

## Mood, users

Mood: **calm, precise, steady**.
Used by depot and fleet managers at a desk or on a wall screen (a TV mode is part B), and by drivers on a phone who only need "is my van ready, and when do I leave". Tone is operational and short: "5 charging, 2 waiting. 12.8 kW free."

## Palette (7 tokens, plus derived hairlines)

| Token     | Light     | Dark      | Use                                   |
| --------- | --------- | --------- | ------------------------------------- |
| `bg`      | `#EDF0F3` | `#0D1318` | Page (cool grey / control-room black) |
| `surface` | `#FFFFFF` | `#151D25` | Panels, rows                          |
| `ink`     | `#0F1A24` | `#E7EDF2` | Text, departure markers               |
| `muted`   | `#475766` | `#9AA8B5` | Secondary text, labels                |
| `accent`  | `#0A6A8C` | `#62C3E4` | Charging, power, current page         |
| `ok`      | `#17683D` | `#62D39B` | Ready                                 |
| `warn`    | `#AE3517` | `#FF9C7D` | At risk of missing departure, errors  |

`on-accent` (text on accent) is `#FFFFFF` / `#0A1620`. Lines and row stripes are `ink` at 13% and 5% alpha, not separate colours.

Status is never colour alone: charging is a filled circle, waiting a hollow square, ready a tick, at risk a triangle, and planned charge is hatched while charged energy is solid. Blue against vermilion stays distinct in the common colour-blind modes.

AA pairs the unit test will check (light / dark), all at least 4.5:1 (WCAG 2.x, measured):

- ink on bg: 15.4 / 15.8
- ink on surface: 17.6 / 14.4
- muted on bg: 6.5 / 7.7
- muted on surface: 7.4 / 7.0
- accent on bg: 5.3 / 9.3
- accent on surface: 6.1 / 8.5
- on-accent on accent: 6.1 / 9.1
- ok on bg: 6.0 / 10.1
- ok on surface: 6.8 / 9.2
- warn on bg: 5.5 / 9.2
- warn on surface: 6.3 / 8.3

## Type (SIL OFL 1.1, self-hosted via `next/font`)

- Labels, panel titles, the wordmark: **IBM Plex Sans Condensed** 600, uppercase labels with tracking.
- Body and controls: **IBM Plex Sans** 400 / 600.
- Every number (kW, times, SoC, cost, plates): **IBM Plex Mono** 500 with tabular figures, so columns line up.

Scale (px, 15 px base): 11 axis ticks, 12 labels and legends, 14 table and body, 15 body on phones, 26 counts, 40 hero kW.

## Layout idea

A **departure timeline console**. A narrow left rail holds the site power reading against the cap (one number, one bar with a cap marker) and four status counts. The main panel is a Gantt-style board: one row per vehicle on a 17:00 to 08:00 axis, solid for energy already delivered, hatched for the plan, a black tick at departure, a line for "now". Rows are separated by hairlines and faint stripes; panels are flat with a 1 px rule and 6 px radius. There are no thick borders and no hard offset shadows. On phones the rail stacks on top, each vehicle becomes a row with its own mini timeline, and a four-tab bar sits at the bottom.

## Logo concept

Original mark (`logo.svg`): a rounded bay outline holding three staggered bars (a schedule) with a vertical tick at the right (the departure). Outline and outer bars are `currentColor`; the middle bar and the tick use `--accent`, falling back to `currentColor`, so it prints in one colour.

## Mocks

`mock.html` shows the depot overview in the demo: banner, nav, site power against the 60 kW cap, status counts, cost per vehicle (desktop) and the departure timeline for eight vehicles. Captured in `docs/brief/`: `desktop-light.png`, `desktop-dark.png` (1440 px) and `phone-light.png`, `phone-dark.png` (390 px). `scrollWidth` equals the viewport width in all four, so no sideways scroll. The figures are invented for the mock. Fonts the mock uses are in `brand/fonts/`.
