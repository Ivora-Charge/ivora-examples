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

-- Notes p_times refusals of one party at p_now. Writes at most once per party per
-- 60 seconds: a note within 60 seconds of the row's last_seen changes nothing and
-- returns false, so a sender cannot drive writes faster than that. A new row past 100
-- for the peer drops the peer's rows seen longest ago. Returns whether it wrote.
create function public.emsp_ocpi_hub_refusal_note(
  p_peer_id uuid,
  p_country_code text,
  p_party_id text,
  p_kind text,
  p_module text,
  p_other_party text,
  p_times integer,
  p_now timestamptz
) returns table (noted boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_noted boolean;
begin
  insert into public.emsp_ocpi_hub_refusals as r (
    peer_id, country_code, party_id, kind, module, other_party, times, first_seen, last_seen
  )
  values (
    p_peer_id, p_country_code, p_party_id, p_kind, p_module, p_other_party,
    greatest(p_times, 1), p_now, p_now
  )
  on conflict (peer_id, country_code, party_id) do update set
    kind = excluded.kind,
    module = excluded.module,
    other_party = excluded.other_party,
    times = r.times + excluded.times,
    last_seen = excluded.last_seen
  where r.last_seen <= excluded.last_seen - interval '60 seconds';
  v_noted := found;
  if v_noted then
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
revoke execute on function public.emsp_ocpi_hub_refusal_note(uuid, text, text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.emsp_ocpi_hub_refusal_note(uuid, text, text, text, text, text, integer, timestamptz) to service_role;

commit;
