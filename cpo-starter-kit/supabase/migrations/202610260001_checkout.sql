begin;

-- Driver checkout: one record per "Pay and charge" on a sticker's page (/c/<code>). The
-- record is the kit's own session: the bill's and the hosted payment's
-- Idempotency-Keys and the payment's return_reference derive from its ID. Drivers are
-- not staff, so nothing here is tied to a staff member; the server writes it with the
-- service role after checking the sticker, the charger and the price itself.
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated. Nothing here is read
-- through the Data API. `npm run check:migrations` (the shared tools/check-migrations)
-- enforces this in CI.

create table if not exists public.cpo_checkouts (
  -- Also the source of the keys (cpo-checkout-<id>-bill, -payment, -start) and of
  -- the payment's return_reference.
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  -- One tap: the page's random ID. The same form sent twice (a double click, a
  -- resubmitted request) continues this checkout with the same keys.
  request_id uuid not null,
  sticker_code text not null check (sticker_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  station_id bigint not null check (station_id > 0),
  connector_id bigint not null check (connector_id > 0),
  -- The Ivora tariff the bill snapshots, and its hold (integer minor units).
  tariff_id bigint not null check (tariff_id > 0),
  hold_minor integer not null check (hold_minor between 50 and 10000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- creating: claimed; the bill or the payment is not confirmed yet (the same form
  -- repeats them with the same keys). checkout: the driver was sent to Ivora Checkout;
  -- from here Ivora's driver page shows the session and the receipt. failed: Ivora
  -- refused (error says why); nothing was charged.
  phase text not null default 'creating'
    check (phase in ('creating', 'checkout', 'failed')),
  bill_id text check (bill_id ~ '^bill_[0-9a-f]{32}$'),
  payment_id text check (char_length(payment_id) between 1 and 100),
  -- The hosted checkout to send the driver to (it expires 60 minutes after creation).
  checkout_url text check (checkout_url ~ '^https://' and char_length(checkout_url) <= 2048),
  -- When the kit started the bill itself, after Ivora's automatic start was refused.
  start_requested_at timestamptz,
  -- An error code and message from Ivora (no personal data).
  error text check (char_length(error) <= 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, request_id)
);
create index if not exists cpo_checkouts_recent
  on public.cpo_checkouts(operator_id, created_at desc);
create index if not exists cpo_checkouts_connector
  on public.cpo_checkouts(operator_id, station_id, connector_id, created_at desc);

alter table public.cpo_checkouts enable row level security;
revoke all on public.cpo_checkouts from public, anon, authenticated;
grant all on public.cpo_checkouts to service_role;

-- Claims a checkout for one tap. The same p_request_id again returns the checkout it
-- already made (created = false), which must be for the same sticker, connector and
-- price; anything else is refused.
create or replace function public.cpo_claim_checkout(
  p_operator_id uuid, p_request_id uuid, p_sticker_code text, p_station_id bigint,
  p_connector_id bigint, p_tariff_id bigint, p_hold_minor integer, p_currency text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_same boolean;
begin
  insert into public.cpo_checkouts (
    operator_id, request_id, sticker_code, station_id, connector_id, tariff_id,
    hold_minor, currency
  ) values (
    p_operator_id, p_request_id, p_sticker_code, p_station_id, p_connector_id,
    p_tariff_id, p_hold_minor, p_currency
  )
  on conflict (operator_id, request_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'created', true);
  end if;
  select id, (sticker_code = p_sticker_code and station_id = p_station_id
      and connector_id = p_connector_id and tariff_id = p_tariff_id
      and hold_minor = p_hold_minor and currency = p_currency)
    into v_id, v_same
    from public.cpo_checkouts
    where operator_id = p_operator_id and request_id = p_request_id;
  if not v_same then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  return jsonb_build_object('id', v_id, 'created', false);
end;
$$;
revoke all on function public.cpo_claim_checkout(uuid, uuid, text, bigint, bigint, bigint, integer, text) from public, anon, authenticated;
grant execute on function public.cpo_claim_checkout(uuid, uuid, text, bigint, bigint, bigint, integer, text) to service_role;

-- Records what Ivora answered. A bill or payment ID, once known, never changes (a
-- different one is refused); a checkout leaves 'creating' once and never goes back.
create or replace function public.cpo_record_checkout(
  p_operator_id uuid, p_id uuid, p_changes jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_phase text := p_changes->>'phase';
begin
  if v_phase is not null and v_phase not in ('creating', 'checkout', 'failed') then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  perform 1 from public.cpo_checkouts
    where id = p_id and operator_id = p_operator_id
      and ((p_changes ? 'bill_id' and bill_id is distinct from p_changes->>'bill_id' and bill_id is not null)
        or (p_changes ? 'payment_id' and payment_id is distinct from p_changes->>'payment_id' and payment_id is not null));
  if found then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  update public.cpo_checkouts set
    bill_id = coalesce(bill_id, p_changes->>'bill_id'),
    payment_id = coalesce(payment_id, p_changes->>'payment_id'),
    checkout_url = case when p_changes ? 'checkout_url' then p_changes->>'checkout_url' else checkout_url end,
    phase = case when phase = 'creating' and v_phase is not null then v_phase else phase end,
    error = case when p_changes ? 'error' then left(p_changes->>'error', 600) else error end,
    start_requested_at = case when p_changes ? 'start_requested'
      then coalesce(start_requested_at, now()) else start_requested_at end,
    updated_at = now()
  where id = p_id and operator_id = p_operator_id;
  return found;
end;
$$;
revoke all on function public.cpo_record_checkout(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.cpo_record_checkout(uuid, uuid, jsonb) to service_role;

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
