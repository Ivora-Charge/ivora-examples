begin;

-- Chargers: the kit's own record of each charger it added (or took over) in Ivora,
-- and the QR sticker codes printed for its connectors.
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated. Nothing here is read
-- through the Data API: the server reads it with the service role, for the operator of
-- the signed-in staff member (and resolves sticker codes for the public /c/<code>
-- page). Writes go through the functions below, which check the staff member's role
-- in the same statement as the write.
-- `npm run check:migrations` (the shared tools/check-migrations) enforces this in CI.

create table if not exists public.cpo_chargers (
  -- Also the source of the Ivora external_reference (cpo-charger-<id>) and of every
  -- Idempotency-Key for this charger.
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  -- Null until Ivora has registered the station.
  station_id bigint check (station_id > 0),
  -- The OCPP connection name, as the API allows it.
  name text not null check (name ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{2,35}$'),
  -- Shown in the kit and on stickers; the kit's own, never sent to Ivora.
  label text check (char_length(label) between 1 and 80),
  location_id bigint check (location_id > 0),
  -- A site still to be created in Ivora (name and address), kept so a retry creates
  -- it with the same Idempotency-Key. Cleared once the location exists.
  new_site jsonb check (new_site is null or jsonb_typeof(new_site) = 'object'),
  connectors smallint not null default 1 check (connectors between 1 and 8),
  connection_url text check (char_length(connection_url) <= 300),
  -- When Ivora confirmed the charger password the kit set. The password itself is
  -- shown once and never stored.
  password_set_at timestamptz,
  -- Counters that go into the Idempotency-Key of the next password, test and edit.
  credential_sets integer not null default 0 check (credential_sets >= 0),
  test_runs integer not null default 0 check (test_runs >= 0),
  edits integer not null default 0 check (edits >= 0),
  -- Last connection test and remote start/stop test (no personal data).
  connection_test jsonb check (connection_test is null or jsonb_typeof(connection_test) = 'object'),
  remote_test jsonb check (remote_test is null or jsonb_typeof(remote_test) = 'object'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Removed from the kit. Kept so its sticker codes say "not in service" and a station
  -- Ivora keeps (one with charging history) stays hidden.
  removed_at timestamptz
);
create index if not exists cpo_chargers_operator on public.cpo_chargers(operator_id);
create unique index if not exists cpo_chargers_one_per_station
  on public.cpo_chargers(operator_id, station_id)
  where station_id is not null and removed_at is null;

-- One stable code per connector: the QR sticker URL is <public base URL>/c/<code>.
-- A random code, never a database or Ivora ID, so a charger can be re-mapped or the
-- hosting moved without reprinting stickers.
create table if not exists public.cpo_sticker_codes (
  code text primary key check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  charger_id uuid not null references public.cpo_chargers(id) on delete cascade,
  connector_number smallint not null check (connector_number between 1 and 99),
  -- Ivora's connector resource ID, when known.
  connector_id bigint check (connector_id > 0),
  created_at timestamptz not null default now(),
  unique (charger_id, connector_number)
);
create index if not exists cpo_sticker_codes_operator on public.cpo_sticker_codes(operator_id);

alter table public.cpo_chargers enable row level security;
alter table public.cpo_sticker_codes enable row level security;
revoke all on public.cpo_chargers, public.cpo_sticker_codes from public, anon, authenticated;
grant all on public.cpo_chargers, public.cpo_sticker_codes to service_role;

-- Technicians and above work on chargers; removing one needs a manager or owner.
-- Locks the actor's staff row (FOR SHARE) until the write commits, so a concurrent
-- demotion waits for it or is seen by it.
create or replace function public.cpo_lock_charger_actor(p_operator_id uuid, p_actor_id uuid, p_manager boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.cpo_staff
    where operator_id = p_operator_id and user_id = p_actor_id
      and (role in ('owner', 'manager') or (not p_manager and role = 'technician'))
    for share;
  if not found then
    raise exception 'cpo_not_allowed' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.cpo_lock_charger_actor(uuid, uuid, boolean) from public, anon, authenticated;

create or replace function public.cpo_create_charger(
  p_operator_id uuid, p_actor_id uuid, p_name text, p_label text, p_location_id bigint,
  p_new_site jsonb, p_connectors integer, p_station_id bigint, p_connection_url text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform public.cpo_lock_charger_actor(p_operator_id, p_actor_id, false);
  insert into public.cpo_chargers (
    operator_id, name, label, location_id, new_site, connectors, station_id, connection_url, created_by
  ) values (
    p_operator_id, p_name, p_label, p_location_id, p_new_site, p_connectors, p_station_id, p_connection_url, p_actor_id
  ) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'cpo_charger_exists' using errcode = 'P0001';
end;
$$;
revoke all on function public.cpo_create_charger(uuid, uuid, text, text, bigint, jsonb, integer, bigint, text) from public, anon, authenticated;
grant execute on function public.cpo_create_charger(uuid, uuid, text, text, bigint, jsonb, integer, bigint, text) to service_role;

-- Changes only the keys present in p_changes. A key with a JSON null clears the column.
create or replace function public.cpo_update_charger(
  p_operator_id uuid, p_actor_id uuid, p_id uuid, p_changes jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_charger_actor(p_operator_id, p_actor_id, false);
  update public.cpo_chargers set
    label = case when p_changes ? 'label' then p_changes->>'label' else label end,
    location_id = case when p_changes ? 'location_id' then (p_changes->>'location_id')::bigint else location_id end,
    new_site = case when p_changes ? 'new_site' then nullif(p_changes->'new_site', 'null'::jsonb) else new_site end,
    station_id = case when p_changes ? 'station_id' then (p_changes->>'station_id')::bigint else station_id end,
    connection_url = case when p_changes ? 'connection_url' then p_changes->>'connection_url' else connection_url end,
    password_set_at = case when p_changes ? 'password_set_at' then (p_changes->>'password_set_at')::timestamptz else password_set_at end,
    connection_test = case when p_changes ? 'connection_test' then nullif(p_changes->'connection_test', 'null'::jsonb) else connection_test end,
    remote_test = case when p_changes ? 'remote_test' then nullif(p_changes->'remote_test', 'null'::jsonb) else remote_test end,
    updated_at = now()
  where id = p_id and operator_id = p_operator_id and removed_at is null;
  if not found then
    raise exception 'cpo_charger_not_found' using errcode = 'P0001';
  end if;
exception when unique_violation then
  raise exception 'cpo_charger_exists' using errcode = 'P0001';
end;
$$;
revoke all on function public.cpo_update_charger(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.cpo_update_charger(uuid, uuid, uuid, jsonb) to service_role;

-- The next number for an Idempotency-Key (credentials, test or edit), counted in one
-- statement so two people never get the same one.
create or replace function public.cpo_next_charger_seq(
  p_operator_id uuid, p_actor_id uuid, p_id uuid, p_kind text
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_next integer;
begin
  perform public.cpo_lock_charger_actor(p_operator_id, p_actor_id, false);
  if p_kind not in ('credentials', 'test', 'edit') then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  update public.cpo_chargers set
    credential_sets = credential_sets + case when p_kind = 'credentials' then 1 else 0 end,
    test_runs = test_runs + case when p_kind = 'test' then 1 else 0 end,
    edits = edits + case when p_kind = 'edit' then 1 else 0 end,
    updated_at = now()
  where id = p_id and operator_id = p_operator_id and removed_at is null
  returning case p_kind when 'credentials' then credential_sets when 'test' then test_runs else edits end
  into v_next;
  if v_next is null then
    raise exception 'cpo_charger_not_found' using errcode = 'P0001';
  end if;
  return v_next;
end;
$$;
revoke all on function public.cpo_next_charger_seq(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cpo_next_charger_seq(uuid, uuid, uuid, text) to service_role;

-- Sticker codes for connectors that have none yet: [{code, connector_number,
-- connector_id}]. A connector that already has a code keeps it; a code that is
-- already taken is skipped (the server draws a new one and tries again).
create or replace function public.cpo_add_sticker_codes(
  p_operator_id uuid, p_actor_id uuid, p_charger_id uuid, p_codes jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_charger_actor(p_operator_id, p_actor_id, false);
  perform 1 from public.cpo_chargers
    where id = p_charger_id and operator_id = p_operator_id and removed_at is null;
  if not found then
    raise exception 'cpo_charger_not_found' using errcode = 'P0001';
  end if;
  insert into public.cpo_sticker_codes (code, operator_id, charger_id, connector_number, connector_id)
    select c.code, p_operator_id, p_charger_id, c.connector_number, c.connector_id
    from jsonb_to_recordset(p_codes) as c(code text, connector_number smallint, connector_id bigint)
  on conflict do nothing;
end;
$$;
revoke all on function public.cpo_add_sticker_codes(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.cpo_add_sticker_codes(uuid, uuid, uuid, jsonb) to service_role;

-- Managers and owners only, except for a charger Ivora never registered (a technician
-- may discard their own failed add). The record stays, marked removed: its sticker
-- codes then say "not in service" instead of pointing at another charger.
create or replace function public.cpo_remove_charger(p_operator_id uuid, p_actor_id uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_station bigint;
begin
  select station_id into v_station from public.cpo_chargers
    where id = p_id and operator_id = p_operator_id and removed_at is null
    for update;
  if not found then
    raise exception 'cpo_charger_not_found' using errcode = 'P0001';
  end if;
  perform public.cpo_lock_charger_actor(p_operator_id, p_actor_id, v_station is not null);
  update public.cpo_chargers set removed_at = now(), updated_at = now()
    where id = p_id;
end;
$$;
revoke all on function public.cpo_remove_charger(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.cpo_remove_charger(uuid, uuid, uuid) to service_role;

commit;
