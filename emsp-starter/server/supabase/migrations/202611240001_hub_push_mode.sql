-- How tokens are pushed to a roaming hub peer. Forward-only and additive.
-- 'hub': one push addressed to the hub's own HUB party (the hub distributes it).
-- 'per_party': one push per trusted CPO party behind the hub.
-- Only a peer with a HUB role reads it; a direct CPO peer ignores it. emsp_ocpi_peers
-- keeps its row level security and its grants (service_role only); nothing new is
-- granted to anon or authenticated.
begin;

alter table public.emsp_ocpi_peers
  add column hub_push_mode text not null default 'hub'
    check (hub_push_mode in ('hub', 'per_party'));

commit;
