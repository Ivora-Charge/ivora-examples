begin;

-- Cards (the optional fleet module, FLEET_MODULE=1): each RFID card's sessions and
-- energy. The cards themselves live in Ivora's token list (GET, POST and PATCH
-- /tokens); the kit keeps no copy of them. Ivora's GET /transactions has no token
-- filter, lists sessions oldest first and its items carry no ID token, so the kit pages
-- each station's list from its own high-water mark (cpo_card_marks), reads each new
-- session in full with GET /transactions/{id} (the token masked to its last 4
-- characters, the energy) and keeps those last 4 characters here. A card's sessions are
-- the ones whose token ends in the card's last 4 characters; two tokens that share them
-- can't be told apart, and the Cards page says so instead of guessing.
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated. Nothing here is read
-- through the Data API: the server reads and writes with the service role. A deployment
-- serves one Ivora project (one tenant), as cpo_active_sessions does, so rows are keyed
-- by Ivora's own transaction and station IDs.
-- `npm run check:migrations` (the shared tools/check-migrations) enforces this in CI.

create table if not exists public.cpo_card_sessions (
  transaction_id bigint primary key check (transaction_id > 0),
  station_id bigint not null check (station_id > 0),
  connector_number integer check (connector_number > 0),
  -- The ID token's last 4 characters (fewer for a shorter token), upper-cased: chargers
  -- match cards case-insensitively. Ivora never returns the rest.
  token_key text not null
    check (char_length(token_key) between 1 and 4 and token_key = upper(token_key)),
  started_at timestamptz,
  ended_at timestamptz,
  energy_wh bigint check (energy_wh >= 0),
  -- False once the session ended. Final: a late report of a running session can't
  -- reopen it.
  active boolean not null default true,
  -- Last read from Ivora: running sessions are read again until they end.
  checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cpo_card_sessions_token
  on public.cpo_card_sessions(token_key, started_at desc);
create index if not exists cpo_card_sessions_running
  on public.cpo_card_sessions(checked_at) where active;
create index if not exists cpo_card_sessions_started
  on public.cpo_card_sessions(started_at);

-- Like cpo_active_marks, for the card scan: the highest transaction ID it is done with
-- at each station, and when a scan of the station last reached the end of its list.
create table if not exists public.cpo_card_marks (
  station_id bigint primary key check (station_id > 0),
  last_transaction_id bigint not null check (last_transaction_id >= 0),
  scanned_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.cpo_card_sessions enable row level security;
alter table public.cpo_card_marks enable row level security;
revoke all on public.cpo_card_sessions, public.cpo_card_marks from public, anon, authenticated;
grant all on public.cpo_card_sessions, public.cpo_card_marks to service_role;

-- A card's figures leave out the kit's own driver checkouts (their tokens are Ivora's
-- payment tokens, never a card): this finds them by transaction.
create index if not exists cpo_checkouts_transaction
  on public.cpo_checkouts(transaction_id) where transaction_id is not null;

-- Records what Ivora reported for a session with an ID token. Safe to repeat and to run
-- twice at once: an ended session stays ended, the energy only grows, and fields Ivora
-- did not report keep their value. A negative energy or connector number is stored as
-- unknown rather than failing the write. Sessions that started over 400 days ago are
-- purged as it goes.
create or replace function public.cpo_record_card_session(
  p_transaction_id bigint, p_station_id bigint, p_connector_number integer,
  p_token_key text, p_started_at timestamptz, p_ended_at timestamptz,
  p_energy_wh bigint, p_active boolean
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_key text := upper(p_token_key);
begin
  if p_transaction_id is null or p_transaction_id <= 0
     or p_station_id is null or p_station_id <= 0 or p_active is null
     or v_key is null or char_length(v_key) not between 1 and 4 then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  insert into public.cpo_card_sessions as s (
    transaction_id, station_id, connector_number, token_key, started_at, ended_at,
    energy_wh, active
  ) values (
    p_transaction_id, p_station_id,
    case when p_connector_number > 0 then p_connector_number end,
    v_key, p_started_at, p_ended_at,
    case when p_energy_wh >= 0 then p_energy_wh end,
    p_active
  )
  on conflict (transaction_id) do update set
    connector_number = coalesce(excluded.connector_number, s.connector_number),
    started_at = coalesce(excluded.started_at, s.started_at),
    ended_at = coalesce(excluded.ended_at, s.ended_at),
    energy_wh = greatest(excluded.energy_wh, s.energy_wh),
    active = excluded.active,
    checked_at = now(),
    updated_at = now()
  where s.active;
  delete from public.cpo_card_sessions
    where started_at < now() - interval '400 days';
end;
$$;
revoke all on function public.cpo_record_card_session(bigint, bigint, integer, text, timestamptz, timestamptz, bigint, boolean) from public, anon, authenticated;
grant execute on function public.cpo_record_card_session(bigint, bigint, integer, text, timestamptz, timestamptz, bigint, boolean) to service_role;

-- Forgets a session Ivora no longer knows (GET /transactions/{id} answered 404).
create or replace function public.cpo_forget_card_session(p_transaction_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.cpo_card_sessions where transaction_id = p_transaction_id;
end;
$$;
revoke all on function public.cpo_forget_card_session(bigint) from public, anon, authenticated;
grant execute on function public.cpo_forget_card_session(bigint) to service_role;

-- Moves a station's card mark up; never down (two scans at once keep the higher).
-- p_scanned also stamps scanned_at: the scan reached the end of the station's list.
create or replace function public.cpo_advance_card_mark(
  p_station_id bigint, p_transaction_id bigint, p_scanned boolean default false
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_station_id is null or p_station_id <= 0
     or p_transaction_id is null or p_transaction_id < 0 then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  insert into public.cpo_card_marks as m (station_id, last_transaction_id, scanned_at)
    values (p_station_id, p_transaction_id,
            case when coalesce(p_scanned, false) then now() end)
  on conflict (station_id) do update set
    last_transaction_id = greatest(m.last_transaction_id, excluded.last_transaction_id),
    scanned_at = coalesce(excluded.scanned_at, m.scanned_at),
    updated_at = now()
  where m.last_transaction_id < excluded.last_transaction_id
     or excluded.scanned_at is not null;
end;
$$;
revoke all on function public.cpo_advance_card_mark(bigint, bigint, boolean) from public, anon, authenticated;
grant execute on function public.cpo_advance_card_mark(bigint, bigint, boolean) to service_role;

-- Sessions and energy per token key for sessions that started in [p_since, p_until),
-- without the kit's own driver checkouts.
create or replace function public.cpo_card_usage(p_since timestamptz, p_until timestamptz)
returns table (token_key text, sessions bigint, running bigint, energy_wh bigint)
language sql stable security definer set search_path = '' as $$
  select s.token_key, count(*), count(*) filter (where s.active),
         coalesce(sum(s.energy_wh), 0)::bigint
  from public.cpo_card_sessions s
  where s.started_at >= p_since and s.started_at < p_until
    and not exists (
      select 1 from public.cpo_checkouts c where c.transaction_id = s.transaction_id
    )
  group by s.token_key;
$$;
revoke all on function public.cpo_card_usage(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.cpo_card_usage(timestamptz, timestamptz) to service_role;

-- One token key's sessions in [p_since, p_until), newest first, at most 500, without
-- the kit's own driver checkouts.
create or replace function public.cpo_card_session_list(
  p_token_key text, p_since timestamptz, p_until timestamptz, p_limit integer
)
returns setof public.cpo_card_sessions
language sql stable security definer set search_path = '' as $$
  select s.* from public.cpo_card_sessions s
  where s.token_key = upper(p_token_key)
    and s.started_at >= p_since and s.started_at < p_until
    and not exists (
      select 1 from public.cpo_checkouts c where c.transaction_id = s.transaction_id
    )
  order by s.started_at desc, s.transaction_id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 500);
$$;
revoke all on function public.cpo_card_session_list(text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.cpo_card_session_list(text, timestamptz, timestamptz, integer) to service_role;

commit;
