-- When each driver last signed in, for the admin web's driver list. Forward-only and
-- additive: one nullable column, without a default or a backfill, so an account reads
-- as "not recorded" until its next sign-in. Row-level security and grants are
-- unchanged (service role only, whose grants on the table cover the new column).
begin;

alter table public.emsp_drivers
  add column last_sign_in_at timestamptz;

commit;
