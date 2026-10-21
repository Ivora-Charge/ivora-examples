-- OCPI peer registry: the CPOs this eMSP is connected to, and the hashes of the
-- credentials tokens we issued to them. Service-only (10-30 rule): RLS on, nothing
-- granted to anon or authenticated. The server reaches these tables as service_role.
begin;

create table public.emsp_ocpi_peers (
  id uuid primary key default gen_random_uuid(),
  -- Admin-given name, for example the CPO's company name.
  label text not null check (char_length(label) between 1 and 100),
  -- 'outbound': we registered at the peer. 'inbound': the peer registered with us.
  direction text not null check (direction in ('outbound', 'inbound')),
  status text not null default 'pending'
    check (status in ('pending', 'registered', 'unregistered', 'failed')),
  versions_url text check (versions_url ~ '^https://' and char_length(versions_url) <= 255),
  version text check (char_length(version) <= 10),
  -- OCPI CredentialsRole objects (role, country_code, party_id, business_details).
  roles jsonb not null default '[]'::jsonb check (jsonb_typeof(roles) = 'array'),
  -- OCPI Endpoint objects (identifier, role, url) from the peer's version details.
  endpoints jsonb not null default '[]'::jsonb check (jsonb_typeof(endpoints) = 'array'),
  -- The token the peer gave us, AES-256-GCM encrypted with OCPI_TOKEN_ENCRYPTION_KEY
  -- (bound to this row's id). Never the plain token.
  token_ciphertext text check (token_ciphertext ~ '^v1:' and char_length(token_ciphertext) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  registered_at timestamptz,
  unregistered_at timestamptz,
  check (status <> 'registered' or (registered_at is not null and token_ciphertext is not null))
);

create index emsp_ocpi_peers_status_idx on public.emsp_ocpi_peers (status);

alter table public.emsp_ocpi_peers enable row level security;
revoke all on table public.emsp_ocpi_peers from public, anon, authenticated, service_role;
-- Peers are never deleted: unregistering keeps the row (status 'unregistered').
grant select, insert, update on table public.emsp_ocpi_peers to service_role;

create table public.emsp_ocpi_issued_tokens (
  -- SHA-256 (hex) of a token we issued. The token itself is never stored.
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  peer_id uuid not null references public.emsp_ocpi_peers (id),
  -- 'registration': a Token A, valid only to register. 'full': a Token B or C.
  scope text not null check (scope in ('registration', 'full')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index emsp_ocpi_issued_tokens_peer_idx
  on public.emsp_ocpi_issued_tokens (peer_id) where revoked_at is null;

alter table public.emsp_ocpi_issued_tokens enable row level security;
revoke all on table public.emsp_ocpi_issued_tokens from public, anon, authenticated, service_role;
-- Tokens are revoked (revoked_at), never deleted.
grant select, insert, update on table public.emsp_ocpi_issued_tokens to service_role;

commit;
