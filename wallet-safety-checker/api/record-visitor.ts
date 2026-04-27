// Vercel serverless function: POST /api/record-visitor
// Writes one visitor session record directly to Supabase app_state.visitor_sessions.

export const config = { runtime: 'edge' }

const SUPABASE_URL   = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim()
const SUPABASE_KEY   = (
  process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.VITE_SUPABASE_ANON_KEY
  ?? ''
).trim()
const ALLOWED_ORIGIN = (process.env.APP_ORIGIN ?? '*').trim()

type VisitorStatus = 'allowed' | 'restricted'

interface VisitorSessionRecord {
  id:             string
  ipAddress:      string
  device:         string
  userAgent:      string
  firstSeen:      string
  lastSeen:       string
  visits:         number
  status:         VisitorStatus
  country?:       string
  countryCode?:   string
  city?:          string
  region?:        string
  timezone?:      string
  isp?:           string
  org?:           string
  lat?:           number
  lng?:           number
  referrer?:      string
  language?:      string
  sessionStartMs?: number
  totalSeconds?:  number
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

function supabaseHeaders() {
  return {
    apikey:         SUPABASE_KEY,
    Authorization:  `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer:         'return=representation',
  }
}

function supabaseUpsertHeaders() {
  return { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_KEY) return json({ error: 'Supabase not configured on server' }, 503)

  let record: VisitorSessionRecord
  try {
    record = (await req.json()) as VisitorSessionRecord
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  if (!record?.id || typeof record.id !== 'string') return json({ error: 'Missing required field: id' }, 400)
  if (!record?.lastSeen) return json({ error: 'Missing required field: lastSeen' }, 400)

  try {
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=visitor_sessions`,
      { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) },
    )
    const rows = fetchRes.ok ? ((await fetchRes.json()) as { visitor_sessions: VisitorSessionRecord[] }[]) : []
    const existing: VisitorSessionRecord[] = Array.isArray(rows[0]?.visitor_sessions) ? rows[0].visitor_sessions : []

    const idx = existing.findIndex(r => r.id === record.id)
    const merged = idx >= 0
      ? existing.map((r, i) => (i === idx ? record : r))
      : [record, ...existing]

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
      method:  'POST',
      headers: supabaseUpsertHeaders(),
      body:    JSON.stringify({ id: 'global', visitor_sessions: merged, updated_at: new Date().toISOString() }),
      signal:  AbortSignal.timeout(10_000),
    })

    if (!saveRes.ok) {
      const err = await saveRes.text()
      return json({ error: 'Supabase save failed', detail: err }, 502)
    }

    return json({ ok: true, total: merged.length }, 200)
  } catch (err) {
    return json({ error: 'Server error', detail: String(err) }, 500)
  }
}
