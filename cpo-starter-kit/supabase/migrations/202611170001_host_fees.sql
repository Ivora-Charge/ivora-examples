begin;

-- Network mode, part 2: the operator's network fee per site host, each host's payout
-- account, and what a checkout at a host's site records when it starts. Additive only:
-- three new tables and new functions; no existing table or function changes.
--
-- - cpo_host_fee_plans: versions of a host's fee, never edited. A change is a new row,
--   effective from when it was saved, so it applies to sessions started after it.
-- - cpo_host_payout_accounts: the host's own Stripe account (a connected account of
--   the operator's Stripe platform) and its status. Read here; written by the host
--   payout setup (see README: Host payouts, live mode pending review).
-- - cpo_checkout_hosts: per checkout at a host's site, the host, its payout account and
--   the fee version at the session's start, written once in one statement.
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated; the server reads with
-- the service role after checking the user, and writes only through the functions
-- below, which check the actor's role in the same statement as the write.
-- `npm run check:migrations` enforces this in CI.

create table if not exists public.cpo_host_fee_plans (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  host_id uuid not null,
  -- percent: basis points of the captured amount. per_kwh: minor units per kWh.
  mode text not null check (mode in ('percent', 'per_kwh')),
  percent_bps integer not null default 0 check (percent_bps between 0 and 10000),
  per_kwh_minor integer not null default 0 check (per_kwh_minor between 0 and 10000),
  -- Shown on the statement per charger and month; never collected by the kit.
  monthly_charger_fee_minor integer not null default 0
    check (monthly_charger_fee_minor between 0 and 1000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  effective_from timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (operator_id, host_id) references public.cpo_hosts(operator_id, id) on delete cascade
);
create index if not exists cpo_host_fee_plans_host
  on public.cpo_host_fee_plans(operator_id, host_id, effective_from desc);

create table if not exists public.cpo_host_payout_accounts (
  operator_id uuid not null,
  host_id uuid not null,
  -- The connected account (acct_…). Changing it only affects checkouts after it.
  stripe_account_id text check (stripe_account_id ~ '^acct_[A-Za-z0-9]{1,64}$'),
  status text not null default 'none' check (status in ('none', 'action_needed', 'ready')),
  requirements text[] not null default '{}',
  checked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (operator_id, host_id),
  foreign key (operator_id, host_id) references public.cpo_hosts(operator_id, id) on delete cascade,
  check (status = 'none' or stripe_account_id is not null)
);

create table if not exists public.cpo_checkout_hosts (
  checkout_id uuid primary key references public.cpo_checkouts(id) on delete cascade,
  operator_id uuid not null,
  location_id bigint not null check (location_id > 0),
  host_id uuid not null,
  -- The account the session's payment is for, as stored when it started.
  payout_account_id text,
  fee_plan_id uuid references public.cpo_host_fee_plans(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  foreign key (operator_id, host_id) references public.cpo_hosts(operator_id, id) on delete cascade
);
create index if not exists cpo_checkout_hosts_host
  on public.cpo_checkout_hosts(operator_id, host_id);

alter table public.cpo_host_fee_plans enable row level security;
alter table public.cpo_host_payout_accounts enable row level security;
alter table public.cpo_checkout_hosts enable row level security;
revoke all on public.cpo_host_fee_plans, public.cpo_host_payout_accounts,
  public.cpo_checkout_hosts from public, anon, authenticated;
grant select on public.cpo_host_fee_plans, public.cpo_host_payout_accounts,
  public.cpo_checkout_hosts to service_role;

-- A new fee version for a host of the operator that is not archived. Owners and
-- managers only, checked here with the actor's row locked (cpo_lock_host_admin), and
-- effective from now, never earlier than the host's latest version.
create or replace function public.cpo_set_host_fee_plan(
  p_operator_id uuid, p_actor_id uuid, p_host_id uuid, p_mode text,
  p_percent_bps integer, p_per_kwh_minor integer, p_monthly_charger_fee_minor integer,
  p_currency text
)
returns public.cpo_host_fee_plans language plpgsql security definer
set search_path = '' as $$
declare
  v_row public.cpo_host_fee_plans;
  v_from timestamptz;
begin
  perform public.cpo_lock_host_admin(p_operator_id, p_actor_id);
  -- Locks the host row: one new version at a time per host, and archiving waits.
  perform 1 from public.cpo_hosts
    where operator_id = p_operator_id and id = p_host_id and archived_at is null
    for update;
  if not found then
    raise exception 'cpo_host_not_found' using errcode = 'P0001';
  end if;
  select greatest(now(), max(effective_from) + interval '1 microsecond') into v_from
    from public.cpo_host_fee_plans
    where operator_id = p_operator_id and host_id = p_host_id;
  insert into public.cpo_host_fee_plans (
    operator_id, host_id, mode, percent_bps, per_kwh_minor, monthly_charger_fee_minor,
    currency, effective_from, created_by
  ) values (
    p_operator_id, p_host_id, p_mode, coalesce(p_percent_bps, 0),
    coalesce(p_per_kwh_minor, 0), coalesce(p_monthly_charger_fee_minor, 0),
    p_currency, coalesce(v_from, now()), p_actor_id
  ) returning * into v_row;
  return v_row;
end;
$$;
revoke execute on function public.cpo_set_host_fee_plan(uuid, uuid, uuid, text, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.cpo_set_host_fee_plan(uuid, uuid, uuid, text, integer, integer, integer, text) to service_role;

-- What a checkout at a site records when it starts: the site's host, the host's payout
-- account and the fee version in effect, all read in this one statement. Written once:
-- a second call returns the first record unchanged. No row (null) when the site has no
-- host. The server passes the site it read from Ivora for the checkout's station.
create or replace function public.cpo_snapshot_checkout_host(
  p_operator_id uuid, p_checkout_id uuid, p_location_id bigint
)
returns setof public.cpo_checkout_hosts language plpgsql security definer
set search_path = '' as $$
begin
  perform 1 from public.cpo_checkouts
    where id = p_checkout_id and operator_id = p_operator_id;
  if not found then
    raise exception 'cpo_not_found' using errcode = 'P0001';
  end if;
  insert into public.cpo_checkout_hosts (
    checkout_id, operator_id, location_id, host_id, payout_account_id, fee_plan_id
  )
  select p_checkout_id, p_operator_id, p_location_id, hs.host_id,
    pa.stripe_account_id,
    (select f.id from public.cpo_host_fee_plans f
      where f.operator_id = p_operator_id and f.host_id = hs.host_id
        and f.effective_from <= now()
      order by f.effective_from desc limit 1)
  from public.cpo_host_sites hs
  join public.cpo_hosts h on h.operator_id = hs.operator_id and h.id = hs.host_id
    and h.archived_at is null
  left join public.cpo_host_payout_accounts pa
    on pa.operator_id = hs.operator_id and pa.host_id = hs.host_id
    and pa.status <> 'none'
  where hs.operator_id = p_operator_id and hs.location_id = p_location_id
  on conflict (checkout_id) do nothing;
  return query select * from public.cpo_checkout_hosts where checkout_id = p_checkout_id;
end;
$$;
revoke execute on function public.cpo_snapshot_checkout_host(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.cpo_snapshot_checkout_host(uuid, uuid, bigint) to service_role;

-- The host of a site and its payout status, for the driver checkout's payout check.
-- The driver is not signed in, so the server reads this with the service role (never
-- through the browser's session, where RLS would show no host and let a host's site be
-- paid into the operator's account). No row: the site has no (active) host.
create or replace function public.cpo_site_payout(p_operator_id uuid, p_location_id bigint)
returns table (host_id uuid, status text)
language sql stable security definer set search_path = '' as $$
  select hs.host_id, coalesce(pa.status, 'none')
  from public.cpo_host_sites hs
  join public.cpo_hosts h on h.operator_id = hs.operator_id and h.id = hs.host_id
    and h.archived_at is null
  left join public.cpo_host_payout_accounts pa
    on pa.operator_id = hs.operator_id and pa.host_id = hs.host_id
  where hs.operator_id = p_operator_id and hs.location_id = p_location_id
$$;
revoke execute on function public.cpo_site_payout(uuid, bigint) from public, anon, authenticated;
grant execute on function public.cpo_site_payout(uuid, bigint) to service_role;

-- The host and fee terms recorded for some checkouts (a Reports page's rows).
create or replace function public.cpo_checkout_host_fees(p_operator_id uuid, p_checkout_ids uuid[])
returns table (
  checkout_id uuid, host_id uuid, mode text, percent_bps integer, per_kwh_minor integer,
  monthly_charger_fee_minor integer, currency text
)
language sql stable security definer set search_path = '' as $$
  select ch.checkout_id, ch.host_id, f.mode, f.percent_bps, f.per_kwh_minor,
    f.monthly_charger_fee_minor, f.currency
  from public.cpo_checkout_hosts ch
  left join public.cpo_host_fee_plans f on f.id = ch.fee_plan_id
  where ch.operator_id = p_operator_id
    and ch.checkout_id = any(coalesce(p_checkout_ids, '{}'))
$$;
revoke execute on function public.cpo_checkout_host_fees(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.cpo_checkout_host_fees(uuid, uuid[]) to service_role;

-- One host's statement: its checkouts made in [p_from, p_to) (by the host recorded at
-- their start), newest first, each with the fee terms recorded then. At most p_limit
-- (up to 5,000) rows.
create or replace function public.cpo_host_statement(
  p_operator_id uuid, p_host_id uuid, p_from timestamptz, p_to timestamptz, p_limit integer
)
returns table (
  checkout jsonb, mode text, percent_bps integer, per_kwh_minor integer,
  monthly_charger_fee_minor integer, currency text
)
language sql stable security definer set search_path = '' as $$
  select to_jsonb(c), f.mode, f.percent_bps, f.per_kwh_minor,
    f.monthly_charger_fee_minor, f.currency
  from public.cpo_checkout_hosts ch
  join public.cpo_checkouts c on c.id = ch.checkout_id
  left join public.cpo_host_fee_plans f on f.id = ch.fee_plan_id
  where ch.operator_id = p_operator_id and ch.host_id = p_host_id
    and c.created_at >= p_from and c.created_at < p_to
  order by c.created_at desc, c.id desc
  limit least(greatest(coalesce(p_limit, 1000), 1), 5000)
$$;
revoke execute on function public.cpo_host_statement(uuid, uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.cpo_host_statement(uuid, uuid, timestamptz, timestamptz, integer) to service_role;

commit;
