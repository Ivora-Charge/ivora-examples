-- Driver accounts (passwordless, Supabase Auth), the admin role table, and payments:
-- one card hold per START_SESSION, captured from the session's CDR, with refunds, the
-- Stripe webhook events we handled, and the stop reason on a session.
-- Service-only (10-30 rule): RLS on, nothing granted to anon or authenticated. The
-- driver app and the admin web reach all of this through the server, never the Data
-- API. No card data is stored: Stripe holds the cards, we keep its IDs.
-- Amounts are whole minor units of their currency (cents; yen for JPY).
begin;

-- A driver's account: one per Supabase Auth user, made at the first sign-in.
create table public.emsp_drivers (
  -- The Supabase Auth user. Also the driver_ref of the driver's tokens and commands.
  id uuid primary key,
  email text not null check (char_length(email) between 3 and 254),
  -- 'restricted': may not charge (real-time authorization answers NOT_ALLOWED).
  status text not null default 'active' check (status in ('active', 'restricted')),
  -- The Stripe Customer on the network's own Stripe account, and the card the driver
  -- chose as default. IDs only.
  stripe_customer_id text unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'),
  default_payment_method_id text check (default_payment_method_id ~ '^pm_[A-Za-z0-9_]+$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index emsp_drivers_email_idx on public.emsp_drivers (lower(email));

alter table public.emsp_drivers enable row level security;
revoke all on table public.emsp_drivers from public, anon, authenticated, service_role;
grant select, insert, update on table public.emsp_drivers to service_role;

-- Who may use the admin web. Add the first admin in the SQL editor (see the README);
-- the server only reads this table.
create table public.emsp_admins (
  user_id uuid primary key,
  -- 'admin': every admin action. 'viewer': read only.
  role text not null check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

alter table public.emsp_admins enable row level security;
revoke all on table public.emsp_admins from public, anon, authenticated, service_role;
grant select on table public.emsp_admins to service_role;

-- One payment per START_SESSION: the card hold placed before the start, then its
-- capture from the session's CDR, or its release.
create table public.emsp_payments (
  id uuid primary key default gen_random_uuid(),
  -- The charge request: a payment captures only from a CDR linked to this start.
  command_id uuid not null unique references public.emsp_commands (id),
  driver_ref text not null check (char_length(driver_ref) between 1 and 64),
  -- 'pending': the hold is being placed. 'held': the card is authorised. 'failed': no
  -- hold. 'captured', 'released' (cancelled, nothing charged) and 'expired' (the card
  -- network dropped the hold before a CDR came) are final.
  status text not null default 'pending' check (status in (
    'pending', 'held', 'failed', 'captured', 'released', 'expired'
  )),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  hold_amount bigint not null check (hold_amount > 0),
  -- What the card network authorised: the hold, raised by increments.
  authorized_amount bigint not null default 0 check (authorized_amount >= 0),
  captured_amount bigint not null default 0 check (captured_amount >= 0),
  refunded_amount bigint not null default 0 check (refunded_amount >= 0),
  payment_method_id text check (payment_method_id ~ '^pm_[A-Za-z0-9_]+$'),
  payment_intent_id text unique check (payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  -- The card network's own deadline for capturing the hold.
  hold_expires_at timestamptz,
  -- Incremental authorization: available on this card, and how many raises so far.
  incremental_available boolean not null default false,
  increments integer not null default 0 check (increments >= 0),
  -- A start whose outcome we never learnt keeps its hold until then, in case a
  -- session appears; after that, with no session, the hold is released.
  release_after timestamptz,
  -- The CDR it was settled from, and the CDR's total incl. VAT in minor units.
  cdr_id uuid references public.emsp_cdrs (id),
  cdr_currency text check (cdr_currency ~ '^[A-Z]{3}$'),
  cdr_amount bigint check (cdr_amount >= 0),
  -- For an admin: why this payment needs a person. Never auto-charged.
  review text check (review in (
    'cdr_above_hold', 'hold_expired', 'currency_mismatch', 'vat_unknown',
    'increment_declined', 'credit_cdr', 'hold_unknown', 'dispute', 'refund_outside',
    'second_cdr'
  )),
  -- The amount the CDR is above what could be captured, in minor units.
  shortfall_amount bigint check (shortfall_amount >= 0),
  reviewed_at timestamptz,
  stop_reason text check (char_length(stop_reason) <= 300),
  -- Safe to show: a Stripe error code or our own words. Never card data.
  error text not null default '' check (char_length(error) <= 300),
  receipt_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (captured_amount <= authorized_amount or status <> 'captured'),
  check (refunded_amount <= captured_amount)
);

create index emsp_payments_driver_idx on public.emsp_payments (driver_ref, created_at desc);
create index emsp_payments_review_idx
  on public.emsp_payments (created_at) where review is not null and reviewed_at is null;
create index emsp_payments_release_idx
  on public.emsp_payments (release_after) where status = 'held' and release_after is not null;
create index emsp_payments_held_idx on public.emsp_payments (created_at) where status = 'held';

alter table public.emsp_payments enable row level security;
revoke all on table public.emsp_payments from public, anon, authenticated, service_role;
-- Payments are a record of money: never deleted.
grant select, insert, update on table public.emsp_payments to service_role;

-- Refunds of a captured payment, partial or whole. One row per admin request.
create table public.emsp_payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.emsp_payments (id),
  -- The admin's request ID: the same request never refunds twice.
  request_id text not null check (request_id ~ '^[A-Za-z0-9._:-]{8,64}$'),
  amount bigint not null check (amount > 0),
  reason text not null default '' check (char_length(reason) <= 300),
  -- 'pending': reserved; sent with no answer yet, or (with stripe_refund_id) pending at
  -- Stripe. 'requires_action': Stripe waits on the bank. 'failed' gives the amount back.
  status text not null default 'pending' check (status in (
    'pending', 'requires_action', 'succeeded', 'failed'
  )),
  stripe_refund_id text unique check (stripe_refund_id ~ '^re_[A-Za-z0-9_]+$'),
  actor text not null check (char_length(actor) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payment_id, request_id)
);

alter table public.emsp_payment_refunds enable row level security;
revoke all on table public.emsp_payment_refunds from public, anon, authenticated, service_role;
grant select, insert, update on table public.emsp_payment_refunds to service_role;

-- Stripe webhook events handled, by Stripe's event ID: a redelivery is acknowledged
-- and skipped.
create table public.emsp_stripe_events (
  id text primary key check (id ~ '^evt_[A-Za-z0-9]+$'),
  type text not null check (char_length(type) between 1 and 100),
  received_at timestamptz not null default now()
);

alter table public.emsp_stripe_events enable row level security;
revoke all on table public.emsp_stripe_events from public, anon, authenticated, service_role;
grant select, insert on table public.emsp_stripe_events to service_role;

-- Why a session ended early, when we stopped it (a declined hold raise, say), so the
-- driver's history and receipt can say so.
alter table public.emsp_sessions
  add column stop_reason text check (char_length(stop_reason) <= 300);

-- Reserves a refund under a lock on the payment: the refunds that are not failed,
-- with this one, may not exceed what was captured. The same request ID again returns
-- its refund ('replayed'); too much is 'exceeds'; else 'created'.
create function public.emsp_payment_reserve_refund(
  p_payment_id uuid,
  p_request_id text,
  p_amount bigint,
  p_reason text,
  p_actor text
) returns table (outcome text, refund jsonb)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  pay public.emsp_payments;
  held public.emsp_payment_refunds;
  reserved bigint;
begin
  select * into pay from public.emsp_payments where id = p_payment_id for update;
  if not found then
    return query select 'not_found'::text, null::jsonb;
    return;
  end if;
  select * into held from public.emsp_payment_refunds
  where payment_id = p_payment_id and request_id = p_request_id;
  if found then
    return query select 'replayed'::text, to_jsonb(held);
    return;
  end if;
  select coalesce(sum(amount), 0) into reserved from public.emsp_payment_refunds
  where payment_id = p_payment_id and status <> 'failed';
  if pay.status <> 'captured' or reserved + p_amount > pay.captured_amount then
    return query select 'exceeds'::text, null::jsonb;
    return;
  end if;
  insert into public.emsp_payment_refunds (payment_id, request_id, amount, reason, actor)
  values (p_payment_id, p_request_id, p_amount, p_reason, p_actor)
  returning * into held;
  return query select 'created'::text, to_jsonb(held);
end;
$$;
revoke execute on function public.emsp_payment_reserve_refund(uuid, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.emsp_payment_reserve_refund(uuid, text, bigint, text, text) to service_role;

-- Records a refund's status and keeps the payment's refunded amount the sum of its
-- succeeded refunds, under the same lock. A pending or requires_action refund may move
-- to any status; a succeeded one only to failed (Stripe can fail it later); a failed
-- one never changes.
create function public.emsp_payment_settle_refund(
  p_refund_id uuid,
  p_status text,
  p_stripe_refund_id text
) returns table (refund jsonb)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r public.emsp_payment_refunds;
begin
  select * into r from public.emsp_payment_refunds where id = p_refund_id;
  if not found then
    return;
  end if;
  perform 1 from public.emsp_payments where id = r.payment_id for update;
  update public.emsp_payment_refunds
  set status = p_status,
      stripe_refund_id = coalesce(p_stripe_refund_id, stripe_refund_id),
      updated_at = now()
  where id = p_refund_id
    and (status in ('pending', 'requires_action') or (status = 'succeeded' and p_status = 'failed'))
  returning * into r;
  if not found then
    select * into r from public.emsp_payment_refunds where id = p_refund_id;
    return query select to_jsonb(r);
    return;
  end if;
  update public.emsp_payments
  set refunded_amount = (
        select coalesce(sum(amount), 0) from public.emsp_payment_refunds
        where payment_id = r.payment_id and status = 'succeeded'
      ),
      updated_at = now()
  where id = r.payment_id;
  return query select to_jsonb(r);
end;
$$;
revoke execute on function public.emsp_payment_settle_refund(uuid, text, text) from public, anon, authenticated;
grant execute on function public.emsp_payment_settle_refund(uuid, text, text) to service_role;

commit;
