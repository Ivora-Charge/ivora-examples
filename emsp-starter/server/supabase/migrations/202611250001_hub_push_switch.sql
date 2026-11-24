-- Makes a hub's push-mode switch safe. Forward-only and additive; service role only
-- (nothing is granted to anon or authenticated; row level security is unchanged).
--
-- 1. push_gen on the peer, raised by every mode switch, and on each outbox row
--    (emsp_token_pushes): the generation the row is owed in. A push that started before
--    a switch carries the older generation, so when it lands it cannot clear a row the
--    switch re-owed: the token is sent again the new way.
-- 2. emsp_ocpi_hub_set_push_mode: the switch, the catch-up (every token, blocked ones
--    too) and the audit row in one transaction, so a crash leaves all of it or none.
begin;

alter table public.emsp_ocpi_peers
  add column push_gen bigint not null default 0;

alter table public.emsp_token_pushes
  add column push_gen bigint not null default 0;

-- Same as before, and the row it owes carries the peer's generation. The peer row is
-- read FOR SHARE, so a token change and a concurrent mode switch (which locks the peer
-- FOR UPDATE) take turns: a change committed first is moved to the new generation by
-- the switch, and one made after it waits for the switch and reads the new generation.
create or replace function public.emsp_tokens_owe_push() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.emsp_token_pushes as q (
    peer_id, token_id, token_last_updated, attempts, last_error, next_attempt_at, updated_at, push_gen
  )
  select p.id, new.id, new.last_updated, 0, '', new.last_updated + interval '1 minute', now(), p.push_gen
  from public.emsp_ocpi_peers as p
  where p.status = 'registered'
    and p.token_ciphertext is not null
    and p.endpoints @> '[{"identifier": "tokens", "role": "RECEIVER"}]'::jsonb
  for share of p
  on conflict (peer_id, token_id) do update set
    token_last_updated = greatest(q.token_last_updated, excluded.token_last_updated),
    next_attempt_at = least(q.next_attempt_at, excluded.next_attempt_at),
    push_gen = greatest(q.push_gen, excluded.push_gen),
    updated_at = excluded.updated_at;
  return null;
end;
$$;

revoke execute on function public.emsp_tokens_owe_push() from public, anon, authenticated;

-- Switches a registered roaming hub's hub_push_mode if it still has revision p_expected_rev
-- (compare-and-set; no row is returned otherwise, and nothing is written). It raises
-- the peer's push_gen and the generation of every push the peer is owed. Switching to
-- 'hub' also owes the peer every token, active or blocked, due at p_now (a push already
-- owed stays one row), when it has a token and a tokens Receiver. The audit row is
-- written in the same transaction. Returns the peer, the previous mode and how many
-- tokens are owed. A peer without a HUB role is refused with an error.
create function public.emsp_ocpi_hub_set_push_mode(
  p_peer_id uuid,
  p_mode text,
  p_expected_rev bigint,
  p_now timestamptz,
  p_actor text
) returns table (peer_row jsonb, from_mode text, owed integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_from text;
  v_roles jsonb;
  v_peer public.emsp_ocpi_peers;
  v_owed integer := 0;
begin
  if p_mode not in ('hub', 'per_party') then
    raise exception 'push mode must be hub or per_party';
  end if;
  select p.hub_push_mode, p.roles into v_from, v_roles
  from public.emsp_ocpi_peers as p
  where p.id = p_peer_id and p.status = 'registered' and p.rev = p_expected_rev
  for update;
  if not found or v_from = p_mode then
    return;
  end if;
  -- The push mode means something only behind a hub; the app checks this first too.
  if not coalesce(v_roles @> '[{"role": "HUB"}]'::jsonb, false) then
    raise exception 'peer % is not a roaming hub', p_peer_id;
  end if;

  update public.emsp_ocpi_peers as p
  set hub_push_mode = p_mode, push_gen = p.push_gen + 1, updated_at = p_now
  where p.id = p_peer_id
  returning p.* into v_peer;

  -- Pushes already owed are sent the new way: a push still under way cannot clear them.
  update public.emsp_token_pushes as q
  set push_gen = v_peer.push_gen
  where q.peer_id = p_peer_id;

  if p_mode = 'hub'
    and v_peer.token_ciphertext is not null
    and v_peer.endpoints @> '[{"identifier": "tokens", "role": "RECEIVER"}]'::jsonb then
    with done as (
      insert into public.emsp_token_pushes as q (
        peer_id, token_id, token_last_updated, attempts, last_error, next_attempt_at, updated_at, push_gen
      )
      select p_peer_id, t.id, t.last_updated, 0, '', p_now, p_now, v_peer.push_gen
      from public.emsp_tokens as t
      on conflict (peer_id, token_id) do update set
        token_last_updated = greatest(q.token_last_updated, excluded.token_last_updated),
        next_attempt_at = least(q.next_attempt_at, excluded.next_attempt_at),
        push_gen = greatest(q.push_gen, excluded.push_gen),
        updated_at = excluded.updated_at
      returning 1
    )
    select count(*)::integer into v_owed from done;
  end if;

  insert into public.emsp_audit_log (actor, action, subject_type, subject_id, details)
  values (
    p_actor, 'ocpi.hub.push_mode_set', 'ocpi_peer', p_peer_id::text,
    jsonb_build_object('mode', p_mode, 'from', v_from, 'owed', v_owed)
  );

  return query select to_jsonb(v_peer), v_from, v_owed;
end;
$$;
revoke execute on function public.emsp_ocpi_hub_set_push_mode(uuid, text, bigint, timestamptz, text) from public, anon, authenticated;
grant execute on function public.emsp_ocpi_hub_set_push_mode(uuid, text, bigint, timestamptz, text) to service_role;

commit;
