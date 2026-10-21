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
  -- New on every change of data. A push that changes one EVSE or connector writes the
  -- location back only if its revision is still the one it read (compare-and-swap), so
  -- concurrent pushes to one location never lose each other's changes.
  revision uuid not null default gen_random_uuid(),
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
  -- New on every change of data, for compare-and-swap like locations.
  revision uuid not null default gen_random_uuid(),
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

-- Stores a page of pulled locations in one call. A location we hold with a newer
-- last_updated (a push got there first, even one committed while the pull ran) keeps
-- its data and revision: the conflict update locks the row and compares against the
-- latest committed version. Every location of the page gets the new seen_at, so a full
-- pull never removes one it saw. Rows: the columns of emsp_ocpi_locations as JSON.
create function public.emsp_ocpi_save_locations(
  p_peer_id uuid,
  p_seen_at timestamptz,
  p_rows jsonb
) returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.emsp_ocpi_locations as l (
    peer_id, country_code, party_id, location_id, data, publish, latitude, longitude,
    search_text, search_ids, last_updated, seen_at
  )
  select p_peer_id, r.country_code, r.party_id, r.location_id, r.data, r.publish,
    r.latitude, r.longitude, r.search_text, r.search_ids, r.last_updated, p_seen_at
  from jsonb_to_recordset(p_rows) as r (
    country_code text, party_id text, location_id text, data jsonb, publish boolean,
    latitude double precision, longitude double precision, search_text text,
    search_ids text[], last_updated timestamptz
  )
  on conflict (peer_id, country_code, party_id, location_id) do update set
    data = excluded.data,
    publish = excluded.publish,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    search_text = excluded.search_text,
    search_ids = excluded.search_ids,
    last_updated = excluded.last_updated,
    seen_at = excluded.seen_at,
    updated_at = now(),
    revision = gen_random_uuid()
  where excluded.last_updated >= l.last_updated;

  update public.emsp_ocpi_locations as l
  set seen_at = p_seen_at
  from jsonb_to_recordset(p_rows) as r (country_code text, party_id text, location_id text)
  where l.peer_id = p_peer_id
    and l.country_code = r.country_code
    and l.party_id = r.party_id
    and l.location_id = r.location_id
    and l.seen_at < p_seen_at;
$$;
revoke execute on function public.emsp_ocpi_save_locations(uuid, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.emsp_ocpi_save_locations(uuid, timestamptz, jsonb) to service_role;

-- The same for a page of pulled tariffs.
create function public.emsp_ocpi_save_tariffs(
  p_peer_id uuid,
  p_seen_at timestamptz,
  p_rows jsonb
) returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.emsp_ocpi_tariffs as t (
    peer_id, country_code, party_id, tariff_id, data, last_updated, seen_at
  )
  select p_peer_id, r.country_code, r.party_id, r.tariff_id, r.data, r.last_updated,
    p_seen_at
  from jsonb_to_recordset(p_rows) as r (
    country_code text, party_id text, tariff_id text, data jsonb, last_updated timestamptz
  )
  on conflict (peer_id, country_code, party_id, tariff_id) do update set
    data = excluded.data,
    last_updated = excluded.last_updated,
    seen_at = excluded.seen_at,
    updated_at = now(),
    revision = gen_random_uuid()
  where excluded.last_updated >= t.last_updated;

  update public.emsp_ocpi_tariffs as t
  set seen_at = p_seen_at
  from jsonb_to_recordset(p_rows) as r (country_code text, party_id text, tariff_id text)
  where t.peer_id = p_peer_id
    and t.country_code = r.country_code
    and t.party_id = r.party_id
    and t.tariff_id = r.tariff_id
    and t.seen_at < p_seen_at;
$$;
revoke execute on function public.emsp_ocpi_save_tariffs(uuid, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.emsp_ocpi_save_tariffs(uuid, timestamptz, jsonb) to service_role;

-- Search candidates: published locations of these peers in the box, with every word
-- and the ID, nearest to (p_lat, p_lng) first, so the limit never drops a near location
-- for a far one. The order uses an equirectangular distance, which ranks like the
-- great-circle distance at search radii; longitudes wrap at the antimeridian. Without a
-- point, the order is by key. Null parameters do not filter.
create function public.emsp_ocpi_location_candidates(
  p_peer_ids uuid[],
  p_min_lat double precision,
  p_max_lat double precision,
  p_min_lng double precision,
  p_max_lng double precision,
  p_lat double precision,
  p_lng double precision,
  p_words text[],
  p_search_id text,
  p_limit integer
) returns table (peer_id uuid, data jsonb, seen_at timestamptz, revision uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.peer_id, l.data, l.seen_at, l.revision
  from public.emsp_ocpi_locations as l
  where l.peer_id = any (p_peer_ids)
    and l.publish
    and (p_min_lat is null or l.latitude between p_min_lat and p_max_lat)
    and (p_min_lng is null or l.longitude between p_min_lng and p_max_lng)
    and (p_search_id is null or l.search_ids @> array[p_search_id])
    and not exists (
      select 1 from unnest(coalesce(p_words, '{}'::text[])) as w (word)
      where strpos(l.search_text, w.word) = 0
    )
  order by
    case when p_lat is null then 0 else
      power(l.latitude - p_lat, 2) + power(
        least(abs(l.longitude - p_lng), 360 - abs(l.longitude - p_lng))
          * cos(radians(p_lat)),
        2
      )
    end,
    l.peer_id, l.country_code, l.party_id, l.location_id
  limit least(greatest(p_limit, 0), 1000);
$$;
revoke execute on function public.emsp_ocpi_location_candidates(uuid[], double precision, double precision, double precision, double precision, double precision, double precision, text[], text, integer) from public, anon, authenticated;
grant execute on function public.emsp_ocpi_location_candidates(uuid[], double precision, double precision, double precision, double precision, double precision, double precision, text[], text, integer) to service_role;

commit;
