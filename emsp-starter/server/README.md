# eMSP Starter: server

> **In progress** (part 3 of 13). See the [template README](../README.md) for what the eMSP Starter is and how the server and the app fit together.

The Next.js server of the eMSP Starter: OCPI 2.2.1 eMSP endpoints, the REST API for the driver app, the admin web, and the Supabase migrations.

![Demo: admin overview with the demo banner and the OCPI identity](docs/screenshot.png)

## What it does today

- **Admin web shell:** an Overview with the eMSP's OCPI identity (version, country code, party ID) and, in demo mode, the names of the variables live mode still needs.
- **API:** `GET /api/v1/status` returns the mode, the network name and the OCPI identity. It holds no secrets, so any origin may read it. `GET /api/v1/locations` searches charging locations; see [Locations and tariffs](#locations-and-tariffs).
- **Config and demo mode:** `lib/server/config.ts` reads the environment (server-only); `lib/server/demo.ts` is the one demo-mode switch and the only gate for outbound requests.
- **Database:** an append-only audit log, the OCPI peer registry and the locations and tariffs cache, the migrate script, and the shared 10-30 check.
- **OCPI 2.2.1 core:** the versions and credentials modules, with any number of CPO peers, in both handshake directions. See [OCPI peers](#ocpi-peers).
- **Locations and tariffs:** pulled from every CPO peer (full, then incremental, paginated and resumable) and received as pushes, stored per peer, searchable by the app, with display prices and a price preview. See [Locations and tariffs](#locations-and-tariffs).
- **Admin, CPO peers** (`/admin/peers`): connect to a CPO, create a Token A for a CPO to register with us, rotate tokens, unregister, list peers, pull a peer's locations and tariffs. Temporarily gated by `ADMIN_SECRET`.

## Run locally

Requires Node.js 22.13 or later.

```sh
npm ci
npm run dev
```

With no credentials it starts in **demo mode**, with a "Demo" banner on every page. Demo mode never charges a card, never sends a command or request to a real CPO, and never sends email or push notifications.

## Connect real services

Copy `.env.example` to `.env.local` and fill it in. All variables are server-side only; never prefix one with `NEXT_PUBLIC_`.

| Variable                    | Purpose                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMSP_COUNTRY_CODE`         | Your ISO 3166-1 alpha-2 country code, for example `NL`. Required for live mode.                                                                                                     |
| `EMSP_PARTY_ID`             | Your 3-character OCPI party ID. Required for live mode.                                                                                                                             |
| `PUBLIC_BASE_URL`           | The `https://` origin this server is reached at. CPO peers call the OCPI endpoints on it. Required.                                                                                 |
| `SUPABASE_URL`              | Supabase project URL. Required for live mode.                                                                                                                                       |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key. Bypasses RLS: never logged, never sent to the app. Required for live mode.                                                                               |
| `SUPABASE_DB_URL`           | Postgres connection string, used only by `npm run db:migrate`.                                                                                                                      |
| `OCPI_TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts the tokens CPO peers give us, at rest. Required for live mode. Losing or changing it means re-registering every peer. |
| `ADMIN_SECRET`              | **Temporary**, until admin sign-in (part 7). At least 32 characters (`openssl rand -base64 32`). Every admin action asks for it; without it the admin actions are disabled.         |
| `CRON_SECRET`               | Optional. At least 32 characters. Enables the scheduled pull, `GET /api/cron/ocpi-sync` with `Authorization: Bearer <CRON_SECRET>`. Without it the route answers 503.               |
| `OCPI_TOKEN_A_TTL_DAYS`     | Optional. Days a Token A we issue stays valid, 1 to 90. Default 7.                                                                                                                  |
| `OCPI_ALLOW_PRIVATE_PEERS`  | **Local development and tests only.** `1` lets peer URLs point at loopback or private addresses, for a CPO on your machine. Off by default; ignored when `NODE_ENV` is production.  |
| `DEMO_MODE`                 | Set to `true` (or `1`, `yes`, `on`) to force demo mode even when everything above is set, for example on a public demo.                                                             |

Live mode turns on only when all required variables are set and valid. OCPI peer credentials are not environment variables: they are exchanged with each CPO over the OCPI credentials module and stored in the database, with tokens we issue stored as hashes and peer tokens encrypted at rest.

> **Before going live:** this part has no admin sign-in, only the temporary `ADMIN_SECRET` on admin actions, rate limited per server instance. Run live mode only on a private deployment until the admin part lands.
>
> **Admin lockout:** wrong secrets are limited to 5 per client and 50 in total per 15 minutes. The total cap is what stops guessing from many addresses, but it also means anyone who can reach the admin page can send 50 wrong secrets and lock the real admin out for 15 minutes, from as many forged addresses as they like. The client key is taken from the hosting platform's own client-IP header where there is one (`x-vercel-forwarded-for`, `x-real-ip`), else from the right-most `X-Forwarded-For` entry, the one your proxy added; entries to its left are whatever the client sent. Without a proxy in front of the server every one of these headers can be forged. Until admin sign-in lands, keep the admin page off the public internet (an IP allow-list or a private network) so the lockout cannot be triggered by strangers; restarting the server clears the counts.

## OCPI peers

This server is the eMSP side of OCPI 2.2.1. Every CPO platform is a peer, and none is special. Our endpoints:

| Endpoint                  | What it does                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /ocpi/versions`      | Our versions. Needs a token we issued (a Token A too).                                               |
| `GET /ocpi/2.2.1`         | Version details: credentials, and the locations and tariffs Receiver interfaces.                     |
| `/ocpi/2.2.1/credentials` | `GET` our credentials, `POST` to register (with a Token A), `PUT` to rotate, `DELETE` to unregister. |
| `/ocpi/2.2.1/locations/…` | Locations Receiver: `GET`, `PUT`, `PATCH` a location, EVSE or connector.                             |
| `/ocpi/2.2.1/tariffs/…`   | Tariffs Receiver: `GET`, `PUT`, `PATCH`, `DELETE` a tariff.                                          |

**We register at a CPO.** The CPO gives you its versions URL and a Token A. In **Connect to a CPO**, this server reads the CPO's versions and 2.2.1 details with Token A, issues our Token B, POSTs our credentials to the CPO and stores the Token C it answers with. It then reads the versions again with Token C, from the URL the CPO returned. If anything fails after the CPO accepted us, it unregisters there again.

**A CPO registers with us.** In **Let a CPO register with us**, create a Token A and send it with our versions URL (`PUBLIC_BASE_URL/ocpi/versions`) to the CPO over a secure channel. The token is shown once; only its hash is stored. It expires after `OCPI_TOKEN_A_TTL_DAYS` (default 7 days). The CPO POSTs its credentials with Token A; we read its versions with its token, revoke Token A and answer with a new Token C.

**Rotate and unregister.** Either side can rotate (credentials `PUT`) or unregister (`DELETE`). When we rotate, our old token keeps working until the CPO has answered, so its calls during the update are not refused. When we unregister, we tell the CPO first, and unregister locally anyway if it has already forgotten us (401 or 405).

When a CPO registers with us and its versions cannot be used, it gets `3001 Peer endpoint unreachable or invalid`, whatever went wrong, so the credentials module cannot be used to probe other hosts. The two exceptions name what its own valid versions answer lacks: `3002 Peer offers no OCPI 2.2.1` and `3003 Peer has no credentials endpoint`.

How it works, in `lib/ocpi/`:

- **Registry** (`store.ts`, `store-supabase.ts`): peers with their roles, endpoints per module and status (`pending`, `registered`, `unregistered`, `failed`); a peer's parties may not belong to another registered peer or to us. Tokens we issue are stored as SHA-256 hashes (`emsp_ocpi_issued_tokens`); the token a peer gave us is AES-256-GCM encrypted with `OCPI_TOKEN_ENCRYPTION_KEY`, bound to the peer's ID. In demo mode the registry is in memory.
- **Client** (`client.ts`): the envelope, `Authorization: Token <base64>`, a new `X-Request-ID` per attempt and one `X-Correlation-ID` per operation, routing headers, a pagination iterator over `Link` / `X-Total-Count` / `X-Limit` with `date_from` and `date_to`, retries with exponential backoff and jitter on timeouts, network errors and HTTP 5xx (GET only, unless a call says it is safe to repeat), and OCPI status codes mapped to error classes. It follows no redirects, and never follows a next-page link to another origin.
- **Peer addresses** (`lib/server/peer-fetch.ts`): peers choose the URLs we call, so every request to a peer goes through `peerFetch`. It refuses demo mode, needs `https://`, resolves the host once and refuses it if any address is loopback, private (RFC 1918), link-local, CGNAT, unique-local IPv6, unspecified, multicast, documentation or reserved, including cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`) and IPv4 embedded in IPv6. The socket then connects to the address it checked, so a second DNS answer cannot redirect it (DNS rebinding). When a CPO calls our credentials module, we read its versions with one 5-second try, and any failure gets the same answer, `3001 Peer endpoint unreachable or invalid`: never the remote server's status or body. The details are logged on our side, without tokens.
- **Size limits**: we read at most 1 MB of an OCPI response and 256 KB of a request; a larger `Content-Length` is refused before reading, and a stream is cut at the limit.
- **Server middleware** (`server.ts`): checks the token's hash against the tokens we issued (base64 or the unencoded 2.1.1 form), refuses unknown, unregistered or failed peers with 401, limits a Token A to the versions and credentials modules, and checks the `OCPI-from/to` routing headers on functional modules: "to" must be us and "from" a party of the token. It echoes `X-Request-ID` and `X-Correlation-ID`.
- **Schema** (`schema.ts`): every incoming credentials, versions, version details and envelope object is validated against 2.2.1 before use.

### Mock CPO

`lib/mock-cpo/` is a second, generic OCPI 2.2.1 CPO that runs in-process: versions, credentials (all four methods, both directions), and paginated locations and tariffs Sender interfaces with `date_from` and `date_to`. It pushes changes to our Receiver interfaces (`setEvseStatus`, `putLocation`, `putTariff`, `deleteTariff`) and injects failures (HTTP errors and hangs). Its sample data (`sample-data.ts`: invented sites in an invented city) covers AC and DC, several connector standards, every EVSE state the search cares about, facilities, parking restrictions, an unpublished site and free, energy, time-of-day, idle-fee, parking and flat-fee tariffs. The tests use it as a real peer, with a second instance on another platform that uses the same location and tariff IDs, over an in-process network (`tests/support/network.ts`): no request leaves the process. Demo mode shows the same sample data.

## Locations and tariffs

Every registered CPO's locations (with their EVSEs and connectors) and tariffs are cached in Supabase, per peer, keyed by country code, party ID and ID. Two CPOs that use the same IDs never overwrite each other, and a CPO can only write its own parties' objects.

**Pull** (`lib/locations/sync.ts`), from each peer's Sender interface, tariffs first and then locations:

- The first pull is full. Later ones are incremental: `date_from` is when the last completed pull started, minus 5 minutes for clock differences.
- Pages follow the `Link` header (100 objects asked per page; the CPO may send fewer). After every page the next page's URL is saved, so a pull that fails or stops resumes at that page on the next call. Each call reads at most 50 pages (20 from the cron route).
- One pull per peer and module at a time; a pull with no progress for 5 minutes counts as interrupted and the next call resumes it.
- A completed full pull removes that peer's objects it did not see, unless a push touched them meanwhile.
- Invalid objects, and objects of a party that is not the peer's, are skipped and counted, never stored. A pulled object older (by `last_updated`) than what a push already gave us does not replace it.

Start a pull from **Pull locations and tariffs** in `/admin/peers` (changes since the last pull, or everything), or on a schedule: set `CRON_SECRET` and call `GET /api/cron/ocpi-sync` with `Authorization: Bearer <CRON_SECRET>`, for example every 15 minutes. On Vercel, add a cron for that path in `vercel.json`; Vercel Cron sends the header itself when `CRON_SECRET` is set.

**Push** (`lib/locations/receiver.ts`): a CPO sends changes as they happen to our Receiver interfaces. `PUT` creates or replaces a location, EVSE, connector or tariff; `PATCH` changes some fields of one (it needs `last_updated`, and the result is validated as a whole); `DELETE` removes a tariff. OCPI 2.2.1 defines `PUT` and `DELETE` for tariffs; `PATCH` is accepted from CPOs that send it. Changing an EVSE or connector moves its location's `last_updated` forward. A change older than what we hold is acknowledged and ignored. EVSEs are never deleted: a CPO sets them to `REMOVED`, and removed EVSEs never appear in the app. Unknown objects get `2003`, invalid bodies `2001` naming the fields, another CPO's party `403`. These endpoints need a registered peer's token and the `OCPI-from`/`OCPI-to` routing headers.

**Search API**, for the app (any origin may read it; locations are public information):

`GET /api/v1/locations`, every parameter optional:

| Parameter                      | Meaning                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `lat`, `lng`, `radius_m`       | Within `radius_m` metres (default 5,000, at most 50,000) of the point, nearest first. Without a point, results are sorted by name. |
| `q`                            | Every word appears in the name, address, postal code or city.                                                                      |
| `evse_id`                      | An EVSE ID such as `NL*ABC*E12345`. Case and separators are ignored.                                                               |
| `charger_id`                   | The reference printed on the charger (`physical_reference`), an EVSE uid or a location ID.                                         |
| `status`                       | Comma-separated EVSE statuses, for example `AVAILABLE`.                                                                            |
| `min_power_kw`, `max_power_kw` | A connector's maximum power in this range.                                                                                         |
| `connector`                    | Comma-separated OCPI connector standards, for example `IEC_62196_T2_COMBO,CHADEMO`.                                                |
| `facility`                     | Comma-separated OCPI facilities; the location has all of them.                                                                     |
| `parking`, `exclude_parking`   | OCPI parking restrictions an EVSE must have (for example `DISABLED`), or must not have (for example `CUSTOMERS`).                  |
| `price`                        | `free` or `paid`, by the connector's tariff. A connector without a known tariff is neither.                                        |
| `limit`, `offset`              | Paging: 1 to 100 (default 20), and from 0.                                                                                         |

EVSE filters (status, parking, EVSE ID, charger ID) and connector filters (power, standard, price) must hold for the same EVSE. Each result says how many EVSEs matched, how many are available, the highest power, the connector standards and a one-line price. Only registered peers' published locations appear (in demo mode, the mock CPO's), and a location whose EVSEs are all removed does not. The store narrows the candidates with a bounding box, the words and the ID, reading at most 1,000 per search (Supabase's default **Max rows** for the Data API); for more locations than that around one point, move the search into Postgres (PostGIS).

`GET /api/v1/locations/{id}` returns one location with its EVSEs, connectors and each connector's display price. `GET /api/v1/locations/{id}/price-preview?evse_uid=&connector_id=&kwh=&minutes=[&parking_minutes=][&start=]` estimates what a session there would cost.

**Prices** (`lib/locations/pricing.ts`) are **display only**. A connector's price is its first active `REGULAR` (or untyped) tariff, else its first active one. The display price lists every energy, time, parking and flat component with its conditions in words (days, time of day, dates, duration, energy, power, current, reservation), VAT included when the CPO gives the rate, and the tariff's minimum and maximum price. The preview walks the session minute by minute in the location's time zone, applying for each dimension the first element whose restrictions match (minimum inclusive, maximum exclusive), rounding the last period of each dimension up to its step size, then the tariff's minimum and maximum price. What a driver pays is settled from the CDR in a later part, and you may add your own fees on top of the CPO's tariff.

## Database

Migrations live in `supabase/migrations/`, named `<YYYYMMDDNNNN>_<name>.sql`, and are additive.

```sh
npm run check:migrations   # the 10-30 check, also run in CI
npm run db:migrate         # applies pending migrations using SUPABASE_DB_URL from .env.local
```

| Migration                                 | What it adds                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `202610210001_baseline.sql`               | The append-only audit log.                                                                                                                             |
| `202610210002_ocpi_peers.sql`             | The OCPI peer registry and the hashes of the tokens we issue.                                                                                          |
| `202610210003_ocpi_locations_tariffs.sql` | The locations and tariffs cache (`emsp_ocpi_locations`, `emsp_ocpi_tariffs`) and the state of each peer's pull (`emsp_ocpi_sync_state`). Service-only. |

`db:migrate` runs every pending file in one transaction under an advisory lock and records it in `public.emsp_schema_migrations`. Without `SUPABASE_DB_URL`, run the files in filename order in the Supabase SQL editor.

The **10-30 rule**, checked by the repository's shared checker, [`tools/check-migrations`](../../tools/check-migrations/README.md) (`npm run check:migrations` runs `node ../../tools/check-migrations supabase/migrations`):

- Every table created in `public` enables row-level security and runs `revoke all on <table> from public, anon, authenticated` in the same migration. The revoke keeps older Supabase projects, whose default privileges still grant new tables to the Data API roles, as closed as new ones. No migration may `disable row level security`.
- No default grants (`alter default privileges ... grant`) and no schema-wide grants (`grant ... on all tables in schema` or `all functions`).
- A table grant to `anon`, `authenticated` or `public` needs a policy on that table. The app talks to this server only, so expect no such grants: tables are service-only.
- Every function or procedure created in `public` runs `revoke execute (or all) on function <name> from public` in the same migration, because Postgres grants `EXECUTE` to `PUBLIC` by default. No migration grants `EXECUTE` to `anon`, `authenticated` or `public`.
- Every `security definer` function sets `search_path` (for example `set search_path = ''`).

**If you fork only this template,** copy `tools/check-migrations` into your repository too, keeping the same layout (`emsp-starter/` and `tools/` side by side, so `../../tools/check-migrations` still resolves), or change the path in `package.json` and the workflow. It needs no install.

`tests/migrations.test.ts` applies every migration to an in-memory Postgres ([PGlite](https://pglite.dev)) with Supabase's roles, and checks RLS, table and function grants, `search_path` on `security definer` functions and table behaviour. It runs them twice: on a database like a new Supabase project, and on one with the legacy default grants of older projects. Use `tests/support/pglite.ts` for the tests of new migrations.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIvora-Charge%2Fivora-examples&root-directory=emsp-starter%2Fserver&project-name=emsp-starter-server&repository-name=emsp-starter)

The button deploys the server in demo mode. To go live, apply the migrations, add the variables above in the project's environment settings and redeploy. For the scheduled pull, set `CRON_SECRET` and add a cron for `/api/cron/ocpi-sync`.

## What it uses

OCPI 2.2.1 as the eMSP role, with any CPO. Nothing from the Ivora API yet; an optional Ivora live-data adapter arrives in a later part.

## Limits and next steps

- No admin sign-in yet: `ADMIN_SECRET` is a stopgap with no session. Wrong secrets are limited to 5 per client and 50 in total per 15 minutes, counted per server instance.
- The OCPI version details list credentials, locations and tariffs; later parts add tokens, sessions, CDRs and commands.
- Demo mode keeps peers in memory and refuses to contact a CPO; its locations and tariffs are the mock CPO's sample data, loaded in-process, never pulled.
- Locations with `publish: false` never appear, including those published only to certain tokens (`publish_allowed_to`); showing them to the right drivers needs the tokens module (part 4).
- The search reads at most 1,000 candidates per query from the store; see [Locations and tariffs](#locations-and-tariffs).
- Prices are display only: the CPO's tariff as it says, without your own fees.
- Rotating `OCPI_TOKEN_ENCRYPTION_KEY` needs every peer to be registered again. An expired Token A leaves its peer pending; unregister it to close it.
- Next parts: tokens and real-time authorization, sessions, CDRs, payments and the admin web.

## Checks

```sh
npm run format:check && npm run typecheck && npm run check:migrations && npm test && npm run build
npx playwright install chromium && npm run test:e2e   # offline demo run, desktop and mobile
```

Tests never need credentials or network access.
