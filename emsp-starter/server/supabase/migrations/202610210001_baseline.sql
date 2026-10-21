-- eMSP Starter baseline: an append-only audit log, and nothing else yet.
--
-- 10-30 rule (checked in CI by scripts/check-migrations.mjs):
-- every public table has row-level security, no default grants, and grants to the
-- Data API roles (anon, authenticated) only on tables that have a policy. The driver
-- app and the admin web talk to the server API only, so tables are service-only:
-- no anon or authenticated grants at all.
begin;

create table public.emsp_audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  -- Who acted, for example 'system', 'admin:<user id>' or 'peer:<country>-<party>'.
  actor text not null check (char_length(actor) between 1 and 200),
  -- What happened, for example 'peer.registered' or 'session.start_requested'.
  action text not null check (char_length(action) between 1 and 200),
  subject_type text check (char_length(subject_type) <= 100),
  subject_id text check (char_length(subject_id) <= 200),
  -- OCPI X-Request-ID / X-Correlation-ID, or our own request ID.
  request_id text check (char_length(request_id) <= 200),
  -- Never store secrets, tokens or card data here.
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create index emsp_audit_log_subject_idx
  on public.emsp_audit_log (subject_type, subject_id, occurred_at desc);

alter table public.emsp_audit_log enable row level security;
revoke all on table public.emsp_audit_log from public, anon, authenticated, service_role;
-- The server (service role) may append and read, never change or remove entries.
grant select, insert on table public.emsp_audit_log to service_role;

create function public.emsp_audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'emsp_audit_log is append-only';
end;
$$;
revoke all on function public.emsp_audit_log_append_only() from public, anon, authenticated;

create trigger emsp_audit_log_append_only
  before update or delete or truncate on public.emsp_audit_log
  for each statement execute function public.emsp_audit_log_append_only();

commit;
