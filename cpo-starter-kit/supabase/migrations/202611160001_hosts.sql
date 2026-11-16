begin;

-- Network mode: site hosts (shops, hotels, car parks, apartment buildings) whose sites
-- carry the operator's chargers. Every charger stays in the operator's one Ivora
-- project; which site belongs to which host, the hosts' own logins and what each host
-- may do live here, in the kit's database. Ivora station and location IDs are never
-- authorization from a browser: a host user's sites are the cpo_host_sites rows of
-- their host, read on the server, and every write a host user makes is checked again
-- below, in the same statement as the write.
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated on the new tables except
-- column-level SELECT on cpo_hosts and cpo_host_sites, each matching an RLS policy:
-- operator staff read their operator's hosts and sites; a host user reads only their
-- own host and its sites. Writes go through the functions below (service_role only).
-- `npm run check:migrations` (the shared tools/check-migrations) enforces this in CI.

create table if not exists public.cpo_hosts (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  contact_name text check (char_length(contact_name) between 1 and 80),
  contact_email text check (contact_email = lower(contact_email) and char_length(contact_email) between 3 and 254),
  contact_phone text check (char_length(contact_phone) between 3 and 40),
  -- What the host's own users may do on the host's own sites. All off by default.
  can_edit_prices boolean not null default false,
  can_control boolean not null default false,
  can_sessions boolean not null default false,
  can_invite boolean not null default false,
  fault_emails boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Archived: its users are removed and its sites go back to the operator.
  archived_at timestamptz,
  unique (operator_id, id)
);
create index if not exists cpo_hosts_operator on public.cpo_hosts(operator_id);

-- One host per site (an Ivora location). No row: the operator's own site.
create table if not exists public.cpo_host_sites (
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  location_id bigint not null check (location_id > 0),
  host_id uuid not null,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (operator_id, location_id),
  foreign key (operator_id, host_id) references public.cpo_hosts(operator_id, id) on delete cascade
);
create index if not exists cpo_host_sites_host on public.cpo_host_sites(operator_id, host_id);

alter table public.cpo_hosts enable row level security;
alter table public.cpo_host_sites enable row level security;
revoke all on public.cpo_hosts, public.cpo_host_sites from public, anon, authenticated;
grant all on public.cpo_hosts, public.cpo_host_sites to service_role;

-- Host users: role 'host', tied to exactly one host of the same operator. Operator
-- staff have no host.
alter table public.cpo_staff add column if not exists host_id uuid;
alter table public.cpo_staff drop constraint if exists cpo_staff_role_check;
alter table public.cpo_staff add constraint cpo_staff_role_check
  check (role in ('owner', 'manager', 'technician', 'viewer', 'host'));
alter table public.cpo_staff drop constraint if exists cpo_staff_host_link;
alter table public.cpo_staff add constraint cpo_staff_host_link
  check ((role = 'host') = (host_id is not null));
alter table public.cpo_staff drop constraint if exists cpo_staff_host_fk;
alter table public.cpo_staff add constraint cpo_staff_host_fk
  foreign key (operator_id, host_id) references public.cpo_hosts(operator_id, id) on delete cascade;
create index if not exists cpo_staff_host on public.cpo_staff(operator_id, host_id) where host_id is not null;

alter table public.cpo_invites add column if not exists host_id uuid;
alter table public.cpo_invites drop constraint if exists cpo_invites_role_check;
alter table public.cpo_invites add constraint cpo_invites_role_check
  check (role in ('owner', 'manager', 'technician', 'viewer', 'host'));
alter table public.cpo_invites drop constraint if exists cpo_invites_host_link;
alter table public.cpo_invites add constraint cpo_invites_host_link
  check ((role = 'host') = (host_id is not null));
alter table public.cpo_invites drop constraint if exists cpo_invites_host_fk;
alter table public.cpo_invites add constraint cpo_invites_host_fk
  foreign key (operator_id, host_id) references public.cpo_hosts(operator_id, id) on delete cascade;

-- The operators the signed-in user belongs to: as before, except that a host user of
-- an archived host belongs to none (their access ends with the archive).
create or replace function public.cpo_my_operator_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select s.operator_id from public.cpo_staff s
  where s.user_id = auth.uid()
    and (s.host_id is null or exists (
      select 1 from public.cpo_hosts h
      where h.operator_id = s.operator_id and h.id = s.host_id and h.archived_at is null
    ))
$$;
revoke all on function public.cpo_my_operator_ids() from public, anon, authenticated;
grant execute on function public.cpo_my_operator_ids() to authenticated, service_role;

-- The signed-in user's host; null for operator staff (and for anyone not on a team).
create or replace function public.cpo_my_host_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.host_id from public.cpo_staff s where s.user_id = auth.uid()
$$;
revoke all on function public.cpo_my_host_id() from public, anon, authenticated;
grant execute on function public.cpo_my_host_id() to authenticated, service_role;

-- Operator staff read their whole team; a host user reads only their own host's users.
drop policy if exists "Staff read their team" on public.cpo_staff;
create policy "Staff read their team" on public.cpo_staff
  for select to authenticated using (
    operator_id in (select public.cpo_my_operator_ids())
    and ((select public.cpo_my_host_id()) is null or host_id = (select public.cpo_my_host_id()))
  );
grant select (host_id) on public.cpo_staff to authenticated;

grant select (id, operator_id, name, contact_name, contact_email, contact_phone,
  can_edit_prices, can_control, can_sessions, can_invite, fault_emails, created_at,
  archived_at) on public.cpo_hosts to authenticated;
create policy "Staff read their hosts" on public.cpo_hosts
  for select to authenticated using (
    operator_id in (select public.cpo_my_operator_ids())
    and ((select public.cpo_my_host_id()) is null or id = (select public.cpo_my_host_id()))
  );

grant select (operator_id, location_id, host_id) on public.cpo_host_sites to authenticated;
create policy "Staff read their host sites" on public.cpo_host_sites
  for select to authenticated using (
    operator_id in (select public.cpo_my_operator_ids())
    and ((select public.cpo_my_host_id()) is null or host_id = (select public.cpo_my_host_id()))
  );

-- Owners and managers manage hosts. Locks the actor's staff row (FOR SHARE) until the
-- write commits, so a concurrent demotion waits for it or is seen by it.
create or replace function public.cpo_lock_host_admin(p_operator_id uuid, p_actor_id uuid)
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
revoke all on function public.cpo_lock_host_admin(uuid, uuid) from public, anon, authenticated;

-- A host user acting on one of their host's sites: the host is not archived, its
-- switch p_permission ('prices', 'control', 'sessions', 'invite') is on, and, when
-- p_location_id is given, that site is the host's. Locks the staff, host and site rows
-- (FOR SHARE) until the write commits, so switching a permission off, archiving the
-- host, removing the user or moving the site waits for the write or is seen by it.
-- Returns the host's ID.
create or replace function public.cpo_lock_host_actor(
  p_operator_id uuid, p_actor_id uuid, p_permission text, p_location_id bigint
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_host uuid;
begin
  select s.host_id into v_host
    from public.cpo_staff s
    join public.cpo_hosts h on h.operator_id = s.operator_id and h.id = s.host_id
    where s.operator_id = p_operator_id and s.user_id = p_actor_id
      and s.role = 'host' and h.archived_at is null
      and case p_permission
        when 'prices' then h.can_edit_prices
        when 'control' then h.can_control
        when 'sessions' then h.can_sessions
        when 'invite' then h.can_invite
        else false
      end
    for share of s, h;
  if v_host is null then
    raise exception 'cpo_not_allowed' using errcode = 'P0001';
  end if;
  if p_location_id is not null then
    perform 1 from public.cpo_host_sites
      where operator_id = p_operator_id and location_id = p_location_id and host_id = v_host
      for share;
    if not found then
      raise exception 'cpo_not_allowed' using errcode = 'P0001';
    end if;
  end if;
  return v_host;
end;
$$;
revoke all on function public.cpo_lock_host_actor(uuid, uuid, text, bigint) from public, anon, authenticated;

-- Adds a host (p_id null) or changes one that is not archived. Switching off "invite
-- further users" revokes the invites its users sent that are still pending.
create or replace function public.cpo_save_host(
  p_operator_id uuid, p_actor_id uuid, p_id uuid, p_name text, p_contact_name text,
  p_contact_email text, p_contact_phone text, p_can_edit_prices boolean,
  p_can_control boolean, p_can_sessions boolean, p_can_invite boolean,
  p_fault_emails boolean
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform public.cpo_lock_host_admin(p_operator_id, p_actor_id);
  if p_id is null then
    insert into public.cpo_hosts (
      operator_id, name, contact_name, contact_email, contact_phone, can_edit_prices,
      can_control, can_sessions, can_invite, fault_emails, created_by
    ) values (
      p_operator_id, p_name, p_contact_name, lower(p_contact_email), p_contact_phone,
      coalesce(p_can_edit_prices, false), coalesce(p_can_control, false),
      coalesce(p_can_sessions, false), coalesce(p_can_invite, false),
      coalesce(p_fault_emails, false), p_actor_id
    ) returning id into v_id;
    return v_id;
  end if;
  update public.cpo_hosts set
    name = p_name,
    contact_name = p_contact_name,
    contact_email = lower(p_contact_email),
    contact_phone = p_contact_phone,
    can_edit_prices = coalesce(p_can_edit_prices, false),
    can_control = coalesce(p_can_control, false),
    can_sessions = coalesce(p_can_sessions, false),
    can_invite = coalesce(p_can_invite, false),
    fault_emails = coalesce(p_fault_emails, false),
    updated_at = now()
  where operator_id = p_operator_id and id = p_id and archived_at is null
  returning id into v_id;
  if v_id is null then
    raise exception 'cpo_host_not_found' using errcode = 'P0001';
  end if;
  if not coalesce(p_can_invite, false) then
    update public.cpo_invites i set revoked_at = now()
      from public.cpo_staff s
      where i.operator_id = p_operator_id and i.host_id = v_id
        and i.accepted_at is null and i.revoked_at is null
        and s.operator_id = p_operator_id and s.user_id = i.invited_by and s.host_id = v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.cpo_save_host(uuid, uuid, uuid, text, text, text, text, boolean, boolean, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.cpo_save_host(uuid, uuid, uuid, text, text, text, text, boolean, boolean, boolean, boolean, boolean) to service_role;

-- Archives a host in one step: its sites go back to the operator, its pending invites
-- are revoked and its users are removed (their access ends at once). Returns the
-- removed users' IDs, so the server can delete their logins too.
create or replace function public.cpo_archive_host(p_operator_id uuid, p_actor_id uuid, p_id uuid)
returns setof uuid language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_host_admin(p_operator_id, p_actor_id);
  update public.cpo_hosts set archived_at = now(), updated_at = now()
    where operator_id = p_operator_id and id = p_id and archived_at is null;
  if not found then
    raise exception 'cpo_host_not_found' using errcode = 'P0001';
  end if;
  delete from public.cpo_host_sites where operator_id = p_operator_id and host_id = p_id;
  update public.cpo_invites set revoked_at = now()
    where operator_id = p_operator_id and host_id = p_id
      and accepted_at is null and revoked_at is null;
  return query
    delete from public.cpo_staff
    where operator_id = p_operator_id and host_id = p_id
    returning user_id;
end;
$$;
revoke all on function public.cpo_archive_host(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.cpo_archive_host(uuid, uuid, uuid) to service_role;

-- Assigns a site to a host of the same operator that is not archived, or (p_host_id
-- null) back to the operator. The server checks the site is one of the operator's.
create or replace function public.cpo_assign_site(
  p_operator_id uuid, p_actor_id uuid, p_location_id bigint, p_host_id uuid
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_host_admin(p_operator_id, p_actor_id);
  if p_host_id is null then
    delete from public.cpo_host_sites
      where operator_id = p_operator_id and location_id = p_location_id;
    return;
  end if;
  perform 1 from public.cpo_hosts
    where operator_id = p_operator_id and id = p_host_id and archived_at is null
    for share;
  if not found then
    raise exception 'cpo_host_not_found' using errcode = 'P0001';
  end if;
  insert into public.cpo_host_sites (operator_id, location_id, host_id, assigned_by)
    values (p_operator_id, p_location_id, p_host_id, p_actor_id)
  on conflict (operator_id, location_id) do update set
    host_id = excluded.host_id, assigned_by = excluded.assigned_by, assigned_at = now();
end;
$$;
revoke all on function public.cpo_assign_site(uuid, uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.cpo_assign_site(uuid, uuid, bigint, uuid) to service_role;

-- Invites a host user. Owners and managers invite for any host; a host user only for
-- their own host, and only while its "invite further users" switch is on. The host
-- must not be archived. A new invite replaces a pending one for the same email.
create or replace function public.cpo_create_host_invite(
  p_operator_id uuid, p_actor_id uuid, p_host_id uuid, p_email text, p_token_hash text,
  p_expires_at timestamptz
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_invite uuid;
  v_host uuid;
begin
  perform 1 from public.cpo_staff
    where operator_id = p_operator_id and user_id = p_actor_id
      and role in ('owner', 'manager');
  if found then
    perform public.cpo_lock_host_admin(p_operator_id, p_actor_id);
    perform 1 from public.cpo_hosts
      where operator_id = p_operator_id and id = p_host_id and archived_at is null
      for share;
    if not found then
      raise exception 'cpo_host_not_found' using errcode = 'P0001';
    end if;
  else
    v_host := public.cpo_lock_host_actor(p_operator_id, p_actor_id, 'invite', null);
    if v_host is distinct from p_host_id then
      raise exception 'cpo_not_allowed' using errcode = 'P0001';
    end if;
  end if;
  if exists (
    select 1 from public.cpo_staff where operator_id = p_operator_id and email = lower(p_email)
  ) then
    raise exception 'cpo_already_staff' using errcode = 'P0001';
  end if;
  update public.cpo_invites set revoked_at = now()
    where operator_id = p_operator_id and email = lower(p_email)
      and accepted_at is null and revoked_at is null;
  insert into public.cpo_invites(operator_id, email, role, host_id, token_hash, invited_by, expires_at)
    values (p_operator_id, lower(p_email), 'host', p_host_id, p_token_hash, p_actor_id, p_expires_at)
    returning id into v_invite;
  return v_invite;
end;
$$;
revoke all on function public.cpo_create_host_invite(uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.cpo_create_host_invite(uuid, uuid, uuid, text, text, timestamptz) to service_role;

-- Accepting an invite, as before, now also carries a host invite's host into the new
-- staff row; an invite for a host archived meanwhile is no longer valid.
create or replace function public.cpo_accept_invite(p_token_hash text, p_user_id uuid, p_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_operator uuid;
  v_role text;
  v_host uuid;
begin
  update public.cpo_invites i set accepted_at = now()
    where i.token_hash = p_token_hash and i.email = lower(p_email)
      and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
      and (i.host_id is null or exists (
        select 1 from public.cpo_hosts h
        where h.operator_id = i.operator_id and h.id = i.host_id and h.archived_at is null
      ))
    returning i.operator_id, i.role, i.host_id into v_operator, v_role, v_host;
  if not found then
    raise exception 'cpo_invite_invalid' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.cpo_staff where user_id = p_user_id) then
    raise exception 'cpo_already_staff' using errcode = 'P0001';
  end if;
  insert into public.cpo_staff(operator_id, user_id, email, role, host_id)
    values (v_operator, p_user_id, lower(p_email), v_role, v_host);
  return v_operator;
end;
$$;
revoke all on function public.cpo_accept_invite(text, uuid, text) from public, anon, authenticated;
grant execute on function public.cpo_accept_invite(text, uuid, text) to service_role;

-- Live commands: the insert itself, shared by the staff claim (technicians and above)
-- and the host claim below. Not callable on its own.
create or replace function public.cpo_put_live_command(
  p_operator_id uuid, p_actor_id uuid, p_request_id uuid, p_station_id bigint,
  p_action text, p_connector_id bigint, p_transaction_id bigint, p_mode text,
  p_confirmed_sessions bigint[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_same boolean;
begin
  update public.cpo_live_commands set
    phase = 'unknown',
    error = 'Ivora did not confirm this command within 15 minutes. Check the charger before sending it again.',
    updated_at = now(), finished_at = now()
  where operator_id = p_operator_id and station_id = p_station_id
    and phase = 'pending' and requested_at < now() - interval '15 minutes';
  insert into public.cpo_live_commands (
    operator_id, request_id, station_id, action, connector_id, transaction_id, mode,
    confirmed_sessions, requested_by
  ) values (
    p_operator_id, p_request_id, p_station_id, p_action, p_connector_id,
    p_transaction_id, p_mode, coalesce(p_confirmed_sessions, '{}'), p_actor_id
  )
  on conflict (operator_id, request_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'created', true);
  end if;
  select id, (station_id = p_station_id and action = p_action
      and connector_id is not distinct from p_connector_id
      and transaction_id is not distinct from p_transaction_id
      and mode is not distinct from p_mode)
    into v_id, v_same
    from public.cpo_live_commands
    where operator_id = p_operator_id and request_id = p_request_id;
  if not v_same then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  return jsonb_build_object('id', v_id, 'created', false);
exception when unique_violation then
  raise exception 'cpo_command_busy' using errcode = 'P0001';
end;
$$;
revoke all on function public.cpo_put_live_command(uuid, uuid, uuid, bigint, text, bigint, bigint, text, bigint[]) from public, anon, authenticated;

-- The staff claim, unchanged in what it allows: technicians and above.
create or replace function public.cpo_claim_live_command(
  p_operator_id uuid, p_actor_id uuid, p_request_id uuid, p_station_id bigint,
  p_action text, p_connector_id bigint, p_transaction_id bigint, p_mode text,
  p_confirmed_sessions bigint[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_charger_actor(p_operator_id, p_actor_id, false);
  return public.cpo_put_live_command(p_operator_id, p_actor_id, p_request_id, p_station_id,
    p_action, p_connector_id, p_transaction_id, p_mode, p_confirmed_sessions);
end;
$$;
revoke all on function public.cpo_claim_live_command(uuid, uuid, uuid, bigint, text, bigint, bigint, text, bigint[]) from public, anon, authenticated;
grant execute on function public.cpo_claim_live_command(uuid, uuid, uuid, bigint, text, bigint, bigint, text, bigint[]) to service_role;

-- A host user's command on a charger at one of their host's sites (p_location_id, the
-- station's site as the server read it from Ivora): start and stop need the host's
-- "start and stop sessions" switch, reset and unlock its "restart and unlock" switch.
create or replace function public.cpo_claim_host_command(
  p_operator_id uuid, p_actor_id uuid, p_location_id bigint, p_request_id uuid,
  p_station_id bigint, p_action text, p_connector_id bigint, p_transaction_id bigint,
  p_mode text, p_confirmed_sessions bigint[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_location_id is null then
    raise exception 'cpo_not_allowed' using errcode = 'P0001';
  end if;
  perform public.cpo_lock_host_actor(p_operator_id, p_actor_id,
    case when p_action in ('start', 'stop') then 'sessions' else 'control' end,
    p_location_id);
  return public.cpo_put_live_command(p_operator_id, p_actor_id, p_request_id, p_station_id,
    p_action, p_connector_id, p_transaction_id, p_mode, p_confirmed_sessions);
end;
$$;
revoke all on function public.cpo_claim_host_command(uuid, uuid, bigint, uuid, bigint, text, bigint, bigint, text, bigint[]) from public, anon, authenticated;
grant execute on function public.cpo_claim_host_command(uuid, uuid, bigint, uuid, bigint, text, bigint, bigint, text, bigint[]) to service_role;

-- Station pricing: the write itself, shared by the staff save (owners and managers)
-- and the host save below. Not callable on its own. Same rules as before: confirmed
-- tariffs of the same operator only, and the form's revision must still hold.
create or replace function public.cpo_put_station_pricing(
  p_operator_id uuid, p_actor_id uuid, p_station_id bigint, p_expected_revision integer,
  p_tariff_id uuid, p_private boolean, p_connectors jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_connectors jsonb := coalesce(p_connectors, '[]'::jsonb);
  v_revision integer;
begin
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
  select revision into v_revision from public.cpo_station_pricing
    where operator_id = p_operator_id and station_id = p_station_id
    for update;
  if not found then
    if p_expected_revision is distinct from 0 then
      raise exception 'cpo_station_changed' using errcode = 'P0001';
    end if;
    insert into public.cpo_station_pricing (operator_id, station_id, tariff_id, private, updated_by)
      values (p_operator_id, p_station_id, p_tariff_id, coalesce(p_private, false), p_actor_id)
      on conflict (operator_id, station_id) do nothing;
    if not found then
      raise exception 'cpo_station_changed' using errcode = 'P0001';
    end if;
  else
    if v_revision is distinct from p_expected_revision then
      raise exception 'cpo_station_changed' using errcode = 'P0001';
    end if;
    update public.cpo_station_pricing set
        tariff_id = p_tariff_id,
        private = coalesce(p_private, false),
        revision = revision + 1,
        updated_by = p_actor_id,
        updated_at = now()
      where operator_id = p_operator_id and station_id = p_station_id;
  end if;
  delete from public.cpo_connector_tariffs
    where operator_id = p_operator_id and station_id = p_station_id;
  insert into public.cpo_connector_tariffs (operator_id, station_id, connector_id, tariff_id, updated_by)
    select p_operator_id, p_station_id, (c->>'connector_id')::bigint, (c->>'tariff_id')::uuid, p_actor_id
    from jsonb_array_elements(v_connectors) c;
end;
$$;
revoke all on function public.cpo_put_station_pricing(uuid, uuid, bigint, integer, uuid, boolean, jsonb) from public, anon, authenticated;

create or replace function public.cpo_set_station_pricing(
  p_operator_id uuid, p_actor_id uuid, p_station_id bigint, p_expected_revision integer,
  p_tariff_id uuid, p_private boolean, p_connectors jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_pricing_actor(p_operator_id, p_actor_id);
  perform public.cpo_put_station_pricing(p_operator_id, p_actor_id, p_station_id,
    p_expected_revision, p_tariff_id, p_private, p_connectors);
end;
$$;
revoke all on function public.cpo_set_station_pricing(uuid, uuid, bigint, integer, uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.cpo_set_station_pricing(uuid, uuid, bigint, integer, uuid, boolean, jsonb) to service_role;

-- A host user choosing the tariffs of a charger at one of their host's sites, while
-- the host's "edit prices" switch is on.
create or replace function public.cpo_set_host_station_pricing(
  p_operator_id uuid, p_actor_id uuid, p_location_id bigint, p_station_id bigint,
  p_expected_revision integer, p_tariff_id uuid, p_private boolean, p_connectors jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_location_id is null then
    raise exception 'cpo_not_allowed' using errcode = 'P0001';
  end if;
  perform public.cpo_lock_host_actor(p_operator_id, p_actor_id, 'prices', p_location_id);
  perform public.cpo_put_station_pricing(p_operator_id, p_actor_id, p_station_id,
    p_expected_revision, p_tariff_id, p_private, p_connectors);
end;
$$;
revoke all on function public.cpo_set_host_station_pricing(uuid, uuid, bigint, bigint, integer, uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.cpo_set_host_station_pricing(uuid, uuid, bigint, bigint, integer, uuid, boolean, jsonb) to service_role;

-- Reports for a set of chargers (a host's, or a host filter): the same as
-- cpo_report_checkouts and cpo_report_totals, limited to p_station_ids, which the
-- server derives from the sites the signed-in user may see.
create or replace function public.cpo_report_checkouts_at(
  p_operator_id uuid, p_station_ids bigint[], p_from timestamptz, p_to timestamptz,
  p_station_id bigint, p_status text, p_limit integer, p_offset integer,
  p_after_created_at timestamptz, p_after_id uuid
)
returns setof public.cpo_checkouts language sql stable security definer
set search_path = '' as $$
  select c.* from public.cpo_checkouts c
  where c.operator_id = p_operator_id
    and c.station_id = any(coalesce(p_station_ids, '{}'))
    and c.created_at >= p_from and c.created_at < p_to
    and (p_station_id is null or c.station_id = p_station_id)
    and (p_status = 'all'
      or (p_status = 'refunded' and c.refunded_minor > 0)
      or public.cpo_report_status(c) = p_status)
    and (p_after_created_at is null
      or (c.created_at, c.id) < (p_after_created_at, p_after_id))
  order by c.created_at desc, c.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke execute on function public.cpo_report_checkouts_at(uuid, bigint[], timestamptz, timestamptz, bigint, text, integer, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.cpo_report_checkouts_at(uuid, bigint[], timestamptz, timestamptz, bigint, text, integer, integer, timestamptz, uuid) to service_role;

create or replace function public.cpo_report_totals_at(
  p_operator_id uuid, p_station_ids bigint[], p_from timestamptz, p_to timestamptz,
  p_station_id bigint, p_status text
)
returns jsonb language sql stable security definer set search_path = '' as $$
  with c as (
    select c.*, public.cpo_report_status(c) as status
    from public.cpo_checkouts c
    where c.operator_id = p_operator_id
      and c.station_id = any(coalesce(p_station_ids, '{}'))
      and c.created_at >= p_from and c.created_at < p_to
      and (p_station_id is null or c.station_id = p_station_id)
      and (p_status = 'all'
        or (p_status = 'refunded' and c.refunded_minor > 0)
        or public.cpo_report_status(c) = p_status)
  )
  select jsonb_build_object(
    'checkouts', (select count(*) from c),
    'paid', (select count(*) from c where kind = 'paid'),
    'free', (select count(*) from c where kind = 'free'),
    'with_session', (select count(*) from c where transaction_id is not null),
    'in_progress', (select count(*) from c where status = 'in_progress'),
    'charged', (select count(*) from c where status = 'charged'),
    'no_charge', (select count(*) from c where status = 'no_charge'),
    'attention', (select count(*) from c where status = 'attention'),
    'energy_wh', (select coalesce(sum(energy_wh), 0) from c where detail_at is not null),
    'details_pending', (select count(*) from c
      where transaction_id is not null and detail_at is null),
    'refunds_unchecked', (select count(*) from c
      where status = 'charged' and refund_checked_at is null),
    'currencies', coalesce((
      select jsonb_agg(jsonb_build_object(
          'currency', currency,
          'charged', charged,
          'billed_minor', billed_minor,
          'captured_minor', captured_minor,
          'refunded_minor', refunded_minor
        ) order by currency)
      from (
        select currency,
          count(*) filter (where status = 'charged') as charged,
          coalesce(sum(final_minor), 0) as billed_minor,
          coalesce(sum(captured_minor), 0) as captured_minor,
          coalesce(sum(refunded_minor), 0) as refunded_minor
        from c where kind = 'paid' and phase in ('settled', 'attention')
        group by currency
      ) m
    ), '[]'::jsonb)
  )
$$;
revoke execute on function public.cpo_report_totals_at(uuid, bigint[], timestamptz, timestamptz, bigint, text) from public, anon, authenticated;
grant execute on function public.cpo_report_totals_at(uuid, bigint[], timestamptz, timestamptz, bigint, text) to service_role;

-- Who gets an email about a new fault at a site: the users of the site's host, while
-- the host is not archived and its "fault emails" switch is on.
create or replace function public.cpo_host_fault_recipients(p_location_id bigint)
returns table (operator_id uuid, host_id uuid, host_name text, user_id uuid, email text)
language sql stable security definer set search_path = '' as $$
  select h.operator_id, h.id, h.name, s.user_id, s.email
  from public.cpo_host_sites hs
  join public.cpo_hosts h on h.operator_id = hs.operator_id and h.id = hs.host_id
  join public.cpo_staff s on s.operator_id = h.operator_id and s.host_id = h.id
  where hs.location_id = p_location_id and h.archived_at is null and h.fault_emails
  order by s.email
$$;
revoke execute on function public.cpo_host_fault_recipients(bigint) from public, anon, authenticated;
grant execute on function public.cpo_host_fault_recipients(bigint) to service_role;

commit;
