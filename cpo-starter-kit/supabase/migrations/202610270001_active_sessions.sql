begin;

-- Live view: the sessions the kit knows are running. Ivora's GET /transactions lists
-- sessions oldest first with no date or active filter, and its items carry no ID token
-- or connector, so "the newest 100" is not "the current ones". The kit tracks them
-- itself: from webhooks (charging_session.status_changed, meter.sampled, connector
-- events), from its own commands and checkouts, and by paging each station's list from
-- a stored high-water mark (cpo_active_marks). Details come from GET /transactions/{id}.
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated. Nothing here is read
-- through the Data API: the server reads and writes with the service role. A deployment
-- serves one Ivora project (one tenant), as cpo_transaction_marks does, so rows are
-- keyed by Ivora's own transaction and station IDs.
-- `npm run check:migrations` (the shared tools/check-migrations) enforces this in CI.

create table if not exists public.cpo_active_sessions (
  transaction_id bigint primary key check (transaction_id > 0),
  station_id bigint not null check (station_id > 0),
  connector_id bigint check (connector_id > 0),
  connector_number integer,
  -- As Ivora shows it: masked to the last 4 characters behind ****.
  id_token text check (char_length(id_token) <= 40),
  started_at timestamptz,
  ended_at timestamptz,
  energy_wh numeric check (energy_wh >= 0),
  -- False once the session ended. Final: a late or repeated report of a running
  -- session (an old webhook, a read that started before the end) can't reopen it.
  active boolean not null default true,
  checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cpo_active_sessions_station
  on public.cpo_active_sessions(station_id, active);
create index if not exists cpo_active_sessions_ended
  on public.cpo_active_sessions(updated_at) where not active;

-- Like cpo_transaction_marks, for the session tracker: the checkout finder moves its
-- own mark past sessions that are not its concern, so the tracker keeps a separate one.
create table if not exists public.cpo_active_marks (
  station_id bigint primary key check (station_id > 0),
  last_transaction_id bigint not null check (last_transaction_id >= 0),
  updated_at timestamptz not null default now()
);

alter table public.cpo_active_sessions enable row level security;
alter table public.cpo_active_marks enable row level security;
revoke all on public.cpo_active_sessions, public.cpo_active_marks from public, anon, authenticated;
grant all on public.cpo_active_sessions, public.cpo_active_marks to service_role;

-- Records what Ivora reported for a session. Safe to repeat and to run twice at once:
-- an ended session stays ended, and fields Ivora did not report keep their value.
-- Ended sessions are kept for a day (the station page shows them) and purged after.
create or replace function public.cpo_track_session(
  p_transaction_id bigint, p_station_id bigint, p_connector_id bigint,
  p_connector_number integer, p_id_token text, p_started_at timestamptz,
  p_ended_at timestamptz, p_energy_wh numeric, p_active boolean
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_transaction_id is null or p_transaction_id <= 0
     or p_station_id is null or p_station_id <= 0 or p_active is null then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  insert into public.cpo_active_sessions as s (
    transaction_id, station_id, connector_id, connector_number, id_token,
    started_at, ended_at, energy_wh, active
  ) values (
    p_transaction_id, p_station_id, p_connector_id, p_connector_number, p_id_token,
    p_started_at, p_ended_at, p_energy_wh, p_active
  )
  on conflict (transaction_id) do update set
    connector_id = coalesce(excluded.connector_id, s.connector_id),
    connector_number = coalesce(excluded.connector_number, s.connector_number),
    id_token = coalesce(excluded.id_token, s.id_token),
    started_at = coalesce(excluded.started_at, s.started_at),
    ended_at = coalesce(excluded.ended_at, s.ended_at),
    energy_wh = greatest(excluded.energy_wh, s.energy_wh),
    active = excluded.active,
    checked_at = now(),
    updated_at = now()
  where s.active;
  delete from public.cpo_active_sessions
    where not active and updated_at < now() - interval '1 day';
end;
$$;
revoke all on function public.cpo_track_session(bigint, bigint, bigint, integer, text, timestamptz, timestamptz, numeric, boolean) from public, anon, authenticated;
grant execute on function public.cpo_track_session(bigint, bigint, bigint, integer, text, timestamptz, timestamptz, numeric, boolean) to service_role;

-- Moves a station's tracker mark up; never down (two scans at once keep the higher).
create or replace function public.cpo_advance_active_mark(p_station_id bigint, p_transaction_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_station_id is null or p_station_id <= 0
     or p_transaction_id is null or p_transaction_id < 0 then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  insert into public.cpo_active_marks (station_id, last_transaction_id)
    values (p_station_id, p_transaction_id)
  on conflict (station_id) do update
    set last_transaction_id = excluded.last_transaction_id, updated_at = now()
    where public.cpo_active_marks.last_transaction_id < excluded.last_transaction_id;
end;
$$;
revoke all on function public.cpo_advance_active_mark(bigint, bigint) from public, anon, authenticated;
grant execute on function public.cpo_advance_active_mark(bigint, bigint) to service_role;

commit;
