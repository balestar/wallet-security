import { jsPDF } from 'jspdf'

// ─── Colour palette ──────────────────────────────────────────────────────────
const DARK   = [11,  18,  32]  as const  // #0b1220
const WHITE  = [255, 255, 255] as const
const MUTED  = [100, 116, 139] as const  // slate-500
const BORDER = [226, 232, 240] as const  // slate-200
const BG     = [248, 250, 252] as const  // slate-50

const SEVERITY_COLOUR: Record<string, [number, number, number]> = {
  low:      [22,  163, 74],   // green-600
  medium:   [217, 119,  6],   // amber-600
  high:     [234,  88, 12],   // orange-600
  critical: [220,  38, 38],   // red-600
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function rgb(doc: jsPDF, col: readonly [number, number, number]) {
  doc.setTextColor(col[0], col[1], col[2])
}

function fillRect(
  doc: jsPDF,
  x: number, y: number, w: number, h: number,
  col: readonly [number, number, number],
) {
  doc.setFillColor(col[0], col[1], col[2])
  doc.rect(x, y, w, h, 'F')
}

function splitLines(doc: jsPDF, text: string, maxWidth: number): string[] {
  return doc.splitTextToSize(text, maxWidth) as string[]
}

const PW = 210  // A4 width mm
const PH = 297  // A4 height mm
const ML = 18   // left margin
const MR = 18   // right margin
const IW = PW - ML - MR  // inner width

// ─── Public API ──────────────────────────────────────────────────────────────

export type SecurityReportPdfData = {
  wallet:        string
  network:       string
  severity:      string
  riskScore:     number
  riskPercent:   number
  balance:       string
  primaryConcern: string
  findings:      string[]
  matchedSignals: string[]
  actionPlan:    string[]
  generatedAt:   string
  toName?:       string
}

export type BotStatusPdfData = {
  wallet:      string
  network:     string
  status:      'approved' | 'declined'
  reason:      string
  requestedAt: string
  reviewedAt:  string
  toName?:     string
}

/** Returns the raw base64 string (no data-uri prefix). */
export function generateSecurityReportPdf(d: SecurityReportPdfData): string {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const sevCol = SEVERITY_COLOUR[d.severity] ?? SEVERITY_COLOUR.medium
  let y = 0

  // ── Header bar ────────────────────────────────────────────────────────────
  fillRect(doc, 0, 0, PW, 28, DARK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  rgb(doc, WHITE)
  doc.text('One Link Security', ML, 12)
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  rgb(doc, [148, 163, 184])
  doc.text('Web3 Security Intelligence', ML, 18)
  // severity badge
  fillRect(doc, PW - MR - 36, 7, 36, 10, sevCol)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  rgb(doc, WHITE)
  doc.text(d.severity.toUpperCase() + ' RISK', PW - MR - 18, 13.5, { align: 'center' })

  y = 36

  // ── Title ─────────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  rgb(doc, DARK)
  doc.text('Wallet Security Report', ML, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  rgb(doc, MUTED)
  doc.text(`Generated: ${d.generatedAt}`, ML, y)
  y += 10

  // ── Risk score block ──────────────────────────────────────────────────────
  fillRect(doc, ML, y, IW, 24, BG)
  doc.setDrawColor(sevCol[0], sevCol[1], sevCol[2])
  doc.setLineWidth(0.6)
  doc.rect(ML, y, IW, 24)
  // big number
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(32)
  rgb(doc, sevCol)
  doc.text(String(d.riskScore), PW - MR - 6, y + 16, { align: 'right' })
  // labels
  doc.setFontSize(8)
  rgb(doc, MUTED)
  doc.text('RISK SCORE', PW - MR - 6, y + 21, { align: 'right' })
  doc.setFontSize(9)
  rgb(doc, DARK)
  doc.setFont('helvetica', 'normal')
  doc.text(riskSummary(d.severity), ML + 4, y + 9, { maxWidth: IW - 38 })
  doc.setFontSize(8)
  rgb(doc, MUTED)
  doc.text(`Risk index: ${d.riskPercent}%`, ML + 4, y + 18)
  y += 30

  // ── KPI row ───────────────────────────────────────────────────────────────
  const kpis: [string, string][] = [
    ['Wallet', truncAddr(d.wallet)],
    ['Network', d.network],
    ['Balance', d.balance],
    ['Primary Concern', d.primaryConcern || 'None'],
  ]
  const kw = IW / kpis.length
  kpis.forEach(([label, value], i) => {
    const kx = ML + i * kw
    fillRect(doc, kx + 0.5, y, kw - 1, 18, BG)
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2])
    doc.setLineWidth(0.3)
    doc.rect(kx + 0.5, y, kw - 1, 18)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7)
    rgb(doc, MUTED)
    doc.text(label.toUpperCase(), kx + kw / 2, y + 6, { align: 'center' })
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    rgb(doc, DARK)
    doc.text(value, kx + kw / 2, y + 13, { align: 'center', maxWidth: kw - 4 })
  })
  y += 24

  // ── Section helper ────────────────────────────────────────────────────────
  const sectionTitle = (title: string) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    rgb(doc, MUTED)
    doc.text(title.toUpperCase(), ML, y)
    y += 3
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2])
    doc.setLineWidth(0.3)
    doc.line(ML, y, PW - MR, y)
    y += 4
  }

  const listItem = (index: number, text: string) => {
    if (y > PH - 24) { doc.addPage(); y = 16 }
    // number circle
    fillRect(doc, ML, y - 3.5, 5, 5, sevCol)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7)
    rgb(doc, WHITE)
    doc.text(String(index + 1), ML + 2.5, y, { align: 'center' })
    // text
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    rgb(doc, DARK)
    const lines = splitLines(doc, text, IW - 10)
    lines.forEach((line, li) => {
      if (li > 0 && y > PH - 20) { doc.addPage(); y = 16 }
      doc.text(line, ML + 8, li === 0 ? y : (y += 5))
    })
    y += 7
  }

  // ── On-chain findings ─────────────────────────────────────────────────────
  sectionTitle('On-Chain Findings')
  if (d.findings.length === 0) {
    rgb(doc, MUTED); doc.setFontSize(9); doc.text('No findings detected.', ML, y); y += 8
  } else {
    d.findings.forEach((f, i) => listItem(i, f))
  }
  y += 2

  // ── Matched signals ───────────────────────────────────────────────────────
  if (y > PH - 50) { doc.addPage(); y = 16 }
  sectionTitle('Matched Risk Signals')
  if (d.matchedSignals.length === 0) {
    rgb(doc, MUTED); doc.setFontSize(9); doc.text('No signals matched.', ML, y); y += 8
  } else {
    d.matchedSignals.forEach((s, i) => listItem(i, s))
  }
  y += 2

  // ── Action plan ───────────────────────────────────────────────────────────
  if (y > PH - 50) { doc.addPage(); y = 16 }
  sectionTitle('Recommended Actions')
  d.actionPlan.forEach((a, i) => listItem(i, a))
  y += 4

  // ── Security warning box ──────────────────────────────────────────────────
  if (y > PH - 30) { doc.addPage(); y = 16 }
  fillRect(doc, ML, y, IW, 18, [254, 242, 242])
  doc.setDrawColor(220, 38, 38); doc.setLineWidth(0.5)
  doc.line(ML, y, ML, y + 18)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  rgb(doc, [153, 27, 27])
  doc.text('SECURITY WARNING', ML + 4, y + 6)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  rgb(doc, [127, 29, 29])
  doc.text('Never share your seed phrase, private key, or recovery words with anyone.', ML + 4, y + 12, { maxWidth: IW - 8 })
  y += 22

  // ── Footer ────────────────────────────────────────────────────────────────
  addFooter(doc, d.wallet, d.generatedAt)

  return doc.output('datauristring').split(',')[1]
}

export function generateBotStatusPdf(d: BotStatusPdfData): string {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const approved = d.status === 'approved'
  const statusCol = approved ? SEVERITY_COLOUR.low : SEVERITY_COLOUR.critical
  let y = 0

  // ── Header ────────────────────────────────────────────────────────────────
  fillRect(doc, 0, 0, PW, 28, DARK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  rgb(doc, WHITE)
  doc.text('One Link Security', ML, 12)
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  rgb(doc, [148, 163, 184])
  doc.text('Blockchain Anti-Bot Protection', ML, 18)
  fillRect(doc, PW - MR - 36, 7, 36, 10, statusCol)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  rgb(doc, WHITE)
  doc.text(approved ? 'APPROVED' : 'DECLINED', PW - MR - 18, 13.5, { align: 'center' })

  y = 36

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  rgb(doc, DARK)
  doc.text(approved ? 'Bot Protection Activated' : 'Bot Protection Request Update', ML, y)
  y += 8

  // ── Summary box ───────────────────────────────────────────────────────────
  const rows: [string, string][] = [
    ['Wallet',     truncAddr(d.wallet)],
    ['Network',    d.network],
    ['Status',     d.status.toUpperCase()],
    ['Requested',  d.requestedAt],
    ['Reviewed',   d.reviewedAt],
  ]
  fillRect(doc, ML, y, IW, rows.length * 10 + 4, BG)
  doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2])
  doc.setLineWidth(0.3)
  doc.rect(ML, y, IW, rows.length * 10 + 4)
  y += 6
  rows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    rgb(doc, MUTED)
    doc.text(label.toUpperCase(), ML + 4, y)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    rgb(doc, DARK)
    doc.text(value, PW - MR - 4, y, { align: 'right', maxWidth: IW / 2 })
    y += 10
  })
  y += 6

  // ── Decision note ─────────────────────────────────────────────────────────
  if (d.reason) {
    fillRect(doc, ML, y, IW, 20, approved ? [240, 253, 244] : [254, 242, 242])
    doc.setDrawColor(statusCol[0], statusCol[1], statusCol[2])
    doc.setLineWidth(0.5)
    doc.line(ML, y, ML, y + 20)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    rgb(doc, approved ? [21, 128, 61] : [153, 27, 27])
    doc.text(approved ? 'ACTIVATION NOTE' : 'DECISION REASON', ML + 4, y + 7)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    rgb(doc, approved ? [20, 83, 45] : [127, 29, 29])
    doc.text(d.reason, ML + 4, y + 14, { maxWidth: IW - 8 })
    y += 26
  }

  if (approved) {
    y += 4
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    rgb(doc, MUTED)
    doc.text('ACTIVE PROTECTION LAYERS', ML, y)
    y += 5
    const layers = [
      'Drainer Shield — intercepts malicious approval transactions before execution.',
      'Watcher Detection — identifies and blocks automated wallet monitoring bots.',
      'MEV Bot Blocker — prevents front-running and sandwich attacks.',
      'Real-time Transaction Guard — validates every outbound transaction.',
      'Seed Phrase Phishing Guard — blocks fake site injection attempts.',
      'Cross-Chain Active — protection spanning all 5 supported EVM networks.',
    ]
    layers.forEach((l, i) => {
      if (y > PH - 20) { doc.addPage(); y = 16 }
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      rgb(doc, DARK)
      doc.text(`${i + 1}. ${l}`, ML, y, { maxWidth: IW })
      y += 7
    })
  }

  addFooter(doc, d.wallet, d.reviewedAt)
  return doc.output('datauristring').split(',')[1]
}

// ─── Private helpers ─────────────────────────────────────────────────────────
function riskSummary(severity: string): string {
  if (severity === 'low')      return 'No immediate compromise signals detected. Continue periodic monitoring.'
  if (severity === 'medium')   return 'Suspicious indicators detected. Perform remediation and tighten controls.'
  if (severity === 'high')     return 'High risk profile detected. Move to a safer wallet and rotate access quickly.'
  return 'Critical risk profile. Assume compromise and evacuate assets immediately.'
}

function truncAddr(addr: string): string {
  if (addr.length > 20) return `${addr.slice(0, 8)}…${addr.slice(-6)}`
  return addr
}

function addFooter(doc: jsPDF, wallet: string, date: string) {
  const pageCount = doc.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    fillRect(doc, 0, PH - 12, PW, 12, DARK)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    rgb(doc, [100, 116, 139])
    doc.text(`One Link Security · ${truncAddr(wallet)} · ${date}`, ML, PH - 5)
    doc.text(`Page ${p} / ${pageCount}`, PW - MR, PH - 5, { align: 'right' })
  }
}
