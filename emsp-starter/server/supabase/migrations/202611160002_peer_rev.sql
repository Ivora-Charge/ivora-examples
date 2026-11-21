-- A version counter on peers, for compare-and-set. Forward-only and additive.
-- The server edits a hub's party list by reading the peer and writing back only if
-- `rev` is unchanged; a millisecond timestamp could repeat within one millisecond, a
-- counter that the database raises on every update cannot. emsp_ocpi_peers keeps its
-- row level security and its grants (service_role only).
begin;

alter table public.emsp_ocpi_peers
  add column rev bigint not null default 0;

create function public.emsp_ocpi_peers_bump_rev() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.rev := old.rev + 1;
  return new;
end;
$$;

-- A trigger function needs no grant to run; nobody may call it directly.
revoke all on function public.emsp_ocpi_peers_bump_rev() from public, anon, authenticated;

create trigger emsp_ocpi_peers_bump_rev
  before update on public.emsp_ocpi_peers
  for each row execute function public.emsp_ocpi_peers_bump_rev();

commit;
