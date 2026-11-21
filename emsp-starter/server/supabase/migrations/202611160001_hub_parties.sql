-- Roaming hub peers: the CPO parties reachable through a hub, and one pull state per
-- party. Forward-only and additive. emsp_ocpi_peers keeps its row level security and
-- its grants (service_role only); nothing new is granted to anon or authenticated.
begin;

-- The parties behind a hub peer: [{countryCode, partyId, status, source, name?}]
-- (camelCase keys, as the server writes them).
-- status 'offered': the hub lists it (hubclientinfo) or declares it as a CPO role in its
-- own credentials, and the operator has not accepted it.
-- status 'trusted': the operator accepted it; only trusted parties are called or served.
-- source: 'admin', 'hubclientinfo' or 'credentials' (who added it).
-- Empty for a direct CPO peer, which behaves as before.
alter table public.emsp_ocpi_peers
  add column hub_parties jsonb not null default '[]'::jsonb
    check (jsonb_typeof(hub_parties) = 'array');

-- A hub's pulls keep one state per party, so one party's cursor never moves another's:
-- the module is then 'locations@NL-ABC'. A direct peer keeps the plain module name.
alter table public.emsp_ocpi_sync_state drop constraint emsp_ocpi_sync_state_module_check;
alter table public.emsp_ocpi_sync_state add constraint emsp_ocpi_sync_state_module_check
  check (module ~ '^(locations|tariffs|sessions|cdrs)(@[A-Z]{2}-[A-Z0-9]{3})?$');

commit;
