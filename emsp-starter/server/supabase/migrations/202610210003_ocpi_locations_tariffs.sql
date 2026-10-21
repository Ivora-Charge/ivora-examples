-- OCPI locations and tariffs cache: every CPO peer's locations (with their EVSEs and
-- connectors) and tariffs, pulled from its Sender interface or pushed to our Receiver
-- interface, and the state of each peer's pull. Stored per peer, keyed by country_code,
-- party_id and id, so peers that use the same IDs never collide.
-- Service-only (10-30 rule): RLS on, nothing granted to anon or authenticated. The
-- driver app reads locations through the server's search API, never the Data API.
begin;

create table public.emsp_ocpi_locations (
  peer_id uuid not null references public.emsp_ocpi_peers (id),
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  party_id text not null check (party_id ~ '^[A-Z0-9]{3}$'),
  location_id text not null check (char_length(location_id) between 1 and 36),
  -- The validated OCPI 2.2.1 Location, with its EVSEs and connectors.
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  -- Copies of what the search filters on.
  publish boolean not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  -- Lower-case name, address, postal code and city.
  search_text text not null default '',
  -- Location ID, EVSE uids, EVSE IDs and physical references: upper case, A-Z and 0-9.
  search_ids text[] not null default '{}',
  last_updated timestamptz not null,
  -- When we last received it, pulled or pushed. A full sync removes older rows.
  seen_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (peer_id, country_code, party_id, location_id)
);

create index emsp_ocpi_locations_position_idx
  on public.emsp_ocpi_locations (latitude, longitude) where publish;
create index emsp_ocpi_locations_ids_idx
  on public.emsp_ocpi_locations using gin (search_ids);
create index emsp_ocpi_locations_seen_idx
  on public.emsp_ocpi_locations (peer_id, seen_at);

alter table public.emsp_ocpi_locations enable row level security;
revoke all on table public.emsp_ocpi_locations from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.emsp_ocpi_locations to service_role;

create table public.emsp_ocpi_tariffs (
  peer_id uuid not null references public.emsp_ocpi_peers (id),
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  party_id text not null check (party_id ~ '^[A-Z0-9]{3}$'),
  tariff_id text not null check (char_length(tariff_id) between 1 and 36),
  -- The validated OCPI 2.2.1 Tariff.
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  last_updated timestamptz not null,
  seen_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (peer_id, country_code, party_id, tariff_id)
);

create index emsp_ocpi_tariffs_id_idx on public.emsp_ocpi_tariffs (peer_id, tariff_id);
create index emsp_ocpi_tariffs_seen_idx on public.emsp_ocpi_tariffs (peer_id, seen_at);

alter table public.emsp_ocpi_tariffs enable row level security;
revoke all on table public.emsp_ocpi_tariffs from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.emsp_ocpi_tariffs to service_role;

create table public.emsp_ocpi_sync_state (
  peer_id uuid not null references public.emsp_ocpi_peers (id),
  module text not null check (module in ('locations', 'tariffs')),
  last_full_sync_at timestamptz,
  -- date_from for the next incremental pull.
  cursor timestamptz,
  -- The pull in progress or interrupted (null when none): its ID guards against two
  -- pulls at once, and `run` holds the next page to resume from.
  run_id uuid,
  run jsonb check (run is null or jsonb_typeof(run) = 'object'),
  -- The outcome of the last pull: counts and an error message, never tokens.
  last_result jsonb check (last_result is null or jsonb_typeof(last_result) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (peer_id, module),
  check ((run_id is null) = (run is null))
);

alter table public.emsp_ocpi_sync_state enable row level security;
revoke all on table public.emsp_ocpi_sync_state from public, anon, authenticated, service_role;
grant select, insert, update on table public.emsp_ocpi_sync_state to service_role;

commit;
