# Design: Connect your Ivora project, and install as an app

Status: **design for security review. No product code, and no template changes, come with this document.** No build ticket is made Ready until the review is done. Start with the Ampleaf template ([`cpo-starter-kit`](../cpo-starter-kit)), after its polish mockups are chosen.

Every identifier below (client IDs, URLs, tokens, secrets) is a placeholder. Names marked **(to confirm)** are assumptions to check against the Ivora OAuth reference before building; nothing here changes if the real name differs.

## Why

Today a template reads Ivora with one long-lived API key in its deployment settings, and the hosted demos show sample data only. An operator who wants to try a template on their own account must create a key, copy it and deploy. Ivora's OAuth (authorization code with PKCE, 15-minute access tokens, rotating refresh tokens, a connection lasting at most 90 days, removable from the dashboard) lets a visitor connect one project to a hosted demo and see their own chargers, sessions and prices with no key and no deployment.

This design adds two modes next to the existing API-key mode. The five-minute API-key start does not change.

| Mode        | Who holds the credential                         | Typical use                                             |
| ----------- | ------------------------------------------------ | ------------------------------------------------------- |
| **API key** | Deployment settings (today)                      | A fork running for one operator                         |
| **Connect** | A short-lived OAuth connection, per visitor      | Trying a hosted demo on your own project (read-only)    |
| **App**     | Client credentials, one installation per project | A deployment that serves several operators, as an app   |

## 1. The Connect flow on a hosted demo

Demo mode stays the default. A visitor who does nothing sees sample data exactly as today.

1. **Button.** The demo banner gains a second action: "Connect your Ivora project". It is a plain `POST` form to `/connect/start` (not a link, so crawlers and prefetch never start a flow).
2. **Start.** The server creates a random `state` and a PKCE `code_verifier`, stores both server-side bound to a short-lived, `HttpOnly`, `SameSite=Lax`, `Secure` pre-login cookie (10 minutes, one use), and redirects the browser to Ivora's authorization endpoint **(to confirm)** with `response_type=code`, the client ID, the exact registered redirect URI, the requested scopes, `state`, and `code_challenge` (S256).
3. **Consent (on Ivora).** The visitor signs in to Ivora if needed, picks **one project**, and sees the scopes the demo asks for in plain words. The demo never sees the visitor's Ivora password. The consent screen is Ivora's; the demo only chooses which scopes to request.
4. **Callback.** `GET /connect/callback?code=…&state=…`. The server checks the pre-login cookie, compares `state` in constant time, consumes it, and exchanges the code with the `code_verifier` for tokens (server to server). On `error=access_denied` it returns to demo mode with a neutral message. The callback never redirects to a URL taken from the request.
5. **After connecting.** The server creates a demo session (random 256-bit ID, `HttpOnly` cookie) mapped to the connection, then redirects to the overview. The browser never receives an Ivora token.
6. **What the demo shows.** The same screens as today, fed by the visitor's project through the same server-only Ivora client: sites, chargers and connectors with status, sessions, prices (tariffs), reports and the Live page. Screens that depend on the template's own database (team, onboarding forms, checkout and settlement records, QR stickers) keep showing labelled sample data, because the demo has no records of the visitor's operation. The page says so ("Sample data: this screen is not connected").
7. **Banner.** While connected, every page shows a persistent banner: **"Live data from your project"**, with the project name, a read-only badge (or "Writes approved" after §2's second consent), the time the connection expires, and a **Disconnect** button. It cannot be dismissed. The sample-data banner is replaced, never shown together with it on the same data.
8. **Disconnect.** `POST /connect/disconnect` revokes the refresh token at Ivora **(to confirm: revocation endpoint)**, deletes the stored connection and the demo session, clears the cookie, and returns to demo mode. If revocation fails, the local deletion still happens and the page tells the visitor to remove the connection from the Ivora dashboard.
9. **Expiry.** When the refresh token is rejected, expired (90 days at most) or removed in the dashboard, the next request deletes the connection and shows demo mode with "Your connection ended. Connect again."

Nothing is sent to Ivora on a visitor's behalf except reads (and, only after the second consent, the writes of §2). A demo with no connected visitors has no stored tokens at all.

## 2. Scopes

The scope names are the permissions the templates already document (for example in the [Ampleaf README](../cpo-starter-kit/README.md#permissions-per-module)); that OAuth scopes use the same names is **to confirm**. A token carries only the scopes approved on the consent screen, and Ivora enforces them; the demo additionally hides what the token cannot do.

**Rule: read-only by default.** The first consent requests read scopes only. Write actions stay disabled (visible but greyed, with "Needs write access") until the operator approves write scopes in a **second, separate consent**: a deliberate "Allow changes" action in the banner starts a new authorization request for the extra scopes, shown on its own consent screen. It is never bundled into the first request, and never pre-triggered by clicking a disabled button.

### Minimum scopes per Ampleaf feature

| Feature                                   | Connect (read-only, first consent)         | Only after the second consent (write)                    |
| ----------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| Overview (sites, chargers, live sessions) | `stations:read`, `billing:read`            | none                                                     |
| Live (status, faults, sessions)           | `stations:read`, `billing:read`            | `stations:control` (start, stop, reset, unlock)          |
| Pricing (view tariffs, preview)           | `stations:read`, `billing:read`            | `billing:write` (new tariff version, retire)             |
| Reports                                   | `stations:read`, `billing:read`            | none                                                     |
| Chargers (list, connection test)          | `stations:read`                            | `stations:write` (add, move, remove, new password)       |
| Cards (optional module)                   | `stations:read`, `billing:read`, `tokens:read` | `tokens:write` (add, block, import)                  |
| Roaming (placeholder)                     | `stations:read`                            | `stations:write`                                         |

The read-only request is the union of the read column: `stations:read`, `billing:read`, `tokens:read` (the last only when the Cards module is on). Write approval is requested per group, so an operator who only wants remote control approves `stations:control` alone.

### Unavailable in a connected demo altogether

These stay disabled or sample-only even with write scopes, because a public demo must not do them for a visitor:

- **Driver checkout and payments.** No bills, holds, captures or refunds in the demo, and no QR stickers pointing at a demo domain. Checkout needs the operator's own Stripe account and their own domain.
- **Remote start on a real charger** by default, even with `stations:control` approved, is behind an extra confirmation naming the charger. (Stop and reset have the same confirmation.) Hosting operators may turn the write mode off entirely with `CONNECT_ALLOW_WRITES=false`.
- **Webhook registration** (`webhooks:write`) and any settlement sweep: a demo never registers endpoints in a visitor's project, so Live polls instead of using webhooks.
- **Team, invites and sign-in** of the template's own users (see §4), and anything stored only in the template's database.
- **Deleting stations or locations** and changing the connection password of a charger stay behind `stations:write`, and are not offered in the connected demo even then. They are one-way changes on production hardware.

## 3. Token handling in a public-code demo

The code is public, so the design must hold when the attacker has read it.

### Where tokens live

- **Refresh token:** server side only, in the demo's database, encrypted at rest with an application key (AES-256-GCM, a per-row random nonce, the connection ID as additional authenticated data). The key comes from a server environment variable and is never in the database or the repository. A key version column allows rotation.
- **Access token (15 minutes):** held in the same row, encrypted, or in server memory only. It is refreshed on demand.
- **Never** in the browser (no cookie, local storage, URL or HTML), never in logs, error messages, analytics, or the response of any route. The Ivora client is `server-only`, as in the [conventions](conventions.md#api-keys-and-tenant-id-stay-on-the-server); log redaction treats `Authorization`, `code`, `refresh_token` and `access_token` as secret. The browser holds only the opaque demo session ID.
- A sealed-cookie design (the encrypted token in the browser) is rejected: it would put refresh material on the visitor's device and make revocation and reuse detection impossible.

### Rotation and reuse

- Refresh tokens rotate: every refresh returns a new one and invalidates the old. The server writes the new token in the same transaction that reads the old one, under a row lock, so two concurrent requests from one visitor cannot both refresh.
- A second request that finds a refresh in progress waits for its result (a short bounded wait) instead of refreshing again.
- If Ivora reports a **reused** refresh token (an old token presented again), treat the connection as compromised: delete it, revoke what can be revoked, show demo mode with "Your connection was closed for safety. Connect again", and write a security event without token content.
- `invalid_grant` from a refresh deletes the connection (§1 step 9). The server never retries a refresh in a loop.

### What the database stores, and for how long

| Data                                                        | Retention                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Pre-login record (`state`, PKCE verifier hash or verifier)  | 10 minutes, deleted on use                                          |
| Connection: encrypted tokens, project ID, project name, granted scopes, created, last used, expiry | Until Disconnect, **7 days idle**, or the 90-day connection limit, whichever is first |
| Demo session: hashed session ID, connection ID, expiry      | Same as the connection; 24 hours maximum per session, renewed on use |
| Security events (reuse, failed callback), without tokens    | 30 days                                                             |
| Ivora response data (chargers, sessions, prices)            | **Not stored.** Read per request and cached only in memory, 30 seconds at most |

A scheduled job deletes everything past its retention (the demo's existing cron mechanism, with a bearer secret). The 7-day idle limit is deliberately shorter than the connection's 90 days, so an abandoned demo does not hold a live token for months. The demo stores no email, name or Ivora profile data of the visitor.

### How a fork configures its own OAuth client

A fork never uses the hosted demo's client. It registers its own with Ivora, either by dynamic client registration **(to confirm availability)** or a client ID created in the Ivora dashboard, and sets, as server variables (all listed in `.env.example` with empty values):

| Variable                  | Purpose                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `IVORA_OAUTH_CLIENT_ID`   | The fork's registered client ID (a public client; PKCE, no secret needed) |
| `IVORA_OAUTH_REDIRECT_URI`| Exactly one redirect URI on the fork's own https domain, registered with Ivora |
| `IVORA_OAUTH_SCOPES`      | Optional narrowing of the requested scopes                                |
| `CONNECT_ENCRYPTION_KEY`  | 32 random bytes (base64) for token encryption                             |
| `CONNECT_ALLOW_WRITES`    | `false` hides the second consent entirely                                 |

The redirect URI is an exact match on Ivora's side; the template never builds it from request headers. A fork without these variables simply has no Connect button.

### Threats

| Threat                                      | Mitigation                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stolen demo database**                    | Tokens are encrypted with a key that is not in the database; access tokens last 15 minutes; refresh tokens rotate and are deleted after 7 idle days; no Ivora response data is stored; the scopes are read-only by default. Residual risk: database plus key together. Keep the key in the host's secret store, separate from the database credentials, and rotate it by key version. |
| **Malicious fork imitating the demo**       | It can only phish with its own client, whose name Ivora shows on the consent screen. Mitigations: the real client's redirect URI is exact-match registered on one domain; the hosted demo's README and banner name its one canonical domain; the consent screen shows the client name and domain, which an operator can check before approving; connections are listed and removable in the Ivora dashboard. The code is public and anyone may fork it, so this is reduced, not removed. |
| **Open redirect**                           | The redirect URI is fixed and exact. A `return_to` after connecting is not accepted from the request; the server redirects to a fixed path, or to a path from a short allow-list stored with `state`. |
| **CSRF on the callback**                    | `state` bound to the pre-login cookie, single use, 10 minutes; PKCE verifier bound the same way; the start and Disconnect routes accept `POST` only and check `Origin`. A callback without a matching pre-login cookie is rejected without exchanging the code. Login CSRF (an attacker connecting their project to a victim's session) is prevented by the same binding. |
| **Scope creep**                             | Scopes are fixed in code per feature, not read from the request. The first consent is read-only. Writes need the separate consent, and the demo compares the granted scopes in the token response with what it asked for, and refuses a connection that holds more. A new feature that needs a new scope is a code change reviewed with the scope table. |
| **Token in logs, errors or referrers**      | Redaction list above; callback URL with `code` is never logged; the callback responds with a redirect (`Referrer-Policy: no-referrer`), so `code` is not leaked onward. |
| **Visitor session theft**                   | `HttpOnly`, `Secure`, `SameSite=Lax` cookie, random 256-bit ID stored hashed, 24-hour maximum; no data is shown from another visitor's connection (every query is keyed by the session's connection ID). |
| **Abuse of a connected demo as a proxy**    | The demo exposes only its own fixed routes, never a generic pass-through to Ivora; rate limits per session and per address; writes limited by §2.                  |
| **Denial by connection flooding**           | Rate limit on `/connect/start`; pre-login records expire in 10 minutes; a cap on connections per day.                                                          |

The security review must also check the neutrality point in §8 (open question 1).

## 4. Not in scope: Ivora sign-in for a template's own users

Connect and app mode are about a template **reading and acting on an Ivora project**. They are not a login for the people who use the template. In a real deployment the operator owns those logins: staff of the CPO template sign in through the operator's own system (Supabase Auth in Ampleaf today), and drivers (who need no account in Ampleaf's checkout) never see Ivora. Ivora sign-in for operator staff or drivers is a separate decision with its own design, and nothing here assumes it. In a connected demo, the demo's own sign-in stays the labelled demo owner; the Ivora connection grants no role in the template's team.

## 5. Install as an app

The same template can register as an **Ivora app** that an operator installs into a project from Ivora, instead of every operator forking and deploying their own copy.

- **Registration.** The template's maintainer (the party operating a deployment) registers the app with Ivora **(to confirm: the app registration process)**, declaring the scopes it needs, its name, its redirect or install URL and its webhook URL. The registered scopes come from the **same scope table** as §2: the table in code is the single source, and the Connect flow and the app manifest both derive from it. A feature's read scopes are the app's required scopes; its write scopes are optional scopes the operator can approve at install.
- **Install.** The operator opens the app in Ivora and approves the scopes for one project. Ivora then tells the app about the installation **(to confirm: install notification)**, and the app stores an installation record: project ID, granted scopes, status. The scope approval at install replaces the Connect consent screens; there is no separate second consent, but optional write scopes are unchecked by default.
- **Credentials.** The app authenticates with **client credentials**: a client ID and secret held in the deployment's server settings, exchanged for an access token valid **10 minutes** for a given installation. Tokens are requested on demand, held in memory, and never stored. The client secret is a deployment secret: server-only, never logged, rotated by the operator who runs the deployment.
- **One deployment, several installs.** Every request resolves the installation first (from the signed-in user's association with an installation, never from a request parameter the user controls), then requests a token for that installation and calls Ivora with it. All data access is keyed by installation ID, in code and in the database (with the same RLS discipline as the [10-30 rule](conventions.md#supabase-and-the-10-30-rule)); a test creates two installations and proves one cannot read the other. Webhook deliveries are verified per [conventions](conventions.md#webhooks) and routed to the installation named in the event.
- **Uninstall.** An uninstall notification deletes the installation record and anything keyed to it, within one hour.
- **Neutrality.** A template does not become an Ivora-hosted service by being installable. The installable deployment is run by whoever registers the app, under their brand, as for any partner app; see [neutrality](neutrality.md) and open question 1.

## 6. Switching modes by configuration

Mode is decided at startup from server variables, in one function with a test, in this order:

1. `DEMO_MODE=true`: demo, nothing else is read.
2. `IVORA_API_KEY` and `IVORA_TENANT_ID` (and Supabase) set: **API-key mode**, exactly as today. The five-minute start is untouched: the OAuth variables are optional and absent from the quick-start steps.
3. `IVORA_OAUTH_CLIENT_ID` and `IVORA_OAUTH_REDIRECT_URI` set, no API key: **Connect mode**: demo by default, per-visitor connections.
4. `IVORA_APP_CLIENT_ID` and `IVORA_APP_CLIENT_SECRET` set: **app mode**.
5. Nothing set: demo.

Setting variables from two of modes 2 to 4 at once is a startup error that names the conflict, since the credential source would be ambiguous. Every feature asks one interface for "can I do X" (scopes granted, or the API key's permissions), so the screens behave the same in all modes. API-key mode keeps showing a missing permission as Ivora's error code; Connect and app modes show "Needs write access" or "Not approved at install".

## 7. Environments

- **Hosted demo:** its OAuth client points at Ivora's **test (sandbox) environment**, never production, in line with "one project per deployment, test resources for previews". A visitor connects a test-environment project. The banner says "Connected to the Ivora test environment" and the project name.
- **Operator with a production account:** while OAuth is not enabled on production, the Connect page does not fail with an error. It says plainly: "Connecting production projects is not available yet. You can try this demo with sample data, connect a test-environment project, or run your own copy with an API key (about five minutes)", with a link to the README quick start. The check is a configuration value (`IVORA_OAUTH_ENABLED_ENVIRONMENTS` or the client list from Ivora, **to confirm**), not a failed authorization attempt, so no visitor sees a raw error. When production OAuth is enabled, it is a second client for production with its own variables, and a separate button, never one client with an environment switch.

## 8. Phasing, build tickets and open questions

Nothing below is Ready until the security review of this document is done.

| #   | Ticket                                                                                                          | Size | Depends on                      |
| --- | --------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------- |
| B1  | Scope table in code for Ampleaf (feature to read/write scopes), capability interface, mode selection function, tests | S    | review                          |
| B2  | Connect core: start, callback with `state` and PKCE, token exchange, encrypted store, migration (additive), Disconnect, expiry and idle cleanup job, redaction, tests with a mocked Ivora | L    | B1                              |
| B3  | Connect UI in Ampleaf: button, "Live data from your project" banner, sample-only labels on unconnected screens, production-not-available page, e2e on mocked Ivora | M    | B2, the chosen polish mockups (SQD-80) |
| B4  | Second consent for write scopes: per-group request, disabled-state UI, confirmation on remote commands, `CONNECT_ALLOW_WRITES` | M    | B3                              |
| B5  | Security hardening pass: reuse handling, concurrency tests for rotation, threat-list tests (open redirect, CSRF, scope creep), log scan | M    | B2                              |
| B6  | Fork docs: README sections, `.env.example`, client registration steps, mode switching                           | S    | B3                              |
| B7  | App mode: manifest from the scope table, installation records, client credentials, per-installation isolation tests, uninstall | L    | B1, B5, Ivora app registration  |
| B8  | Rollout to the other templates (forecourt-checkout, fleet-depot, installer-kit, emsp-starter) using the shared pattern, one ticket each | S–M each | B6                              |

Sizes: S under a day, M one to three days, L three to five days. Order: B1, B2, B5 in parallel with B3, then B4, B6, then B7. App mode (B7) waits for confirmation of how Ivora registers and notifies apps.

### Open questions for the review and for Ivora

1. **Neutrality.** The [neutrality rules](neutrality.md) say Ivora never hosts or operates a template as its own service. A hosted demo that holds tokens for visitors' projects is closer to operation than a sample-data demo. Who runs the hosted demos, and does holding connections change that? One option is to keep Connect off the hosted demos and ship it only as a documented capability for forks; the owner should decide before B3.
2. Exact OAuth endpoints, revocation, scope names and reuse-detection signalling **(all marked to confirm)**.
3. Dynamic client registration, or a client created in the dashboard, for forks.
4. How Ivora registers apps and notifies installs and uninstalls (B7).
5. Whether a sandbox environment exists for OAuth, and the date production OAuth is enabled (§7).
6. Idle limit (7 days) and the session maximum (24 hours): confirm or change in review.
