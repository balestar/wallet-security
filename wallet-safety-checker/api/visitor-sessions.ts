// Vercel serverless function: GET /api/visitor-sessions
// Returns all visitor session records directly from Supabase.
// Allows the admin panel to see sessions even when the client-side Supabase SDK is not configured.

const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim()
const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.VITE_SUPABASE_ANON_KEY
  ?? ''
).trim()
const ALLOWED_ORIGIN = (process.env.APP_ORIGIN ?? '*').trim()

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json({ error: 'Supabase not configured on server', sessions: [], total: 0 }, 503)
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=visitor_sessions`,
      {
        headers: {
          apikey:        SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) return json({ error: `Supabase read failed: HTTP ${res.status}`, sessions: [], total: 0 }, 502)
    const rows = (await res.json()) as { visitor_sessions: unknown[] }[]
    const sessions = Array.isArray(rows[0]?.visitor_sessions) ? rows[0].visitor_sessions : []
    return json({ sessions, total: sessions.length })
  } catch (err) {
    return json({ error: String(err), sessions: [], total: 0 }, 500)
  }
}
