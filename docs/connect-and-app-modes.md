# Design: Connect your Ivora project, and install as an app

Status: **design for security review. No product code, and no template changes, come with this document.** No build ticket is made Ready until the review is done. Offering Connect on the **hosted demos** depends on an open owner decision (neutrality, [open question 1](#open-questions-for-the-review)); the design applies equally to forks, which can run Connect on their own deployment whatever that decision is. Start with the Ampleaf template ([`cpo-starter-kit`](../cpo-starter-kit)), after its polish mockups are chosen.

Every identifier below (client IDs, URLs, tokens, secrets) is a placeholder. Everything this design expects from Ivora's OAuth is listed once, as an assumption to confirm, in [Assumptions about Ivora OAuth](#assumptions-about-ivora-oauth-to-confirm) and referenced as **(A1)**, **(A2)** and so on. Where an assumption turns out wrong, the design names what changes.

## Why

Today a template reads Ivora with one long-lived API key in its deployment settings, and the hosted demos show sample data only. An operator who wants to try a template on their own account must create a key, copy it and deploy. With Ivora's OAuth (authorization code with PKCE, the flow MCP clients and the CLI use) a visitor could connect one project to a demo and see their own chargers, sessions and prices with no key and no deployment.

This design adds two modes next to the existing API-key mode. The five-minute API-key start does not change.

| Mode        | Who holds the credential                         | Typical use                                           |
| ----------- | ------------------------------------------------ | ----------------------------------------------------- |
| **API key** | Deployment settings (today)                      | A fork running for one operator                       |
| **Connect** | A short-lived OAuth connection, per visitor      | Trying a demo on your own project (read-only)         |
| **App**     | Client credentials, one installation per project | A deployment that serves several operators, as an app |

## Assumptions about Ivora OAuth (to confirm)

Nothing in this list is stated as fact; each item is checked against the Ivora OAuth reference before the build ticket that relies on it is made Ready.

| #   | Assumption                                                                                                                                                                     | If it is wrong                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| A1  | Authorization code flow with PKCE (S256) for a **public client** (no client secret), with an authorization, a token and a revocation endpoint.                                 | A confidential client: the secret becomes a server variable like the encryption key.                 |
| A2  | Access tokens last about **15 minutes**.                                                                                                                                       | Only the refresh frequency changes.                                                                  |
| A3  | Refresh tokens **rotate**: each refresh returns a new one and invalidates the old, and presenting an old one is reported as reuse.                                             | Without rotation, reuse handling falls away and the short session limit carries the risk alone.      |
| A4  | A connection lasts **at most 90 days** and the operator can **remove it from the Ivora dashboard**.                                                                            | The demo's own limits (§3) are shorter anyway; dashboard removal is then only the demo's Disconnect. |
| A5  | On the consent screen the operator **picks one project**, and the token response names that project's ID.                                                                      | Without the project ID in the response, the demo reads it from a token-info call before any use.     |
| A6  | The consent screen shows the **client name and its domain** and the requested scopes in plain words.                                                                           | The malicious-fork mitigation (§3) weakens; the demo's own page must then name its domain louder.    |
| A7  | OAuth scope names equal the API-key permission names (`stations:read`, `billing:write`, …), and Ivora enforces them on every call.                                             | The scope table keeps its shape; only the names change.                                              |
| A8  | A client ID can be created in the **Ivora dashboard**; dynamic client registration may or may not exist.                                                                       | Forks follow whichever registration path exists.                                                     |
| A9  | A second authorization request for the same client and project, with more scopes, returns a new grant that can replace the first.                                              | The second consent becomes "disconnect and connect again with write scopes".                         |
| A10 | OAuth may not be available for **production** projects at first; a test environment with OAuth exists.                                                                         | If production is available, §7's message is not shown; if no test environment exists, see §7.        |
| A11 | Apps: Ivora lets a maintainer register an app with required and optional scopes, operators install it into one project, and Ivora tells the app about installs and uninstalls. | App mode (§5) waits.                                                                                 |
| A12 | Apps authenticate with **client credentials** and get access tokens valid about **10 minutes** for one installation.                                                           | Only the token cache lifetime changes.                                                               |
| A13 | The authorization response carries an `iss` parameter (RFC 9207), or each environment has a distinct issuer the client can check.                                              | The future production client relies on per-environment callback paths alone (§3, mix-up).            |

## 1. The Connect flow on a demo

Demo mode stays the default. A visitor who does nothing sees sample data exactly as today.

1. **Button.** The demo banner gains a second action: "Connect your Ivora project". It is a plain `POST` form to `/connect/start` (not a link, so crawlers and prefetch never start a flow).
2. **Start.** The server creates a random `state` and a PKCE `code_verifier`, stores both server side (the verifier itself, encrypted, because the token exchange needs it; a hash would be useless) in a pre-login record bound to a short-lived pre-login cookie `__Host-connect_pre` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 10 minutes, one use), and redirects the browser to Ivora's authorization endpoint (A1) with `response_type=code`, the client ID, the exact registered redirect URI, the requested scopes, `state`, and `code_challenge` (S256). The pre-login record also stores which Ivora environment the flow was started against.
3. **Consent (on Ivora).** The visitor signs in to Ivora if needed, picks one project (A5) and sees the requested scopes (A6). The demo never sees the visitor's Ivora password. The consent screen is Ivora's; the demo only chooses which scopes to request.
4. **Callback.** `GET /connect/callback?code=…&state=…`. The server checks the pre-login cookie, compares `state` in constant time, consumes the record, checks the issuer (A13), and exchanges the code with the stored `code_verifier` for tokens (server to server). On `error=access_denied` it returns to demo mode with a neutral message. The callback never redirects to a URL taken from the request.
5. **After connecting.** The server stores the connection with the project ID from the token response (A5), creates a demo session (random 256-bit ID in a `__Host-demo_session` cookie, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`) mapped to the connection, then redirects to the overview. The browser never receives an Ivora token.
6. **What the demo shows.** The same screens as today, fed by the visitor's project through the same server-only Ivora client: sites, chargers and connectors with status, sessions, prices (tariffs), reports and the Live page. Screens that depend on the template's own database (team, onboarding forms, checkout and settlement records, QR stickers) keep showing labelled sample data, because the demo has no records of the visitor's operation. The page says so ("Sample data: this screen is not connected").
7. **Banner.** While connected, every page shows a persistent banner: **"Live data from your project"**, with the project name, a read-only badge (or "Changes allowed" after §2's second consent), when the connection ends, and a **Disconnect** button. It cannot be dismissed. The sample-data banner is replaced, never shown together with it on the same data.
8. **Disconnect.** `POST /connect/disconnect` revokes the refresh token at Ivora (A1), deletes the stored connection and the demo session, clears the cookie, and returns to demo mode. If revocation fails, the local deletion still happens and the page tells the visitor how to remove the connection on Ivora's side (A4).
9. **End of session or connection.** The connection never outlives its demo session. When the session ends (idle limit or maximum age, §3), the connection is revoked and deleted with it. When Ivora rejects the refresh token (expired, removed, or reused), the next request deletes the connection and shows demo mode with "Your connection ended. Connect again."

Nothing is sent to Ivora on a visitor's behalf except reads (and, only after the second consent, the writes of §2). A demo with no connected visitors has no stored tokens at all.

## 2. Scopes

The scope names are the permissions Ampleaf already documents in its [README](../cpo-starter-kit/README.md#permissions-per-module) (A7). A token carries only the scopes approved on the consent screen; the demo additionally hides what the token cannot do.

**Rule: read-only by default.** The first consent requests read scopes only. Write actions stay disabled (visible but greyed, with "Needs write access") until the operator approves write scopes in a **second, separate consent**: a deliberate "Allow changes" action in the banner starts a new authorization request for the extra scopes, shown on its own consent screen (A9). It is never bundled into the first request, and never pre-triggered by clicking a disabled button.

### Minimum scopes per Ampleaf feature

| Feature                                   | Read-only (first consent)                      | Only after the second consent (write)                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview (sites, chargers, live sessions) | `stations:read`, `billing:read`                | none                                                                                                                                                    |
| Live (status, faults, sessions)           | `stations:read`, `billing:read`                | Commands (start, stop, reset, unlock): `stations:control`; the first remote start also `tokens:read`, `tokens:write`                                    |
| Pricing (view tariffs, preview)           | `stations:read`, `billing:read`                | `billing:write` (new tariff version, retire)                                                                                                            |
| Reports                                   | `stations:read`, `billing:read`                | none                                                                                                                                                    |
| Chargers (list, status)                   | `stations:read`                                | `stations:write` (add a site or charger, move a charger); the remote start/stop test: `stations:control`, `billing:read`, `tokens:read`, `tokens:write` |
| Cards (optional module)                   | `stations:read`, `billing:read`, `tokens:read` | `tokens:write` (add, block, import)                                                                                                                     |

The read-only request is the union of the read column: `stations:read`, `billing:read`, and `tokens:read` only when the Cards module is on. Write approval is requested per group, so an operator who only wants remote control approves that group alone:

| Write group    | Scopes requested in the second consent            | Unlocks                                            |
| -------------- | ------------------------------------------------- | -------------------------------------------------- |
| Remote control | `stations:control`, `tokens:read`, `tokens:write` | Live commands, the Chargers remote start/stop test |
| Pricing        | `billing:write`                                   | New tariff version, retire                         |
| Chargers       | `stations:write`                                  | Add a site or charger, move a charger              |
| Cards          | `tokens:write`                                    | Add, block, import cards                           |

Every remote command in a connected demo (start, stop, reset, unlock, the charger test) asks for a confirmation that names the charger and the project and says it acts on real hardware; the first remote start also says it creates an authorization token in the project. The hosting party can turn the second consent off entirely with `CONNECT_ALLOW_WRITES=false`.

### Unavailable in a connected demo altogether

These stay disabled or sample-only even with write scopes, because a public demo must not do them for a visitor:

- **Onboarding.** Driver-page branding and logo, registering and verifying a return domain, and the Stripe status belong to the operator's own deployment and domain.
- **Driver checkout and payments.** No bills, holds, captures or refunds in the demo, and no QR stickers pointing at a demo domain. Checkout needs the operator's own Stripe account and their own domain.
- **Roaming (OCPI publishing).** A demo never publishes or changes a project's roaming data.
- **Webhook registration** (`webhooks:write`) and any settlement sweep: a demo never registers endpoints in a visitor's project, so Live polls instead of using webhooks.
- **Deleting sites or chargers, and setting a new charger connection password.** One-way changes on production hardware; not offered even with `stations:write`.
- **Team, invites and sign-in** of the template's own users (see §4), and anything stored only in the template's database.

## 3. Token handling in a public-code demo

The code is public, so the design must hold when the attacker has read it.

### Where tokens and secrets live

- **Refresh token:** server side only, in the demo's database, encrypted at rest with an application key (AES-256-GCM, a per-row random nonce, the connection ID as additional authenticated data). The key comes from a server environment variable and is never in the database or the repository. A key version column allows rotation (below).
- **Access token:** held in the same row, encrypted, or in server memory only, and refreshed on demand (A2).
- **Never** in the browser (no cookie, local storage, URL or HTML), never in application logs, error messages, analytics, or the response of any route. The Ivora client is `server-only`, as in the [conventions](conventions.md#api-keys-and-tenant-id-stay-on-the-server); log redaction treats `Authorization`, `code`, `state`, `code_verifier`, `refresh_token` and `access_token` as secret. The browser holds only the opaque demo session ID.
- **Host request logs.** The hosting platform's own request logs record the callback URL, including `code` and `state`, outside the template's control. That code is single use, short-lived and useless without the PKCE verifier, which exists only in the database; the callback exchanges it immediately. The hosting party keeps request-log retention short.
- **Production deployment only.** The OAuth client variables, the encryption key and the connection database exist only in the hosted demo's production deployment. Preview builds and branch deployments never receive them and use no connection database, so they show no Connect button; the mode selection (§6) also refuses Connect mode in a preview environment even if the variables leak in.
- A sealed-cookie design (the encrypted token in the browser) is rejected: it would put refresh material on the visitor's device and make revocation and reuse detection impossible.

### Project binding on every call

The connection row stores the project ID from the token response (A5). Every Ivora call takes the tenant ID from that row, never from a request parameter, route or form field, and the client checks before sending that the call's tenant ID equals the connection's project ID. A mismatch, or a token response naming a different project than the stored one after a refresh, ends the connection and writes a security event.

### Caching

Connected reads are never shared between visitors:

- The in-memory read cache (30 seconds at most) is keyed by **connection ID** plus the request, never by URL or project alone, and is dropped on Disconnect.
- Connected reads bypass Next.js data caching: every fetch passes `cache: 'no-store'`, nothing connected goes through `'use cache'`, `unstable_cache` or any other shared cache, and connected pages render dynamically per request (they read the session cookie). Responses carry `Cache-Control: private, no-store`.
- A test runs two connections in parallel against a mocked Ivora with different data and proves neither sees the other's results, and that the Ivora client is called with `no-store` for connected reads.

### Rotation and reuse

- Refresh tokens rotate (A3). The server refreshes under a row lock on the connection, so two concurrent requests from one visitor cannot both refresh. The lock is bounded: the Ivora token call has a 5-second timeout and the lock a matching lock timeout; a second request waits at most that long for the result and otherwise answers "try again" without refreshing itself.
- **Ivora rotated but the database write failed.** The old refresh token is now spent and the new one exists only in memory. The server never retries with the old token (that would look like reuse). It revokes the new refresh token from memory, deletes the connection (best effort), and shows "Your connection ended. Connect again."
- If Ivora reports a **reused** refresh token, treat the connection as compromised: delete it, revoke what can be revoked, show demo mode with "Your connection was closed for safety. Connect again", and write a security event without token content.
- `invalid_grant` from a refresh deletes the connection (§1 step 9). The server never retries a refresh in a loop.

### The second consent

- "Allow changes" starts a new authorization request whose pre-login record also stores the current demo session ID and the connection's project ID.
- The callback accepts it only for the **same demo session** (the session cookie must match the stored session ID) and only if the token response names the **same project**. A grant for a different project is rejected: the new tokens are revoked, the existing connection stays as it was, and the page says "That was a different project. Changes were not allowed."
- On success the stored tokens and granted scopes are replaced **in one transaction** under the connection's row lock, then the previous refresh token is revoked (A9). A failure leaves the previous read-only connection intact.

### What the database stores, and for how long

| Data                                                                                                                       | Retention                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Pre-login record: `state`, the PKCE verifier (encrypted), environment, and for a second consent the session and project ID | 10 minutes, deleted on use                                                                                          |
| Connection: encrypted tokens, key version, project ID, project name, granted scopes, created, last used                    | Until Disconnect or the end of its demo session, whichever is first                                                 |
| Demo session: hashed session ID, connection ID, created, last used                                                         | **2 hours idle** or **24 hours** after connecting, whichever is first; ending it revokes and deletes the connection |
| Security events (reuse, project mismatch, failed callback), without tokens                                                 | 30 days                                                                                                             |
| Ivora response data (chargers, sessions, prices)                                                                           | **Not stored.** Read per request and cached only in memory, 30 seconds at most                                      |

Expiry is checked on every request (an expired session is revoked and deleted before anything is shown), and a scheduled job every 15 minutes revokes and deletes whatever expired without a further request (the demo's existing cron mechanism, with a bearer secret). The demo stores no email, name or Ivora profile data of the visitor.

### Key rotation

The encryption key has a version. To rotate: add the new key as current and keep the old one for decryption only; a re-encrypt job decrypts every row with its recorded version and writes it back under the new one, in batches; once no row has the old version, remove the old key. Because no connection lives longer than 24 hours, waiting a day after switching the current key also drains old rows; the re-encrypt job is for an urgent rotation.

### How a fork configures its own OAuth client

A fork never uses the hosted demo's client. It registers its own with Ivora (A8) and sets, as server variables (all listed in `.env.example` with empty values):

| Variable                   | Purpose                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `IVORA_OAUTH_CLIENT_ID`    | The fork's registered client ID                                                                    |
| `IVORA_OAUTH_REDIRECT_URI` | Exactly one redirect URI on the fork's own https domain, registered with Ivora                     |
| `IVORA_OAUTH_SCOPES`       | Optional narrowing of the requested scopes                                                         |
| `CONNECT_ENCRYPTION_KEY`   | 32 random bytes (base64) for token encryption; `CONNECT_ENCRYPTION_KEY_PREVIOUS` during a rotation |
| `CONNECT_ALLOW_WRITES`     | `false` hides the second consent entirely                                                          |

The redirect URI is an exact match on Ivora's side; the template never builds it from request headers. A fork without these variables simply has no Connect button.

### Threats

| Threat                                       | Mitigation                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stolen demo database**                     | Tokens are encrypted with a key that is not in the database; no connection lives more than 24 hours; refresh tokens rotate (A3); no Ivora response data is stored; scopes are read-only by default. Residual risk: database plus key together. The key lives in the host's secret store, separate from the database credentials, and is rotated by key version.                                      |
| **Preview or branch build reaching secrets** | The OAuth client, the encryption key and the connection database exist only in the production deployment; previews get none and refuse Connect mode (§6).                                                                                                                                                                                                                                            |
| **Malicious fork imitating the demo**        | It can only phish with its own client. The real client's redirect URI is exact-match registered on one domain; the README and banner name the demo's one canonical domain; the consent screen is expected to show the client name and domain (A6); the operator can remove a connection on Ivora's side (A4). The code is public and anyone may fork it, so this is reduced, not removed.            |
| **Open redirect**                            | The redirect URI is fixed and exact. A `return_to` after connecting is not accepted from the request; the server redirects to a fixed path, or to a path from a short allow-list stored with `state`.                                                                                                                                                                                                |
| **CSRF on the callback**                     | `state` bound to the `__Host-` pre-login cookie, single use, 10 minutes; PKCE verifier bound the same way; the start, "Allow changes" and Disconnect routes accept `POST` only and check `Origin`. A callback without a matching pre-login cookie is rejected without exchanging the code. Login CSRF (an attacker connecting their project to a victim's session) is prevented by the same binding. |
| **Project swap**                             | Every call checks its tenant ID against the connection's project ID; the second consent must return the same session and project, or it is rejected and revoked.                                                                                                                                                                                                                                     |
| **Scope creep**                              | Scopes are fixed in code per feature, not read from the request. The first consent is read-only. Writes need the separate consent; the demo compares the granted scopes in the token response with what it asked for and refuses a connection that holds more. A new feature that needs a new scope is a code change reviewed with the scope table.                                                  |
| **Cross-visitor data via caches**            | Cache keyed by connection ID; `no-store` for connected reads; dynamic rendering; a test with two connections (§3, Caching).                                                                                                                                                                                                                                                                          |
| **Mix-up between environments**              | Today there is one client and one environment. A future production client is a separate client with its own callback path; the pre-login record stores the environment, the callback checks the issuer (A13), and the code is exchanged only at the recorded environment's token endpoint.                                                                                                           |
| **Token in logs, errors or referrers**       | Redaction list above; the application never logs the callback URL; host request logs are covered above; the callback responds with a redirect and `Referrer-Policy: no-referrer`, so `code` is not leaked onward.                                                                                                                                                                                    |
| **Visitor session theft**                    | `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Lax`, random 256-bit ID stored hashed, 2 hours idle and 24 hours at most; no data is shown from another visitor's connection (every query is keyed by the session's connection ID).                                                                                                                                                                |
| **Abuse of a connected demo as a proxy**     | The demo exposes only its own fixed routes, never a generic pass-through to Ivora; rate limits per session and per address; writes limited by §2.                                                                                                                                                                                                                                                    |
| **Denial by connection flooding**            | Rate limit on `/connect/start`; pre-login records expire in 10 minutes; a cap on new connections per day.                                                                                                                                                                                                                                                                                            |

The security review must also check the neutrality point (open question 1).

## 4. Not in scope: Ivora sign-in for a template's own users

Connect and app mode are about a template **reading and acting on an Ivora project**. They are not a login for the people who use the template. In a real deployment the operator owns those logins: staff of the CPO template sign in through the operator's own system (Supabase Auth in Ampleaf today), and drivers (who need no account in Ampleaf's checkout) never see Ivora. Ivora sign-in for operator staff or drivers is a separate decision with its own design, and nothing here assumes it. In a connected demo, the demo's own sign-in stays the labelled demo owner; the Ivora connection grants no role in the template's team.

## 5. Install as an app

The same template can register as an **Ivora app** that an operator installs into a project from Ivora (A11), instead of every operator forking and deploying their own copy.

- **Registration.** The party operating the deployment registers the app with Ivora, declaring its name, the scopes it needs, its install URL and its webhook URL. The registered scopes come from the **same scope table** as §2: the table in code is the single source, and the Connect flow and the app manifest both derive from it. A feature's read scopes are the app's required scopes; its write groups are optional scopes the operator can approve at install, unchecked by default. Features unavailable in a connected demo (§2) are not limited this way in app mode, because the operator runs the template for real; they are listed with their scopes as optional.
- **Install.** The operator approves the scopes for one project in Ivora, and Ivora tells the app about the installation (A11). The app stores an installation record: installation ID, project ID, granted scopes, status. The approval at install replaces the Connect consent screens.
- **Linking a template user to an installation.** The template's own users (§4) are not Ivora users, so the link is made once, with a **signed one-time install claim**. After install, Ivora sends the operator to the app's install URL with the installation ID. The app verifies the installation server to server with its client credentials, never trusting the URL alone, and issues a claim: random, stored hashed, bound to that installation, single use, 15 minutes. (If Ivora can sign such a claim itself, the app verifies Ivora's signature instead, A11.) The operator signs in to or signs up for the template and redeems the claim, which makes them the owner of that installation in the template; further staff are invited inside the template as today. An installation with no redeemed claim shows no data to anyone, and a claim cannot be redeemed twice or for another installation.
- **Credentials.** The app authenticates with client credentials (A12): a client ID and secret held in the deployment's server settings, exchanged for a short-lived access token for a given installation. Tokens are requested on demand, held in memory, keyed by installation ID, and never stored. The client secret is a deployment secret: server-only, production deployment only, never logged, rotated by the operator who runs the deployment.
- **One deployment, several installs.** Every request resolves the installation from the signed-in user's link (above), never from a request parameter the user controls, then requests a token for that installation and calls Ivora with the installation's project ID, checked as in §3. All data access is keyed by installation ID, in code and in the database (with the same RLS discipline as the [10-30 rule](conventions.md#supabase-and-the-10-30-rule)); a test creates two installations and proves one cannot read the other. Webhook deliveries are verified per [conventions](conventions.md#webhooks) and routed to the installation named in the event.
- **Uninstall.** An uninstall notification deletes the installation record, its user links and anything keyed to it, within one hour.
- **Neutrality.** A template does not become an Ivora-hosted service by being installable. The installable deployment is run by whoever registers the app, under their brand, as for any partner app; see [neutrality](neutrality.md) and open question 1.

## 6. Switching modes by configuration

Mode is decided at startup from server variables, in one function with a test, in this order:

1. `DEMO_MODE=true`: demo, nothing else is read.
2. `IVORA_API_KEY` and `IVORA_TENANT_ID` (and Supabase) set: **API-key mode**, exactly as today. The five-minute start is untouched: the OAuth variables are optional and absent from the quick-start steps.
3. `IVORA_OAUTH_CLIENT_ID`, `IVORA_OAUTH_REDIRECT_URI` and `CONNECT_ENCRYPTION_KEY` set, no API key, production deployment: **Connect mode**: demo by default, per-visitor connections.
4. `IVORA_APP_CLIENT_ID` and `IVORA_APP_CLIENT_SECRET` set: **app mode**.
5. Nothing set: demo.

Setting variables from two of modes 2 to 4 at once is a startup error that names the conflict, since the credential source would be ambiguous. In a preview or branch deployment, modes 3 and 4 fall back to demo with a log line naming the reason (§3). Every feature asks one interface for "can I do X" (scopes granted, or the API key's permissions), so the screens behave the same in all modes. API-key mode keeps showing a missing permission as Ivora's error code; Connect and app modes show "Needs write access" or "Not approved at install".

## 7. Environments

- **Hosted demo:** its OAuth client points at Ivora's **test environment**, never production, in line with "one project per deployment, test resources for previews". A visitor connects a test-environment project (A10). The banner says "Connected to the Ivora test environment" and the project name.
- **Operator with a production account:** while OAuth is not available for production projects (A10), the Connect page does not fail with an error. It says plainly: "Connecting production projects is not available yet. You can try this demo with sample data, connect a test-environment project, or run your own copy with an API key (about five minutes)", with a link to the README quick start. This is decided from configuration (the environments the deployment has a client for), not from a failed authorization attempt, so no visitor sees a raw error. Connecting production projects later is a second client with its own variables, callback path and button, never one client with an environment switch (§3, mix-up).
- If no test environment with OAuth exists (A10), the hosted demo keeps sample data only and Connect ships as a documented capability for forks.

## 8. Phasing, build tickets and open questions

Nothing below is Ready until the security review of this document is done, and B3 also waits for the owner's neutrality decision (open question 1).

| #   | Ticket                                                                                                                                                                                                                                                                                                                               | Size     | Depends on                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------- |
| B1  | Scope table in code for Ampleaf (features, read scopes, write groups), capability interface, mode selection function including the preview refusal, tests                                                                                                                                                                            | S        | review                                         |
| B2  | Connect core: start, callback with `state`, PKCE and issuer check, token exchange, encrypted store with key version, project binding, migration (additive), Disconnect, session-bound expiry and cleanup job, redaction, connection-keyed cache with `no-store`, tests with a mocked Ivora (including the two-connection cache test) | L        | B1                                             |
| B3  | Connect UI in Ampleaf: button, "Live data from your project" banner, sample-only labels on unconnected screens, production-not-available page, e2e on mocked Ivora                                                                                                                                                                   | M        | B2, the chosen polish mockups, open question 1 |
| B4  | Second consent: per-group request bound to session and project, atomic token replacement, disabled-state UI, confirmation on remote commands, `CONNECT_ALLOW_WRITES`                                                                                                                                                                 | M        | B3                                             |
| B5  | Security hardening: reuse handling, bounded lock and "rotated but not saved" tests, project-mismatch tests, threat-list tests (open redirect, CSRF, scope creep), re-encrypt job, log scan                                                                                                                                           | M        | B2                                             |
| B6  | Fork docs: README sections, `.env.example`, client registration steps, mode switching, key rotation                                                                                                                                                                                                                                  | S        | B3                                             |
| B7  | App mode: manifest from the scope table, installation records, signed one-time install claim, client credentials, per-installation isolation tests, uninstall                                                                                                                                                                        | L        | B1, B5, A11 confirmed                          |
| B8  | Rollout to the other templates (forecourt-checkout, fleet-depot, installer-kit, emsp-starter) using the shared pattern, one ticket each                                                                                                                                                                                              | S–M each | B6                                             |

Sizes: S under a day, M one to three days, L three to five days. Order: B1, then B2; B5 in parallel with B3; then B4 and B6; then B7.

### Open questions for the review

1. **Neutrality.** The [neutrality rules](neutrality.md) say Ivora never hosts or operates a template as its own service. A hosted demo that holds tokens for visitors' projects is closer to operation than a sample-data demo. Who runs the hosted demos, and does holding connections change that? One option is to keep Connect off the hosted demos and ship it only as a documented capability for forks. The owner decides before B3.
2. Every assumption A1 to A13, checked against the Ivora OAuth reference.
3. The session limits (2 hours idle, 24 hours at most) and the 15-minute install claim: confirm or change in review.
