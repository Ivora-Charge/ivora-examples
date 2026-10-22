-- Live-data adapters: per CPO peer, an optional read-only source of what OCPI 2.2.1
-- does not carry, such as the vehicle's state of charge. One row per peer that has
-- one; a peer without a row uses the null adapter (nothing extra). Service-only
-- (10-30 rule): RLS on, nothing granted to anon or authenticated.
begin;

create table public.emsp_live_data_adapters (
  peer_id uuid primary key references public.emsp_ocpi_peers (id),
  -- Which adapter reads this peer, for example 'ivora'. Adapters are code; a kind the
  -- server does not know falls back to the null adapter.
  kind text not null check (kind ~ '^[a-z][a-z0-9_-]{0,31}$'),
  -- The CPO's API origin (and path prefix, if any). https only, no credentials in it.
  base_url text not null
    check (base_url ~ '^https://[^/@?#\s]+(/[^?#\s]*)?$' and char_length(base_url) <= 255),
  -- The CPO's account on its own API, for example an Ivora tenant ID.
  account_id text not null check (account_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- The read-only API key, AES-256-GCM encrypted with OCPI_TOKEN_ENCRYPTION_KEY
  -- (bound to this peer). Never the plain key.
  key_ciphertext text not null
    check (key_ciphertext ~ '^v1:' and char_length(key_ciphertext) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.emsp_live_data_adapters enable row level security;
revoke all on table public.emsp_live_data_adapters from public, anon, authenticated, service_role;
-- An admin may replace or remove a peer's adapter.
grant select, insert, update, delete on table public.emsp_live_data_adapters to service_role;

commit;
