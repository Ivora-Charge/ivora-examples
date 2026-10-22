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
  -- Last read from Ivora.
  checked_at timestamptz not null default now(),
  -- Last time the energy grew or the session ended. A running session whose energy
  -- has not changed for 12 hours is shown as stalled and read less often.
  changed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cpo_active_sessions_running
  on public.cpo_active_sessions(station_id, transaction_id) where active;
create index if not exists cpo_active_sessions_ended_station
  on public.cpo_active_sessions(station_id, transaction_id desc) where not active;
create index if not exists cpo_active_sessions_ended
  on public.cpo_active_sessions(updated_at) where not active;

-- Like cpo_transaction_marks, for the session tracker: the checkout finder moves its
-- own mark past sessions that are not its concern, so the tracker keeps a separate one.
create table if not exists public.cpo_active_marks (
  station_id bigint primary key check (station_id > 0),
  last_transaction_id bigint not null check (last_transaction_id >= 0),
  -- When a scan of the station last reached the end of its list (null: never). The
  -- scan throttle and the "may be incomplete" note read it, so they hold across
  -- server instances.
  scanned_at timestamptz,
  -- A first scan's mark seeding (a binary search for the station's newest ID), saved
  -- after each probe so a search cut short by a page load's budget resumes next load:
  -- something exists after seed_lo; nothing existed after seed_hi (null: not found
  -- yet). Unused once the mark is set.
  seed_lo bigint check (seed_lo >= 0),
  seed_hi bigint check (seed_hi > 0),
  updated_at timestamptz not null default now()
);

alter table public.cpo_active_sessions enable row level security;
alter table public.cpo_active_marks enable row level security;
revoke all on public.cpo_active_sessions, public.cpo_active_marks from public, anon, authenticated;
grant all on public.cpo_active_sessions, public.cpo_active_marks to service_role;

-- Records what Ivora reported for a session. Safe to repeat and to run twice at once:
-- an ended session stays ended, and fields Ivora did not report keep their value.
-- A value the table can't hold (a negative energy, a connector ID of 0, an over-long
-- token) is stored as unknown rather than failing the write, so one odd answer can't
-- stop the others. Ended sessions are kept for a day (the station page shows them)
-- and purged after.
create or replace function public.cpo_track_session(
  p_transaction_id bigint, p_station_id bigint, p_connector_id bigint,
  p_connector_number integer, p_id_token text, p_started_at timestamptz,
  p_ended_at timestamptz, p_energy_wh numeric, p_active boolean
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_connector_id bigint := case when p_connector_id > 0 then p_connector_id end;
  v_id_token text := case when char_length(p_id_token) <= 40 then p_id_token end;
  v_energy_wh numeric := case
    when p_energy_wh >= 0 and p_energy_wh <> 'NaN'::numeric then p_energy_wh end;
begin
  if p_transaction_id is null or p_transaction_id <= 0
     or p_station_id is null or p_station_id <= 0 or p_active is null then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  insert into public.cpo_active_sessions as s (
    transaction_id, station_id, connector_id, connector_number, id_token,
    started_at, ended_at, energy_wh, active
  ) values (
    p_transaction_id, p_station_id, v_connector_id, p_connector_number, v_id_token,
    p_started_at, p_ended_at, v_energy_wh, p_active
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
    changed_at = case
      when not excluded.active
        or greatest(excluded.energy_wh, s.energy_wh) is distinct from s.energy_wh
      then now() else s.changed_at end,
    updated_at = now()
  where s.active;
  delete from public.cpo_active_sessions
    where not active and updated_at < now() - interval '1 day';
end;
$$;
revoke all on function public.cpo_track_session(bigint, bigint, bigint, integer, text, timestamptz, timestamptz, numeric, boolean) from public, anon, authenticated;
grant execute on function public.cpo_track_session(bigint, bigint, bigint, integer, text, timestamptz, timestamptz, numeric, boolean) to service_role;

-- Forgets a session Ivora no longer knows (GET /transactions/{id} answered 404).
create or replace function public.cpo_forget_session(p_transaction_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.cpo_active_sessions where transaction_id = p_transaction_id;
end;
$$;
revoke all on function public.cpo_forget_session(bigint) from public, anon, authenticated;
grant execute on function public.cpo_forget_session(bigint) to service_role;

-- Forgets the sessions and marks of stations that are no longer in Ivora: p_keep is the
-- complete list of the operator's stations.
create or replace function public.cpo_forget_removed_stations(p_keep bigint[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_keep is null then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  delete from public.cpo_active_sessions where station_id <> all(p_keep);
  delete from public.cpo_active_marks where station_id <> all(p_keep);
end;
$$;
revoke all on function public.cpo_forget_removed_stations(bigint[]) from public, anon, authenticated;
grant execute on function public.cpo_forget_removed_stations(bigint[]) to service_role;

-- Moves a station's tracker mark up; never down (two scans at once keep the higher).
-- p_scanned also stamps scanned_at: the scan reached the end of the station's list.
create or replace function public.cpo_advance_active_mark(
  p_station_id bigint, p_transaction_id bigint, p_scanned boolean default false
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_station_id is null or p_station_id <= 0
     or p_transaction_id is null or p_transaction_id < 0 then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  insert into public.cpo_active_marks as m (station_id, last_transaction_id, scanned_at)
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
revoke all on function public.cpo_advance_active_mark(bigint, bigint, boolean) from public, anon, authenticated;
grant execute on function public.cpo_advance_active_mark(bigint, bigint, boolean) to service_role;

-- Saves a seed's search progress. Two searches at once keep the higher lo and the
-- lower hi (both still hold); a lo at or above hi means sessions came in after hi was
-- probed, so hi is dropped and the search goes up from lo again.
create or replace function public.cpo_save_active_seed(
  p_station_id bigint, p_lo bigint, p_hi bigint
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_station_id is null or p_station_id <= 0
     or p_lo is null or p_lo < 0 or p_hi <= 0 then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  insert into public.cpo_active_marks as m (station_id, last_transaction_id, seed_lo, seed_hi)
    values (p_station_id, 0, p_lo, case when p_hi > p_lo then p_hi end)
  on conflict (station_id) do update set
    seed_lo = greatest(m.seed_lo, excluded.seed_lo),
    seed_hi = case
      when least(m.seed_hi, p_hi) > greatest(m.seed_lo, excluded.seed_lo)
      then least(m.seed_hi, p_hi) end,
    updated_at = now();
end;
$$;
revoke all on function public.cpo_save_active_seed(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.cpo_save_active_seed(bigint, bigint, bigint) to service_role;

commit;
