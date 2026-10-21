# SQD-29 brief: installer-kit brand

> Location note: the ticket asks for `<template>/brand/BRIEF.md`. The `brand/` folder is created in the full part A (`brand.ts`, `tokens.css`, `logo.svg`); this brief and its mocks live in `docs/brief/` so the BRIEF PR touches only documents. The final build moves `logo.svg` into `brand/`.

## Name

**Boltmark**. Coined; it is a one-line change in `brand/brand.ts` later.
Alternates: **Lugline**, **Sparkhand**.
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

Original mark (`logo.svg`): a rounded tile with a single bold stroke that forms a "B" whose lower bowl ends in a round dot, read as a bolt head and a plug pin. It uses `currentColor` plus one inner colour, so it recolours from tokens and prints in one colour.

## Mocks

`mock.html` is a static page (no app code) showing the Connect step: demo banner, step rail, OCPP details with copy buttons, password reveal, live online status. Captured in light mode: `desktop.png` (1440 px) and `phone.png` (390 px, no sideways scroll; checked `scrollWidth` = 390). Fonts used by the mock are in `fonts/`.
