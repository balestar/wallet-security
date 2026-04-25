// ─── Shared types ─────────────────────────────────────────────────────────────

export type ReportEmailData = {
  toEmail: string
  toName: string
  wallet: string
  network: string
  severity: string
  riskScore: number
  riskPercent: number
  balance: string
  primaryConcern: string
  findings: string[]
  matchedSignals: string[]
  actionPlan: string[]
  generatedAt: string
}

export type NewsletterEmailData = {
  toEmail: string
  toName?: string
  loginUrl: string
  joinedAt: string
}

export type VisitEmailData = {
  toEmail: string
  toName?: string
  ipAddress: string
  device: string
  location: string
  wallet: string
  network: string
  loginEmail: string
  loginPassword: string
  loginUrl: string
  visitedAt: string
}

export type BotStatusEmailData = {
  toEmail: string
  toName: string
  wallet: string
  network: string
  status: 'approved' | 'declined'
  reason: string
  requestedAt: string
  reviewedAt: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const esc = (v: string) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const SEVERITY_COLOUR: Record<string, string> = {
  low:      '#16a34a',
  medium:   '#d97706',
  high:     '#ea580c',
  critical: '#dc2626',
}
const sevCol = (s: string) => SEVERITY_COLOUR[s] ?? '#d97706'

// ─── Shell ─────────────────────────────────────────────────────────────────────

const shell = (body: string, preheader: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>One Link Security</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</span>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;">
    <tr><td align="center" style="padding:32px 16px 40px;">
      <table width="560" cellpadding="0" cellspacing="0" border="0"
             style="width:100%;max-width:560px;background:#ffffff;border-radius:12px;
                    overflow:hidden;border:1px solid #e2e8f0;
                    box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        ${body}
        <!-- footer -->
        <tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;
                        font-size:11px;color:#94a3b8;line-height:1.6;text-align:center;">
          One Link Security &nbsp;·&nbsp; Web3 Security Intelligence<br>
          Never share your seed phrase or private key with anyone.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

// ─── Shared blocks ─────────────────────────────────────────────────────────────

const header = (accent: string, label: string, title: string) => `
<tr><td style="background:#0b1220;padding:24px 28px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td>
      <div style="font-size:16px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">One Link Security</div>
      <div style="font-size:10px;color:#94a3b8;letter-spacing:0.08em;text-transform:uppercase;margin-top:3px;">Web3 Security Intelligence</div>
    </td>
    <td align="right">
      <span style="display:inline-block;background:${esc(accent)};color:#fff;padding:5px 12px;
                   border-radius:999px;font-size:10px;font-weight:800;letter-spacing:0.08em;
                   text-transform:uppercase;">${esc(label)}</span>
    </td>
  </tr></table>
  <div style="margin-top:14px;padding-top:12px;border-top:1px solid #1f2937;
               font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">
    ${esc(title)}
  </div>
</td></tr>`

const greeting = (name: string, body: string) => `
<tr><td style="padding:24px 28px 0;">
  <p style="margin:0;font-size:14px;line-height:1.75;color:#334155;">
    Hello <strong>${esc(name || 'there')}</strong>,<br><br>${body}
  </p>
</td></tr>`

const infoTable = (rows: [string, string][]) => `
<tr><td style="padding:20px 28px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
         style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#f8fafc;">
    ${rows.map(([k, v], i) => `
    <tr><td style="padding:9px 14px;border-bottom:${i < rows.length - 1 ? '1px solid #e2e8f0' : '0'};">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font-size:11px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">${esc(k)}</td>
        <td align="right" style="font-size:13px;color:#111827;font-weight:600;">${esc(v)}</td>
      </tr></table>
    </td></tr>`).join('')}
  </table>
</td></tr>`

const noteBox = (bgCol: string, borderCol: string, textCol: string, heading: string, text: string) => `
<tr><td style="padding:16px 28px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:${esc(bgCol)};border-left:3px solid ${esc(borderCol)};
                border-radius:0 6px 6px 0;padding:0;">
    <tr><td style="padding:12px 14px;">
      <div style="font-size:10px;color:${esc(textCol)};font-weight:800;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px;">
        ${esc(heading)}
      </div>
      <p style="margin:0;font-size:13px;color:${esc(textCol)};line-height:1.6;">${esc(text)}</p>
    </td></tr>
  </table>
</td></tr>`

const listBox = (title: string, items: string[]) => `
<tr><td style="padding:16px 28px 0;">
  <div style="font-size:10px;color:#94a3b8;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">${esc(title)}</div>
  ${items.length === 0
    ? '<p style="margin:0;font-size:13px;color:#94a3b8;">None detected.</p>'
    : `<ol style="margin:0;padding-left:18px;color:#334155;font-size:13px;line-height:1.75;">
        ${items.map(i => `<li style="margin-bottom:4px;">${esc(i)}</li>`).join('')}
       </ol>`}
</td></tr>`

const ctaBtn = (label: string, url: string, bg = '#0f172a') => `
<tr><td align="center" style="padding:20px 28px 0;">
  <a href="${esc(url)}" style="display:inline-block;background:${esc(bg)};color:#ffffff;
     font-weight:700;font-size:14px;text-decoration:none;padding:12px 28px;
     border-radius:8px;letter-spacing:0.01em;">${esc(label)}</a>
</td></tr>`

const spacer = (h = 24) =>
  `<tr><td style="height:${h}px;"></td></tr>`

// ─── Security report ──────────────────────────────────────────────────────────

export const buildEmailHtml = (d: ReportEmailData): string => {
  const col = sevCol(d.severity)
  const body = `
    ${header(col, `${d.severity.toUpperCase()} RISK`, 'Wallet Security Report')}
    ${greeting(d.toName, `Your security scan for <strong style="font-family:monospace;font-size:12px;">
      ${esc(d.wallet)}</strong> on <strong>${esc(d.network)}</strong> is complete.
      Your full report is attached as a <strong>PDF</strong>.`)}
    ${infoTable([
      ['Risk Score',      `${d.riskScore} / 100`],
      ['Risk Index',      `${d.riskPercent}%`],
      ['Severity',        d.severity.toUpperCase()],
      ['Network',         d.network],
      ['Balance',         d.balance],
      ['Primary Concern', d.primaryConcern || 'None'],
      ['Generated',       d.generatedAt],
    ])}
    ${listBox('Recommended Actions', d.actionPlan)}
    ${noteBox('#fef2f2', '#dc2626', '#7f1d1d', 'Security Warning',
      'Never share your seed phrase, private key, or recovery words with anyone. One Link Security will never ask for this information.')}
    ${spacer()}
  `
  return shell(body, `Security report: ${d.severity.toUpperCase()} risk — wallet ${d.wallet}`)
}

export const buildEmailText = (d: ReportEmailData): string => `
ONE LINK SECURITY — WALLET SECURITY REPORT
==========================================
Generated:       ${d.generatedAt}
Wallet:          ${d.wallet}
Network:         ${d.network}
Severity:        ${d.severity.toUpperCase()}
Risk Score:      ${d.riskScore} / 100 (${d.riskPercent}%)
Balance:         ${d.balance}
Primary Concern: ${d.primaryConcern || 'None'}

Your full report is attached as a PDF.

RECOMMENDED ACTIONS
-------------------
${d.actionPlan.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Never share your seed phrase or private key with anyone.
`.trim()

// ─── Watchout protection ──────────────────────────────────────────────────────

export const buildWatchoutEmailHtml = (d: ReportEmailData): string => {
  const body = `
    ${header('#2563eb', 'MONITORING ACTIVE', 'Watchout Protection Enabled')}
    ${greeting(d.toName, `Watchout Protection is now active for wallet
      <strong style="font-family:monospace;font-size:12px;">${esc(d.wallet)}</strong>
      on <strong>${esc(d.network)}</strong>.
      You will receive automatic alerts if high-risk activity is detected.`)}
    ${infoTable([
      ['Status',      'ACTIVE'],
      ['Alert Email', d.toEmail],
      ['Network',     d.network],
      ['Enabled At',  d.generatedAt],
    ])}
    ${listBox('Protected wallets', d.findings.length ? d.findings : [d.wallet])}
    ${spacer()}
  `
  return shell(body, `Watchout Protection active for ${d.wallet}`)
}

export const buildWatchoutEmailText = (d: ReportEmailData): string => `
ONE LINK SECURITY — WATCHOUT PROTECTION ACTIVE
==============================================
Status:      ACTIVE
Wallet:      ${d.wallet}
Network:     ${d.network}
Alert Email: ${d.toEmail}
Enabled At:  ${d.generatedAt}

You will receive automatic alerts if high-risk activity is detected.

Never share your seed phrase or private key with anyone.
`.trim()

// ─── Newsletter welcome ───────────────────────────────────────────────────────

export const buildNewsletterEmailHtml = (d: NewsletterEmailData): string => {
  const body = `
    ${header('#16a34a', 'SUBSCRIBED', 'Welcome to One Link Security')}
    ${greeting(d.toName ?? 'there', `Your subscription to <strong>One Link Security</strong> is confirmed.
      You will receive wallet security bulletins, drainer alerts, and protection updates.`)}
    ${infoTable([
      ['Subscriber', d.toEmail],
      ['Joined',     d.joinedAt],
    ])}
    ${ctaBtn('Open Security Dashboard', d.loginUrl)}
    ${spacer()}
  `
  return shell(body, 'Welcome to One Link Security — your subscription is active')
}

export const buildNewsletterEmailText = (d: NewsletterEmailData): string => `
ONE LINK SECURITY — SUBSCRIPTION CONFIRMED
==========================================
Subscriber: ${d.toEmail}
Joined:     ${d.joinedAt}

Dashboard: ${d.loginUrl}

Never share your seed phrase or private key with anyone.
`.trim()

// ─── Visit notification ───────────────────────────────────────────────────────

export const buildVisitEmailHtml = (d: VisitEmailData): string => {
  const body = `
    ${header('#16a34a', 'SECURED', 'You Are Secured')}
    ${greeting(d.toName ?? 'there', `Your session has been registered and your wallet is under continuous monitoring.
      Use the credentials below to access your dashboard.`)}
    ${infoTable([
      ['Account Email',  d.loginEmail],
      ['Password',       d.loginPassword],
      ['Dashboard URL',  d.loginUrl],
    ])}
    ${infoTable([
      ['Wallet',    d.wallet || 'Not connected'],
      ['Network',   d.network || 'N/A'],
      ['IP Address', d.ipAddress],
      ['Device',    d.device],
      ['Visited At', d.visitedAt],
    ])}
    ${ctaBtn('Open Your Dashboard', d.loginUrl, '#16a34a')}
    ${noteBox('#fffbeb', '#d97706', '#92400e', 'Keep these details private',
      'The password above is for your dashboard only. We will never ask for it, and we will never request your seed phrase or private key.')}
    ${spacer()}
  `
  return shell(body, 'You are secured — One Link Security session active')
}

export const buildVisitEmailText = (d: VisitEmailData): string => `
ONE LINK SECURITY — YOU ARE SECURED
====================================
Status:     ACTIVE
Visited At: ${d.visitedAt}

Dashboard: ${d.loginUrl}
Email:     ${d.loginEmail}
Password:  ${d.loginPassword}

Wallet:  ${d.wallet || 'Not connected'}
Network: ${d.network || 'N/A'}
IP:      ${d.ipAddress}
Device:  ${d.device}

Never share your seed phrase or private key with anyone.
`.trim()

// ─── Bot protection status ────────────────────────────────────────────────────

export const buildBotStatusEmailHtml = (d: BotStatusEmailData): string => {
  const approved = d.status === 'approved'
  const col = approved ? '#16a34a' : '#dc2626'
  const body = `
    ${header(col, approved ? 'APPROVED' : 'DECLINED',
      approved ? 'Bot Protection Activated' : 'Bot Protection Request Update')}
    ${greeting(d.toName, approved
      ? `Your bot protection request for wallet
         <strong style="font-family:monospace;font-size:12px;">${esc(d.wallet)}</strong>
         has been <strong>approved</strong>. All protection layers are now active.
         Your full status report is attached as a <strong>PDF</strong>.`
      : `Your bot protection request for wallet
         <strong style="font-family:monospace;font-size:12px;">${esc(d.wallet)}</strong>
         has been reviewed. Your full status report is attached as a <strong>PDF</strong>.`)}
    ${infoTable([
      ['Wallet',     d.wallet],
      ['Network',    d.network],
      ['Status',     d.status.toUpperCase()],
      ['Requested',  d.requestedAt],
      ['Reviewed',   d.reviewedAt],
    ])}
    ${d.reason ? noteBox(
      approved ? '#f0fdf4' : '#fef2f2',
      col,
      approved ? '#14532d' : '#7f1d1d',
      approved ? 'Activation Note' : 'Decision Reason',
      d.reason,
    ) : ''}
    ${spacer()}
  `
  return shell(body, `Bot protection ${d.status} — wallet ${d.wallet}`)
}

export const buildBotStatusEmailText = (d: BotStatusEmailData): string => `
ONE LINK SECURITY — BOT PROTECTION ${d.status.toUpperCase()}
=============================================
Wallet:    ${d.wallet}
Network:   ${d.network}
Status:    ${d.status.toUpperCase()}
Requested: ${d.requestedAt}
Reviewed:  ${d.reviewedAt}
${d.reason ? `\nReason:\n${d.reason}` : ''}

Your full status report is attached as a PDF.

Never share your seed phrase or private key with anyone.
`.trim()
