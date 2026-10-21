-- The OCPI commands we send to CPOs for our drivers (START_SESSION, STOP_SESSION): one
-- row per app request, claimed atomically so one tap sends one command, with the
-- CPO's synchronous CommandResponse and the asynchronous CommandResult it POSTs to our
-- response_url.
-- Service-only (10-30 rule): RLS on, nothing granted to anon or authenticated. The
-- driver app reaches commands through the server's API, never the Data API.
begin;

create table public.emsp_commands (
  -- Also the last segment of our response_url.
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('START_SESSION', 'STOP_SESSION')),
  -- The driver: the account's ID once driver sign-in lands.
  driver_ref text not null check (char_length(driver_ref) between 1 and 64),
  -- The app's request ID. One command per driver, type and request ID.
  request_id text not null check (request_id ~ '^[A-Za-z0-9._:-]{8,64}$'),
  peer_id uuid not null references public.emsp_ocpi_peers (id),
  -- The CPO party the command goes to (routing headers).
  to_country_code text not null check (to_country_code ~ '^[A-Z]{2}$'),
  to_party_id text not null check (to_party_id ~ '^[A-Z0-9]{3}$'),
  -- A start's location, EVSE and connector, as the CPO knows them.
  location_id text check (char_length(location_id) between 1 and 36),
  evse_uid text check (char_length(evse_uid) between 1 and 36),
  connector_id text check (char_length(connector_id) between 1 and 36),
  -- A stop's session; a start's, once the Sessions module links it.
  session_id text check (char_length(session_id) between 1 and 36),
  -- A start's reference, which the CPO puts on the session and CDR.
  authorization_reference text unique check (char_length(authorization_reference) between 1 and 36),
  -- 'claimed': recorded, nothing sent. 'sending': sent or being sent, outcome not yet
  -- known; never sent again. 'accepted': the CPO forwards it. The rest are final.
  status text not null default 'claimed' check (status in (
    'claimed', 'sending', 'accepted',
    'succeeded', 'failed', 'not_supported', 'timed_out', 'hold_failed'
  )),
  response_result text check (response_result in ('NOT_SUPPORTED', 'REJECTED', 'ACCEPTED', 'UNKNOWN_SESSION')),
  response_timeout_s integer check (response_timeout_s >= 0),
  result text check (result in (
    'ACCEPTED', 'CANCELED_RESERVATION', 'EVSE_OCCUPIED', 'EVSE_INOPERATIVE', 'FAILED',
    'NOT_SUPPORTED', 'REJECTED', 'TIMEOUT', 'UNKNOWN_RESERVATION'
  )),
  -- A CommandResult that arrived after we had timed the command out.
  late_result text check (late_result in (
    'ACCEPTED', 'CANCELED_RESERVATION', 'EVSE_OCCUPIED', 'EVSE_INOPERATIVE', 'FAILED',
    'NOT_SUPPORTED', 'REJECTED', 'TIMEOUT', 'UNKNOWN_RESERVATION'
  )),
  -- The CPO's answer to the request never arrived (timeout, HTTP 5xx, no CommandResponse).
  outcome_uncertain boolean not null default false,
  -- The CPO's message for the driver, if any.
  peer_message text not null default '' check (char_length(peer_message) <= 300),
  -- Safe to show: no tokens or peer data.
  error text not null default '' check (char_length(error) <= 300),
  -- The payment hold, from the pre-authorization hook.
  hold_ref text check (char_length(hold_ref) between 1 and 255),
  -- An open command that reaches this ends: 'claimed' as failed, else as timed out.
  deadline_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  finished_at timestamptz,
  unique (driver_ref, type, request_id),
  check (type <> 'START_SESSION' or location_id is not null),
  check (type <> 'STOP_SESSION' or session_id is not null),
  check (connector_id is null or evse_uid is not null)
);

-- One open start per driver, and one open stop per session: a second tap waits for
-- the first. emsp_command_claim checks these under a lock; the indexes back it up.
create unique index emsp_commands_open_start_idx
  on public.emsp_commands (driver_ref)
  where type = 'START_SESSION' and status in ('claimed', 'sending', 'accepted');
create unique index emsp_commands_open_stop_idx
  on public.emsp_commands (peer_id, session_id)
  where type = 'STOP_SESSION' and status in ('claimed', 'sending', 'accepted');
create index emsp_commands_session_idx
  on public.emsp_commands (peer_id, session_id) where type = 'START_SESSION';
create index emsp_commands_deadline_idx
  on public.emsp_commands (deadline_at) where status in ('claimed', 'sending', 'accepted');

alter table public.emsp_commands enable row level security;
revoke all on table public.emsp_commands from public, anon, authenticated, service_role;
-- Commands are a record of what was sent to chargers: never deleted.
grant select, insert, update on table public.emsp_commands to service_role;

-- Claims an app request in one step, under a lock per driver (and per session for a
-- stop), so two taps never both send: the command already held for this request ID
-- ('replayed'), else the open command that blocks it ('busy'), else a new one
-- ('created').
create function public.emsp_command_claim(
  p_type text,
  p_driver_ref text,
  p_request_id text,
  p_peer_id uuid,
  p_to_country_code text,
  p_to_party_id text,
  p_location_id text,
  p_evse_uid text,
  p_connector_id text,
  p_session_id text,
  p_authorization_reference text,
  p_deadline_at timestamptz
) returns table (outcome text, command jsonb)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  held public.emsp_commands;
begin
  -- Driver lock first, session lock second, in every caller: no lock cycles.
  perform pg_advisory_xact_lock(hashtextextended('emsp_commands:driver:' || p_driver_ref, 0));
  if p_type = 'STOP_SESSION' then
    perform pg_advisory_xact_lock(
      hashtextextended('emsp_commands:session:' || p_peer_id::text || ':' || coalesce(p_session_id, ''), 0)
    );
  end if;

  select * into held from public.emsp_commands as c
  where c.driver_ref = p_driver_ref and c.type = p_type and c.request_id = p_request_id;
  if found then
    return query select 'replayed'::text, to_jsonb(held);
    return;
  end if;

  select * into held from public.emsp_commands as c
  where c.type = p_type
    and c.status in ('claimed', 'sending', 'accepted')
    and (
      (p_type = 'START_SESSION' and c.driver_ref = p_driver_ref)
      or (p_type = 'STOP_SESSION' and c.peer_id = p_peer_id and c.session_id = p_session_id)
    )
  order by c.created_at
  limit 1;
  if found then
    return query select 'busy'::text, to_jsonb(held);
    return;
  end if;

  insert into public.emsp_commands (
    type, driver_ref, request_id, peer_id, to_country_code, to_party_id, location_id,
    evse_uid, connector_id, session_id, authorization_reference, deadline_at
  ) values (
    p_type, p_driver_ref, p_request_id, p_peer_id, p_to_country_code, p_to_party_id,
    p_location_id, p_evse_uid, p_connector_id, p_session_id, p_authorization_reference,
    p_deadline_at
  )
  returning * into held;
  return query select 'created'::text, to_jsonb(held);
end;
$$;
revoke execute on function public.emsp_command_claim(text, text, text, uuid, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.emsp_command_claim(text, text, text, uuid, text, text, text, text, text, text, text, timestamptz) to service_role;

commit;
