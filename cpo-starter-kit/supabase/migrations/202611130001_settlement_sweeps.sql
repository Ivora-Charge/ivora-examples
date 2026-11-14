begin;

-- When the settlement sweep (GET /api/cron/settle) last finished a pass. One row.
-- Live payments need the sweep every minute: it stops paid sessions before their cost
-- reaches the card hold and releases holds that never started charging. The kit
-- refuses a new paid checkout while the last pass is more than a few minutes old.
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated; the server reads it
-- with the service role and writes it only through cpo_mark_settlement_sweep.

create table if not exists public.cpo_settlement_sweeps (
  id smallint primary key default 1 check (id = 1),
  swept_at timestamptz not null
);
alter table public.cpo_settlement_sweeps enable row level security;
revoke all on public.cpo_settlement_sweeps from public, anon, authenticated, service_role;
grant select on public.cpo_settlement_sweeps to service_role;

-- Moves the one row forward only: an older pass that finishes last changes nothing.
create or replace function public.cpo_mark_settlement_sweep(p_swept_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_swept_at is null then
    raise exception 'cpo_invalid' using errcode = 'P0001';
  end if;
  insert into public.cpo_settlement_sweeps (id, swept_at) values (1, p_swept_at)
  on conflict (id) do update
    set swept_at = excluded.swept_at
    where public.cpo_settlement_sweeps.swept_at < excluded.swept_at;
end;
$$;
revoke all on function public.cpo_mark_settlement_sweep(timestamptz) from public, anon, authenticated;
grant execute on function public.cpo_mark_settlement_sweep(timestamptz) to service_role;

commit;
