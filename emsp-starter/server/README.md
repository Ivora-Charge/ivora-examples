# eMSP Starter: server

> **In progress** (part 2 of 13). See the [template README](../README.md) for what the eMSP Starter is and how the server and the app fit together.

The Next.js server of the eMSP Starter: OCPI 2.2.1 eMSP endpoints, the REST API for the driver app, the admin web, and the Supabase migrations.

![Demo: admin overview with the demo banner and the OCPI identity](docs/screenshot.png)

## What it does today

- **Admin web shell:** an Overview with the eMSP's OCPI identity (version, country code, party ID) and, in demo mode, the names of the variables live mode still needs.
- **API:** `GET /api/v1/status` returns the mode, the network name and the OCPI identity. It holds no secrets, so any origin may read it.
- **Config and demo mode:** `lib/server/config.ts` reads the environment (server-only); `lib/server/demo.ts` is the one demo-mode switch and the only gate for outbound requests.
- **Database baseline:** one migration with an append-only audit log, the migrate script and the 10-30 check.
- **OCPI 2.2.1 core:** the versions and credentials modules, with any number of CPO peers, in both handshake directions. See [OCPI peers](#ocpi-peers).
- **Admin, CPO peers** (`/admin/peers`): connect to a CPO, create a Token A for a CPO to register with us, rotate tokens, unregister, list peers. Temporarily gated by `ADMIN_SECRET`.

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
| `OCPI_TOKEN_A_TTL_DAYS`     | Optional. Days a Token A we issue stays valid, 1 to 90. Default 7.                                                                                                                  |
| `OCPI_ALLOW_PRIVATE_PEERS`  | **Local development and tests only.** `1` lets peer URLs point at loopback or private addresses, for a CPO on your machine. Off by default; ignored when `NODE_ENV` is production.  |
| `DEMO_MODE`                 | Set to `true` (or `1`, `yes`, `on`) to force demo mode even when everything above is set, for example on a public demo.                                                             |

Live mode turns on only when all required variables are set and valid. OCPI peer credentials are not environment variables: they are exchanged with each CPO over the OCPI credentials module and stored in the database, with tokens we issue stored as hashes and peer tokens encrypted at rest.

> **Before going live:** this part has no admin sign-in, only the temporary `ADMIN_SECRET` on admin actions, rate limited per server instance. Run live mode only on a private deployment until the admin part lands.

## OCPI peers

This server is the eMSP side of OCPI 2.2.1. Every CPO platform is a peer, and none is special. Our endpoints:

| Endpoint                  | What it does                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /ocpi/versions`      | Our versions. Needs a token we issued (a Token A too).                                               |
| `GET /ocpi/2.2.1`         | Version details: the modules we implement (credentials for now).                                     |
| `/ocpi/2.2.1/credentials` | `GET` our credentials, `POST` to register (with a Token A), `PUT` to rotate, `DELETE` to unregister. |

**We register at a CPO.** The CPO gives you its versions URL and a Token A. In **Connect to a CPO**, this server reads the CPO's versions and 2.2.1 details with Token A, issues our Token B, POSTs our credentials to the CPO and stores the Token C it answers with. It then reads the versions again with Token C, from the URL the CPO returned. If anything fails after the CPO accepted us, it unregisters there again.

**A CPO registers with us.** In **Let a CPO register with us**, create a Token A and send it with our versions URL (`PUBLIC_BASE_URL/ocpi/versions`) to the CPO over a secure channel. The token is shown once; only its hash is stored. It expires after `OCPI_TOKEN_A_TTL_DAYS` (default 7 days). The CPO POSTs its credentials with Token A; we read its versions with its token, revoke Token A and answer with a new Token C.

**Rotate and unregister.** Either side can rotate (credentials `PUT`) or unregister (`DELETE`). When we rotate, our old token keeps working until the CPO has answered, so its calls during the update are not refused. When we unregister, we tell the CPO first, and unregister locally anyway if it has already forgotten us (401 or 405).

How it works, in `lib/ocpi/`:

- **Registry** (`store.ts`, `store-supabase.ts`): peers with their roles, endpoints per module and status (`pending`, `registered`, `unregistered`, `failed`); a peer's parties may not belong to another registered peer or to us. Tokens we issue are stored as SHA-256 hashes (`emsp_ocpi_issued_tokens`); the token a peer gave us is AES-256-GCM encrypted with `OCPI_TOKEN_ENCRYPTION_KEY`, bound to the peer's ID. In demo mode the registry is in memory.
- **Client** (`client.ts`): the envelope, `Authorization: Token <base64>`, a new `X-Request-ID` per attempt and one `X-Correlation-ID` per operation, routing headers, a pagination iterator over `Link` / `X-Total-Count` / `X-Limit` with `date_from` and `date_to`, retries with exponential backoff and jitter on timeouts, network errors and HTTP 5xx (GET only, unless a call says it is safe to repeat), and OCPI status codes mapped to error classes. It follows no redirects, and never follows a next-page link to another origin.
- **Peer addresses** (`lib/server/peer-fetch.ts`): peers choose the URLs we call, so every request to a peer goes through `peerFetch`. It refuses demo mode, needs `https://`, resolves the host once and refuses it if any address is loopback, private (RFC 1918), link-local, CGNAT, unique-local IPv6, unspecified, multicast, documentation or reserved, including cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`) and IPv4 embedded in IPv6. The socket then connects to the address it checked, so a second DNS answer cannot redirect it (DNS rebinding). When a CPO calls our credentials module, we read its versions with one 5-second try, and any failure gets the same answer, `3001 Peer endpoint unreachable or invalid`: never the remote server's status or body. The details are logged on our side, without tokens.
- **Size limits**: we read at most 1 MB of an OCPI response and 256 KB of a request; a larger `Content-Length` is refused before reading, and a stream is cut at the limit.
- **Server middleware** (`server.ts`): checks the token's hash against the tokens we issued (base64 or the unencoded 2.1.1 form), refuses unknown, unregistered or failed peers with 401, limits a Token A to the versions and credentials modules, and checks the `OCPI-from/to` routing headers on functional modules: "to" must be us and "from" a party of the token. It echoes `X-Request-ID` and `X-Correlation-ID`.
- **Schema** (`schema.ts`): every incoming credentials, versions, version details and envelope object is validated against 2.2.1 before use.

### Mock CPO

`lib/mock-cpo/` is a second, generic OCPI 2.2.1 CPO that runs in-process: versions, credentials (all four methods, both directions) and a paginated sample locations module, with failure injection (HTTP errors and hangs). The tests use it as a real peer for both handshake directions, rotation and unregistering, with several peers at once, over an in-process network (`tests/support/network.ts`): no request leaves the process. Later parts extend it, and demo mode will serve its sample data.

## Database

Migrations live in `supabase/migrations/`, named `<YYYYMMDDNNNN>_<name>.sql`, and are additive.

```sh
npm run check:migrations   # the 10-30 check, also run in CI
npm run db:migrate         # applies pending migrations using SUPABASE_DB_URL from .env.local
```

`db:migrate` runs every pending file in one transaction under an advisory lock and records it in `public.emsp_schema_migrations`. Without `SUPABASE_DB_URL`, run the files in filename order in the Supabase SQL editor.

The **10-30 rule**, checked by `scripts/check-migrations.mjs`:

- Every table created in `public` enables row-level security and runs `revoke all on <table> from public, anon, authenticated` in the same migration. The revoke keeps older Supabase projects, whose default privileges still grant new tables to the Data API roles, as closed as new ones. No migration may `disable row level security`.
- No default grants (`alter default privileges ... grant`) and no schema-wide grants (`grant ... on all tables in schema` or `all functions`).
- A table grant to `anon`, `authenticated` or `public` needs a policy on that table. The app talks to this server only, so expect no such grants: tables are service-only.
- Every function or procedure created in `public` runs `revoke execute (or all) on function <name> from public` in the same migration, because Postgres grants `EXECUTE` to `PUBLIC` by default. No migration grants `EXECUTE` to `anon`, `authenticated` or `public`.
- Every `security definer` function sets `search_path` (for example `set search_path = ''`).

`tests/migrations.test.ts` applies every migration to an in-memory Postgres ([PGlite](https://pglite.dev)) with Supabase's roles, and checks RLS, table and function grants, `search_path` on `security definer` functions and table behaviour. It runs them twice: on a database like a new Supabase project, and on one with the legacy default grants of older projects. Use `tests/support/pglite.ts` for the tests of new migrations.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIvora-Charge%2Fivora-examples&root-directory=emsp-starter%2Fserver&project-name=emsp-starter-server&repository-name=emsp-starter)

The button deploys the server in demo mode. To go live, apply the migrations, add the variables above in the project's environment settings and redeploy.

## What it uses

OCPI 2.2.1 as the eMSP role, with any CPO. Nothing from the Ivora API yet; an optional Ivora live-data adapter arrives in a later part.

## Limits and next steps

- No admin sign-in yet: `ADMIN_SECRET` is a stopgap with no session. Wrong secrets are limited to 5 per client and 50 in total per 15 minutes, counted per server instance.
- The OCPI version details list only the credentials module; later parts add locations, tariffs, tokens, sessions, CDRs and commands, and the routing-header check comes into play with them.
- Demo mode keeps peers in memory and refuses to contact a CPO; it does not yet route to the mock CPO in-process.
- Rotating `OCPI_TOKEN_ENCRYPTION_KEY` needs every peer to be registered again. An expired Token A leaves its peer pending; unregister it to close it.
- Next parts: locations and tariffs, tokens, sessions, CDRs, payments and the admin web.

## Checks

```sh
npm run format:check && npm run typecheck && npm run check:migrations && npm test && npm run build
npx playwright install chromium && npm run test:e2e   # offline demo run, desktop and mobile
```

Tests never need credentials or network access.
