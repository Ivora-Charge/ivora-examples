-- The OCPI sessions and CDRs of our drivers, as CPOs push them to our Receiver
-- interfaces or we pull them from their Sender interfaces, linked to the driver's charge
-- request (the START_SESSION command, by authorization_reference) and token; and the
-- reconciliation data per peer and day.
-- Service-only (10-30 rule): RLS on, nothing granted to anon or authenticated. The
-- driver app reaches sessions through the server's API, never the Data API.
-- Amounts are E4: ten-thousandths of the unit (kWh, or the currency's major unit), as
-- whole numbers, so sums are exact.
begin;

create table public.emsp_sessions (
  id uuid primary key default gen_random_uuid(),
  peer_id uuid not null references public.emsp_ocpi_peers (id),
  -- The CPO party the session runs at, and its session ID.
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  party_id text not null check (party_id ~ '^[A-Z0-9]{3}$'),
  session_id text not null check (char_length(session_id) between 1 and 36),
  -- The OCPI 2.2.1 Session as we hold it: validated, with every change applied.
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  -- When each field of data was last set, by the CPO's last_updated: a change older
  -- than a field's time leaves that field alone, so PATCHes may arrive in any order.
  field_times jsonb not null default '{}'::jsonb check (jsonb_typeof(field_times) = 'object'),
  status text not null check (status in ('ACTIVE', 'COMPLETED', 'INVALID', 'PENDING', 'RESERVATION')),
  start_date_time timestamptz not null,
  end_date_time timestamptz,
  kwh_e4 bigint not null check (kwh_e4 >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  last_updated timestamptz not null,
  -- The driver, by the start command or the token. Null for a token we did not issue.
  driver_ref text check (char_length(driver_ref) between 1 and 64),
  -- The START_SESSION it came from, by authorization_reference.
  command_id uuid references public.emsp_commands (id),
  -- When it ended for us (COMPLETED or INVALID, or a CDR arrived): set once, with the
  -- session.completed event.
  completed_at timestamptz,
  -- Changes with every write: the compare-and-swap token.
  revision uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (peer_id, country_code, party_id, session_id)
);

create index emsp_sessions_start_idx on public.emsp_sessions (start_date_time);
create index emsp_sessions_peer_session_idx on public.emsp_sessions (peer_id, session_id);
create index emsp_sessions_driver_idx
  on public.emsp_sessions (driver_ref, start_date_time desc) where driver_ref is not null;

alter table public.emsp_sessions enable row level security;
revoke all on table public.emsp_sessions from public, anon, authenticated, service_role;
-- Sessions are a record of what drivers charged: never deleted.
grant select, insert, update on table public.emsp_sessions to service_role;

create table public.emsp_cdrs (
  id uuid primary key default gen_random_uuid(),
  peer_id uuid not null references public.emsp_ocpi_peers (id),
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  party_id text not null check (party_id ~ '^[A-Z0-9]{3}$'),
  cdr_id text not null check (char_length(cdr_id) between 1 and 39),
  -- The session it bills, when the CPO names one.
  session_id text check (char_length(session_id) between 1 and 36),
  -- The OCPI 2.2.1 CDR exactly as validated on arrival.
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  start_date_time timestamptz not null,
  end_date_time timestamptz not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- As the CPO sent them (a credit CDR's may be negative).
  total_energy_e4 bigint not null,
  total_cost_excl_vat_e4 bigint not null,
  total_cost_incl_vat_e4 bigint,
  credit boolean not null default false,
  credit_reference_id text check (char_length(credit_reference_id) between 1 and 39),
  last_updated timestamptz not null,
  -- Linked on arrival, like a session.
  driver_ref text check (char_length(driver_ref) between 1 and 64),
  command_id uuid references public.emsp_commands (id),
  source text not null check (source in ('push', 'pull')),
  received_at timestamptz not null default now(),
  unique (peer_id, country_code, party_id, cdr_id),
  check (not credit or credit_reference_id is not null)
);

create index emsp_cdrs_session_idx
  on public.emsp_cdrs (peer_id, country_code, party_id, session_id) where session_id is not null;
create index emsp_cdrs_start_idx on public.emsp_cdrs (start_date_time);

alter table public.emsp_cdrs enable row level security;
revoke all on table public.emsp_cdrs from public, anon, authenticated, service_role;
-- A CDR is what the driver is billed for: kept exactly as received, never changed.
grant select, insert on table public.emsp_cdrs to service_role;

create function public.emsp_cdrs_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'emsp_cdrs is immutable';
end;
$$;
revoke all on function public.emsp_cdrs_immutable() from public, anon, authenticated;

create trigger emsp_cdrs_immutable
  before update or delete or truncate on public.emsp_cdrs
  for each statement execute function public.emsp_cdrs_immutable();

-- The pull of sessions and CDRs keeps its state beside that of locations and tariffs.
alter table public.emsp_ocpi_sync_state drop constraint emsp_ocpi_sync_state_module_check;
alter table public.emsp_ocpi_sync_state add constraint emsp_ocpi_sync_state_module_check
  check (module in ('locations', 'tariffs', 'sessions', 'cdrs'));

-- Reconciliation per peer, UTC day (of the start) and currency, for sessions and CDRs
-- that started in [p_from, p_to): counts, sessions COMPLETED without a CDR, CDRs that
-- name no session we hold, and totals. A credit CDR counts against the totals and needs
-- no session. At most 100 IDs per list (country_code/party_id/id); the counts are whole.
create function public.emsp_reconciliation(
  p_from timestamptz,
  p_to timestamptz,
  p_peer_id uuid
) returns table (
  peer_id uuid,
  day date,
  currency text,
  sessions integer,
  sessions_open integer,
  sessions_completed integer,
  sessions_invalid integer,
  session_kwh_e4 bigint,
  sessions_without_cdr integer,
  sessions_without_cdr_ids text[],
  cdrs integer,
  credit_cdrs integer,
  cdrs_without_session integer,
  cdrs_without_session_ids text[],
  cdr_energy_e4 bigint,
  cdr_cost_excl_vat_e4 bigint,
  cdr_cost_incl_vat_e4 bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with s as (
    select s.peer_id, (s.start_date_time at time zone 'UTC')::date as day, s.currency,
      s.status, s.kwh_e4,
      s.country_code || '/' || s.party_id || '/' || s.session_id as ref,
      exists (
        select 1 from public.emsp_cdrs as c
        where c.peer_id = s.peer_id and c.country_code = s.country_code
          and c.party_id = s.party_id and c.session_id = s.session_id and not c.credit
      ) as has_cdr
    from public.emsp_sessions as s
    where s.start_date_time >= p_from and s.start_date_time < p_to
      and (p_peer_id is null or s.peer_id = p_peer_id)
  ),
  c as (
    select c.peer_id, (c.start_date_time at time zone 'UTC')::date as day, c.currency,
      c.credit,
      c.country_code || '/' || c.party_id || '/' || c.cdr_id as ref,
      case when c.credit then -abs(c.total_energy_e4) else c.total_energy_e4 end as energy,
      case when c.credit then -abs(c.total_cost_excl_vat_e4) else c.total_cost_excl_vat_e4 end as excl,
      case when c.credit then -abs(c.total_cost_incl_vat_e4) else c.total_cost_incl_vat_e4 end as incl,
      c.credit or exists (
        select 1 from public.emsp_sessions as s
        where s.peer_id = c.peer_id and s.country_code = c.country_code
          and s.party_id = c.party_id and s.session_id = c.session_id
      ) as has_session
    from public.emsp_cdrs as c
    where c.start_date_time >= p_from and c.start_date_time < p_to
      and (p_peer_id is null or c.peer_id = p_peer_id)
  ),
  sa as (
    select s.peer_id, s.day, s.currency,
      count(*)::integer as sessions,
      count(*) filter (where s.status in ('ACTIVE', 'PENDING', 'RESERVATION'))::integer as sessions_open,
      count(*) filter (where s.status = 'COMPLETED')::integer as sessions_completed,
      count(*) filter (where s.status = 'INVALID')::integer as sessions_invalid,
      coalesce(sum(s.kwh_e4) filter (where s.status <> 'INVALID'), 0)::bigint as session_kwh_e4,
      count(*) filter (where s.status = 'COMPLETED' and not s.has_cdr)::integer as sessions_without_cdr,
      coalesce(
        (array_agg(s.ref order by s.ref collate "C") filter (where s.status = 'COMPLETED' and not s.has_cdr))[1:100],
        '{}'::text[]
      ) as sessions_without_cdr_ids
    from s
    group by s.peer_id, s.day, s.currency
  ),
  ca as (
    select c.peer_id, c.day, c.currency,
      count(*) filter (where not c.credit)::integer as cdrs,
      count(*) filter (where c.credit)::integer as credit_cdrs,
      count(*) filter (where not c.has_session)::integer as cdrs_without_session,
      coalesce(
        (array_agg(c.ref order by c.ref collate "C") filter (where not c.has_session))[1:100],
        '{}'::text[]
      ) as cdrs_without_session_ids,
      sum(c.energy)::bigint as cdr_energy_e4,
      sum(c.excl)::bigint as cdr_cost_excl_vat_e4,
      -- Null when any CDR of the group gave no amount including VAT.
      case when bool_and(c.incl is not null) then sum(c.incl) end::bigint as cdr_cost_incl_vat_e4
    from c
    group by c.peer_id, c.day, c.currency
  )
  select coalesce(sa.peer_id, ca.peer_id), coalesce(sa.day, ca.day),
    coalesce(sa.currency, ca.currency),
    coalesce(sa.sessions, 0), coalesce(sa.sessions_open, 0),
    coalesce(sa.sessions_completed, 0), coalesce(sa.sessions_invalid, 0),
    coalesce(sa.session_kwh_e4, 0), coalesce(sa.sessions_without_cdr, 0),
    coalesce(sa.sessions_without_cdr_ids, '{}'::text[]),
    coalesce(ca.cdrs, 0), coalesce(ca.credit_cdrs, 0),
    coalesce(ca.cdrs_without_session, 0),
    coalesce(ca.cdrs_without_session_ids, '{}'::text[]),
    coalesce(ca.cdr_energy_e4, 0), coalesce(ca.cdr_cost_excl_vat_e4, 0),
    case when ca.peer_id is null then 0 else ca.cdr_cost_incl_vat_e4 end
  from sa
  full join ca on ca.peer_id = sa.peer_id and ca.day = sa.day and ca.currency = sa.currency
  order by 1, 2, 3;
$$;
revoke execute on function public.emsp_reconciliation(timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.emsp_reconciliation(timestamptz, timestamptz, uuid) to service_role;

commit;
