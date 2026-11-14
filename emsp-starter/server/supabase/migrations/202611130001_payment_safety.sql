-- Payment safety: a review reason for captures Stripe refuses, and the
-- payment sweep's last run. Additive: the review check only gains a value, and the
-- new table is service-only (10-30 rule): RLS on, nothing granted to anon or
-- authenticated.
begin;

-- Stripe refused the capture of a hold it still has (an amount it won't take, say).
-- The same idempotency key would only get the same answer, so the payment waits for
-- an admin instead of being retried until the hold expires.
alter table public.emsp_payments drop constraint emsp_payments_review_check;
alter table public.emsp_payments add constraint emsp_payments_review_check
  check (review in (
    'cdr_above_hold', 'hold_expired', 'currency_mismatch', 'vat_unknown',
    'increment_declined', 'credit_cdr', 'hold_unknown', 'dispute', 'refund_outside',
    'second_cdr', 'capture_refused'
  ));

-- When the payment sweep (/api/cron/ocpi-sync) last finished a pass. One row. Live
-- card holds are refused when it has not run for a few minutes: holds of starts that
-- never charged are released only by the sweep.
create table public.emsp_payment_sweeps (
  id smallint primary key default 1 check (id = 1),
  swept_at timestamptz not null
);

alter table public.emsp_payment_sweeps enable row level security;
revoke all on table public.emsp_payment_sweeps from public, anon, authenticated, service_role;
grant select, insert, update on table public.emsp_payment_sweeps to service_role;

commit;
