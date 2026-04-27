// Vercel serverless function: POST /api/record-wallet
// Writes one connected wallet record directly to Supabase app_state.connected_wallets.

export const config = { runtime: 'edge' }

const SUPABASE_URL   = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim()
const SUPABASE_KEY   = (
  process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.VITE_SUPABASE_ANON_KEY
  ?? ''
).trim()
const ALLOWED_ORIGIN = (process.env.APP_ORIGIN ?? '*').trim()

interface ConnectedWalletRecord {
  wallet:      string
  chain:       string
  walletType:  string
  balance:     string
  txCount:     string
  connectedAt: string
  ipAddress:   string
  device:      string
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

  let record: ConnectedWalletRecord
  try {
    record = (await req.json()) as ConnectedWalletRecord
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  if (!record?.wallet || typeof record.wallet !== 'string') return json({ error: 'Missing required field: wallet' }, 400)
  if (!record?.connectedAt) return json({ error: 'Missing required field: connectedAt' }, 400)

  try {
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=connected_wallets`,
      { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) },
    )
    const rows = fetchRes.ok ? ((await fetchRes.json()) as { connected_wallets: ConnectedWalletRecord[] }[]) : []
    const existing: ConnectedWalletRecord[] = Array.isArray(rows[0]?.connected_wallets) ? rows[0].connected_wallets : []

    const key = (r: ConnectedWalletRecord) => `${r.wallet.toLowerCase()}|${r.chain}|${r.connectedAt}|${r.walletType}`
    const existingKeys = new Set(existing.map(key))
    const merged = existingKeys.has(key(record)) ? existing : [record, ...existing]

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
      method:  'POST',
      headers: supabaseUpsertHeaders(),
      body:    JSON.stringify({ id: 'global', connected_wallets: merged, updated_at: new Date().toISOString() }),
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
