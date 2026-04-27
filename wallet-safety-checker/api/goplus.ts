// Vercel serverless function: GET /api/goplus?address=0x...&chainId=1
// Proxies GoPlus address_security API server-side to avoid CORS and rate-limit issues.
// Optionally uses VITE_GOPLUS_ACCESS_TOKEN (set without the VITE_ prefix for server use too,
// or use a dedicated GOPLUS_ACCESS_TOKEN env var).

export const config = { runtime: 'edge' }

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1'

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const url = new URL(req.url)
  const address = (url.searchParams.get('address') ?? '').trim()
  const chainId = (url.searchParams.get('chainId') ?? '').trim()

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return json({ error: 'Invalid or missing address' }, 400)
  }
  if (!chainId || !/^\d+$/.test(chainId)) {
    return json({ error: 'Invalid or missing chainId' }, 400)
  }

  const token = (process.env.GOPLUS_ACCESS_TOKEN ?? process.env.VITE_GOPLUS_ACCESS_TOKEN ?? '').trim()
  const headers: HeadersInit = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    const upstream = await fetch(
      `${GOPLUS_BASE}/address_security/${address}?chain_id=${chainId}`,
      { headers, signal: AbortSignal.timeout(8000) },
    )

    const text = await upstream.text()
    let data: unknown = null
    try { data = JSON.parse(text) } catch { /* keep null */ }

    if (!upstream.ok) {
      return json(
        { error: `GoPlus responded with ${upstream.status}`, details: data ?? text },
        upstream.status >= 500 ? 502 : 400,
      )
    }

    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upstream fetch failed'
    return json({ error: msg }, 502)
  }
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
