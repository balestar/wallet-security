create table if not exists public.app_state (
  id text primary key,
  connected_wallets jsonb not null default '[]'::jsonb,
  scan_history jsonb not null default '[]'::jsonb,
  signer_checks jsonb not null default '[]'::jsonb,
  email_records jsonb not null default '[]'::jsonb,
  admin_intel_records jsonb not null default '[]'::jsonb,
  protect_checklist_done jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "app_state_read" on public.app_state;
create policy "app_state_read"
on public.app_state
for select
to anon, authenticated
using (true);

drop policy if exists "app_state_write" on public.app_state;
create policy "app_state_write"
on public.app_state
for insert
to anon, authenticated
with check (true);

drop policy if exists "app_state_update" on public.app_state;
create policy "app_state_update"
on public.app_state
for update
to anon, authenticated
using (true)
with check (true);
