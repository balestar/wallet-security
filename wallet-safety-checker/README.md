# Sentinel Vault

Sentinel Vault is a Vite + React application for wallet risk scanning, watchout alerts, and admin/security intelligence workflows.

## Supabase + Cloud Setup

1. Create a new Supabase project.
2. Open SQL Editor and run `supabase/schema.sql`.
3. Copy `.env.example` to `.env` and fill:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - optional `VITE_GOPLUS_ACCESS_TOKEN`
4. Install and run locally:
   - `npm install`
   - `npm run dev`

When env vars are present, app records are synced to the cloud table `public.app_state`.

## Deploy To Cloud (Vercel)

1. Push this project to GitHub.
2. Import repo in Vercel.
3. Add environment variables in Vercel project settings:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_GOPLUS_ACCESS_TOKEN` (optional)
4. Deploy.

Vercel will run `npm run build` and host the static `dist` output.

## Security Note

`app_state` is currently configured for open read/write to `anon` and `authenticated` so the frontend-only app can persist data without a backend. For production hardening, add auth and tighten RLS policies per-user.
