begin;

-- Live view: the charger commands staff send (remote start, stop, reset, unlock), each
-- operator's staff token for remote starts, and the Ivora webhook events the kit has
-- received.
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated. Nothing here is read
-- through the Data API: the server reads it with the service role, for the operator of
-- the signed-in staff member. Commands are claimed through cpo_claim_live_command,
-- which checks the staff member's role in the same statement as the write.
-- `npm run check:migrations` (the shared tools/check-migrations) enforces this in CI.

create table if not exists public.cpo_live_commands (
  -- Also the source of the command's Idempotency-Key (cpo-command-<id>-<action>), so
  -- every re-check of the same command sends the same key.
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.cpo_operators(id) on delete cascade,
  -- One tap: the confirmation form's random ID. Sending the same form twice (a double
  -- click, a resubmitted request) finds this command instead of making another.
  request_id uuid not null,
  station_id bigint not null check (station_id > 0),
  action text not null check (action in ('start', 'stop', 'reset', 'unlock')),
  connector_id bigint check (connector_id > 0),
  transaction_id bigint check (transaction_id > 0),
  mode text check (mode in ('soft', 'hard')),
  -- pending: sent, or being sent, and not answered for sure yet (it blocks other
  -- commands on the station). accepted, failed (a definite refusal) and unknown
  -- (Ivora could not confirm it reached the charger) are final.
  phase text not null default 'pending'
    check (phase in ('pending', 'accepted', 'failed', 'unknown')),
  operation_id text check (char_length(operation_id) <= 100),
  charger_status text check (char_length(charger_status) <= 40),
  -- An error code and message from Ivora or the charger (no personal data).
  error text check (char_length(error) <= 600),
  -- Sessions the staff member confirmed this command may end, by transaction ID.
  confirmed_sessions bigint[] not null default '{}',
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  check (
    (action = 'start' and connector_id is not null)
    or (action = 'stop' and transaction_id is not null)
    or (action = 'reset' and mode is not null)
    or (action = 'unlock' and connector_id is not null)
  ),
  unique (operator_id, request_id)
);
create index if not exists cpo_live_commands_recent
  on public.cpo_live_commands(operator_id, requested_at desc);
create index if not exists cpo_live_commands_operation
  on public.cpo_live_commands(operation_id) where operation_id is not null;
-- One unanswered command per charger: a second tab or a double click is refused while
-- the first is pending, so it never sends a second command.
create unique index if not exists cpo_live_commands_one_pending
  on public.cpo_live_commands(operator_id, station_id) where phase = 'pending';

-- Ivora webhook deliveries, by event ID: a redelivery is acknowledged once and never
-- processed twice. Purged after 7 days (Ivora stops retrying after about two).
create table if not exists public.cpo_ivora_events (
  id text primary key check (char_length(id) between 1 and 100),
  type text not null check (char_length(type) <= 80),
  station_id bigint,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists cpo_ivora_events_received on public.cpo_ivora_events(received_at);

-- Each operator's staff token: the ID token a remote start from the Live view uses.
-- Random per operator (never a shared, guessable value), registered once in the
-- operator's Ivora token list with the external reference cpo-staff-<operator_id>, so
-- staff sessions are labelled and show in Ivora's sessions and reports. token_id is
-- Ivora's token ID once registered. 20 characters: the OCPP 1.6 idTag maximum.
create table if not exists public.cpo_staff_tokens (
  operator_id uuid primary key references public.cpo_operators(id) on delete cascade,
  id_token text not null unique check (id_token ~ '^[A-Z0-9-]{8,20}$'),
  token_id bigint check (token_id > 0),
  created_at timestamptz not null default now(),
  registered_at timestamptz
);

alter table public.cpo_live_commands enable row level security;
alter table public.cpo_ivora_events enable row level security;
alter table public.cpo_staff_tokens enable row level security;
revoke all on public.cpo_live_commands, public.cpo_ivora_events, public.cpo_staff_tokens from public, anon, authenticated;
grant all on public.cpo_live_commands, public.cpo_ivora_events, public.cpo_staff_tokens to service_role;

-- Claims a command for one tap: technicians and above only, checked (and the staff
-- row locked) in the same statement as the insert. The same p_request_id again returns
-- the command it already made (created = false) instead of a new one. A pending
-- command on the same station refuses with cpo_command_busy; one left pending for over
-- 15 minutes (Ivora never answered for sure) is closed as unknown first, never resent.
create or replace function public.cpo_claim_live_command(
  p_operator_id uuid, p_actor_id uuid, p_request_id uuid, p_station_id bigint,
  p_action text, p_connector_id bigint, p_transaction_id bigint, p_mode text,
  p_confirmed_sessions bigint[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_same boolean;
begin
  perform public.cpo_lock_charger_actor(p_operator_id, p_actor_id, false);
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
revoke all on function public.cpo_claim_live_command(uuid, uuid, uuid, bigint, text, bigint, bigint, text, bigint[]) from public, anon, authenticated;
grant execute on function public.cpo_claim_live_command(uuid, uuid, uuid, bigint, text, bigint, bigint, text, bigint[]) to service_role;

-- Records what Ivora reported for a pending command (its operation, the charger's
-- answer, a final phase). Called by the server after a staff action, a page load or a
-- verified webhook has re-read the operation from the API. A final command never
-- changes again, so a late or repeated report can't reopen or overwrite it.
create or replace function public.cpo_record_live_command(
  p_operator_id uuid, p_id uuid, p_changes jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_phase text := coalesce(p_changes->>'phase', 'pending');
begin
  if v_phase not in ('pending', 'accepted', 'failed', 'unknown') then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  update public.cpo_live_commands set
    phase = v_phase,
    operation_id = case when p_changes ? 'operation_id' then p_changes->>'operation_id' else operation_id end,
    charger_status = case when p_changes ? 'charger_status' then p_changes->>'charger_status' else charger_status end,
    error = case when p_changes ? 'error' then left(p_changes->>'error', 600) else error end,
    updated_at = now(),
    finished_at = case when v_phase = 'pending' then null else now() end
  where id = p_id and operator_id = p_operator_id and phase = 'pending';
  return found;
end;
$$;
revoke all on function public.cpo_record_live_command(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.cpo_record_live_command(uuid, uuid, jsonb) to service_role;

-- Stores a webhook event ID once. True for a new event, false for a redelivery (which
-- is acknowledged without processing it again). Purges old IDs as it goes.
create or replace function public.cpo_record_ivora_event(p_id text, p_type text, p_station_id bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_new boolean;
begin
  insert into public.cpo_ivora_events (id, type, station_id)
    values (p_id, p_type, p_station_id)
  on conflict (id) do nothing
  returning true into v_new;
  delete from public.cpo_ivora_events where received_at < now() - interval '7 days';
  return coalesce(v_new, false);
end;
$$;
revoke all on function public.cpo_record_ivora_event(text, text, bigint) from public, anon, authenticated;
grant execute on function public.cpo_record_ivora_event(text, text, bigint) to service_role;

commit;
