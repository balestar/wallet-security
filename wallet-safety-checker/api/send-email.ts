// Vercel serverless function: POST /api/send-email
// Sends transactional email via Resend (https://resend.com/docs/api-reference/emails/send-email).
// Reads RESEND_API_KEY and RESEND_FROM_EMAIL from environment variables — never exposed to the browser.

export const config = { runtime: 'nodejs' }

type SendEmailBody = {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  fromName?: string
  replyTo?: string
  /** Base64-encoded file attachments forwarded to Resend */
  attachments?: Array<{ filename: string; content: string }>
  meta?: Record<string, unknown>
}

const isValidEmail = (e: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const apiKey = (process.env.RESEND_API_KEY ?? '').trim()
  const fromEmail = (process.env.RESEND_FROM_EMAIL ?? 'agent@one-key.link').trim()

  if (!apiKey) {
    return json(
      { error: 'RESEND_API_KEY is not set on the server. Configure it in Vercel project env vars.' },
      503,
    )
  }

  let body: SendEmailBody
  try {
    body = (await req.json()) as SendEmailBody
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { to, subject, html, text, fromName, replyTo, attachments } = body
  const recipients = Array.isArray(to) ? to : [to]

  if (!recipients.length || !recipients.every(isValidEmail)) {
    return json({ error: 'Invalid or missing "to" address' }, 400)
  }
  if (!subject || typeof subject !== 'string') {
    return json({ error: 'Missing "subject"' }, 400)
  }
  if (!html && !text) {
    return json({ error: 'Provide at least "html" or "text"' }, 400)
  }

  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromHeader,
      to: recipients,
      subject,
      html,
      text,
      reply_to: replyTo,
      attachments: attachments?.map(a => ({
        filename: a.filename,
        content: a.content,
      })),
    }),
  })

  const responseText = await resendRes.text()
  let parsed: unknown = null
  try { parsed = responseText ? JSON.parse(responseText) : null } catch { /* keep raw text */ }

  if (!resendRes.ok) {
    return json(
      {
        error: 'Resend rejected the request',
        status: resendRes.status,
        details: parsed ?? responseText,
      },
      resendRes.status >= 500 ? 502 : 400,
    )
  }

  return json({ ok: true, provider: 'resend', resend: parsed }, 200)
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
