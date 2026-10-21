# SQD-29 brief: installer-kit brand

> Approved by the owner on 2026-10-21 with the name Lugline and four fixes (listed at the end). The mock in `mock.html` and `mock/` is the approved brief stage and still shows the earlier working name and mark.

## Name

**Lugline** (a lug is the crimped terminal on the end of a cable). Coined; a rename is one line in `brand/brand.ts`.
Alternates: **Boltmark**, **Sparkhand**.
Name searches for EV and charging companies were not exhaustive (no trademark search done); the owner may want a quick check before the full build.

## Mood, users

Mood: **rugged, direct, legible**.
Used by installers and electricians on site, on a phone, outdoors in gloves and bright sun, or in a dark garage. Tone is short and practical: "Plug in the charger. Then tap Test."

## Palette (7 tokens; AA contrast measured with the WCAG 2.x formula)

| Token       | Light     | Dark      | Use                                        |
| ----------- | --------- | --------- | ------------------------------------------ |
| `bg`        | `#F3F0E6` | `#0F1214` | Page (warm concrete / garage black)        |
| `surface`   | `#FFFFFF` | `#1A1F22` | Cards, inputs                              |
| `ink`       | `#14181B` | `#F2EFE6` | Text, borders                              |
| `muted`     | `#4A524F` | `#A9B1AC` | Secondary text                             |
| `accent`    | `#B34700` | `#FFA62B` | Safety orange: primary action, active step |
| `on-accent` | `#FFFFFF` | `#14181B` | Text on accent                             |
| `ok`        | `#116B3A` | `#4FD08A` | Online / pass                              |
| `danger`    | `#B0200F` | `#FF8A78` | Errors                                     |

Contrast pairs the unit test will check (light / dark), all at least 4.5:1:

- ink on bg: 15.7 / 16.4
- ink on surface: 17.9 / 14.5
- muted on bg: 7.1 / 8.6
- muted on surface: 8.0 / 7.6
- accent on bg: 4.8 / 9.6
- accent on surface: 5.5 / 8.5
- on-accent on accent: 5.5 / 9.1
- ok on surface: 6.6 / 8.5
- danger on surface: 6.9 / 7.3

(Eight tokens listed because `danger` is kept separate from `accent`; the brief range of 5-7 is exceeded by one. Say if it should be folded.)

## Type (SIL OFL 1.1, self-hosted via `next/font`)

- Headings and buttons: **Barlow Condensed** 700, uppercase, slight tracking.
- Body and labels: **Barlow** 400 / 600.
- Station IDs, OCPP URLs, passwords: **JetBrains Mono** 400 / 600.

Scale (rem, 17 px base): 0.8 label caps, 1 body, 1.2 mono values, 1.5 section title, 2.5 page title, 1.25 big buttons. Body never below 16 px on phones.

## Layout idea

A **checklist wizard**: a numbered step rail (done = green, current = orange with a hard offset shadow, upcoming = outline) beside one card per step on desktop; stacked above the card on phones. Thick 2 px ink borders, hard offset shadows and large 48-56 px targets give a stamped, tool-label look that survives sunlight and black-and-white printing.

## Logo concept

Original mark (`logo.svg`): a heavy "L" whose foot is crimped into a ring lug, the terminal an electrician fits to a cable. The L is `currentColor` and the lug uses `--accent`, falling back to `currentColor`, so it prints in one colour.

## Mocks

`mock.html` is a static page (no app code) showing the Connect step: demo banner, step rail, OCPP details with copy buttons, password reveal, live online status. Captured in light mode: `mock/desktop.png` (1440 px) and `mock/phone.png` (390 px, no sideways scroll; checked `scrollWidth` = 390). Fonts used by the mock are in `fonts/`.

## Owner fixes applied in the build

1. Phones get a compact step bar ("Step 2 of 5" and five segments; done steps link back). Desktop keeps the rail.
2. The mark is redrawn for Lugline (above).
3. The connect step shows either "Plug in the charger. Then tap Test." (charger not online) or "Charger online" (booted), never both.
4. Connection URL, charge point ID and password stay on one line with an ellipsis; the `title` holds the full value and Copy copies all of it.
