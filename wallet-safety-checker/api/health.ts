// Vercel serverless function: GET /api/health
// Returns configuration and connectivity status — helps diagnose missing env vars.

const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim()
const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.VITE_SUPABASE_ANON_KEY
  ?? ''
).trim()
const RESEND_KEY     = (process.env.RESEND_API_KEY ?? '').trim()

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })

  const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY)

  let supabaseReachable = false
  let supabaseError     = ''
  if (supabaseConfigured) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=id`,
        {
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
          signal: AbortSignal.timeout(6000),
        },
      )
      supabaseReachable = res.ok
      if (!res.ok) supabaseError = `HTTP ${res.status}`
    } catch (err) {
      supabaseError = String(err)
    }
  }

  return json({
    ok: supabaseConfigured && supabaseReachable,
    env: {
      SUPABASE_URL:      SUPABASE_URL  ? `${SUPABASE_URL.slice(0, 30)}…` : 'NOT SET',
      SUPABASE_KEY:      SUPABASE_KEY  ? `${SUPABASE_KEY.slice(0, 8)}…`  : 'NOT SET',
      RESEND_API_KEY:    RESEND_KEY    ? `${RESEND_KEY.slice(0, 8)}…`    : 'NOT SET',
    },
    supabase: {
      configured: supabaseConfigured,
      reachable:  supabaseReachable,
      error:      supabaseError || null,
    },
  })
}
