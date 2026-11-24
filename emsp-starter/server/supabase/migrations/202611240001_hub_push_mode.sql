-- How tokens are pushed to a roaming hub peer. Forward-only and additive.
-- 'hub': one push addressed to the hub's own HUB party (the hub distributes it).
-- 'per_party': one push per trusted CPO party behind the hub.
-- Only a peer with a HUB role reads it; a direct CPO peer ignores it. emsp_ocpi_peers
-- keeps its row level security and its grants (service_role only); nothing new is
-- granted to anon or authenticated.
begin;

-- Every existing peer keeps today's behaviour (one push per trusted party): the column
-- is added with 'per_party', which fills the rows already there ...
alter table public.emsp_ocpi_peers
  add column hub_push_mode text not null default 'per_party'
    check (hub_push_mode in ('hub', 'per_party'));

-- ... and only peers registered from now on start with 'hub'.
alter table public.emsp_ocpi_peers
  alter column hub_push_mode set default 'hub';

-- The catch-up when an admin switches a hub to 'hub': owes the peer every active token
-- through the outbox (emsp_token_pushes), due at p_now, so the retry job sends the hub
-- the full set once. A push already owed stays one row (its newest version is kept),
-- so running it twice never owes a token twice. Returns how many tokens are owed.
create function public.emsp_token_owe_active(
  p_peer_id uuid,
  p_now timestamptz
) returns table (owed integer)
language sql
security invoker
set search_path = ''
as $$
  with done as (
    insert into public.emsp_token_pushes as q (
      peer_id, token_id, token_last_updated, attempts, last_error, next_attempt_at, updated_at
    )
    select p_peer_id, t.id, t.last_updated, 0, '', p_now, p_now
    from public.emsp_tokens as t
    where t.status = 'active'
    on conflict (peer_id, token_id) do update set
      token_last_updated = greatest(q.token_last_updated, excluded.token_last_updated),
      next_attempt_at = least(q.next_attempt_at, excluded.next_attempt_at),
      updated_at = excluded.updated_at
    returning 1
  )
  select count(*)::integer from done;
$$;
revoke execute on function public.emsp_token_owe_active(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.emsp_token_owe_active(uuid, timestamptz) to service_role;

commit;
