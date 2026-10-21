begin;

-- Onboarding: the operator's company details and brand, one row per operator.
--
-- 10-30 rule: RLS on, no privileges for anon or authenticated. Nothing here is read
-- through the Data API: the server reads and writes it with the service role, for the
-- operator of the signed-in staff member. Writes go through the functions below, which
-- check the staff member's role in the same statement as the write.
-- `npm run check:migrations` (the shared tools/check-migrations) enforces this in CI.

create table if not exists public.cpo_company_profiles (
  operator_id uuid primary key references public.cpo_operators(id) on delete cascade,
  -- The name drivers see on Ivora's payment pages.
  name text check (char_length(name) between 1 and 80),
  support_email text check (char_length(support_email) between 3 and 254),
  support_url text check (support_url ~ '^https://' and char_length(support_url) <= 300),
  website text check (website ~ '^https://' and char_length(website) <= 300),
  -- IANA time zone (for example Europe/Berlin) and ISO 4217 currency (USD).
  time_zone text check (char_length(time_zone) between 1 and 64),
  currency text check (currency ~ '^[A-Z]{3}$'),
  primary_color text check (primary_color ~ '^#[0-9a-f]{6}$'),
  -- The logo as Ivora serves it; the image itself is stored by Ivora, not here.
  logo_url text check (char_length(logo_url) <= 2048),
  -- SHA-256 of the branding last pushed to Ivora, so the kit knows if it is current.
  branding_hash text check (branding_hash ~ '^[0-9a-f]{64}$'),
  branding_synced_at timestamptz,
  -- Counters that go into the Idempotency-Key of the next push and upload.
  branding_syncs integer not null default 0 check (branding_syncs >= 0),
  logo_uploads integer not null default 0 check (logo_uploads >= 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.cpo_company_profiles enable row level security;
revoke all on public.cpo_company_profiles from public, anon, authenticated;
grant all on public.cpo_company_profiles to service_role;

-- Owners and managers only. Locks the actor's staff row (FOR SHARE) until the write
-- commits, so a concurrent demotion waits for it or is seen by it.
create or replace function public.cpo_lock_onboarding_actor(p_operator_id uuid, p_actor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.cpo_staff
    where operator_id = p_operator_id and user_id = p_actor_id
      and role in ('owner', 'manager')
    for share;
  if not found then
    raise exception 'cpo_not_allowed' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.cpo_lock_onboarding_actor(uuid, uuid) from public, anon, authenticated;

create or replace function public.cpo_save_company(
  p_operator_id uuid, p_actor_id uuid, p_name text, p_support_email text,
  p_support_url text, p_website text, p_time_zone text, p_currency text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_onboarding_actor(p_operator_id, p_actor_id);
  insert into public.cpo_company_profiles as c (
    operator_id, name, support_email, support_url, website, time_zone, currency, updated_by
  ) values (
    p_operator_id, p_name, lower(p_support_email), p_support_url, p_website, p_time_zone, p_currency, p_actor_id
  )
  on conflict (operator_id) do update set
    name = excluded.name,
    support_email = excluded.support_email,
    support_url = excluded.support_url,
    website = excluded.website,
    time_zone = excluded.time_zone,
    currency = excluded.currency,
    updated_by = excluded.updated_by,
    updated_at = now();
end;
$$;
revoke all on function public.cpo_save_company(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.cpo_save_company(uuid, uuid, text, text, text, text, text, text) to service_role;

create or replace function public.cpo_save_brand(p_operator_id uuid, p_actor_id uuid, p_primary_color text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_onboarding_actor(p_operator_id, p_actor_id);
  insert into public.cpo_company_profiles as c (operator_id, primary_color, updated_by)
    values (p_operator_id, lower(p_primary_color), p_actor_id)
  on conflict (operator_id) do update set
    primary_color = excluded.primary_color,
    updated_by = excluded.updated_by,
    updated_at = now();
end;
$$;
revoke all on function public.cpo_save_brand(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cpo_save_brand(uuid, uuid, text) to service_role;

-- What Ivora answered: the branding now live on the driver pages (p_hash, null when
-- only the logo changed) and the logo URL it serves.
create or replace function public.cpo_record_branding(
  p_operator_id uuid, p_actor_id uuid, p_hash text, p_logo_url text, p_logo_uploaded boolean
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cpo_lock_onboarding_actor(p_operator_id, p_actor_id);
  update public.cpo_company_profiles set
    branding_hash = coalesce(p_hash, branding_hash),
    branding_synced_at = case when p_hash is null then branding_synced_at else now() end,
    branding_syncs = branding_syncs + case when p_hash is null then 0 else 1 end,
    logo_uploads = logo_uploads + case when p_logo_uploaded then 1 else 0 end,
    logo_url = p_logo_url
  where operator_id = p_operator_id;
  if not found then
    raise exception 'cpo_no_company' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.cpo_record_branding(uuid, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.cpo_record_branding(uuid, uuid, text, text, boolean) to service_role;

commit;
