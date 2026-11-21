# Design: a fixed core plus switchable modules

**Status:** design for review. Nothing here is built yet: this document changes no code, no migration and no environment variable. Implementation starts only after review, in the tickets proposed at the end.

The CPO Starter Kit covers what an operator's own staff do every day. Optional features become **modules** that an owner turns on or off in the kit's settings. The kit is not a copy of the Ivora dashboard: anything about the operator's own account with Ivora (its platform billing, API keys, team access to the dashboard) stays in the dashboard and never comes into the kit.

All endpoint paths below are under `/v1/tenants/{tenant_id}` unless they start with `/payment/` or `/v1/billing/`, and were checked against the [published OpenAPI schema](https://api.ivoracharge.com/openapi.json) (contract version 2026-10-15). Scopes are the API key permissions the schema names.

## Rules

These hold for the core and for every module.

1. **Public API only.** A module is offered only when every endpoint it needs is in the published API reference. No private, staff-only or administration endpoints (nothing under `/v1/admin/`), and no Ivora-hosted operation of the kit. Where the API is missing something, the module leaves that part out and the gap is listed in [Public API gaps](#public-api-gaps); it is never worked around.
2. **A switch hides UI; it is not a permission.** Turning a module off hides its screens and stops its jobs. It never grants or removes access. Permission is enforced twice, and never by the switch alone:
   - by the **Ivora API**, through the scopes of the deployment's API key (a call without the scope is refused by Ivora, whatever the switch says), and
   - by the **kit's server**, through the staff role (`requireRole()` and the database functions that re-check the role in the same statement as the write).

   Each module below names both.

3. **Modules that can change a charger or move money default to off** on a new deployment.
4. **Nothing about the operator's platform account.** No Ivora platform billing, invoices or usage fees, no API key management, no Ivora dashboard team management, no payment account connection (Stripe is connected in the Ivora dashboard; the kit only reads its status).
5. **Turning a module off changes nothing in Ivora.** It does not unpublish roaming sites, block cards or remove discounts from tariffs. The Modules page says so before an owner turns a module off (see [Disabled behaviour](#disabled-behaviour)).

## Core (always on)

The core cannot be switched off. Every screen keeps the role checks it has today.

| Core area                  | Screens and flows                                                                                                                                                | Kit role                                                                    | API scopes                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Stations and live status   | Overview; Chargers (add, connection password, connection test, edit, move, remove); Live (map, list, connector status, faults, sessions charging now)            | Viewer reads; technician adds, tests and edits; manager removes             | `stations:read`, `stations:write`, `billing:read`                                                     |
| Sessions and receipts      | Live sessions; driver checkout (pay and charge, free sessions); the driver session page with what was charged; settlement sweep; "Driver sessions that need you" | Viewer reads; drivers need no login                                         | `stations:read`, `stations:control`, `billing:read`, `billing:write`, `tokens:read`, `tokens:write`\* |
| Pricing                    | Tariffs (per kWh, time of use, idle fee, session fee, free), previews, assignment per charger and connector, private chargers                                    | Manager and owner                                                           | `stations:read`, `billing:read`, `tariffs:write`                                                      |
| QR and checkout link       | QR stickers on the deployer's own domain, `/c/<code>`, the return domain, driver-page branding and logo (Onboarding, Settings → Brand)                           | Technician prints stickers; manager sets brand and return domain            | `stations:read`, `stations:write`                                                                     |
| Reports                    | Ivora figures, the kit's own checkout records, session and bill lists, CSV export, payouts link to the Stripe dashboard                                          | Viewer and up                                                               | `stations:read`, `billing:read`                                                                       |
| Team and sign-in           | Setup, sign-in (password or emailed link), invites, roles, Settings → Company and Payments (status only)                                                         | Owner and manager invite and change roles; the last owner cannot be removed | None for the team (Supabase); `billing:read` for the Stripe status                                    |
| Modules (new, this design) | Settings → Modules                                                                                                                                               | Owner changes; manager reads                                                | None (kit database)                                                                                   |

\* Driver checkout itself sends `start` and `stop` commands (starting a paid bill, stopping a session before it passes its hold, the driver's own stop button) and uses the free charging token. These stay in the core whatever the [Remote commands](#remote-commands-and-firmware) switch says, because a paid session must always be stoppable. So the key keeps `stations:control` and `tokens:read`, `tokens:write` for the core; the Remote commands switch hides only the **staff** commands.

## Modules

Every module is one switch. "Exists today" means every endpoint the module needs is in the published API now. "Default" is the default on a **new** deployment; see [Migration](#migration-for-existing-deployments) for upgrades.

| Module (key)                                       | Purpose                                                                                                                          | Endpoints                                                                                                                                                                                                                                                                                                                                                                     | Exists today                                | Default | Permission needed (kit role; API scopes)                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Site hosts (`network`)                             | Chargers at many site hosts: the Hosts page, host logins that see only their own sites, per-host switches                        | `GET /locations`, `GET /stations`, `GET /stations/{station_id}`, `GET /transactions?station_id=`, `GET /bills?station_id=`; hosts and their sites in the kit database                                                                                                                                                                                                         | Yes, without payouts (no payouts API)       | Off     | Owner, manager manage hosts; host users per switch. `stations:read`, `billing:read`; host writes use the core's scopes                                                         |
| Fleet and RFID cards (`fleet`)                     | RFID cards per driver or vehicle, CSV import, block and expire, each card's sessions and energy                                  | `GET /tokens`, `POST /tokens`, `POST /tokens/import`, `GET /tokens/{token_id}`, `PATCH /tokens/{token_id}`, `GET /stations`, `GET /transactions?station_id=&after=`, `GET /transactions/{transaction_id}`                                                                                                                                                                     | Yes                                         | Off     | Viewer reads; manager, owner change. `tokens:read`, `tokens:write` (tenant admin), `stations:read`, `billing:read`                                                             |
| Roaming (`roaming`)                                | Publish sites to Ivora's OCPI roaming partners, own party ID request, EVSE IDs (read only)                                       | `GET /ocpi`, `PUT /ocpi`, `GET /ocpi/evse-ids`, `GET /locations`, `GET /stations`                                                                                                                                                                                                                                                                                             | Yes                                         | Off     | Manager, owner. `stations:read`, `stations:write`                                                                                                                              |
| Station status emails (`status_emails`)            | Email chosen staff, and host users whose host has the switch on, when a charger goes offline or faults                           | `POST /webhooks` events `station.connected`, `station.disconnected`, `station.fault_opened`, `station.fault_cleared`, `connector.status_changed`; `GET /events?type=&station_id=` (catch-up); `GET /stations/{station_id}`, `GET /stations/{station_id}/faults`                                                                                                               | Yes                                         | Off     | Manager, owner choose recipients. `stations:read`; `webhooks:write` for the registration script only                                                                           |
| Remote commands and firmware (`remote_commands`)   | Staff start, stop, reset, unlock, availability; the chargers' remote start and stop test; firmware update and diagnostics upload | `POST /stations/{station_id}/commands` (`start`, `stop`, `reset`, `unlock`, `availability`, `update_firmware`, `upload_diagnostics`), `GET /operations/{operation_id}`, `POST /stations/{station_id}/trigger`, webhook events `operation.completed`, `station.firmware_status`, `station.diagnostics_status`; `GET /tokens?external_reference=`, `POST /tokens` (staff token) | Yes                                         | Off     | Technician and up for start, stop, reset, unlock, availability; manager, owner for firmware and diagnostics. `stations:control`; the staff token `tokens:read`, `tokens:write` |
| Promotions (`promotions`); rewards are not offered | Discounts on tariffs: percent off for card groups or listed cards, and merchant validation codes                                 | `POST /tariffs` (`rules.group_discounts`, `rules.merchant_validation`), `POST /tariffs/simulate`, `POST /tariffs/{tariff_id}/quote`, `POST /bills` (`merchant_validation`, `pricing_group`)                                                                                                                                                                                   | Promotions yes; rewards no (no loyalty API) | Off     | Manager, owner. `tariffs:write`, `billing:read`, `billing:write`                                                                                                               |

Every default is off. Three modules can change a charger or move money (Remote commands; Promotions; Fleet, because an accepted card starts charging with no payment), so rule 3 requires it. The other three are off because they serve a particular kind of operator and need extra setup (host logins, an email provider and webhook events, roaming publication): a new deployment starts with the core only.

### Site hosts (network mode)

- **Shows:** the Hosts page (`/hosts`), the Host role on the Team page, the Host filter on Chargers, Live and Reports, and host users' narrowed views (Overview, Chargers, Live, Reports; Pricing and Team per switch).
- **Switches per host depend on other modules:** "Restart and unlock" and "Start and stop sessions" are shown and allowed only with Remote commands on; "Receive fault emails" only with Station status emails on; "Edit prices" and "Invite further users" are core.
- **Payouts are not offered.** The public API has no payouts endpoint, so the kit can't show or send a host its share. Reports keeps the link to the operator's own Stripe dashboard.
- **Permission:** host access is decided on the server from `cpo_host_sites` on every request and re-checked by the database functions (`cpo_claim_host_command`, `cpo_set_host_station_pricing`, `cpo_create_host_invite`). Ivora sees one project and one key; the narrowing is the kit's. With the module off, a host user gets 404 on every page, because `requireNetworkReader()` refuses the host role.

### Fleet and RFID cards

- **Shows:** Cards (`/cards`, `/cards/[id]`), the private chargers list on Cards, and card ledger figures.
- **Background:** the card ledger refresh in the settlement sweep and on Cards page loads.
- **Permission:** `tokens:write` is granted only by a project admin in the Ivora dashboard. Turning the module off does not block any card: cards stay valid in Ivora. To stop cards working, block them first, or remove `tokens:write` from the key (the core's free charging and staff tokens are created once and then only read).

### Roaming

- **Shows:** Settings → Roaming.
- **Turning off:** the kit hides the page, but what Ivora publishes stays as last saved. The Modules page warns and links to Settings → Roaming to turn publishing off first.
- **Permission:** manager and owner on the server; `stations:write` for saving. Party approval and EVSE ID import stay with Ivora; the kit shows both and changes neither.

### Station status emails

- **Shows:** a recipients list on Settings → Modules (staff who opt in), the host switch "Receive fault emails", and the email itself.
- **Needs:** an email provider (`RESEND_API_KEY`, `EMAIL_FROM`) and the events above registered on the webhook (`npm run ivora:webhook -- register` adds them). Without a provider the module can be on but the page says no email is sent.
- **Background:** the webhook handler sends at most one email per charger and event kind per 15 minutes; a sweep step reads `GET /events` from a stored cursor to catch deliveries a webhook missed. Both skip when the module is off.
- **Permission:** reads only, `stations:read`. Recipients are chosen by managers and owners; host users get emails only for their own host's sites.

### Remote commands and firmware

- **Shows:** the command buttons in Live (start, stop, reset, unlock), availability (operative, inoperative), the remote start and stop test in Chargers, and a new Firmware panel on a charger's page (update from an `https` URL, upload diagnostics to an `https` URL, with the charger's reported status).
- **Without the module:** Live and Chargers stay, read only for charger state; the connection test (a read) stays. Driver checkout's own commands are core (see the footnote under [Core](#core-always-on)).
- **Permission:** the kit's role check (technician and up; manager and up for firmware and diagnostics) and the host switches run on the server before any call. Ivora refuses a command without `stations:control`. Because driver checkout needs that scope too, the key always holds it: the kit's role check, not the switch, is what stops a viewer from sending a command. Ivora refuses `update_firmware` while a session is running (`409 transaction_active`); the kit shows that and never asks to force it.

### Promotions

- **Shows:** a Discounts section on a tariff in Pricing (group or card discounts, merchant validation codes and their discount), the adjustment in previews, and an optional "Validation code" field at driver checkout that is passed to `POST /bills`.
- **Rewards are not offered.** The public API has no loyalty balance, points or earned credit, so a rewards programme can't be built on it.
- **Turning off:** tariffs created with discounts keep them in Ivora. The Modules page lists the tariffs that still carry discounts; to end a promotion, save the tariff again without it (a new tariff version, as Pricing does today).
- **Permission:** managers and owners on the server (as Pricing); Ivora requires `tariffs:write` to create tariffs and `billing:write` for bills.

## The switch mechanism

### Storage

A new kit table, created by an additive migration in `supabase/migrations/` (named like the others, for example `2026112N0001_modules.sql`):

```sql
create table if not exists public.cpo_operator_modules (
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  module text not null check (module in
    ('network', 'fleet', 'roaming', 'status_emails', 'remote_commands', 'promotions')),
  enabled boolean not null,
  rev integer not null default 1,
  source text not null default 'owner' check (source in ('owner', 'upgrade')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (operator_id, module)
);
```

- It follows the 10-30 rule: RLS on, all privileges revoked from `public`, `anon` and `authenticated`, no Data API grant. The server reads it with the service role.
- One function writes it: `cpo_set_module(p_actor uuid, p_operator uuid, p_module text, p_enabled boolean, p_expected_rev integer)`, `security definer`, with `search_path` set, `EXECUTE` revoked from `public`, `anon` and `authenticated` and granted to `service_role` only. In one statement it locks the actor's `cpo_staff` row, refuses unless the actor is still an **owner** of that operator, refuses if the row's `rev` is not `p_expected_rev` (0 for no row: someone changed it in between, so the page asks to reload), and upserts the row with `rev + 1`.
- The module list is a constant in `lib/modules.ts`, the same list as the `check`. A module that is not offered (rewards, host payouts) is not in the list at all.
- **Demo mode** keeps switches in the browser's demo cookie, like the demo team and demo cards, with a reset button. Nothing is written anywhere.

### Who may change it

- **Owners only**, on Settings → Modules (`/settings/modules`). Managers see the same page read only. Technicians and viewers do not see it (404). Host users never see it.
- The server action calls `requireRole("owner")`, then `cpo_set_module`, which checks again in the same statement. After a change the server logs the actor's user ID, the module and on or off (no email).
- The page shows, for each module, what it shows, the API scopes it needs and the role checks it keeps, so an owner knows which permissions to add to the key in the Ivora dashboard. The kit cannot read the key's scopes (see gaps); a missing scope shows Ivora's error code where it is needed, as today.

### Environment defaults

For one-click deploys, each module has an environment variable that sets its default:

| Variable                 | Module                       |
| ------------------------ | ---------------------------- |
| `MODULE_NETWORK`         | Site hosts                   |
| `MODULE_FLEET`           | Fleet and RFID cards         |
| `MODULE_ROAMING`         | Roaming                      |
| `MODULE_STATUS_EMAILS`   | Station status emails        |
| `MODULE_REMOTE_COMMANDS` | Remote commands and firmware |
| `MODULE_PROMOTIONS`      | Promotions                   |

- Values: `on` (also `1`, `true`, `yes`) or `off` (also `0`, `false`, `no`), any case. Unset, empty or `demo` means "no default": the built-in default (off) applies. Any other value is ignored with a warning on the Set up page and the Modules page, and the built-in default applies.
- `FLEET_MODULE`, the variable the kit reads today, stays as an alias of `MODULE_FLEET`. When both are set, `MODULE_FLEET` wins.
- They are read on the server only (in `lib/server/env.ts`) and listed in `.env.example` and the README's variable table.

**Resolution**, on the server, once per request:

1. A row in `cpo_operator_modules` for this operator and module: its `enabled` wins.
2. Otherwise the module's environment variable, if it is `on` or `off`.
3. Otherwise the built-in default: off.

So an environment variable sets the starting state, and an owner's choice in the kit then overrides it. To return a module to the environment default, the Modules page has **Use the deployment default**, which deletes the row (through the same function, with the same checks).

### Disabled behaviour

When a module resolves to off:

- **Navigation:** its entries are hidden. `modulesFor()` and `visibleModules()` take the resolved switches instead of `{ fleet }`. Parts of core screens that belong to the module are hidden too (Live's command buttons, Chargers' remote test step, the Pricing discounts section, the Settings → Roaming tab, the host switches that depend on it).
- **Routes return not found:** every page and layout of the module calls `requireModule(key)` first, which calls `notFound()`. It runs before the role check, so a disabled module answers 404 to everyone, the same as a route that does not exist. Route handlers that belong to a module answer `404` with no body.
- **Server actions refuse:** each action of the module calls `requireModule(key)` first and returns a not-found error without calling Ivora or writing to the database. A form left open in a browser when the module was turned off therefore does nothing.
- **Background jobs do not run:** the settlement sweep skips the module's step (the card ledger; the status events catch-up). The webhook handler verifies the signature, records the event ID and acknowledges with `2xx` as today, but does not run the module's handler (fault and status emails). Events skipped while off are not replayed when the module is turned on again, because handlers treat webhooks as signals and read the current state from the API.
- **Data is kept:** turning a module off deletes nothing in the kit or in Ivora. Turning it on again shows the same hosts, cards and settings. The card ledger has a gap for the time the module was off, and its page says from when its figures are complete.
- **Turning off warns** with what stays active in Ivora: roaming publication, cards that can still charge, tariffs that still carry discounts, host logins (kept but refused).
- **Tests** per module: with the switch off, the page answers 404, each action refuses with no Ivora call (`fetch` stubbed to fail), the nav hides the entry, and the sweep or webhook step is skipped.

## Parity list

For each core area and module: the Ivora dashboard feature it corresponds to and the API calls it uses. Calls in the module table above are not repeated here. "Not in the kit" rows are dashboard features with no kit counterpart, so missing coverage is visible.

| Kit area                  | Dashboard feature it corresponds to                           | API calls                                                                                                                                                                                                                                                                                                                                                                          | Coverage                                                                                          |
| ------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Overview                  | Project home                                                  | `GET /locations`, `GET /stations`, `GET /stations/{station_id}`, `GET /transactions?station_id=&after=`, `GET /transactions/{transaction_id}`                                                                                                                                                                                                                                      | Full                                                                                              |
| Chargers                  | Stations: add, credentials, edit, delete                      | `POST /locations`, `POST /stations`, `GET /stations?external_reference=`, `PUT /stations/{station_id}/credentials`, `PATCH /stations/{station_id}`, `DELETE /stations/{station_id}`, `GET /operations/{operation_id}`                                                                                                                                                              | EVSE and connector edits and charger configuration not in the kit (API exists; see below)         |
| Live                      | Station status and faults                                     | `GET /stations/{station_id}/faults`, `GET /transactions?active=`; webhook `connector.status_changed`, `station.fault_opened`                                                                                                                                                                                                                                                       | Full (commands are the Remote commands module)                                                    |
| Sessions and receipts     | Sessions, bills, payments                                     | `POST /bills`, `GET /bills/{bill_id}`, `POST /bills/{bill_id}/start`, `POST /bills/{bill_id}/finalize`, `POST /v1/billing/bills/{bill_id}/alerts`, `POST /payment/stripe/v1/tenants/{tenant_id}/payments`, `GET …/payments/{payment_id}`, `POST …/payments/{payment_id}/capture`, `POST …/payments/{payment_id}/release`, `POST /stations/{station_id}/commands` (`start`, `stop`) | Refunds not in the kit (the API has `POST …/payments/{payment_id}/refund` with `billing:refund`)  |
| Pricing                   | Tariffs                                                       | `POST /tariffs`, `GET /tariffs?external_reference=`, `DELETE /tariffs/{tariff_id}`, `POST /tariffs/simulate`, `GET /tariffs/{tariff_id}`, `POST /tariffs/{tariff_id}/quote`                                                                                                                                                                                                        | Connector, location and project default tariffs and location tax not used (API exists; see below) |
| QR and checkout link      | Driver branding, return domains                               | `PUT /branding`, `PUT /branding/logo`, `GET /return-domains`, `POST /return-domains`, `POST /return-domains/{domain_id}/verify`                                                                                                                                                                                                                                                    | QR stickers are the kit's own codes on the deployer's domain                                      |
| Reports                   | Statistics, sessions, bills                                   | `GET /stats`, `GET /transactions` (`started_from`, `started_to`, `station_id`, `order`, `cursor`), `GET /bills` (`created_from`, `created_to`, `station_id`, `order`, `after`), `GET /payment/stripe/v1/tenants/{tenant_id}/account`                                                                                                                                               | Payouts are a link to the Stripe dashboard (no payouts API)                                       |
| Team and sign-in          | None (kit staff are not Ivora dashboard users)                | None (Supabase)                                                                                                                                                                                                                                                                                                                                                                    | By design                                                                                         |
| Site hosts                | None (the kit's own model)                                    | See the module table                                                                                                                                                                                                                                                                                                                                                               | No payouts; host reports have no Ivora figures (gaps 1, 2)                                        |
| Fleet and RFID cards      | RFID tokens                                                   | See the module table                                                                                                                                                                                                                                                                                                                                                               | Figures matched by last 4 characters; cards are project wide (gaps 4 to 7)                        |
| Roaming                   | OCPI settings                                                 | See the module table                                                                                                                                                                                                                                                                                                                                                               | Roaming payments with partners not offered (a later add-on)                                       |
| Station status emails     | Webhooks and events                                           | See the module table                                                                                                                                                                                                                                                                                                                                                               | Full                                                                                              |
| Remote commands, firmware | Station commands                                              | See the module table                                                                                                                                                                                                                                                                                                                                                               | Full for the listed commands                                                                      |
| Promotions                | Tariff billing rules                                          | See the module table                                                                                                                                                                                                                                                                                                                                                               | Rewards not offered (gap 8)                                                                       |
| Not in the kit            | Platform billing, API keys, dashboard team, Stripe connection | None, by rule 4                                                                                                                                                                                                                                                                                                                                                                    | Excluded, stays in the Ivora dashboard                                                            |

**In the public API but not used by the kit or any module yet** (candidates for later work, not gaps): `PUT /stations/{station_id}/evses/{evse_number}/connectors/{connector_id}/tariff`, `PUT /locations/{location_id}/default-tariff` and `PUT /default-tariff` (Ivora-side tariff assignment, `tariffs:write`; the kit keeps its own assignments today); `PUT /locations/{location_id}/tax`; `POST /payment/stripe/v1/tenants/{tenant_id}/payments/{payment_id}/refund`; `GET` and `POST /stations/{station_id}/configuration` (`stations:admin`); `POST /stations/{station_id}/charging-profiles` (smart charging, which is the fleet-depot template's job); `PUT /stations/{station_id}/evses/{evse_number}/display` and display messages; `GET /go-live`.

**Kit documentation to correct (found while checking):** the README's permission tables name `billing:write` for creating and retiring tariffs, but the published API now asks for `tariffs:write` there; and the README's Pricing limits say the public API can't set a connector's tariff, which the endpoint above now does. Both belong in the first implementation ticket.

## Public API gaps

One line each. These are reported, not worked around.

1. No payouts endpoint: a site host's share can't be shown or paid from the kit.
2. `GET /stats` has no `station_id` or `location_id` filter, so a host's report has no Ivora figures.
3. `GET /transactions` and `GET /bills` take one `station_id`, with no list of stations and no `location_id`.
4. `GET /transactions` has no token filter and its items carry no ID token.
5. `GET /transactions/{transaction_id}` shows only the last 4 characters of the token.
6. A token can't be limited to some stations or locations (`TokenInput` has no such field).
7. `PATCH /tokens/{token_id}` takes no precondition (no `If-Match` or expected `updated_at`).
8. No loyalty or rewards resource (points, balances, earned credit).
9. `GET /v1/access` has no documented response schema, so the kit can't tell an owner which scopes its key lacks before a module is turned on.

## Migration for existing deployments

Today four of the six module features are always on, one is behind `FLEET_MODULE` and one is not built:

| Feature today                                                         | Becomes              | On upgrade                                                               | New deployment |
| --------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------ | -------------- |
| Hosts page, host users, Host filter (always on)                       | `network`            | **On**, seeded by the migration                                          | Off            |
| Cards (`FLEET_MODULE`)                                                | `fleet`              | **As today:** no row is seeded, so `FLEET_MODULE` (now an alias) decides | Off            |
| Settings → Roaming (always on)                                        | `roaming`            | **On**, seeded                                                           | Off            |
| Host fault emails (always on, per host switch)                        | `status_emails`      | **On**, seeded, so the host switch keeps working                         | Off            |
| Live start, stop, reset, unlock; Chargers remote test (always on)     | `remote_commands`    | **On**, seeded                                                           | Off            |
| Firmware and diagnostics, staff status emails, promotions (not built) | Parts of the modules | Arrive off inside their module: built after upgrade, they are new UI     | Off            |

- The migration that creates `cpo_operator_modules` also inserts, for every existing row of `cpo_operators`, rows for `network`, `roaming`, `status_emails` and `remote_commands` with `enabled = true` and `source = 'upgrade'` (plain `insert … select … on conflict do nothing`, no `do` block). A fresh database has no operator when the migration runs, so it seeds nothing, and the first owner starts with every module off unless the deployment sets `MODULE_*` variables.
- So nothing disappears on upgrade: every screen that is on today stays on until an owner turns its module off. Seeded rows show "On since the upgrade" on the Modules page.
- When the Firmware panel ships later, it appears in upgraded deployments whose `remote_commands` is on (seeded on), for managers and owners only. There is no separate switch for it in this design (see the open questions).
- The release notes for the version that ships the switches tell owners to review Settings → Modules and list what each switch hides.

## Proposed implementation tickets

Each is one pull request in this template only. None changes the public API.

1. **Module switches: storage, settings page and resolution.** The migration (table, `cpo_set_module`, upgrade seeding), `MODULE_*` variables and the `FLEET_MODULE` alias, `requireModule()`, `modulesFor()` on resolved switches, Settings → Modules (owner edits, manager reads, demo cookie), README and `.env.example`, and the two README permission corrections above. Database tests (grants, owner check, stale `rev`), resolution tests, e2e for the page. Fleet moves onto the new mechanism unchanged.
   Paths: `cpo-starter-kit/supabase/migrations/`, `cpo-starter-kit/lib/`, `cpo-starter-kit/app/(staff)/settings/`, `cpo-starter-kit/app/(staff)/layout.tsx`, `cpo-starter-kit/tests/`, `cpo-starter-kit/e2e/`, `cpo-starter-kit/README.md`, `cpo-starter-kit/.env.example`
2. **Gate site hosts, roaming and fleet on their switches.** Pages, layouts, actions and the sweep step behind `requireModule()`; the host switches that depend on other modules; the off warning; 404, refusal and skip tests per module.
   Paths: `cpo-starter-kit/app/(staff)/hosts/`, `cpo-starter-kit/app/(staff)/settings/roaming/`, `cpo-starter-kit/app/(staff)/cards/`, `cpo-starter-kit/app/(staff)/team/`, `cpo-starter-kit/app/api/cron/settle/`, `cpo-starter-kit/lib/server/`, `cpo-starter-kit/tests/`, `cpo-starter-kit/e2e/`
3. **Remote commands module: gate today's commands.** Live command buttons, availability, the Chargers remote test and the host command switches behind `remote_commands`; checkout's own commands stay core, with a test that a paid session still stops when the module is off.
   Paths: `cpo-starter-kit/app/(staff)/live/`, `cpo-starter-kit/app/(staff)/chargers/`, `cpo-starter-kit/lib/server/live/`, `cpo-starter-kit/lib/server/chargers/`, `cpo-starter-kit/tests/`, `cpo-starter-kit/e2e/`
4. **Remote commands module: firmware and diagnostics.** A Firmware panel per charger (`update_firmware`, `upload_diagnostics`, `station.firmware_status`, `station.diagnostics_status`), manager and up, demo stand-in, idempotency keys, `409 transaction_active` shown.
   Paths: `cpo-starter-kit/app/(staff)/chargers/`, `cpo-starter-kit/lib/server/ivora/`, `cpo-starter-kit/lib/server/chargers/`, `cpo-starter-kit/app/api/webhooks/ivora/`, `cpo-starter-kit/scripts/ivora-webhook.mjs`, `cpo-starter-kit/tests/`, `cpo-starter-kit/README.md`
5. **Station status emails module.** Recipients on the Modules page, offline and fault emails with a 15-minute limit per charger, the events catch-up step in the sweep, webhook event registration, the host fault emails moved under the switch.
   Paths: `cpo-starter-kit/app/api/webhooks/ivora/`, `cpo-starter-kit/app/api/cron/settle/`, `cpo-starter-kit/lib/server/hosts/`, `cpo-starter-kit/lib/server/mail.ts`, `cpo-starter-kit/app/(staff)/settings/`, `cpo-starter-kit/supabase/migrations/`, `cpo-starter-kit/scripts/ivora-webhook.mjs`, `cpo-starter-kit/tests/`, `cpo-starter-kit/README.md`
6. **Promotions module.** Discounts on a tariff (`rules.group_discounts`, `rules.merchant_validation`), previews with adjustments, a validation code at checkout passed to `POST /bills`, the list of tariffs that still carry discounts. Money logic: integer minor units, tests for every adjustment and for checkout with and without a code.
   Paths: `cpo-starter-kit/app/(staff)/pricing/`, `cpo-starter-kit/lib/server/pricing/`, `cpo-starter-kit/app/(driver)/`, `cpo-starter-kit/lib/server/checkout/`, `cpo-starter-kit/tests/`, `cpo-starter-kit/e2e/`, `cpo-starter-kit/README.md`

Tickets 2 to 6 depend on ticket 1. Ticket 4 depends on ticket 3.

## Open questions for review

- **Owners only:** should managers also be allowed to change switches that neither change a charger nor move money (Site hosts, Roaming, Station status emails)? This design says owners only, for one simple rule.
- **Remote commands off on new deployments** hides the chargers' remote start and stop test, a step many operators use when installing. Alternatively the test could stay core as a technician tool. This design follows the rule that anything that can change a charger is off by default.
- **Firmware inside Remote commands:** the ticket groups them as one module. Firmware updates reboot chargers and are rarer than a reset; should they be a seventh switch, so an upgraded deployment (where Remote commands is seeded on) does not gain them automatically?
- **Host payouts** wait for a payouts API (gap 1). Until then network mode ships without payouts, as it does today.
