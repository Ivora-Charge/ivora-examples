begin;

-- Driver checkout: one record per "Pay and charge" (or "Start free session") on a
-- sticker's page (/c/<code>). The record is the kit's own session: every
-- Idempotency-Key for its bill, payment, start, stop, finalize, capture and release
-- derives from its ID. Drivers are not staff, so nothing here is tied to a staff
-- member; the server writes it with the service role after checking the sticker, the
-- charger and the price itself.
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated. Nothing here is read
-- through the Data API. `npm run check:migrations` (the shared tools/check-migrations)
-- enforces this in CI.

create table if not exists public.cpo_checkouts (
  -- The source of the keys (cpo-checkout-<id>-bill, -payment, -start, …). Never sent
  -- to a browser or in a URL.
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  -- One tap: the page's random ID. The same form sent twice (a double click, a
  -- resubmitted request) continues this checkout with the same keys. It is also the
  -- driver's capability: only the browser that tapped holds it (an HTTP-only cookie),
  -- and it is never sent to Ivora or Stripe.
  request_id uuid not null,
  -- The payment's return_reference: separate from the capability above, because it
  -- ends up in Ivora's and Stripe's URLs.
  reference text not null unique
    default 'ck_' || replace(gen_random_uuid()::text, '-', '')
    check (reference ~ '^ck_[0-9a-f]{32}$'),
  -- paid: a bill and an Ivora Checkout hold. free: a start with the operator's free
  -- charging token, only while the connector's tariff is free.
  kind text not null default 'paid' check (kind in ('paid', 'free')),
  sticker_code text not null check (sticker_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  station_id bigint not null check (station_id > 0),
  connector_id bigint not null check (connector_id > 0),
  -- The Ivora tariff the bill snapshots, and the card hold (integer minor units): the
  -- tariff's at the tap, then the bill's once it exists (the bill is the truth).
  tariff_id bigint not null check (tariff_id > 0),
  hold_minor integer not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- creating: claimed; the bill, payment or start is not confirmed yet (the same form
  --   repeats them with the same keys).
  -- open: paid: the driver was sent to Ivora Checkout, or the session runs; free: the
  --   start was sent (or may have been: it stays stoppable).
  -- settling: the session ended; the bill is being finalized and captured.
  -- releasing: nothing will be charged; the hold is being released.
  -- settled: the final bill was captured (or, free, the session ended).
  -- released: the hold was released (or never placed); nothing was charged.
  -- failed: Ivora refused before any hold; nothing was charged.
  -- attention: settlement needs the operator (for example a bill above its hold).
  -- creating and open hold the connector: one per connector (index below).
  phase text not null default 'creating'
    check (phase in ('creating', 'open', 'settling', 'releasing', 'settled',
      'released', 'failed', 'attention')),
  bill_id text check (bill_id ~ '^bill_[0-9a-f]{32}$'),
  payment_id text check (char_length(payment_id) between 1 and 100),
  -- The hosted checkout to send the driver to.
  checkout_url text check (checkout_url ~ '^https://' and char_length(checkout_url) <= 2048),
  -- When the kit started the session itself (a refused automatic start, or free).
  start_requested_at timestamptz,
  start_operation_id text check (char_length(start_operation_id) between 1 and 100),
  -- The charging core's transaction, once known.
  transaction_id bigint check (transaction_id > 0),
  -- When the kit stopped the session because its cost neared the hold.
  stop_requested_at timestamptz,
  -- When the kit sent that stop a second time, because the charger kept charging.
  stop_retried_at timestamptz,
  -- The session's energy (Wh) when it last changed, and when: a session the charger
  -- reports nothing for (a lost StopTransaction) is stopped and settled after a while.
  meter_wh bigint check (meter_wh >= 0),
  meter_at timestamptz,
  -- Why the operator should look at it (shown in Live): stalled (the charger never
  -- ended the session) or hold_stop_ignored (it kept charging after the hold stop).
  alert text check (alert in ('stalled', 'hold_stop_ignored')),
  -- The finalized bill and what was captured (integer minor units).
  final_minor integer check (final_minor >= 0),
  captured_minor integer check (captured_minor >= 0),
  -- An error code and message from Ivora (no personal data).
  error text check (char_length(error) <= 600),
  checked_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, request_id),
  check ((kind = 'paid' and hold_minor between 50 and 10000)
    or (kind = 'free' and hold_minor = 0)),
  check (captured_minor is null or captured_minor <= hold_minor)
);
-- One waiting or running checkout per connector: a second driver is told the
-- connector is in use before any hold is placed.
create unique index if not exists cpo_checkouts_one_per_connector
  on public.cpo_checkouts(operator_id, station_id, connector_id)
  where phase in ('creating', 'open');
create index if not exists cpo_checkouts_unsettled
  on public.cpo_checkouts(checked_at nulls first)
  where phase in ('creating', 'open', 'settling', 'releasing');
create index if not exists cpo_checkouts_station
  on public.cpo_checkouts(station_id)
  where phase in ('creating', 'open', 'settling', 'releasing');
create index if not exists cpo_checkouts_alerts
  on public.cpo_checkouts(operator_id, created_at desc)
  where phase = 'attention' or alert is not null;

alter table public.cpo_checkouts enable row level security;
revoke all on public.cpo_checkouts from public, anon, authenticated;
grant all on public.cpo_checkouts to service_role;

-- Claims a checkout for one tap. The same p_request_id again returns the checkout it
-- already made (created = false), which must be for the same sticker, connector, kind
-- and tariff; anything else is refused. The hold is not compared: once the bill exists
-- its hold replaces the tariff's. While another checkout holds the connector
-- (creating or open), nothing is inserted and that one is returned as busy, also when
-- two taps race: the unique index decides, and the loser reads the winner.
create or replace function public.cpo_claim_checkout(
  p_operator_id uuid, p_request_id uuid, p_kind text, p_sticker_code text,
  p_station_id bigint, p_connector_id bigint, p_tariff_id bigint,
  p_hold_minor integer, p_currency text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_same boolean;
begin
  for i in 1..2 loop
    select id, (kind = p_kind and sticker_code = p_sticker_code
        and station_id = p_station_id and connector_id = p_connector_id
        and tariff_id = p_tariff_id and currency = p_currency)
      into v_id, v_same
      from public.cpo_checkouts
      where operator_id = p_operator_id and request_id = p_request_id;
    if v_id is not null then
      if not v_same then
        raise exception 'cpo_invalid' using errcode = 'P0001';
      end if;
      return jsonb_build_object('id', v_id, 'created', false);
    end if;
    select id into v_id from public.cpo_checkouts
      where operator_id = p_operator_id and station_id = p_station_id
        and connector_id = p_connector_id and phase in ('creating', 'open');
    if v_id is not null then
      return jsonb_build_object('busy', v_id);
    end if;
    begin
      insert into public.cpo_checkouts (
        operator_id, request_id, kind, sticker_code, station_id, connector_id,
        tariff_id, hold_minor, currency
      ) values (
        p_operator_id, p_request_id, p_kind, p_sticker_code, p_station_id,
        p_connector_id, p_tariff_id, p_hold_minor, p_currency
      )
      returning id into v_id;
      return jsonb_build_object('id', v_id, 'created', true);
    exception when unique_violation then
      -- A concurrent tap won (the same request or the same connector): read it.
      v_id := null;
    end;
  end loop;
  raise exception 'cpo_busy' using errcode = 'P0001';
end;
$$;
revoke all on function public.cpo_claim_checkout(uuid, uuid, text, text, bigint, bigint, bigint, integer, text) from public, anon, authenticated;
grant execute on function public.cpo_claim_checkout(uuid, uuid, text, text, bigint, bigint, bigint, integer, text) to service_role;

-- Records what Ivora answered. An ID (bill, payment, start operation, transaction),
-- once known, never changes (a different one is refused). Phases only move forward:
-- creating -> open | failed | releasing | released; open -> settling | releasing |
-- released | settled | attention; releasing -> open (a late start ran after all) |
-- settling | released | settled | attention; settling -> settled | attention. The hold
-- changes only while the checkout is unsettled (to the bill's). Returns
-- false when the change was not applied (an older reader lost to a newer one).
create or replace function public.cpo_record_checkout(
  p_operator_id uuid, p_id uuid, p_changes jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_phase text := p_changes->>'phase';
  v_row public.cpo_checkouts;
begin
  select * into v_row from public.cpo_checkouts
    where id = p_id and operator_id = p_operator_id for update;
  if not found then
    return false;
  end if;
  if (p_changes ? 'bill_id' and v_row.bill_id is not null and v_row.bill_id is distinct from p_changes->>'bill_id')
    or (p_changes ? 'payment_id' and v_row.payment_id is not null and v_row.payment_id is distinct from p_changes->>'payment_id')
    or (p_changes ? 'start_operation_id' and v_row.start_operation_id is not null and v_row.start_operation_id is distinct from p_changes->>'start_operation_id')
    or (p_changes ? 'transaction_id' and v_row.transaction_id is not null and v_row.transaction_id is distinct from (p_changes->>'transaction_id')::bigint) then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  if v_phase is not null and v_phase <> v_row.phase and not (
    (v_row.phase = 'creating' and v_phase in ('open', 'failed', 'releasing', 'released'))
    or (v_row.phase = 'open' and v_phase in ('settling', 'releasing', 'released', 'settled', 'attention'))
    or (v_row.phase = 'releasing' and v_phase in ('open', 'settling', 'released', 'settled', 'attention'))
    or (v_row.phase = 'settling' and v_phase in ('settled', 'attention'))
  ) then
    return false;
  end if;
  -- Taking the connector again (releasing -> open) must not break the one-per-connector
  -- rule; if another checkout holds it, the record stays releasing.
  if v_phase = 'open' and v_row.phase = 'releasing' and exists (
    select 1 from public.cpo_checkouts
      where operator_id = p_operator_id and station_id = v_row.station_id
        and connector_id = v_row.connector_id and phase in ('creating', 'open')
        and id <> p_id
  ) then
    v_phase := null;
  end if;
  update public.cpo_checkouts set
    bill_id = coalesce(bill_id, p_changes->>'bill_id'),
    hold_minor = case when p_changes ? 'hold_minor'
        and v_row.phase in ('creating', 'open', 'settling', 'releasing')
      then (p_changes->>'hold_minor')::integer else hold_minor end,
    payment_id = coalesce(payment_id, p_changes->>'payment_id'),
    start_operation_id = coalesce(start_operation_id, p_changes->>'start_operation_id'),
    transaction_id = coalesce(transaction_id, (p_changes->>'transaction_id')::bigint),
    checkout_url = case when p_changes ? 'checkout_url' then p_changes->>'checkout_url' else checkout_url end,
    final_minor = coalesce(final_minor, (p_changes->>'final_minor')::integer),
    captured_minor = coalesce(captured_minor, (p_changes->>'captured_minor')::integer),
    phase = coalesce(v_phase, phase),
    error = case when p_changes ? 'error' then left(p_changes->>'error', 600) else error end,
    start_requested_at = case when p_changes ? 'start_requested'
      then coalesce(start_requested_at, now()) else start_requested_at end,
    stop_requested_at = case when p_changes ? 'stop_requested'
      then coalesce(stop_requested_at, now()) else stop_requested_at end,
    stop_retried_at = case when p_changes ? 'stop_retried'
      then coalesce(stop_retried_at, now()) else stop_retried_at end,
    -- meter_at moves only when the energy changes (or is first seen).
    meter_at = case when p_changes ? 'meter_wh' and (meter_at is null
        or meter_wh is distinct from (p_changes->>'meter_wh')::bigint)
      then now() else meter_at end,
    meter_wh = case when p_changes ? 'meter_wh'
      then (p_changes->>'meter_wh')::bigint else meter_wh end,
    alert = coalesce(p_changes->>'alert', alert),
    checked_at = case when p_changes ? 'checked' then now() else checked_at end,
    settled_at = case when coalesce(v_phase, phase) in ('settled', 'released', 'failed', 'attention')
      then coalesce(settled_at, now()) else settled_at end,
    updated_at = now()
  where id = p_id and operator_id = p_operator_id;
  return true;
end;
$$;
revoke all on function public.cpo_record_checkout(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.cpo_record_checkout(uuid, uuid, jsonb) to service_role;

-- The operator's free charging token: registered once in Ivora (type Central,
-- external_reference cpo-free-<operator id>), like the staff token. Sessions started
-- with it are labelled "free" in Live and on the Overview.
create table if not exists public.cpo_free_tokens (
  operator_id uuid primary key references public.cpo_operators(id) on delete cascade,
  id_token text not null unique check (id_token ~ '^[A-Z0-9-]{8,20}$'),
  token_id bigint check (token_id > 0),
  created_at timestamptz not null default now(),
  registered_at timestamptz
);
alter table public.cpo_free_tokens enable row level security;
revoke all on public.cpo_free_tokens from public, anon, authenticated;
grant all on public.cpo_free_tokens to service_role;

-- Pricing: when each tariff version's latest create attempt started. "Discard this
-- draft" waits until that attempt can no longer be in flight, so a create Ivora
-- finishes late is found and archived rather than left behind unused.
alter table public.cpo_tariff_versions
  add column if not exists attempted_at timestamptz not null default now();

create or replace function public.cpo_next_tariff_attempt(
  p_operator_id uuid, p_actor_id uuid, p_tariff_id uuid, p_version integer
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_attempt integer;
begin
  perform public.cpo_lock_pricing_actor(p_operator_id, p_actor_id);
  update public.cpo_tariff_versions set attempt = attempt + 1, attempted_at = now()
    where tariff_id = p_tariff_id and operator_id = p_operator_id
      and version = p_version and ivora_tariff_id is null
    returning attempt into v_attempt;
  if not found then
    raise exception 'cpo_tariff_not_found' using errcode = 'P0001';
  end if;
  return v_attempt;
end;
$$;
revoke all on function public.cpo_next_tariff_attempt(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.cpo_next_tariff_attempt(uuid, uuid, uuid, integer) to service_role;

commit;
