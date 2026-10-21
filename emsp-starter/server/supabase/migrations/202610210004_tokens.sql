-- Our drivers' OCPI tokens (APP_USER tokens and RFID cards), which every CPO peer may
-- pull from our Tokens Sender interface, and which we push to each peer's Tokens
-- Receiver; and the push outbox: what each peer is owed, written in the same
-- transaction as the token change and cleared once the push lands.
-- Service-only (10-30 rule): RLS on, nothing granted to anon or authenticated. The
-- driver app reaches tokens through the server's API, never the Data API.
begin;

create table public.emsp_tokens (
  id uuid primary key default gen_random_uuid(),
  -- Our own party, from EMSP_COUNTRY_CODE and EMSP_PARTY_ID when the token was made.
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  party_id text not null check (party_id ~ '^[A-Z0-9]{3}$'),
  -- Upper case. A CPO authorizes by uid and type.
  uid text not null check (uid ~ '^[A-Z0-9]{1,36}$'),
  type text not null check (type in ('APP_USER', 'RFID')),
  -- eMA ID (country code, party ID, 'C', 8 characters), shared by a driver's tokens.
  contract_id text not null check (contract_id ~ '^[A-Z]{2}[A-Z0-9]{3}C[A-Z0-9]{8}$'),
  -- The driver: the account's ID once driver sign-in lands.
  driver_ref text not null check (char_length(driver_ref) between 1 and 64),
  -- What is printed on an RFID card.
  visual_number text check (char_length(visual_number) between 1 and 64),
  group_id text not null check (char_length(group_id) between 1 and 36),
  issuer text not null check (char_length(issuer) between 1 and 64),
  whitelist text not null check (whitelist in ('ALWAYS', 'ALLOWED', 'ALLOWED_OFFLINE', 'NEVER')),
  language text check (language ~ '^[a-z]{2}$'),
  -- 'active': may charge. 'blocked': by an admin, until unblocked. 'expired': past expires_at.
  status text not null default 'active' check (status in ('active', 'blocked', 'expired')),
  expires_at timestamptz,
  -- OCPI last_updated: what a CPO's pull with date_from and date_to filters on.
  last_updated timestamptz not null,
  created_at timestamptz not null default now(),
  -- New on every change, for compare-and-swap.
  revision uuid not null default gen_random_uuid(),
  unique (uid, type)
);

-- One APP_USER token, and so one contract, per driver.
create unique index emsp_tokens_app_user_driver_idx
  on public.emsp_tokens (driver_ref) where type = 'APP_USER';
create unique index emsp_tokens_app_user_contract_idx
  on public.emsp_tokens (contract_id) where type = 'APP_USER';
create index emsp_tokens_driver_idx on public.emsp_tokens (driver_ref);
create index emsp_tokens_last_updated_idx on public.emsp_tokens (last_updated, id);
create index emsp_tokens_expiry_idx
  on public.emsp_tokens (expires_at) where status = 'active' and expires_at is not null;

alter table public.emsp_tokens enable row level security;
revoke all on table public.emsp_tokens from public, anon, authenticated, service_role;
-- Tokens are blocked, never deleted: a CPO may still hold sessions and CDRs for them.
grant select, insert, update on table public.emsp_tokens to service_role;

create table public.emsp_token_pushes (
  peer_id uuid not null references public.emsp_ocpi_peers (id),
  token_id uuid not null references public.emsp_tokens (id),
  -- The newest token version the peer is owed. A successful push of this or a newer
  -- version clears the row; a change after it keeps it.
  token_last_updated timestamptz not null,
  -- Failed attempts so far: 0 for a change whose first push is still under way.
  attempts integer not null default 1 check (attempts >= 0),
  -- Safe to show: no tokens or peer data.
  last_error text not null default '' check (char_length(last_error) <= 300),
  next_attempt_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (peer_id, token_id)
);

create index emsp_token_pushes_due_idx on public.emsp_token_pushes (next_attempt_at);

alter table public.emsp_token_pushes enable row level security;
revoke all on table public.emsp_token_pushes from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.emsp_token_pushes to service_role;

-- How many tokens a CPO's pull covers: last_updated in [p_date_from, p_date_to), for
-- the X-Total-Count header. Null parameters do not filter.
create function public.emsp_tokens_count(
  p_date_from timestamptz,
  p_date_to timestamptz
) returns table (total bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*) from public.emsp_tokens as t
  where (p_date_from is null or t.last_updated >= p_date_from)
    and (p_date_to is null or t.last_updated < p_date_to);
$$;
revoke execute on function public.emsp_tokens_count(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.emsp_tokens_count(timestamptz, timestamptz) to service_role;

-- Records a failed push in one statement, so concurrent failures never lose a count:
-- one more attempt, the next one after 1, 2, 4 ... minutes (at most 6 hours), and the
-- newest token version the peer is owed.
create function public.emsp_token_push_failed(
  p_peer_id uuid,
  p_token_id uuid,
  p_token_last_updated timestamptz,
  p_error text,
  p_now timestamptz
) returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.emsp_token_pushes as p (
    peer_id, token_id, token_last_updated, attempts, last_error, next_attempt_at, updated_at
  )
  values (
    p_peer_id, p_token_id, p_token_last_updated, 1, left(p_error, 300),
    p_now + interval '1 minute', p_now
  )
  on conflict (peer_id, token_id) do update set
    token_last_updated = greatest(p.token_last_updated, excluded.token_last_updated),
    attempts = p.attempts + 1,
    last_error = excluded.last_error,
    next_attempt_at = p_now + least(
      interval '1 minute' * power(2, least(p.attempts, 20)),
      interval '6 hours'
    ),
    updated_at = p_now;
$$;
revoke execute on function public.emsp_token_push_failed(uuid, uuid, timestamptz, text, timestamptz) from public, anon, authenticated;
grant execute on function public.emsp_token_push_failed(uuid, uuid, timestamptz, text, timestamptz) to service_role;

-- The outbox: every token change owes its new version to each registered peer with a
-- tokens Receiver, in the same transaction as the change, so a push is never lost when
-- the server dies before sending it. The first push follows at once from the server;
-- the row becomes due for the retry job a minute later in case it never did.
create function public.emsp_tokens_owe_push() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.emsp_token_pushes as q (
    peer_id, token_id, token_last_updated, attempts, last_error, next_attempt_at, updated_at
  )
  select p.id, new.id, new.last_updated, 0, '', new.last_updated + interval '1 minute', now()
  from public.emsp_ocpi_peers as p
  where p.status = 'registered'
    and p.token_ciphertext is not null
    and p.endpoints @> '[{"identifier": "tokens", "role": "RECEIVER"}]'::jsonb
  on conflict (peer_id, token_id) do update set
    token_last_updated = greatest(q.token_last_updated, excluded.token_last_updated),
    next_attempt_at = least(q.next_attempt_at, excluded.next_attempt_at),
    updated_at = excluded.updated_at;
  return null;
end;
$$;
revoke execute on function public.emsp_tokens_owe_push() from public, anon, authenticated;

create trigger emsp_tokens_owe_push
  after insert or update on public.emsp_tokens
  for each row execute function public.emsp_tokens_owe_push();

commit;
