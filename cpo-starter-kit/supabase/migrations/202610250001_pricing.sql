begin;

-- Pricing: the operator's tariffs (each change a new version, each version its own
-- Ivora tariff, so bills keep the price they snapshot), which tariff each station and
-- connector uses, and which stations are private (no public QR checkout).
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated. Nothing here is read
-- through the Data API: the server reads it with the service role, for the operator of
-- the signed-in staff member (and for the public /c/<code> page). Writes go through
-- the functions below, which check the staff member is an owner or manager in the same
-- statement as the write.
-- `npm run check:migrations` (the shared tools/check-migrations) enforces this in CI.

create table if not exists public.cpo_tariffs (
  -- Also the source of every version's Ivora external_reference
  -- (cpo-tariff-<id>-v<n>) and Idempotency-Key.
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id)
);

create table if not exists public.cpo_tariff_versions (
  tariff_id uuid not null,
  operator_id uuid not null,
  version integer not null check (version >= 1),
  -- The editor's definition (integer minor units, periods, idle grace, driver text).
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  -- Ivora's tariff for this version; null while its creation is unconfirmed.
  ivora_tariff_id bigint check (ivora_tariff_id > 0),
  -- When Ivora archived this version's tariff, after a newer version replaced it.
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tariff_id, version),
  foreign key (operator_id, tariff_id)
    references public.cpo_tariffs(operator_id, id) on delete cascade
);
-- One unconfirmed version per tariff: a second save waits for "Finish saving".
create unique index if not exists cpo_tariff_versions_one_pending
  on public.cpo_tariff_versions(tariff_id) where ivora_tariff_id is null;

-- A station's tariff and access. tariff_id null: no station-wide tariff.
create table if not exists public.cpo_station_pricing (
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  station_id bigint not null check (station_id > 0),
  tariff_id uuid,
  -- Private: no public QR checkout; staff and RFID only.
  private boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (operator_id, station_id),
  foreign key (operator_id, tariff_id) references public.cpo_tariffs(operator_id, id)
);

-- A connector's own tariff, where it differs from its station's.
create table if not exists public.cpo_connector_tariffs (
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  station_id bigint not null check (station_id > 0),
  connector_id bigint not null check (connector_id > 0),
  tariff_id uuid not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (operator_id, connector_id),
  foreign key (operator_id, tariff_id) references public.cpo_tariffs(operator_id, id)
);
create index if not exists cpo_connector_tariffs_station
  on public.cpo_connector_tariffs(operator_id, station_id);

alter table public.cpo_tariffs enable row level security;
alter table public.cpo_tariff_versions enable row level security;
alter table public.cpo_station_pricing enable row level security;
alter table public.cpo_connector_tariffs enable row level security;
revoke all on public.cpo_tariffs, public.cpo_tariff_versions, public.cpo_station_pricing, public.cpo_connector_tariffs from public, anon, authenticated;
grant all on public.cpo_tariffs, public.cpo_tariff_versions, public.cpo_station_pricing, public.cpo_connector_tariffs to service_role;

-- Owners and managers only. Locks the actor's staff row (FOR SHARE) until the write
-- commits, so a concurrent demotion waits for it or is seen by it.
create or replace function public.cpo_lock_pricing_actor(p_operator_id uuid, p_actor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.cpo_staff
    where operator_id = p_operator_id and user_id = p_actor_id
      and role in ('owner', 'manager')
    for share;
  if not found then
    raise exception 'cpo_not_allowed' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.cpo_lock_pricing_actor(uuid, uuid) from public, anon, authenticated;

-- A new tariff with its first, unconfirmed version.
create or replace function public.cpo_create_tariff(
  p_operator_id uuid, p_actor_id uuid, p_name text, p_definition jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform public.cpo_lock_pricing_actor(p_operator_id, p_actor_id);
  insert into public.cpo_tariffs (operator_id, name, created_by)
    values (p_operator_id, p_name, p_actor_id)
    returning id into v_id;
  insert into public.cpo_tariff_versions (tariff_id, operator_id, version, definition, created_by)
    values (v_id, p_operator_id, 1, p_definition, p_actor_id);
  return v_id;
end;
$$;
revoke all on function public.cpo_create_tariff(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.cpo_create_tariff(uuid, uuid, text, jsonb) to service_role;

-- The next version of a tariff, unconfirmed. Refused with cpo_tariff_busy while an
-- earlier version is still unconfirmed. The tariff row is locked, so two saves at
-- once get different version numbers or one of them is refused.
create or replace function public.cpo_add_tariff_version(
  p_operator_id uuid, p_actor_id uuid, p_tariff_id uuid, p_name text, p_definition jsonb
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_version integer;
begin
  perform public.cpo_lock_pricing_actor(p_operator_id, p_actor_id);
  update public.cpo_tariffs set name = p_name, updated_at = now()
    where id = p_tariff_id and operator_id = p_operator_id;
  if not found then
    raise exception 'cpo_tariff_not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.cpo_tariff_versions
      where tariff_id = p_tariff_id and ivora_tariff_id is null) then
    raise exception 'cpo_tariff_busy' using errcode = 'P0001';
  end if;
  select coalesce(max(version), 0) + 1 into v_version
    from public.cpo_tariff_versions where tariff_id = p_tariff_id;
  insert into public.cpo_tariff_versions (tariff_id, operator_id, version, definition, created_by)
    values (p_tariff_id, p_operator_id, v_version, p_definition, p_actor_id);
  return v_version;
exception when unique_violation then
  raise exception 'cpo_tariff_busy' using errcode = 'P0001';
end;
$$;
revoke all on function public.cpo_add_tariff_version(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.cpo_add_tariff_version(uuid, uuid, uuid, text, jsonb) to service_role;

-- Ivora created the version's tariff. Repeating it with the same ID changes nothing;
-- a version never gets a second Ivora tariff.
create or replace function public.cpo_record_tariff_version(
  p_operator_id uuid, p_actor_id uuid, p_tariff_id uuid, p_version integer, p_ivora_tariff_id bigint
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_pricing_actor(p_operator_id, p_actor_id);
  update public.cpo_tariff_versions set ivora_tariff_id = p_ivora_tariff_id
    where tariff_id = p_tariff_id and operator_id = p_operator_id and version = p_version
      and (ivora_tariff_id is null or ivora_tariff_id = p_ivora_tariff_id);
  if not found then
    raise exception 'cpo_tariff_not_found' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.cpo_record_tariff_version(uuid, uuid, uuid, integer, bigint) from public, anon, authenticated;
grant execute on function public.cpo_record_tariff_version(uuid, uuid, uuid, integer, bigint) to service_role;

-- Ivora definitely refused an unconfirmed version: it is forgotten, and a tariff left
-- without any version goes with it. A confirmed version is never deleted.
create or replace function public.cpo_drop_tariff_version(
  p_operator_id uuid, p_actor_id uuid, p_tariff_id uuid, p_version integer
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_pricing_actor(p_operator_id, p_actor_id);
  delete from public.cpo_tariff_versions
    where tariff_id = p_tariff_id and operator_id = p_operator_id
      and version = p_version and ivora_tariff_id is null;
  delete from public.cpo_tariffs t
    where t.id = p_tariff_id and t.operator_id = p_operator_id
      and not exists (select 1 from public.cpo_tariff_versions v where v.tariff_id = t.id);
end;
$$;
revoke all on function public.cpo_drop_tariff_version(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.cpo_drop_tariff_version(uuid, uuid, uuid, integer) to service_role;

-- Ivora archived a replaced version's tariff.
create or replace function public.cpo_record_tariff_archived(
  p_operator_id uuid, p_actor_id uuid, p_tariff_id uuid, p_version integer
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_pricing_actor(p_operator_id, p_actor_id);
  update public.cpo_tariff_versions set archived_at = coalesce(archived_at, now())
    where tariff_id = p_tariff_id and operator_id = p_operator_id
      and version = p_version and ivora_tariff_id is not null;
end;
$$;
revoke all on function public.cpo_record_tariff_archived(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.cpo_record_tariff_archived(uuid, uuid, uuid, integer) to service_role;

-- Replaces a station's tariff, private flag and connector tariffs in one statement.
-- p_connectors is [{"connector_id": n, "tariff_id": "<uuid>"}]. Every tariff must be
-- the operator's and already in Ivora (cpo_tariff_not_ready otherwise), so a bill
-- always has a tariff to snapshot.
create or replace function public.cpo_set_station_pricing(
  p_operator_id uuid, p_actor_id uuid, p_station_id bigint, p_tariff_id uuid,
  p_private boolean, p_connectors jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_connectors jsonb := coalesce(p_connectors, '[]'::jsonb);
begin
  perform public.cpo_lock_pricing_actor(p_operator_id, p_actor_id);
  if jsonb_typeof(v_connectors) <> 'array' then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from (
      select p_tariff_id as tariff_id where p_tariff_id is not null
      union all
      select (c->>'tariff_id')::uuid from jsonb_array_elements(v_connectors) c
    ) wanted
    where not exists (
      select 1 from public.cpo_tariff_versions v
      where v.tariff_id = wanted.tariff_id and v.operator_id = p_operator_id
        and v.ivora_tariff_id is not null
    )
  ) then
    raise exception 'cpo_tariff_not_ready' using errcode = 'P0001';
  end if;
  delete from public.cpo_connector_tariffs
    where operator_id = p_operator_id and station_id = p_station_id;
  insert into public.cpo_connector_tariffs (operator_id, station_id, connector_id, tariff_id, updated_by)
    select p_operator_id, p_station_id, (c->>'connector_id')::bigint, (c->>'tariff_id')::uuid, p_actor_id
    from jsonb_array_elements(v_connectors) c;
  if p_tariff_id is null and not coalesce(p_private, false) then
    delete from public.cpo_station_pricing
      where operator_id = p_operator_id and station_id = p_station_id;
  else
    insert into public.cpo_station_pricing (operator_id, station_id, tariff_id, private, updated_by)
      values (p_operator_id, p_station_id, p_tariff_id, coalesce(p_private, false), p_actor_id)
    on conflict (operator_id, station_id) do update set
      tariff_id = excluded.tariff_id,
      private = excluded.private,
      updated_by = excluded.updated_by,
      updated_at = now();
  end if;
end;
$$;
revoke all on function public.cpo_set_station_pricing(uuid, uuid, bigint, uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.cpo_set_station_pricing(uuid, uuid, bigint, uuid, boolean, jsonb) to service_role;

commit;
