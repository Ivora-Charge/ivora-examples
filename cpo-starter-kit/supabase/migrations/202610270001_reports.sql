begin;

-- Reports: the sessions table, its totals and the CSV export read the kit's own
-- checkout records, by the time each checkout was made (the driver's tap), through the
-- functions below. Ivora's transaction list has no date filter and lists oldest first,
-- so the kit never scans it for a period. Instead the settlement sweep copies each
-- ended session's details (start, end, energy, stop reason) from
-- GET /transactions/{id} once, and re-reads each charged payment's refunds from
-- GET /payments/{id} once a day for 90 days. Both are additive columns.
--
-- 10-30 rule: no new tables. The functions are for the service role only; nothing is
-- read through the Data API. `npm run check:migrations` enforces this in CI.

alter table public.cpo_checkouts
  -- The charging session as Ivora recorded it, once it ended (detail_at says when the
  -- kit copied it). detail_checked_at: when the sweep last asked.
  add column if not exists session_started_at timestamptz,
  add column if not exists session_ended_at timestamptz,
  add column if not exists energy_wh bigint check (energy_wh >= 0),
  add column if not exists connector_number integer check (connector_number > 0),
  add column if not exists stop_reason text check (char_length(stop_reason) <= 60),
  add column if not exists detail_at timestamptz,
  add column if not exists detail_checked_at timestamptz,
  -- What was refunded of the captured amount (integer minor units), as the payment
  -- last said, and when the sweep last read it. Refunds are made outside the kit (the
  -- Ivora dashboard or API); never more than was captured.
  add column if not exists refunded_minor integer check (refunded_minor >= 0),
  add column if not exists refund_checked_at timestamptz;

-- The reports' date index: one operator's checkouts by when they were made.
create index if not exists cpo_checkouts_reports
  on public.cpo_checkouts(operator_id, created_at desc, id desc);
-- The sweep's work lists.
create index if not exists cpo_checkouts_details_due
  on public.cpo_checkouts(detail_checked_at nulls first)
  where detail_at is null and transaction_id is not null
    and phase in ('settled', 'attention');
create index if not exists cpo_checkouts_refunds_due
  on public.cpo_checkouts(refund_checked_at nulls first)
  where kind = 'paid' and phase = 'settled' and captured_minor > 0;

-- A checkout's status in reports: in_progress (settlement still works on it),
-- attention (it needs the operator), charged (a paid session with money captured) or
-- no_charge (released, failed, free, or captured nothing).
create or replace function public.cpo_report_status(p_row public.cpo_checkouts)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_row.phase in ('creating', 'open', 'settling', 'releasing') then 'in_progress'
    when p_row.phase = 'attention' then 'attention'
    when p_row.phase = 'settled' and p_row.kind = 'paid'
      and coalesce(p_row.captured_minor, 0) > 0 then 'charged'
    else 'no_charge'
  end
$$;
revoke execute on function public.cpo_report_status(public.cpo_checkouts) from public, anon, authenticated;
grant execute on function public.cpo_report_status(public.cpo_checkouts) to service_role;

-- One page of an operator's checkouts made in [p_from, p_to), newest first, with the
-- charger and status filters (p_status: all, in_progress, charged, no_charge,
-- refunded, attention). Pages by p_offset (the Reports page) or after a row
-- (p_after_created_at and p_after_id: the CSV export, which new checkouts cannot
-- shift). At most 500 rows.
create or replace function public.cpo_report_checkouts(
  p_operator_id uuid, p_from timestamptz, p_to timestamptz, p_station_id bigint,
  p_status text, p_limit integer, p_offset integer,
  p_after_created_at timestamptz, p_after_id uuid
)
returns setof public.cpo_checkouts language sql stable security definer
set search_path = '' as $$
  select c.* from public.cpo_checkouts c
  where c.operator_id = p_operator_id
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
revoke execute on function public.cpo_report_checkouts(uuid, timestamptz, timestamptz, bigint, text, integer, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.cpo_report_checkouts(uuid, timestamptz, timestamptz, bigint, text, integer, integer, timestamptz, uuid) to service_role;

-- The totals of the same checkouts (same period and filters): counts by kind and
-- status, the energy of sessions whose details are recorded, and per currency what
-- paid sessions were billed (final bills), captured and refunded. Money from paid
-- checkouts only: free sessions never carry any.
create or replace function public.cpo_report_totals(
  p_operator_id uuid, p_from timestamptz, p_to timestamptz, p_station_id bigint,
  p_status text
)
returns jsonb language sql stable security definer set search_path = '' as $$
  with c as (
    select c.*, public.cpo_report_status(c) as status
    from public.cpo_checkouts c
    where c.operator_id = p_operator_id
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
revoke execute on function public.cpo_report_totals(uuid, timestamptz, timestamptz, bigint, text) from public, anon, authenticated;
grant execute on function public.cpo_report_totals(uuid, timestamptz, timestamptz, bigint, text) to service_role;

-- Records a session's details from GET /transactions/{id}. Only an ended session's
-- are kept, once (they don't change after that); every call notes that the sweep
-- asked. Returns false for an unknown checkout.
create or replace function public.cpo_record_checkout_details(
  p_operator_id uuid, p_id uuid, p_started_at timestamptz, p_ended_at timestamptz,
  p_energy_wh bigint, p_connector_number integer, p_stop_reason text
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.cpo_checkouts set
    session_started_at = case when detail_at is null and p_ended_at is not null
      then p_started_at else session_started_at end,
    session_ended_at = case when detail_at is null and p_ended_at is not null
      then p_ended_at else session_ended_at end,
    energy_wh = case when detail_at is null and p_ended_at is not null
      then p_energy_wh else energy_wh end,
    connector_number = case when detail_at is null and p_ended_at is not null
      then p_connector_number else connector_number end,
    stop_reason = case when detail_at is null and p_ended_at is not null
      then left(p_stop_reason, 60) else stop_reason end,
    detail_at = case when detail_at is null and p_ended_at is not null
      then now() else detail_at end,
    detail_checked_at = now()
  where id = p_id and operator_id = p_operator_id;
  return found;
end;
$$;
revoke execute on function public.cpo_record_checkout_details(uuid, uuid, timestamptz, timestamptz, bigint, integer, text) from public, anon, authenticated;
grant execute on function public.cpo_record_checkout_details(uuid, uuid, timestamptz, timestamptz, bigint, integer, text) to service_role;

-- Records what the payment says was refunded, capped at what was captured. Only for a
-- settled paid checkout that captured money. Returns false otherwise.
create or replace function public.cpo_record_checkout_refund(
  p_operator_id uuid, p_id uuid, p_refunded_minor integer
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_refunded_minor is null or p_refunded_minor < 0 then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  update public.cpo_checkouts set
    refunded_minor = least(p_refunded_minor, captured_minor),
    refund_checked_at = now()
  where id = p_id and operator_id = p_operator_id and kind = 'paid'
    and phase = 'settled' and captured_minor > 0;
  return found;
end;
$$;
revoke execute on function public.cpo_record_checkout_refund(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.cpo_record_checkout_refund(uuid, uuid, integer) to service_role;

commit;
