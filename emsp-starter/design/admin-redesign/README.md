# eMSP Starter admin redesign: brief and mockups (phase 1)

Static, clickable mockups of the redesigned admin web for the eMSP Starter, with the brief behind them. **Nothing here is part of the shipped app:** no page, route, server action or test uses these files. Sample data only; every name, address and figure is invented.

The admin web in [`../../server`](../../server/README.md#admin-web) is built from these mockups (phase 2). It shows only what the server can tell it today, so a state drawn here may wait for a follow-up ticket [below](#what-would-need-new-server-behaviour). Follow-ups 1 and 2 (the setup status and the record of job runs, with Health and the view before the first admin) are built: see [Setup status](../../server/README.md#setup-status). So are follow-ups 3, 4, 5, 6 and 9 (sign-in that explains itself: the source and wait of a limit, the resend cooldown, "no admin exists yet", the emailed link, and the admin secret exchanged for a session): see [Admin sign-in](../../server/README.md#admin-sign-in). So are follow-ups 7, 8, 10, 11 and 12 (a refused token that says which one, counts and totals and search on Sessions, failed pulls in a row with the request ID, and trusted-since per party): see [Lists and failures](../../server/README.md#lists-and-failures-what-the-admin-pages-keep). A control that does nothing in a mockup carries the tooltip "Not in this mockup".

Open [`index.html`](index.html) in a browser. Each screen is one self-contained file (styles, script and the brand fonts are inside it) that asks the network for nothing, so it opens on its own, offline, from a phone or a file share. Links between screens are relative: keep the seven `.html` files in one folder and they find each other. The dark strip at the top of a screen is the mockup's own control: it switches between the screen's states and between light and dark. It is not part of the design.

## Brief

### Who the admin is

|                           | Day one                                                                                                                                                                                 | Day thirty                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Who**                   | The developer who has just deployed the template. Knows a terminal, has not read the whole README, is often on a phone next to a laptop.                                                | Someone who runs a small charging network. Not necessarily the person who deployed it.                                                      |
| **Question**              | "What is still missing, and what exactly do I type to fix it?"                                                                                                                          | "Is everything working? Where is this session, this payment, this peer?"                                                                    |
| **What goes wrong today** | A page says "live" over an empty database; forms ask for a secret that is not set; the first admin needs a statement nobody shows; a hub is connected through a form written for a CPO. | Lists stay empty until a button is pressed; actions need an ID copied from another card; limits of the hosting plan are only in the README. |
| **Opens on**              | **Setup**: six stops, each with a state and its fix.                                                                                                                                    | **Health**: the same six checks, all passing, then straight to the lists.                                                                   |

### Identity

The admin is the same brand as the driver app, Kilolane, and uses only its tokens (`server/brand/tokens.json`): violet, the sodium-yellow flare, warm paper by day and indigo by night, Bricolage Grotesque for headings, Instrument Sans for text, DM Mono for IDs and labels. It is not a restyle of the current cards. Three things carry the identity:

- **The power tile.** In the app a square tile shows a charger's power: one big number, one small word, filled green when free and outlined amber when busy. The admin uses the same tile for the state of anything: `13 of 13` migrations, `24 hours` between job runs, `2 of 5` parties trusted, `0 admins`. Filled means good, outlined means it needs you, red means broken, dashed means it waits for something else.
- **The lane.** Setup is a route with six stops and a dashed centre line between them. One stop at a time is "next": it gets a dark outline and a flare shadow. Nothing else on a screen uses that shadow, so the next thing to do is always the yellow one.
- **Flare means "look here".** Yellow is used for the next step and for limits of the deployment (free hosting), never for decoration.

### Tone

- Say what was found, then what to do, in the reader's words: "The database has no tables", not "status: unmigrated".
- Name whose limit or whose error it is: this server, the email service, the hub, the CPO.
- Every problem keeps the pattern of `lib/admin/errors.ts`: a sentence, a **code**, a **next step**. The next step is something the reader can do now, and says when a familiar action would _not_ help.
- Use the peer's own words once, then ours: "The hub's portal may call it a registration token, credentials token or Token A."
- A state is always a word with a mark, never colour alone: Done, Needs you, Broken, Waiting; Registered, Charging, Finished, Needs a look.

### Layout principles

- **Phone first.** One column, a top bar with the mark and the account, and a tab bar with five places (Setup or Health, Peers, Sessions, Money, More). From 60rem the tab bar becomes a labelled rail on the left and pages gain a side column for context (what happens next, our own address, the connection).
- **Things, not forms.** A peer, a party or a session is a row you open. Its actions sit on it. Nobody copies an ID from one card into another.
- **Lists open by themselves** for a signed-in admin. A page with nobody signed in shows one prompt, "Sign in as an admin", with a link. No form anywhere has a secret field.
- **One primary action per screen**, filled violet. Others are outlined; destructive ones are outlined red and never first.
- **Tables are tables on a wide screen and one card per row on a phone**, from the same markup, with the state and the amount in the same corner of every card.
- Tap targets are at least 44px, focus is always visible, and text contrast is the brand tokens' AA pairs in both themes.

## Information architecture

| Place                       | What it holds                                                                                                                                                                                                            | Today                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Setup**, later **Health** | The six checks with state and fix; the deployment's identity and limits.                                                                                                                                                 | Overview (`/`), plus README sections                         |
| **Network: Peers**          | The list of CPOs and hubs. A peer's own page: parties (for a hub), last pulls, tokens, live-data key, unregister. **Connect** starts from what you were given: a hub's token, a CPO's token, or "they register with us". | CPO peers: six cards on one page; Live data: a separate page |
| **Charging: Sessions**      | Live and recent sessions.                                                                                                                                                                                                | Sessions                                                     |
| **Charging: Problems**      | What drivers reported.                                                                                                                                                                                                   | Reported problems                                            |
| **Money: Payments**         | Review queue, lookup, refunds, audit log.                                                                                                                                                                                | Payments and refunds                                         |
| **Money: Reconciliation**   | Sessions against CDRs against captures, per peer and day, with the CSV.                                                                                                                                                  | Reconciliation                                               |
| **Drivers**                 | Drivers and their tokens, RFID cards, missed pushes.                                                                                                                                                                     | Drivers and tokens                                           |
| **Account**                 | Sign in, who is signed in and until when, sign out.                                                                                                                                                                      | Admin sign-in                                                |

### What moves where

| Today                                                                                  | Proposed                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Admin secret" field on every action card                                              | Gone. Signed out: a sign-in prompt in place of the page's content. On a deployment where `ADMIN_SECRET` is set, the sign-in page offers "use the admin secret instead", once. |
| Overview says "Live" from the environment alone                                        | Setup says "Setting up: 3 of 6 done" until the database, webhook, job, admin and peer checks pass. "Live" is the last state, not the first.                                   |
| First admin: a SQL statement in the README                                             | Setup stop 5 and the sign-in page show the statement with the email just used, in the right order: ask for a code, run it, type the code.                                     |
| "Show peers", "Show sessions" buttons                                                  | The list is the page.                                                                                                                                                         |
| "Connect to a CPO" used for hubs                                                       | Connect asks what you were given first. The hub path has its own words and a "what happens" column.                                                                           |
| "Parties behind a roaming hub" card with a hub peer ID field                           | The hub's own page: Trusted and Offered lists with Accept and Remove on each row.                                                                                             |
| "Rotate tokens or unregister", "Pull locations and tariffs" cards with a peer ID field | Buttons on the peer's page.                                                                                                                                                   |
| Free-hosting limits in the README                                                      | Setup stop 4 (yellow), the "Limits here" card, and Health when the job is late.                                                                                               |
| Sign-in: two cards, "Get a code" and "Enter the code"                                  | One step at a time. After the email: "Type the code from the email. Do not click the link."                                                                                   |

## The setup checklist

Six stops, in the order they depend on each other. A stop is Done, Needs you, Broken or Waiting; a stop that cannot be checked yet says what it waits for. Every stop has a problem state that shows its fix on the page, and the mockup shows each of the six:

| Stop                | Done                                                | Needs you / Broken                                                                                           | The fix it shows                                                                                                                       | In the mockup                                                |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1. Environment      | `6 of 6` live-mode settings present and well formed | `4 of 6`: each missing or malformed variable by name, never its value; the server is in demo mode until then | The command that makes the key, where to set the variables, and that a changed variable needs a redeploy                               | [1 Settings missing](setup.html#env)                         |
| 2. Database         | `13 of 13` migrations applied, newest named         | `0 of 13`: "The database has no tables"; or `11 of 13` with the pending files named                          | `npm run db:migrate`, or the files in the SQL editor in file-name order                                                                | [2 Empty database](setup.html#blank)                         |
| 3. Payments webhook | Last signed event and how long ago                  | `0 events`: no signed event has arrived; or events arrive and the signature does not match                   | The endpoint address to register, the 11 events to subscribe to, which variable takes the signing secret, then a test event            | [3 No webhook yet](setup.html#webhook)                       |
| 4. Scheduled job    | "Every minute", last run, age of the payment sweep  | "Once a day": holds are refused (the free-hosting limit, in yellow); or "stopped 12 minutes ago"             | The schedule line for a paid plan, or the request to call from any scheduler every minute                                              | [Setting up](setup.html#mid), [Job stopped](setup.html#late) |
| 5. First admin      | Who the admins are and their roles                  | `0 admins`: "No admin exists yet"                                                                            | Ask for a code, the exact SQL statement for that email, then type the code                                                             | [Setting up](setup.html#mid), [sign-in](sign-in.html#first)  |
| 6. First peer       | Counts of CPOs, hubs and trusted parties            | `0 peers`: "No peer yet"                                                                                     | What to ask the CPO or hub for (versions URL, one-time token), a "Connect a peer" button, and for a hub: accept its parties afterwards | [6 No peer yet](setup.html#peer)                             |

The header sums it up in one line and one tile: "Demo mode: 0 of 6 done", "Not live: 1 of 6 done", "Setting up: 3 of 6 done", "Almost live: 5 of 6 done", "Live", or "Live, but card holds are refused".

To keep the page short on a phone:

- **A done stop is one line** on day one (tile, name, "Done"); tap it for the detail. On Health, where all six are done and there is nothing else to read, they stay open.
- **One stop is next** and its fix is open. A later stop that also needs you says what is wrong and keeps its steps behind "Show the fix" on a phone; a wide screen shows them all. A limit of the deployment (the yellow free-hosting note) is never folded away.
- **A copy box wraps** its text inside the box, with the Copy button underneath on a phone, so what will be copied is always readable in full.

## Screens

Phone width (390) first, then desktop (1440), light and dark. The 32 pictures in [`screens/`](screens/) are exactly the ones below, named `<screen>-<state>-<phone|desktop>-<light|dark>.png`.

| Screen                                             | Phone                                                                                        | Desktop                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Setup: settings missing](setup.html#env)          | ![Setup, two settings missing, phone, light](screens/setup-env-phone-light.png)              | ![Setup, two settings missing, desktop, dark](screens/setup-env-desktop-dark.png)              |
| [Setup: empty database](setup.html#blank)          | ![Setup with an empty database, phone, dark](screens/setup-blank-phone-dark.png)             | ![Setup with an empty database, desktop, light](screens/setup-blank-desktop-light.png)         |
| [Setup: no webhook yet](setup.html#webhook)        | ![Setup, payments webhook not verified, phone, light](screens/setup-webhook-phone-light.png) | ![Setup, payments webhook not verified, desktop, dark](screens/setup-webhook-desktop-dark.png) |
| [Setup: job daily, no admin](setup.html#mid)       | ![Setup checklist on a phone, light](screens/setup-mid-phone-light.png)                      | ![Setup checklist on desktop, dark](screens/setup-mid-desktop-dark.png)                        |
| [Setup: no peer yet](setup.html#peer)              | ![Setup, no peer yet, phone, dark](screens/setup-peer-phone-dark.png)                        | ![Setup, no peer yet, desktop, light](screens/setup-peer-desktop-light.png)                    |
| [Health, day thirty](setup.html#health)            | ![Health, phone, light](screens/setup-health-phone-light.png)                                | ![Health with the job stopped, desktop, light](screens/setup-late-desktop-light.png)           |
| [Sign in: the code](sign-in.html#code)             | ![Type the code from the email, phone, light](screens/sign-in-code-phone-light.png)          | ![Type the code from the email, desktop, dark](screens/sign-in-code-desktop-dark.png)          |
| [Sign in: rate limit](sign-in.html#limit)          | ![Too many codes, phone, dark](screens/sign-in-limit-phone-dark.png)                         | ![Too many codes, desktop, light](screens/sign-in-limit-desktop-light.png)                     |
| [Sign in: no admin yet](sign-in.html#first)        | ![No admin exists yet, phone, light](screens/sign-in-first-phone-light.png)                  | ![No admin exists yet, desktop, dark](screens/sign-in-first-desktop-dark.png)                  |
| [Not signed in](peers.html#out)                    | ![Sign-in prompt in place of the list, phone, light](screens/peers-out-phone-light.png)      | ![Sign-in prompt in place of the list, desktop, dark](screens/peers-out-desktop-dark.png)      |
| [Peers](peers.html#list)                           | ![Peers list, phone, dark](screens/peers-list-phone-dark.png)                                | ![Peers list, desktop, light](screens/peers-list-desktop-light.png)                            |
| [Connect a roaming hub](connect.html#hub-form)     | ![Hub token form, phone, light](screens/connect-hub-form-phone-light.png)                    | ![Hub token form, desktop, dark](screens/connect-hub-form-desktop-dark.png)                    |
| [Hub registered](connect.html#hub-done)            | ![Registered, accept parties next, phone, dark](screens/connect-hub-done-phone-dark.png)     | ![Registered, accept parties next, desktop, light](screens/connect-hub-done-desktop-light.png) |
| [Hub refused the token](connect.html#hub-refused)  | ![Refused one-time token, phone, light](screens/connect-hub-refused-phone-light.png)         | ![Refused one-time token, desktop, dark](screens/connect-hub-refused-desktop-dark.png)         |
| [Parties behind a hub](hub.html#trusted)           | ![Trusted and offered parties, phone, light](screens/hub-trusted-phone-light.png)            | ![Trusted and offered parties, desktop, dark](screens/hub-trusted-desktop-dark.png)            |
| [Sessions (the table pattern)](sessions.html#list) | ![Sessions as cards, phone, dark](screens/sessions-list-phone-dark.png)                      | ![Sessions as a table, desktop, light](screens/sessions-list-desktop-light.png)                |

## Texts for states and errors

The texts the mockups propose, in the code and next-step pattern. Codes in _italics_ are new names; the others exist today.

| Where                          | What it says                                                                          | Code                      | Next step                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any page, signed out           | Sign in as an admin to see your peers.                                                | none                      | A "Sign in" button. No secret field.                                                                                                                                                                                 |
| Sign in, code sent             | Type the code. Do not click the link in the email.                                    | none                      | If the email has no code: add `{{ .Token }}` to the project's Magic Link email template, then ask for a new code.                                                                                                    |
| Sign in, our limit             | Too many codes for this email. You can ask again in 38:12.                            | _`sign_in_limited`_       | Whose limit: this server's, 5 codes per email per hour. Type the newest code you have, or wait and ask once.                                                                                                         |
| Sign in, email service's limit | The email service is holding back sign-in emails. Try again in about 1 hour.          | _`email_service_limited`_ | Whose limit: the email service's, for the whole project. Wait, or connect your own mail provider and raise the limit there.                                                                                          |
| Sign in, not on the list       | The code was right, but this address is not an admin. You have been signed out again. | _`not_an_admin`_          | Ask an admin to add you, or use the address that is on the list.                                                                                                                                                     |
| Connect a hub, token refused   | The hub refused the one-time token. Nothing was stored on either side.                | `HTTP 401`                | Get a new one-time token in the hub's portal and paste it. Rotating tokens does not help: there is no registration to rotate yet. Reasons: already used, expired or from the other environment, copied with a space. |
| Hub, no party trusted          | Connected, but idle: no party is trusted yet.                                         | none                      | Accept the CPOs you have an agreement with.                                                                                                                                                                          |
| Hub, party trusted but no data | Accepted a party but see none of its chargers?                                        | none                      | Check your subscription in the hub's own portal. You need both.                                                                                                                                                      |
| Peer, pull failing             | The CPO answered the sessions pull with an error of its own.                          | `OCPI 3000`               | Nothing is lost: the next pull resumes. If it still fails in an hour, send the CPO the time and the request ID.                                                                                                      |
| Setup, settings missing        | Two settings need you. Until all six are right, this server runs in demo mode.        | none                      | The variables by name; make the key, set both, redeploy.                                                                                                                                                             |
| Setup, no webhook event        | No signed payment event has arrived.                                                  | none                      | Register the endpoint address, subscribe the 11 events, set the signing secret, send a test event. If events are refused: the secret is from another endpoint or mode.                                               |
| Setup, no peer                 | No peer yet. The drivers' map is empty and nobody can charge.                         | none                      | Ask the CPO or hub for its versions URL and a one-time token, then Connect.                                                                                                                                          |
| Health, job late               | Card holds refused: the payment sweep has not run in the last 5 minutes.              | _`payment_sweep_stale`_   | Check that the scheduler still calls the job every minute and gets a 200. Holds resume after the next run.                                                                                                           |

## What would need new server behaviour

Proposed follow-up tickets. None of these is built here, and the phase 2 build can ship without them by showing "cannot check from here" on the stops that depend on them.

1. **Setup status for the checklist.** One server-side read that reports, without values: the names of missing or malformed live-mode variables (the server knows these today, the page does not show them), applied migrations against the files shipped (and "no tables"), the time and result of the last signed payment webhook and of the last refused one, the time of the last job run and the age of the payment sweep, how many admins exist, how many peers. "Live" is reported only when the database check passes. Needs a decision on what a signed-out visitor may see before the first admin exists (proposed: the six states and fixes, no data).
2. **Record job runs.** Keep the last few run times of the scheduled job so the admin can say how often it really runs ("once a day", "every minute", "stopped 12 minutes ago"), not what the schedule file claims.
3. **Sign-in limits that explain themselves.** Pass the wait (`Retry-After`) and the source of a limit (this server's per-email, per-client or total limit, or the email service's) from the sign-in code to the page. Today both end as the same sentence.
4. **"No admin exists yet" on sign-in.** Let the sign-in page know that the admin list is empty, so it can show the first-admin statement for the email just used instead of "this account is not an admin".
5. **Make the emailed link work too, or detect the missing code.** Either accept the link on the admin sign-in page (the sign-in code already understands a link's token hash for drivers), or add a setup check that the project's email template contains the code. Until then the page only explains it.
6. **Admin secret asked once.** Exchange `ADMIN_SECRET` for a short admin session on the sign-in page, so no form carries it. Without this, phase 2 can keep it in the page's memory for the tab and add it to each action itself.
7. **Context for a refused token.** Tell a refusal during a first registration (one-time token: "get a new one") apart from a refusal on a registered peer (permanent token: "rotate, then register again"), so `lib/admin/errors.ts` gives the right next step for each.
8. **Counts and totals for lists.** Totals per state for Sessions ("Charging now 2", "Needs a look 1") and the list's total ("8 of 128") in one read.
9. **Resend cooldown.** Tell the sign-in page how long until another code may be requested for this address ("New code possible in 0:52"), so the button can wait instead of failing.
10. **Pull failure count and request ID.** Keep, per peer and module, how many pulls have failed in a row and the request ID of the last failed one ("failed 12 min ago, 4 times in a row", "send the CPO the time and the request ID").
11. **Trusted-since per party.** Record when a party behind a hub was accepted, to show "Trusted since 12 Nov" on its row.
12. **Session search.** Find sessions by driver, charger or reference on the server; today's list has no search.

Related work, not repeated here: actionable error logs and first-deploy troubleshooting, the secret key format docs, and the hub token push mode.

## Rebuilding

The HTML files are generated; edit `src/`, never the output.

```sh
node build.mjs     # writes the seven .html files from src/ and the brand tokens
node check.mjs     # checks them in a browser, offline (needs `npm ci` in ../../server for Playwright)
node shoot.mjs     # retakes the pictures above and removes any other PNG from screens/
```

`build.mjs` refuses a `data-go` (the attribute that moves a screen to another state) on anything but a link or a button. `check.mjs` opens every state at phone width and fails if a tap, click, focus or key press in a form field changes the state, if a submit button or state link does not lead where it says, if a link is not relative or points at a screen or state that does not exist, if a page asks the network for anything, or if a page or a copy box is wider than the phone.

Requires Node.js 22. `build.mjs` reads `../../server/brand/tokens.json` and the fonts in `../../server/brand/fonts/`, so a change of brand restyles the mockups too. The brand fonts inside each HTML file are under the SIL Open Font License 1.1; the licence texts are in `../../server/brand/fonts/`. The committed pictures were reduced to a 256-colour palette after capture to keep them small.
