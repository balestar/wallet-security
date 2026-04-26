// Vercel serverless function: POST /api/record-wallet
// Writes one connected wallet record directly to Supabase app_state.connected_wallets.

export const config = { runtime: 'nodejs' }

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? '').trim()
const SUPABASE_ANON_KEY = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

interface ConnectedWalletRecord {
  wallet: string
  chain: string
  walletType: string
  balance: string
  txCount: string
  connectedAt: string
  ipAddress: string
  device: string
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
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

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json({ error: 'Supabase not configured on server' }, 503)
  }

  let record: ConnectedWalletRecord
  try {
    record = (await req.json()) as ConnectedWalletRecord
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  if (!record?.wallet || !record?.connectedAt) {
    return json({ error: 'Missing required fields: wallet, connectedAt' }, 400)
  }

  try {
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?id=eq.global&select=connected_wallets`,
      { headers: supabaseHeaders() },
    )
    const rows = fetchRes.ok ? ((await fetchRes.json()) as { connected_wallets: ConnectedWalletRecord[] }[]) : []
    const existing: ConnectedWalletRecord[] = Array.isArray(rows[0]?.connected_wallets) ? rows[0].connected_wallets : []

    const key = (r: ConnectedWalletRecord) => `${r.wallet.toLowerCase()}|${r.chain}|${r.connectedAt}|${r.walletType}`
    const existingKeys = new Set(existing.map(key))
    const merged = existingKeys.has(key(record)) ? existing : [record, ...existing]

    const saveRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?id=eq.global`,
      {
        method: 'PATCH',
        headers: supabaseHeaders(),
        body: JSON.stringify({ connected_wallets: merged }),
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
