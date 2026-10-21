begin;

-- Team: operators, staff logins with roles, invites and sign-in rate limits.
--
-- 10-30 rule: every public table has RLS on and starts with no privileges for anon or
-- authenticated. Only the two tables the server reads through the Data API with the
-- staff member's own session (cpo_operators, cpo_staff) get column-level SELECT for
-- authenticated, matching their RLS policies. Everything else is service_role only,
-- behind server code that has already checked the staff member's role.
-- `npm run check:migrations` enforces this in CI.

create table if not exists public.cpo_operators (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);

-- One staff login belongs to one operator.
create table if not exists public.cpo_staff (
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  role text not null check (role in ('owner', 'manager', 'technician', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (operator_id, user_id)
);
create index if not exists cpo_staff_email on public.cpo_staff(email);

-- Invites store a SHA-256 of the single-use token, never the token itself.
create table if not exists public.cpo_invites (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  role text not null check (role in ('owner', 'manager', 'technician', 'viewer')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists cpo_invites_one_pending
  on public.cpo_invites(operator_id, email)
  where accepted_at is null and revoked_at is null;

-- Keys are HMAC digests, never plain email or IP addresses.
create table if not exists public.cpo_rate_limits (
  key text primary key,
  attempts integer not null check (attempts > 0),
  resets_at timestamptz not null
);
create index if not exists cpo_rate_limits_expiry on public.cpo_rate_limits(resets_at);

alter table public.cpo_operators enable row level security;
alter table public.cpo_staff enable row level security;
alter table public.cpo_invites enable row level security;
alter table public.cpo_rate_limits enable row level security;

revoke all on public.cpo_operators, public.cpo_staff, public.cpo_invites, public.cpo_rate_limits
  from public, anon, authenticated;
grant all on public.cpo_operators, public.cpo_staff, public.cpo_invites, public.cpo_rate_limits
  to service_role;

-- The operators the signed-in staff member belongs to. SECURITY DEFINER so the
-- cpo_staff policy can use it without recursing into itself.
create or replace function public.cpo_my_operator_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select s.operator_id from public.cpo_staff s where s.user_id = auth.uid()
$$;
revoke all on function public.cpo_my_operator_ids() from public, anon, authenticated;
grant execute on function public.cpo_my_operator_ids() to authenticated, service_role;

-- Data API reads with the staff member's session: their own operator and team only.
grant select (id, name) on public.cpo_operators to authenticated;
grant select (operator_id, user_id, email, role, created_at) on public.cpo_staff to authenticated;
create policy "Staff read their operator" on public.cpo_operators
  for select to authenticated using (id in (select public.cpo_my_operator_ids()));
create policy "Staff read their team" on public.cpo_staff
  for select to authenticated using (operator_id in (select public.cpo_my_operator_ids()));

-- The last owner can't be removed or demoted. Locking the operator row serializes
-- concurrent changes, so two owners cannot demote each other at the same time.
create or replace function public.cpo_keep_an_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner'
    and (tg_op = 'DELETE' or new.role <> 'owner' or new.operator_id <> old.operator_id) then
    perform 1 from public.cpo_operators where id = old.operator_id for update;
    -- The operator itself is being deleted: its staff go with it.
    if found and not exists (
      select 1 from public.cpo_staff
      where operator_id = old.operator_id and role = 'owner' and user_id <> old.user_id
    ) then
      raise exception 'cpo_last_owner' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function public.cpo_keep_an_owner() from public, anon, authenticated;
drop trigger if exists cpo_staff_keep_an_owner on public.cpo_staff;
create trigger cpo_staff_keep_an_owner
  before update or delete on public.cpo_staff
  for each row execute function public.cpo_keep_an_owner();

-- First owner, from the setup screen. Works once: after that everyone joins by invite.
create or replace function public.cpo_bootstrap_owner(p_user_id uuid, p_email text, p_operator_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_operator uuid;
begin
  lock table public.cpo_staff in exclusive mode;
  if exists (select 1 from public.cpo_staff) then
    raise exception 'cpo_setup_done' using errcode = 'P0001';
  end if;
  insert into public.cpo_operators(name) values (p_operator_name) returning id into v_operator;
  insert into public.cpo_staff(operator_id, user_id, email, role)
    values (v_operator, p_user_id, lower(p_email), 'owner');
  return v_operator;
end;
$$;
revoke all on function public.cpo_bootstrap_owner(uuid, text, text) from public, anon, authenticated;
grant execute on function public.cpo_bootstrap_owner(uuid, text, text) to service_role;

-- A new invite replaces any pending one for the same email.
create or replace function public.cpo_create_invite(
  p_operator_id uuid, p_email text, p_role text, p_token_hash text, p_invited_by uuid, p_expires_at timestamptz
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_invite uuid;
begin
  if exists (
    select 1 from public.cpo_staff where operator_id = p_operator_id and email = lower(p_email)
  ) then
    raise exception 'cpo_already_staff' using errcode = 'P0001';
  end if;
  update public.cpo_invites set revoked_at = now()
    where operator_id = p_operator_id and email = lower(p_email)
      and accepted_at is null and revoked_at is null;
  insert into public.cpo_invites(operator_id, email, role, token_hash, invited_by, expires_at)
    values (p_operator_id, lower(p_email), p_role, p_token_hash, p_invited_by, p_expires_at)
    returning id into v_invite;
  return v_invite;
end;
$$;
revoke all on function public.cpo_create_invite(uuid, text, text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.cpo_create_invite(uuid, text, text, text, uuid, timestamptz) to service_role;

-- Single use: the invite is marked accepted and the staff row inserted in one step.
create or replace function public.cpo_accept_invite(p_token_hash text, p_user_id uuid, p_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_operator uuid;
  v_role text;
begin
  update public.cpo_invites set accepted_at = now()
    where token_hash = p_token_hash and email = lower(p_email)
      and accepted_at is null and revoked_at is null and expires_at > now()
    returning operator_id, role into v_operator, v_role;
  if not found then
    raise exception 'cpo_invite_invalid' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.cpo_staff where user_id = p_user_id) then
    raise exception 'cpo_already_staff' using errcode = 'P0001';
  end if;
  insert into public.cpo_staff(operator_id, user_id, email, role)
    values (v_operator, p_user_id, lower(p_email), v_role);
  return v_operator;
end;
$$;
revoke all on function public.cpo_accept_invite(text, uuid, text) from public, anon, authenticated;
grant execute on function public.cpo_accept_invite(text, uuid, text) to service_role;

-- One atomic quota shared by every server instance.
create or replace function public.cpo_take_rate_limit(bucket_key text, quota integer, period_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if quota < 1 or period_seconds < 1 then
    raise exception 'Invalid rate limit';
  end if;
  insert into public.cpo_rate_limits as r (key, attempts, resets_at)
    values (bucket_key, 1, now() + make_interval(secs => period_seconds))
  on conflict (key) do update set
    attempts = case when r.resets_at <= now() then 1 else r.attempts + 1 end,
    resets_at = case when r.resets_at <= now() then excluded.resets_at else r.resets_at end
  where r.resets_at <= now() or r.attempts < quota;
  return found;
end;
$$;
revoke all on function public.cpo_take_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.cpo_take_rate_limit(text, integer, integer) to service_role;

commit;
