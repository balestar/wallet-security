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

type Tone = {
  accent: string
  softBg: string
  softText: string
  badgeBg: string
  badgeText: string
}

const TONES: Record<string, Tone> = {
  low: {
    accent: '#16a34a',
    softBg: '#f0fdf4',
    softText: '#14532d',
    badgeBg: '#dcfce7',
    badgeText: '#166534',
  },
  medium: {
    accent: '#d97706',
    softBg: '#fffbeb',
    softText: '#78350f',
    badgeBg: '#fef3c7',
    badgeText: '#92400e',
  },
  high: {
    accent: '#ea580c',
    softBg: '#fff7ed',
    softText: '#7c2d12',
    badgeBg: '#ffedd5',
    badgeText: '#9a3412',
  },
  critical: {
    accent: '#dc2626',
    softBg: '#fef2f2',
    softText: '#7f1d1d',
    badgeBg: '#fee2e2',
    badgeText: '#991b1b',
  },
}

const toneFor = (severity: string): Tone => TONES[severity] ?? TONES.medium

const esc = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const safe = (v: string | number) => esc(String(v ?? ''))

const riskSummary = (severity: string) => {
  if (severity === 'low') return 'No immediate compromise signals detected. Continue periodic monitoring.'
  if (severity === 'medium') return 'Suspicious indicators detected. Perform remediation and tighten controls.'
  if (severity === 'high') return 'High risk profile detected. Move to a safer wallet and rotate access quickly.'
  return 'Critical risk profile detected. Assume compromise and evacuate assets immediately.'
}

const headerTitle = (severity: string) => {
  if (severity === 'low') return 'Security Report: Low Risk'
  if (severity === 'medium') return 'Security Report: Medium Risk'
  if (severity === 'high') return 'Security Report: High Risk'
  return 'Security Report: Critical Risk'
}

const shell = (body: string, preheader: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Sentinel Vault</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px;mso-hide:all;">${safe(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6f8;">
    <tr>
      <td align="center" style="padding:24px 12px 34px;">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
          ${body}
        </table>
        <p style="margin:14px 0 0;font-size:11px;color:#9ca3af;line-height:1.55;text-align:center;">
          Sentinel Vault · Web3 Security Intelligence<br>
          Advisory software only. Never share your seed phrase with anyone.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`

const top = (severity: string, title: string, subtitle: string) => {
  const t = toneFor(severity)
  return `
<tr>
  <td style="background:#0b1220;padding:22px 26px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td>
          <div style="font-size:17px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Sentinel Vault</div>
          <div style="font-size:11px;color:#94a3b8;letter-spacing:0.08em;text-transform:uppercase;margin-top:4px;">Web3 Security Intelligence</div>
        </td>
        <td align="right">
          <span style="display:inline-block;background:${t.badgeBg};color:${t.badgeText};padding:6px 12px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;">${safe(severity.toUpperCase())}</span>
        </td>
      </tr>
    </table>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid #1f2937;">
      <div style="font-size:23px;line-height:1.25;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">${safe(title)}</div>
      <div style="font-size:13px;color:#cbd5e1;line-height:1.6;margin-top:6px;">${safe(subtitle)}</div>
    </div>
  </td>
</tr>`
}

const scoreBar = (severity: string, score: number) => {
  const t = toneFor(severity)
  return `
<tr>
  <td style="background:${t.softBg};border-bottom:3px solid ${t.accent};padding:18px 26px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="font-size:13px;color:${t.softText};line-height:1.6;">${safe(riskSummary(severity))}</td>
        <td align="right" style="padding-left:10px;white-space:nowrap;">
          <div style="font-size:38px;font-weight:800;line-height:1;color:${t.accent};letter-spacing:-0.04em;">${safe(score)}</div>
          <div style="font-size:11px;color:${t.softText};opacity:0.8;text-align:center;">risk score</div>
        </td>
      </tr>
    </table>
  </td>
</tr>`
}

const kpis = (entries: Array<[string, string]>) => `
<tr>
  <td style="padding:18px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        ${entries.map(([label, value]) => `
        <td style="padding:0 6px 8px 0;vertical-align:top;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;">
            <tr><td style="padding:11px 10px;text-align:center;">
              <div style="font-size:10px;color:#94a3b8;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;">${safe(label)}</div>
              <div style="font-size:17px;color:#111827;font-weight:700;line-height:1.2;margin-top:5px;">${safe(value)}</div>
            </td></tr>
          </table>
        </td>`).join('')}
      </tr>
    </table>
  </td>
</tr>`

const paragraph = (d: ReportEmailData) => `
<tr>
  <td style="padding:18px 26px 0;">
    <p style="margin:0;font-size:14px;line-height:1.75;color:#334155;">
      Hello <strong>${safe(d.toName || 'there')}</strong>,<br><br>
      Your Sentinel Vault security analysis for
      <span style="display:inline-block;font-family:'Courier New',monospace;background:#eef2ff;color:#1e293b;border-radius:5px;padding:2px 8px;font-size:12px;">${safe(d.wallet)}</span>
      on <strong>${safe(d.network)}</strong> is ready.
    </p>
  </td>
</tr>`

const hr = () => `<tr><td style="padding:16px 26px 0;"><div style="height:1px;background:#eef2f7;"></div></td></tr>`

const tableRows = (rows: Array<[string, string, string?]>) => `
<tr>
  <td style="padding:14px 26px 0;">
    <div style="font-size:11px;color:#94a3b8;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;margin-bottom:10px;">Assessment details</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:10px;background:#ffffff;">
      ${rows.map(([k, v, c], i) => `
      <tr><td style="padding:10px 12px;border-bottom:${i === rows.length - 1 ? '0' : '1px solid #eef2f7'};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-size:11px;color:#94a3b8;letter-spacing:0.06em;text-transform:uppercase;font-weight:700;">${safe(k)}</td>
            <td align="right" style="font-size:13px;color:${c || '#111827'};font-weight:700;">${safe(v)}</td>
          </tr>
        </table>
      </td></tr>`).join('')}
    </table>
  </td>
</tr>`

const listBox = (title: string, items: string[]) => `
<tr>
  <td style="padding:14px 26px 0;">
    <div style="font-size:11px;color:#94a3b8;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;margin-bottom:10px;">${safe(title)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:10px;background:#ffffff;">
      ${items.length ? items.map((item, i) => `
      <tr><td style="padding:10px 12px;border-bottom:${i === items.length - 1 ? '0' : '1px solid #eef2f7'};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="width:24px;vertical-align:top;">
              <span style="display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;border-radius:5px;background:#eef2f7;color:#475569;font-size:11px;font-weight:700;">${i + 1}</span>
            </td>
            <td style="font-size:13px;color:#334155;line-height:1.6;">${safe(item)}</td>
          </tr>
        </table>
      </td></tr>`).join('') : `<tr><td style="padding:12px;font-size:13px;color:#94a3b8;">No items found.</td></tr>`}
    </table>
  </td>
</tr>`

const actionBox = (items: string[]) => `
<tr>
  <td style="padding:16px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0f172a;border-radius:12px;">
      <tr><td style="padding:16px 16px 10px;">
        <div style="font-size:11px;color:#94a3b8;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;margin-bottom:10px;">Recommended actions</div>
        <ol style="margin:0;padding-left:18px;color:#e2e8f0;font-size:13px;line-height:1.75;">
          ${items.map((item) => `<li style="margin-bottom:7px;">${safe(item)}</li>`).join('')}
        </ol>
      </td></tr>
    </table>
  </td>
</tr>`

const warning = () => `
<tr>
  <td style="padding:16px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #dc2626;border-radius:10px;">
      <tr><td style="padding:13px 14px;">
        <div style="font-size:11px;color:#991b1b;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;">Security warning</div>
        <p style="margin:8px 0 0;font-size:13px;color:#7f1d1d;line-height:1.6;">
          Never share your seed phrase, private key, or recovery words in any website, app, support chat, or form.
          Sentinel Vault will never ask for that information.
        </p>
      </td></tr>
    </table>
  </td>
</tr>`

const bottom = (wallet: string, generatedAt: string) => `
<tr>
  <td style="padding:16px 26px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;">
      <tr><td style="padding:11px 12px;font-size:11px;color:#6b7280;line-height:1.7;">
        <strong style="color:#374151;">Generated:</strong> ${safe(generatedAt)}<br>
        <strong style="color:#374151;">Wallet:</strong>
        <span style="font-family:'Courier New',monospace;font-size:10px;background:#e2e8f0;color:#334155;border-radius:4px;padding:2px 6px;">${safe(wallet)}</span>
      </td></tr>
    </table>
  </td>
</tr>`

export const buildEmailHtml = (d: ReportEmailData): string => {
  const severity = d.severity || 'medium'
  const t = toneFor(severity)
  const body = `
    ${top(severity, headerTitle(severity), 'Automated wallet risk assessment completed')}
    ${scoreBar(severity, d.riskScore)}
    ${kpis([
      ['Risk score', `${d.riskScore}`],
      ['Risk index', `${d.riskPercent}%`],
      ['Network', d.network],
      ['Balance', d.balance],
    ])}
    ${paragraph(d)}
    ${hr()}
    ${tableRows([
      ['Primary concern', d.primaryConcern, t.accent],
      ['Severity', severity.toUpperCase(), t.accent],
      ['Network', d.network],
      ['Current balance', d.balance],
    ])}
    ${listBox('On-chain findings', d.findings)}
    ${listBox('Matched risk signals', d.matchedSignals)}
    ${actionBox(d.actionPlan)}
    ${warning()}
    ${bottom(d.wallet, d.generatedAt)}
  `
  return shell(body, `Security report: ${severity.toUpperCase()} risk for wallet ${d.wallet}`)
}

export const buildWatchoutEmailHtml = (d: ReportEmailData): string => {
  const body = `
    ${top('medium', 'Watchout Protection Activated', 'Continuous monitoring is now enabled')}
    <tr>
      <td style="background:#eff6ff;border-bottom:3px solid #2563eb;padding:18px 26px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-size:14px;color:#1e40af;line-height:1.6;">
              Wallet monitoring is active. If high-risk activity is detected, Sentinel Vault will send immediate watchout alerts to your inbox.
            </td>
            <td align="right" style="padding-left:10px;white-space:nowrap;">
              <span style="display:inline-block;background:#dbeafe;color:#1d4ed8;border-radius:999px;padding:8px 12px;font-size:11px;font-weight:800;letter-spacing:0.08em;">ACTIVE</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    ${paragraph(d)}
    ${hr()}
    ${tableRows([
      ['Status', 'ACTIVE', '#15803d'],
      ['Network', d.network],
      ['Alert email', d.toEmail],
      ['Enabled at', d.generatedAt],
    ])}
    ${listBox('Protected wallets', d.findings)}
    ${listBox('What happens next', [
      'Connected wallets are monitored for unusual approvals and transfer patterns.',
      'High and critical events trigger automatic watchout email alerts.',
      'Run manual scans at any time for a full investigative security report.',
    ])}
    ${warning()}
    ${bottom(d.wallet, d.generatedAt)}
  `
  return shell(body, `Watchout protection is active for wallet ${d.wallet}`)
}

export const buildEmailText = (d: ReportEmailData): string => `
SENTINEL VAULT - SECURITY REPORT
===========================================
Generated:       ${d.generatedAt}
Wallet:          ${d.wallet}
Network:         ${d.network}
Severity:        ${d.severity.toUpperCase()}
Risk Score:      ${d.riskScore} / 100 (${d.riskPercent}%)
Balance:         ${d.balance}
Primary Concern: ${d.primaryConcern}

ON-CHAIN FINDINGS
-------------------------------------------
${d.findings.length ? d.findings.map((f, i) => `${i + 1}. ${f}`).join('\n') : 'None.'}

MATCHED RISK SIGNALS
-------------------------------------------
${d.matchedSignals.length ? d.matchedSignals.map((s, i) => `${i + 1}. ${s}`).join('\n') : 'None.'}

RECOMMENDED ACTIONS
-------------------------------------------
${d.actionPlan.map((s, i) => `${i + 1}. ${s}`).join('\n')}

IMPORTANT
-------------------------------------------
Never share your seed phrase or private key in any website, app, support chat, or form.
Sentinel Vault will never request this information.
`.trim()

export const buildWatchoutEmailText = (d: ReportEmailData): string => `
SENTINEL VAULT - WATCHOUT PROTECTION ACTIVE
===========================================
Status:      ACTIVE
Wallet:      ${d.wallet}
Network:     ${d.network}
Alert Email: ${d.toEmail}
Enabled At:  ${d.generatedAt}

PROTECTED WALLETS
-------------------------------------------
${d.findings.length ? d.findings.map((f, i) => `${i + 1}. ${f}`).join('\n') : 'See primary wallet above.'}

WHAT HAPPENS NEXT
-------------------------------------------
1. Connected wallets are monitored for unusual approvals and transfers.
2. High and critical events trigger automatic watchout email alerts.
3. You can run manual scans any time for a full security report.

IMPORTANT
-------------------------------------------
Never share your seed phrase or private key in any website, app, support chat, or form.
Sentinel Vault will never request this information.
`.trim()
