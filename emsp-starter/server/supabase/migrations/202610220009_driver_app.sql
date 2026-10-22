-- The driver app's own data (part 11): push tokens, favourite locations and the
-- problems drivers report from the app. The app reads and writes them through the
-- server's driver API only. Service-only (10-30 rule): RLS on, nothing granted to anon
-- or authenticated.
begin;

-- A device's Expo push token, for "charging finished" and "the command failed". One
-- row per token: a token that moves to another driver (a shared phone) moves with it.
create table public.emsp_push_tokens (
  token text primary key
    check (token ~ '^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{8,200}\]$'),
  driver_ref text not null check (char_length(driver_ref) between 1 and 64),
  platform text not null check (platform in ('ios', 'android')),
  -- BCP 47 language tag of the device, for the notification's words.
  locale text not null default 'en'
    check (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$' and char_length(locale) <= 35),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index emsp_push_tokens_driver on public.emsp_push_tokens (driver_ref);

alter table public.emsp_push_tokens enable row level security;
revoke all on table public.emsp_push_tokens from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.emsp_push_tokens to service_role;

-- A driver's favourite locations, by the app's location ID.
create table public.emsp_favourites (
  driver_ref text not null check (char_length(driver_ref) between 1 and 64),
  location_id text not null check (char_length(location_id) between 1 and 200),
  created_at timestamptz not null default now(),
  primary key (driver_ref, location_id)
);

alter table public.emsp_favourites enable row level security;
revoke all on table public.emsp_favourites from public, anon, authenticated, service_role;
grant select, insert, delete on table public.emsp_favourites to service_role;

-- A problem a driver reported at a charger, for the admin web. The photo is optional,
-- a JPEG or PNG of at most 1 MB, base64. Never deleted; an admin marks it resolved.
create table public.emsp_problem_reports (
  id uuid primary key default gen_random_uuid(),
  driver_ref text not null check (char_length(driver_ref) between 1 and 64),
  location_id text not null check (char_length(location_id) between 1 and 200),
  evse_uid text check (char_length(evse_uid) between 1 and 36),
  category text not null check (category in (
    'not_starting', 'stopped_early', 'damaged', 'blocked', 'payment', 'other'
  )),
  message text not null check (char_length(message) between 1 and 2000),
  photo_type text check (photo_type in ('image/jpeg', 'image/png')),
  photo_base64 text check (char_length(photo_base64) <= 1400000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by text check (char_length(resolved_by) <= 100),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check ((photo_type is null) = (photo_base64 is null)),
  check ((status = 'resolved') = (resolved_at is not null))
);

create index emsp_problem_reports_open on public.emsp_problem_reports (status, created_at desc);
create index emsp_problem_reports_driver on public.emsp_problem_reports (driver_ref, created_at desc);

alter table public.emsp_problem_reports enable row level security;
revoke all on table public.emsp_problem_reports from public, anon, authenticated, service_role;
-- Reports are never deleted: an admin only marks them resolved.
grant select, insert, update on table public.emsp_problem_reports to service_role;

commit;
