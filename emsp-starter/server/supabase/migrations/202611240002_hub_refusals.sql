-- Refused pushes from parties a roaming hub peer sends us but we do not trust.
-- Forward-only and additive. Service role only: row level security on, and nothing is
-- granted to anon or authenticated.
--
-- A hub peer passes our token check, but a push in the name of a party the operator
-- has not accepted is refused (403, OCPI 2000). This keeps a bounded summary of such
-- refusals so the hub's page can say who tried and offer to accept them: one row per
-- (hub peer, refused party). No request body, token, header value or IP address.
begin;

create table public.emsp_ocpi_hub_refusals (
  peer_id uuid not null references public.emsp_ocpi_peers (id),
  -- The refused party: the OCPI-from party, or the party of the URL or body when the
  -- OCPI-from party was the hub itself or a different party.
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  party_id text not null check (party_id ~ '^[A-Z0-9]{3}$'),
  -- 'routing': the OCPI-from party is not trusted behind this hub.
  -- 'path': the party of the URL or body is not the OCPI-from party.
  kind text not null check (kind in ('routing', 'path')),
  -- The OCPI module of the last refused request (locations, sessions, ...).
  module text not null check (module ~ '^[a-z]{1,20}$'),
  -- The other party of the last refused request, 'CC-PID', when the OCPI-from party and
  -- the party of the URL or body differ.
  other_party text check (other_party ~ '^[A-Z]{2}-[A-Z0-9]{3}$'),
  -- Refusals counted (a lower bound: see emsp_ocpi_hub_refusal_note).
  times bigint not null default 1 check (times >= 1),
  first_seen timestamptz not null,
  last_seen timestamptz not null check (last_seen >= first_seen),
  primary key (peer_id, country_code, party_id)
);

create index emsp_ocpi_hub_refusals_seen_idx
  on public.emsp_ocpi_hub_refusals (peer_id, last_seen desc);

alter table public.emsp_ocpi_hub_refusals enable row level security;
revoke all on table public.emsp_ocpi_hub_refusals from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.emsp_ocpi_hub_refusals to service_role;

-- Notes p_times refusals of one party, at the database's own clock (now()). Bounded so
-- that a hub token holder cannot drive writes:
-- - per party: a note within 60 seconds of the row's last_seen changes nothing;
-- - per hub, for new parties: a party with no row yet gets one only while fewer than
--   10 of the peer's rows were first seen in the last 60 seconds, so rotating the
--   party on every request adds at most 10 rows (and drops at most 10 old ones) a
--   minute;
-- - at most 100 rows per peer: a new row past that drops the peer's rows seen
--   longest ago.
-- Calls for one peer run one at a time (a transaction lock per peer), so concurrent
-- calls cannot overshoot the budget or the cap. Returns whether it wrote.
create function public.emsp_ocpi_hub_refusal_note(
  p_peer_id uuid,
  p_country_code text,
  p_party_id text,
  p_kind text,
  p_module text,
  p_other_party text,
  p_times integer
) returns table (noted boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_last timestamptz;
  v_noted boolean := false;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('emsp_ocpi_hub_refusals:peer:' || p_peer_id::text, 0)
  );
  select r.last_seen into v_last
  from public.emsp_ocpi_hub_refusals as r
  where r.peer_id = p_peer_id
    and r.country_code = p_country_code
    and r.party_id = p_party_id;
  if found then
    update public.emsp_ocpi_hub_refusals as r set
      kind = p_kind,
      module = p_module,
      other_party = p_other_party,
      times = r.times + greatest(p_times, 1),
      last_seen = greatest(v_now, r.last_seen)
    where r.peer_id = p_peer_id
      and r.country_code = p_country_code
      and r.party_id = p_party_id
      and r.last_seen <= v_now - interval '60 seconds';
    v_noted := found;
  elsif (
    select count(*)
    from public.emsp_ocpi_hub_refusals as b
    where b.peer_id = p_peer_id
      and b.first_seen > v_now - interval '60 seconds'
  ) < 10 then
    insert into public.emsp_ocpi_hub_refusals (
      peer_id, country_code, party_id, kind, module, other_party, times, first_seen, last_seen
    )
    values (
      p_peer_id, p_country_code, p_party_id, p_kind, p_module, p_other_party,
      greatest(p_times, 1), v_now, v_now
    );
    v_noted := true;
    delete from public.emsp_ocpi_hub_refusals as d
    where d.peer_id = p_peer_id
      and (d.country_code, d.party_id) not in (
        select k.country_code, k.party_id
        from public.emsp_ocpi_hub_refusals as k
        where k.peer_id = p_peer_id
        order by k.last_seen desc, k.country_code, k.party_id
        limit 100
      );
  end if;
  return query select v_noted;
end;
$$;
revoke execute on function public.emsp_ocpi_hub_refusal_note(uuid, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.emsp_ocpi_hub_refusal_note(uuid, text, text, text, text, text, integer) to service_role;

commit;
