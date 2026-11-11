# Ampleaf polish mockups (SQD-80)

Static, clickable mockups for owner review. **Nothing here is part of the shipped app**: no route, API call or test uses these files, and they add no dependency.

- Open `index.html` (it links every screen). Each screen page puts the current template screenshot (`../screens/`) beside the proposal, with a light/dark and desktop 1440 / phone 390 switch, and lists what changes and why, which Squid screen it follows, accessibility, brand tokens and a build size.
- `proposed/*.html` are the proposed screens. They read colour, type, radius and spacing from `../../brand/tokens.css`; they define no colours of their own.
- `content.mjs` and `build.mjs` generate the HTML: `node docs/mockups/build.mjs && npx prettier --write docs/mockups`.
- Demo data only: every name, id and figure is invented.

## Preview deployment

`vercel.json` runs `scripts/stage-mockups.mjs` before `next build`. The script copies this folder (plus the screenshots, tokens and fonts it uses) into `public/mockups/` **only when `VERCEL_ENV=preview`**, so production builds never contain it. In a preview open `/mockups/`. The preview must run in demo mode (as the kit's previews already should, with no live credentials); in live mode the proxy asks signed-out visitors to sign in, and the mockups are not on its public list on purpose. Locally: `MOCKUPS=1 node scripts/stage-mockups.mjs`, or just open `docs/mockups/index.html` in a browser.
