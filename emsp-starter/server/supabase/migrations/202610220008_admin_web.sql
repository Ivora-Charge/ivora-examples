-- The admin web: indexes for its lists (sessions by status or peer, the audit trail of
-- one payment or token) and the payment side of reconciliation, beside
-- emsp_reconciliation: per peer, UTC day (of the CDR's start) and currency, what was
-- captured and refunded for the CDRs, the CDRs of our drivers that no payment was
-- settled from, and the payments whose capture differs from their CDR.
-- Additive only. No new tables; functions are for the service role only (10-30 rule).
begin;

create index emsp_sessions_status_start_idx
  on public.emsp_sessions (status, start_date_time desc);
create index emsp_sessions_peer_start_idx
  on public.emsp_sessions (peer_id, start_date_time desc);
create index emsp_payments_cdr_idx
  on public.emsp_payments (cdr_id) where cdr_id is not null;
create index emsp_audit_log_subject_id_idx
  on public.emsp_audit_log (subject_id, occurred_at desc) where subject_id is not null;

-- For CDRs (not credit CDRs) that started in [p_from, p_to): CDRs a payment was settled
-- from; CDRs of our drivers (a driver_ref) that none was; the CDR totals those payments
-- saw, and what they captured and refunded, in minor units of the CDR's currency (a
-- payment in another currency is not summed: it counts as a mismatch); and the payments
-- whose capture is not the CDR's total, or in another currency. At most 100 IDs per list:
-- `country_code/party_id/cdr_id` for CDRs, the payment ID for payments.
create function public.emsp_payment_reconciliation(
  p_from timestamptz,
  p_to timestamptz,
  p_peer_id uuid
) returns table (
  peer_id uuid,
  day date,
  currency text,
  cdrs_paid integer,
  cdrs_unpaid integer,
  cdrs_unpaid_ids text[],
  cdr_amount bigint,
  captured_amount bigint,
  refunded_amount bigint,
  amount_mismatches integer,
  amount_mismatch_ids text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  with c as (
    select c.peer_id, (c.start_date_time at time zone 'UTC')::date as day, c.currency,
      c.country_code || '/' || c.party_id || '/' || c.cdr_id as ref,
      c.driver_ref,
      p.id::text as payment_id,
      p.currency = c.currency as same_currency,
      p.cdr_amount, p.captured_amount, p.refunded_amount,
      p.id is not null and (
        p.currency <> c.currency or p.captured_amount is distinct from p.cdr_amount
      ) as mismatch
    from public.emsp_cdrs as c
    left join public.emsp_payments as p on p.cdr_id = c.id
    where not c.credit
      and c.start_date_time >= p_from and c.start_date_time < p_to
      and (p_peer_id is null or c.peer_id = p_peer_id)
  )
  select c.peer_id, c.day, c.currency,
    count(*) filter (where c.payment_id is not null)::integer,
    count(*) filter (where c.payment_id is null and c.driver_ref is not null)::integer,
    coalesce(
      (array_agg(c.ref order by c.ref collate "C")
        filter (where c.payment_id is null and c.driver_ref is not null))[1:100],
      '{}'::text[]
    ),
    coalesce(sum(c.cdr_amount) filter (where c.payment_id is not null), 0)::bigint,
    coalesce(sum(c.captured_amount) filter (where c.same_currency), 0)::bigint,
    coalesce(sum(c.refunded_amount) filter (where c.same_currency), 0)::bigint,
    count(*) filter (where c.mismatch)::integer,
    coalesce(
      (array_agg(c.payment_id order by c.payment_id collate "C") filter (where c.mismatch))[1:100],
      '{}'::text[]
    )
  from c
  group by c.peer_id, c.day, c.currency
  order by 1, 2, 3;
$$;
revoke execute on function public.emsp_payment_reconciliation(timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.emsp_payment_reconciliation(timestamptz, timestamptz, uuid) to service_role;

commit;
