import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import emailjs from '@emailjs/browser'
import { useAppKit, useAppKitAccount, useAppKitNetwork } from '@reown/appkit/react'
import { useWalletClient, useSwitchChain } from 'wagmi'
import { buildEmailHtml, buildEmailText, buildWatchoutEmailHtml, buildWatchoutEmailText, type ReportEmailData } from './emailTemplate'
import { loadCloudState, saveCloudState } from './cloudState'
import { isSupabaseConfigured } from './supabaseClient'
import './App.css'

// ── EmailJS config — set your own IDs at https://emailjs.com ────────────
const EMAILJS_SERVICE_ID  = 'YOUR_SERVICE_ID'
const EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID'
const EMAILJS_PUBLIC_KEY  = 'YOUR_PUBLIC_KEY'
const EMAIL_CONFIGURED    = EMAILJS_SERVICE_ID !== 'YOUR_SERVICE_ID'

// ── Types ────────────────────────────────────────────────────────────────
type Severity = 'low' | 'medium' | 'high' | 'critical'
type ChainKey = 'ethereum' | 'base' | 'arbitrum' | 'bsc' | 'polygon'
type ViewKey  = 'home' | 'scan' | 'protect' | 'ownership' | 'recovery' | 'support' | 'admin'

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

type ConnectedWalletRecord = { wallet: string; chain: ChainKey; walletType: string; balance: string; txCount: string; connectedAt: string }
type ScanRecord            = { wallet: string; chain: ChainKey; score: number; severity: Severity; balance: string; findings: string[]; matchedSignals: string[]; generatedAt: string }
type SignerCheckRecord     = { wallet: string; chain: ChainKey; status: 'passed' | 'failed'; detail: string; checkedAt: string }
type EmailRecord           = { email: string; name: string; wallet: string; chain: ChainKey; severity: Severity; score: number; balance: string; sentAt: string; emailStatus: 'sent' | 'pending' | 'failed' }
type AdminCreds            = { email: string; password: string }
type SupportConfig         = { email: string; telegram: string }

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

const ADMIN_CREDS_KEY = 'sv_admin_creds'
const SUPPORT_CONFIG_KEY = 'sv_support_config'
const ADMIN_INTEL_KEY = 'sv_admin_intel_records'
const SCAN_HISTORY_KEY = 'sv_scan_history'
const PROTECT_CHECKLIST_KEY = 'sv_protect_checklist_done'
const CONNECTED_WALLETS_KEY = 'sv_connected_wallets'
const SIGNER_CHECKS_KEY = 'sv_signer_checks'
const EMAIL_RECORDS_KEY = 'sv_email_records'
const NEWSLETTER_EMAILS_KEY = 'sv_newsletter_emails'
const NEWS_REFRESH_MS = 5 * 60 * 1000
const DEFAULT_ADMIN_EMAIL = 'admin@admin.com'
const DEFAULT_ADMIN_PASSWORD = 'vault-admin-2026'
const DEFAULT_SUPPORT_EMAIL = 'support@sentinelvault.io'
const DEFAULT_SUPPORT_TELEGRAM = 'https://t.me/sentinelvault'

const loadStoredJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const capRecords = <T,>(rows: T[], max = 200): T[] => rows.slice(0, max)

const loadAdminCreds = (): AdminCreds => {
  const p = loadStoredJson<{ username?: string; email?: string; password?: string } | null>(ADMIN_CREDS_KEY, null)
  const legacyEmail = typeof p?.username === 'string' && p.username.includes('@') ? p.username.toLowerCase() : ''
  if (p?.password) {
    return { email: (p.email?.toLowerCase() || legacyEmail || DEFAULT_ADMIN_EMAIL), password: p.password }
  }
  return { email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD }
}

const loadSupportConfig = (): SupportConfig => {
  const p = loadStoredJson<Partial<SupportConfig> | null>(SUPPORT_CONFIG_KEY, null)
  return {
    email: p?.email?.trim() || DEFAULT_SUPPORT_EMAIL,
    telegram: p?.telegram?.trim() || DEFAULT_SUPPORT_TELEGRAM,
  }
}

const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f714f27d1e84f3dd0314c0f7b2291e5b200ac8c7c3b8d'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55aeb0f4fefab'
const GOPLUS_BASE_URL = 'https://api.gopluslabs.io/api/v1'
const GOPLUS_ACCESS_TOKEN = (import.meta.env.VITE_GOPLUS_ACCESS_TOKEN ?? '').trim()
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

const weiToNative = (v: string | null, decimals = 4) => {
  if (!v) return null
  const wei = BigInt(v)
  const whole = wei / 10n ** 18n
  const frac  = ((wei % 10n ** 18n) * 10n ** BigInt(decimals) / 10n ** 18n).toString().padStart(decimals, '0')
  return `${whole}.${frac}`
}

const topicForAddress = (a: string) =>
  `0x000000000000000000000000${a.toLowerCase().replace('0x', '')}`

const getSeverity = (score: number): Severity =>
  score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low'

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
  return Array.from({ length: count }, (_) => {
    const offsetMs = Math.floor(Math.random() * 240 * 60 * 1000)
    const d = new Date(now.getTime() - offsetMs)
    return {
      wallet:      rndAddr(),
      chain:       SCAN_CHAIN_KEYS[Math.floor(Math.random() * SCAN_CHAIN_KEYS.length)],
      walletType:  WALLET_TYPES[Math.floor(Math.random() * WALLET_TYPES.length)],
      balance:     `${(Math.random() * 5).toFixed(4)} ETH`,
      txCount:     String(Math.floor(Math.random() * 2000)),
      connectedAt: d.toLocaleString(),
    }
  }).sort((a, b) => new Date(b.connectedAt).getTime() - new Date(a.connectedAt).getTime())
}

const makeSignerCheckRows = (count: number): SignerCheckRecord[] => {
  const now = new Date()
  return Array.from({ length: count }, (_) => {
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

  const headers: HeadersInit = {}
  if (GOPLUS_ACCESS_TOKEN) headers.Authorization = `Bearer ${GOPLUS_ACCESS_TOKEN}`

  const res = await fetch(`${GOPLUS_BASE_URL}/address_security/${address}?chain_id=${chainId}`, { headers })
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
  const [activeView, setActiveView] = useState<ViewKey>('home')
  const [menuOpen,   setMenuOpen]   = useState(false)

  // ── Reown AppKit hooks ────────────────────────────────────────────────
  const { open: openAppKit }                                    = useAppKit()
  const { address: appKitAddress, isConnected: isAppKitConnected } = useAppKitAccount()
  const { chainId: appKitChainId }                              = useAppKitNetwork()
  const { data: walletClient }                                  = useWalletClient()
  const { switchChain }                                         = useSwitchChain()

  // Wallet state
  const [walletBalance, setWalletBalance] = useState('')
  const [wallet,        setWallet]        = useState('')
  const [chain,         setChain]         = useState<ChainKey>('ethereum')
  const connectedAddress = appKitAddress ?? ''
  const connectedChainId = typeof appKitChainId === 'number'
    ? appKitChainId
    : (typeof appKitChainId === 'string' ? Number(appKitChainId) : null)
  const connectedProvider = isAppKitConnected ? (walletClient ?? {}) : null
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
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false)
  const [adminTab,             setAdminTab]             = useState<'wallets' | 'scans' | 'signers' | 'emails' | 'templates' | 'osint' | 'intel' | 'settings'>('wallets')
  const [adminCreds,           setAdminCreds]           = useState(loadAdminCreds)
  const [supportConfig,        setSupportConfig]        = useState(loadSupportConfig)
  const [supportEmailInput,    setSupportEmailInput]    = useState('')
  const [supportStatus,        setSupportStatus]        = useState('')
  const [newsletterEmails,     setNewsletterEmails]     = useState<string[]>(() => loadStoredJson<string[]>(NEWSLETTER_EMAILS_KEY, []))
  const [settingsCurPass,      setSettingsCurPass]      = useState('')
  const [settingsNewEmail,     setSettingsNewEmail]     = useState('')
  const [settingsNewPass,      setSettingsNewPass]      = useState('')
  const [settingsConfirmPass,  setSettingsConfirmPass]  = useState('')
  const [settingsSupportEmail, setSettingsSupportEmail] = useState('')
  const [settingsSupportTelegram, setSettingsSupportTelegram] = useState('')
  const [settingsMsg,          setSettingsMsg]          = useState('')
  const [settingsError,        setSettingsError]        = useState('')

  // Records
  const [connectedWallets, setConnectedWallets] = useState<ConnectedWalletRecord[]>(() => loadStoredJson<ConnectedWalletRecord[]>(CONNECTED_WALLETS_KEY, []))
  const [scanHistory,      setScanHistory]      = useState<ScanRecord[]>(() => loadStoredJson<ScanRecord[]>(SCAN_HISTORY_KEY, []))
  const [signerChecks,     setSignerChecks]     = useState<SignerCheckRecord[]>(() => loadStoredJson<SignerCheckRecord[]>(SIGNER_CHECKS_KEY, []))
  const [emailRecords,     setEmailRecords]     = useState<EmailRecord[]>(() => loadStoredJson<EmailRecord[]>(EMAIL_RECORDS_KEY, []))
  const [adminIntelRecords, setAdminIntelRecords] = useState<AdminIntelRecord[]>(() => loadStoredJson<AdminIntelRecord[]>(ADMIN_INTEL_KEY, []))
  const [protectChecklistDone, setProtectChecklistDone] = useState<string[]>(() => loadStoredJson<string[]>(PROTECT_CHECKLIST_KEY, []))
  const [cloudSyncStatus, setCloudSyncStatus] = useState('')
  const [isTestingCloud, setIsTestingCloud] = useState(false)
  const cloudHydratedRef = useRef(false)
  const cloudSyncTimerRef = useRef<number | null>(null)
  const [cryptoNews, setCryptoNews] = useState<CryptoNewsItem[]>(STATIC_NEWS)
  const [newsLoading, setNewsLoading] = useState(false)
  const [newsLive, setNewsLive] = useState(false)

  // Admin Intel form state
  const [intelAddress,   setIntelAddress]   = useState('')
  const [intelChain,     setIntelChain]     = useState<ChainKey>('ethereum')
  const [intelSeverity,  setIntelSeverity]  = useState<Severity>('medium')
  const [intelFindings,  setIntelFindings]  = useState('')
  const [intelNotes,     setIntelNotes]     = useState('')
  const [intelFormError, setIntelFormError] = useState('')
  const [osintExpanded,  setOsintExpanded]  = useState<string | null>(null)

  // Template preview
  const [previewEmail,        setPreviewEmail]        = useState<EmailRecord | null>(null)
  const [previewIsWatchout,   setPreviewIsWatchout]   = useState(false)

  const addressValid = useMemo(() => isAddress(wallet), [wallet])

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
        return [{ wallet: appKitAddress, chain: ch, walletType: 'AppKit', balance: '', txCount: 'N/A', connectedAt: nowString() }, ...filtered].slice(0, 100)
      })
    } else if (!isAppKitConnected) {
      setWalletBalance('')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAppKitConnected, appKitAddress, connectedChainId])

  useEffect(() => {
    let active = true
    const hydrateCloudState = async () => {
      if (!isSupabaseConfigured) {
        setCloudSyncStatus('Cloud sync is off. Add Supabase env vars to enable.')
        cloudHydratedRef.current = true
        return
      }
      try {
        const cloudState = await loadCloudState()
        if (!active) return
        if (cloudState) {
          setConnectedWallets(capRecords(cloudState.connectedWallets as ConnectedWalletRecord[]))
          setScanHistory(capRecords(cloudState.scanHistory as ScanRecord[]))
          setSignerChecks(capRecords(cloudState.signerChecks as SignerCheckRecord[]))
          setEmailRecords(capRecords(cloudState.emailRecords as EmailRecord[]))
          setAdminIntelRecords(capRecords(cloudState.adminIntelRecords as AdminIntelRecord[]))
          setProtectChecklistDone(cloudState.protectChecklistDone)
          setCloudSyncStatus('Cloud sync active. Data restored from Supabase.')
        } else {
          setCloudSyncStatus('Cloud sync active. No remote data yet.')
        }
      } catch (error) {
        if (!active) return
        setCloudSyncStatus(`Cloud sync unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`)
      } finally {
        if (active) cloudHydratedRef.current = true
      }
    }
    void hydrateCloudState()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(CONNECTED_WALLETS_KEY, JSON.stringify(connectedWallets))
  }, [connectedWallets])

  useEffect(() => {
    localStorage.setItem(SIGNER_CHECKS_KEY, JSON.stringify(signerChecks))
  }, [signerChecks])

  useEffect(() => {
    localStorage.setItem(EMAIL_RECORDS_KEY, JSON.stringify(emailRecords))
  }, [emailRecords])

  useEffect(() => {
    localStorage.setItem(ADMIN_INTEL_KEY, JSON.stringify(adminIntelRecords))
  }, [adminIntelRecords])

  useEffect(() => {
    localStorage.setItem(SCAN_HISTORY_KEY, JSON.stringify(scanHistory))
  }, [scanHistory])

  useEffect(() => {
    localStorage.setItem(PROTECT_CHECKLIST_KEY, JSON.stringify(protectChecklistDone))
  }, [protectChecklistDone])

  useEffect(() => {
    localStorage.setItem(SUPPORT_CONFIG_KEY, JSON.stringify(supportConfig))
  }, [supportConfig])

  useEffect(() => {
    localStorage.setItem(NEWSLETTER_EMAILS_KEY, JSON.stringify(newsletterEmails))
  }, [newsletterEmails])

  useEffect(() => {
    if (!isSupabaseConfigured || !cloudHydratedRef.current) return
    if (cloudSyncTimerRef.current) window.clearTimeout(cloudSyncTimerRef.current)
    cloudSyncTimerRef.current = window.setTimeout(() => {
      void saveCloudState({
        connectedWallets,
        scanHistory,
        signerChecks,
        emailRecords,
        adminIntelRecords,
        protectChecklistDone,
      }).then(() => {
        setCloudSyncStatus('Cloud sync active. Latest changes saved.')
      }).catch((error: unknown) => {
        setCloudSyncStatus(`Cloud sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      })
    }, 600)

    return () => {
      if (cloudSyncTimerRef.current) window.clearTimeout(cloudSyncTimerRef.current)
    }
  }, [
    connectedWallets,
    scanHistory,
    signerChecks,
    emailRecords,
    adminIntelRecords,
    protectChecklistDone,
  ])

  const testCloudConnection = async () => {
    if (!isSupabaseConfigured) {
      setCloudSyncStatus('Cloud test skipped: Supabase env vars are missing.')
      return
    }
    setIsTestingCloud(true)
    setCloudSyncStatus('Running Supabase connection test...')
    try {
      const remote = await loadCloudState()
      if (!remote) {
        await saveCloudState({
          connectedWallets,
          scanHistory,
          signerChecks,
          emailRecords,
          adminIntelRecords,
          protectChecklistDone,
        })
        setCloudSyncStatus('Supabase test passed: created cloud state and wrote data.')
      } else {
        await saveCloudState({
          connectedWallets,
          scanHistory,
          signerChecks,
          emailRecords,
          adminIntelRecords,
          protectChecklistDone,
        })
        setCloudSyncStatus('Supabase test passed: read and write both succeeded.')
      }
    } catch (error) {
      setCloudSyncStatus(`Supabase test failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setIsTestingCloud(false)
    }
  }

  // ── AppKit pending-protection effect ─────────────────────────────────
  useEffect(() => {
    if (pendingProtection && isAppKitConnected && appKitAddress) {
      void sendProtectionWatchEmail(pendingProtection, appKitAddress).finally(() => setPendingProtection(null))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAppKitConnected, appKitAddress])

  const switchNetwork = async () => {
    if (!isAppKitConnected) return
    try {
      switchChain({ chainId: chainConfig[chain].chainId })
      setWeb3Status(`Switching to ${chainConfig[chain].label}…`)
    } catch (e) { setWeb3Status(`Switch failed: ${e instanceof Error ? e.message : 'Unknown error'}`) }
  }

  // ── Signer probe ──────────────────────────────────────────────────────
  const testSigner = async () => {
    if (!walletClient || !appKitAddress) { setSignerCheck('No wallet connected. Please connect via the button above.'); return }
    try {
      setIsTestingSigner(true)
      const challenge = `Sentinel ownership check @ ${new Date().toISOString()}`
      await walletClient.signMessage({ account: appKitAddress as `0x${string}`, message: challenge })
      setSignerCheck('Ownership verified — wallet signed the challenge successfully.')
      setOwnershipStatus('Ownership verified via message signature.')
      setSignerChecks(prev => [{ wallet: appKitAddress, chain, status: 'passed' as const, detail: 'Signed ownership challenge.', checkedAt: nowString() }, ...prev].slice(0, 200))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      setSignerCheck(`Signer check failed: ${msg}`)
      setOwnershipStatus(`Ownership prompt failed: ${msg}`)
      setSignerChecks(prev => [{ wallet: appKitAddress || wallet || 'Unknown', chain, status: 'failed' as const, detail: msg, checkedAt: nowString() }, ...prev].slice(0, 200))
    } finally { setIsTestingSigner(false) }
  }

  // ── Run scan ──────────────────────────────────────────────────────────
  const runScan = async (e: FormEvent) => {
    e.preventDefault(); setSubmitted(true); setReportStatus(''); setEmailSentMsg('')
    if (!addressValid) return

    const matchedSignals = signals.filter(s => selectedSignals.includes(s.id))
    const baseScore = matchedSignals.reduce((sum, s) => sum + s.points, 0)
    const byGroup: Record<Signal['group'], number> = { watching: 0, seed: 0, drainer: 0 }
    matchedSignals.forEach(s => { byGroup[s.group] += s.points })
    const primaryConcern = (Object.entries(byGroup).sort((a, b) => b[1] - a[1])[0][1]
      ? Object.entries(byGroup).sort((a, b) => b[1] - a[1])[0][0] : null) as Signal['group'] | null

    setIsRunningWeb3(true)
    setWeb3Status(`Scanning ${chainConfig[chain].label} — fetching on-chain data…`)

    // ── Look up admin-seeded intel for this address ─────────────────────
    const adminIntel = adminIntelRecords.find(r =>
      r.address.toLowerCase() === wallet.toLowerCase() &&
      (r.chain === chain || r.chain === 'ethereum')
    ) ?? null

    try {
      const [web3, securityApi] = await Promise.all([
        runWeb3Scan(wallet, chain),
        runSecurityApiScan(wallet, chain).catch(() => null),
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

      // Admin intel overrides minimum severity and adds extra points
      const adminIntelPoints = adminIntel
        ? (adminIntel.severity === 'critical' ? 40 : adminIntel.severity === 'high' ? 25 : adminIntel.severity === 'medium' ? 10 : 0)
        : 0

      const rawScore = baseScore + web3Points + securityApiPoints + adminIntelPoints
      const score = Math.min(100, rawScore)
      let severity = getSeverity(score)
      // Admin intel can only raise severity, never lower it
      if (adminIntel) {
        const sevOrder: Severity[] = ['low', 'medium', 'high', 'critical']
        if (sevOrder.indexOf(adminIntel.severity) > sevOrder.indexOf(severity)) severity = adminIntel.severity
      }
      const bal = web3.nativeBalance ? `${web3.nativeBalance} ${chainConfig[chain].nativeSymbol}` : (walletBalance || 'N/A')
      const findings = [
        ...web3.findings,
        ...(securityApi?.findings ?? []),
        ...(adminIntel ? adminIntel.findings.map(f => `[Admin Intel] ${f}`) : []),
      ]

      setResult({ score, severity, riskPercent: score, matchedSignals, byGroup, primaryConcern, web3, web3RiskPoints: web3Points, securityApi, adminIntel, generatedAt: nowString() })
      setScanHistory(prev => [{
        wallet, chain, score, severity, balance: bal,
        findings, matchedSignals: matchedSignals.map(s => s.label),
        generatedAt: nowString(),
      }, ...prev].slice(0, 200))
      const rpcMsg = isWalletConnected && appKitChainId === chainConfig[chain].chainId ? 'connected wallet RPC' : 'public RPC fallback'
      const apiMsg = securityApi ? 'GoPlus intel included.' : 'GoPlus unavailable.'
      const intelMsg = adminIntel ? ' Admin intel applied.' : ''
      setWeb3Status(`Scan complete via ${rpcMsg}. ${apiMsg}${intelMsg}`)
    } catch (err) {
      const severity = adminIntel?.severity ?? getSeverity(baseScore)
      const adminIntelPoints = adminIntel
        ? (adminIntel.severity === 'critical' ? 40 : adminIntel.severity === 'high' ? 25 : adminIntel.severity === 'medium' ? 10 : 0)
        : 0
      const score = Math.min(100, baseScore + adminIntelPoints)
      setResult({ score, severity, riskPercent: score, matchedSignals, byGroup, primaryConcern, web3: null, web3RiskPoints: 0, securityApi: null, adminIntel, generatedAt: nowString() })
      setScanHistory(prev => [{
        wallet, chain, score, severity, balance: walletBalance || 'N/A',
        findings: adminIntel ? adminIntel.findings.map(f => `[Admin Intel] ${f}`) : [],
        matchedSignals: matchedSignals.map(s => s.label), generatedAt: nowString(),
      }, ...prev].slice(0, 200))
      setWeb3Status(`RPC error: ${err instanceof Error ? err.message : 'Unknown'}`)
    } finally { setIsRunningWeb3(false) }
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

    if (EMAIL_CONFIGURED) {
      try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
          to_email:   data.toEmail,
          to_name:    data.toName,
          subject:    `Your Sentinel Vault Security Report — ${data.severity.toUpperCase()} Risk`,
          html_body:  buildEmailHtml(data),
          text_body:  buildEmailText(data),
          wallet:     data.wallet,
          network:    data.network,
          severity:   data.severity,
          risk_score: data.riskScore,
        }, EMAILJS_PUBLIC_KEY)
        setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'sent' } : r))
        setEmailSentMsg(`Report sent to ${emailInput}.`)
      } catch {
        setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'failed' } : r))
        setEmailSentMsg('Email delivery failed. Report saved in admin.')
      }
    } else {
      setEmailSentMsg(`Report saved for ${emailInput}. Configure EmailJS to enable delivery.`)
    }
    setEmailSending(false)
  }

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

    if (EMAIL_CONFIGURED) {
      try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
          to_email: payload.email,
          to_name: payload.name || 'there',
          subject: 'Wallet Watchout Protection Activated',
          html_body: buildWatchoutEmailHtml(watchData),
          text_body: buildWatchoutEmailText(watchData),
          wallet: connectedWallet,
          network: chainConfig[payload.network].label,
          severity: 'medium',
          risk_score: 35,
        }, EMAILJS_PUBLIC_KEY)
        setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'sent' } : r))
        setSecureStatus(`Wallet connected. Watchout protection email sent to ${payload.email}.`)
      } catch {
        setEmailRecords(prev => prev.map((r, i) => i === 0 ? { ...r, emailStatus: 'failed' } : r))
        setSecureStatus('Wallet connected, but watchout email failed to send.')
      }
    } else {
      setSecureStatus(`Wallet connected. Email queued for ${payload.email}; configure EmailJS to send live.`)
    }
  }

  const startSecureWallet = async (e: FormEvent) => {
    e.preventDefault()
    const parsedWallets = secureWalletsInput
      .split(/[\n,\s]+/)
      .map(entry => entry.trim())
      .filter(Boolean)

    if (!secureEmailInput.trim()) {
      setSecureStatus('Enter an email to receive automatic watchout alerts.')
      return
    }
    if (parsedWallets.length === 0) {
      setSecureStatus('Enter at least one wallet address to secure.')
      return
    }
    if (!secureMultiMode && parsedWallets.length > 1) {
      setSecureStatus('Multiple addresses detected. Enable multiple wallet mode or keep one address.')
      return
    }
    const invalidWallet = parsedWallets.find(item => !isAddress(item))
    if (invalidWallet) {
      setSecureStatus(`Invalid wallet address: ${invalidWallet}`)
      return
    }

    setWallet(parsedWallets[0])
    const request: PendingProtection = {
      email: secureEmailInput.trim(),
      name: secureNameInput.trim(),
      wallets: parsedWallets,
      network: chain,
    }
    setPendingProtection(request)

    if (isAppKitConnected && appKitAddress) {
      await sendProtectionWatchEmail(request, appKitAddress)
      setPendingProtection(null)
      return
    }

    setSecureStatus('Secure flow started. Connect your wallet to complete protection setup.')
    openAppKit()
  }

  const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

  const openAdminAuthPrompt = () => {
    setAdminPasswordInput('')
    setAdminAuthError('')
    setAdminAuthModalOpen(true)
  }

  const submitSupportEmail = (e: FormEvent) => {
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
    setNewsletterEmails(prev => prev.includes(email) ? prev : [email, ...prev].slice(0, 500))
    setSupportStatus('Subscribed to the newsletter list. We will share updates soon.')
    setSupportEmailInput('')
  }

  const verifyAdminFromSupport = (e: FormEvent) => {
    e.preventDefault()
    if (adminPasswordInput === adminCreds.password) {
      setIsAdminAuthenticated(true)
      setAdminAuthModalOpen(false)
      setAdminAuthError('')
      setSupportStatus('Admin authenticated successfully. Opening dashboard...')
      setActiveView('admin')
      return
    }
    setAdminAuthError('Incorrect admin password.')
  }

  const saveCredentials = (e: FormEvent) => {
    e.preventDefault()
    setSettingsError(''); setSettingsMsg('')
    if (settingsCurPass !== adminCreds.password) { setSettingsError('Current password is incorrect.'); return }
    const newEmail = (settingsNewEmail.trim() || adminCreds.email).toLowerCase()
    const newPass = settingsNewPass || adminCreds.password
    const updatedSupportEmail = settingsSupportEmail.trim() || supportConfig.email
    const updatedSupportTelegram = settingsSupportTelegram.trim() || supportConfig.telegram
    if (!isValidEmail(newEmail)) { setSettingsError('Admin email format is invalid.'); return }
    if (!isValidEmail(updatedSupportEmail)) { setSettingsError('Support email format is invalid.'); return }
    if (!/^https?:\/\//.test(updatedSupportTelegram)) { setSettingsError('Telegram button URL must start with http:// or https://'); return }
    if (settingsNewPass && settingsNewPass !== settingsConfirmPass) { setSettingsError('New passwords do not match.'); return }
    if (settingsNewPass && settingsNewPass.length < 6) { setSettingsError('New password must be at least 6 characters.'); return }
    const updated: AdminCreds = { email: newEmail, password: newPass }
    localStorage.setItem(ADMIN_CREDS_KEY, JSON.stringify(updated))
    setAdminCreds(updated)
    setSupportConfig({ email: updatedSupportEmail, telegram: updatedSupportTelegram })
    setSettingsCurPass(''); setSettingsNewEmail(''); setSettingsNewPass(''); setSettingsConfirmPass('')
    setSettingsSupportEmail(''); setSettingsSupportTelegram('')
    setSettingsMsg('Admin credentials and support links updated successfully.')
  }

  const resetCredentials = () => {
    localStorage.removeItem(ADMIN_CREDS_KEY)
    localStorage.removeItem(SUPPORT_CONFIG_KEY)
    setAdminCreds({ email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD })
    setSupportConfig({ email: DEFAULT_SUPPORT_EMAIL, telegram: DEFAULT_SUPPORT_TELEGRAM })
    setSettingsMsg('Defaults restored for admin credentials and support links.')
  }

  const isConnectedToChain = Boolean(isWalletConnected && connectedChainId === chainConfig[chain].chainId)
  const checklistProgress = Math.round((protectChecklistDone.length / protectChecklist.length) * 100)
  const featuredNews = cryptoNews[0] ?? null
  const newsList = cryptoNews.slice(1, 7)

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

  const adminTabs: { key: typeof adminTab; label: string; count?: number }[] = [
    { key: 'wallets',   label: 'Connected Wallets', count: connectedWallets.length },
    { key: 'scans',     label: 'Scan History',      count: scanHistory.length },
    { key: 'signers',   label: 'Signer Checks',     count: signerChecks.length },
    { key: 'emails',    label: 'User Emails',        count: emailRecords.length },
    { key: 'templates', label: 'Email Templates' },
    { key: 'osint',     label: 'OSINT Profiles',    count: [...new Set(scanHistory.map(r => r.wallet.toLowerCase()))].length },
    { key: 'intel',     label: 'Address Intel',     count: adminIntelRecords.length },
    { key: 'settings',  label: 'Settings' },
  ]

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

  const cloudBanner = useMemo(() => {
    if (isTestingCloud) {
      return { tone: 'info', title: 'Testing Cloud Connection' }
    }
    const text = cloudSyncStatus.toLowerCase()
    if (text.includes('failed') || text.includes('unavailable')) {
      return { tone: 'error', title: 'Cloud Sync Issue' }
    }
    if (text.includes('off') || text.includes('missing')) {
      return { tone: 'warn', title: 'Cloud Sync Disabled' }
    }
    if (text.includes('passed') || text.includes('active') || text.includes('saved')) {
      return { tone: 'ok', title: 'Cloud Sync Connected' }
    }
    return { tone: 'info', title: 'Cloud Sync Status' }
  }, [cloudSyncStatus, isTestingCloud])

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">

      {/* ── Top bar ── */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <svg viewBox="0 0 16 16"><path d="M8 1L2 4v4c0 3.3 2.5 6.4 6 7 3.5-.6 6-3.7 6-7V4L8 1z"/></svg>
          </div>
          <span className="brand-name">Sentinel Vault</span>
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
          {isWalletConnected && <span className="chain-badge">{chainConfig[chain].label}</span>}
          {isWalletConnected && walletBalance && <span className="chain-badge">{walletBalance}</span>}
          {isWalletConnected ? (
            <button className="connect-btn connected" type="button" onClick={() => openAppKit()}>
              <span className="wallet-dot" />{shortAddr(appKitAddress ?? '')}
            </button>
          ) : (
            <button className="connect-btn" type="button" onClick={() => openAppKit()}>
              Connect Wallet
            </button>
          )}
          <button className="menu-btn" type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen(p => !p)}>
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>
      </header>


      {/* AppKit renders its own connect modal — triggered via openAppKit() */}

      {/* ── Email template preview modal ── */}
      {previewEmail && (
        <div className="modal-overlay" onClick={() => { setPreviewEmail(null); setPreviewIsWatchout(false) }}>
          <div className="modal email-preview-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Email Preview — {previewEmail.email}</h3>
              <button className="modal-close" type="button" onClick={() => { setPreviewEmail(null); setPreviewIsWatchout(false) }}>✕</button>
            </div>
            <div className="email-preview-body" dangerouslySetInnerHTML={{ __html:
              previewIsWatchout
                ? buildWatchoutEmailHtml(templatePreviewData(previewEmail))
                : buildEmailHtml(templatePreviewData(previewEmail))
            }} />
          </div>
        </div>
      )}

      {/* ── Admin auth modal (triggered from Support page) ── */}
      {adminAuthModalOpen && (
        <div className="modal-overlay" onClick={() => setAdminAuthModalOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Admin Authentication</h3>
              <button className="modal-close" type="button" onClick={() => setAdminAuthModalOpen(false)}>✕</button>
            </div>
            <p className="muted" style={{ marginBottom: '0.8rem', fontSize: '0.86rem' }}>
              Admin email detected (<code>{adminCreds.email}</code>). Enter the admin password to continue.
            </p>
            <form onSubmit={verifyAdminFromSupport}>
              <div className="field">
                <label htmlFor="admin-auth-password">Password</label>
                <input
                  id="admin-auth-password"
                  type="password"
                  value={adminPasswordInput}
                  onChange={e => setAdminPasswordInput(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Enter admin password"
                  required
                />
              </div>
              {adminAuthError && <p className="error">{adminAuthError}</p>}
              <div className="action-row">
                <button className="btn-primary" type="submit">Unlock Admin</button>
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
            <h1 className="home-title">Your wallet.<br />Your security.</h1>
            <p className="home-sub">Sentinel Vault gives you real on-chain telemetry and a proactive hardening toolkit — all in one place, with no seed phrase ever requested.</p>
          </div>

          <div className="home-paths">
            {/* Path A — Scan */}
            <button className="home-path-card" type="button" onClick={() => setActiveView('scan')}>
              <div className="home-path-icon scan-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
                </svg>
              </div>
              <div className="home-path-body">
                <h2>Scan Your Wallet</h2>
                <p>Run a live security assessment. Check on-chain telemetry, risk score, approval history, and get a full incident report for any EVM wallet.</p>
                <ul className="home-path-list">
                  <li>Real-time on-chain data</li>
                  <li>Risk scoring across 8 signals</li>
                  <li>Exportable JSON + email report</li>
                </ul>
              </div>
              <span className="home-path-cta">Scan now →</span>
            </button>

            {/* Path B — Secure */}
            <button className="home-path-card protect" type="button" onClick={() => setActiveView('protect')}>
              <div className="home-path-icon protect-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
              </div>
              <div className="home-path-body">
                <h2>Secure Your Wallet</h2>
                <p>Learn how to harden your wallet before anything goes wrong. Approval hygiene, hardware signer tips, and a step-by-step security checklist.</p>
                <ul className="home-path-list">
                  <li>Security hardening checklist</li>
                  <li>Approval & permission hygiene</li>
                  <li>Threat feed & best practices</li>
                </ul>
              </div>
              <span className="home-path-cta">Secure now →</span>
            </button>
          </div>

          <div className="home-stats">
            <div className="stat-item"><strong>5</strong><span>Networks supported</span></div>
            <div className="stat-item"><strong>8</strong><span>Risk signals checked</span></div>
            <div className="stat-item"><strong>{scanHistory.length > 0 ? scanHistory.length : liveScanRows.length}+</strong><span>Wallets scanned</span></div>
            <div className="stat-item"><strong>0</strong><span>Seed phrases collected</span></div>
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
                  { n: '0',  label: 'Seed phrases collected' },
                ].map(s => (
                  <div key={s.label} className="protect-stat">
                    <strong>{s.n}</strong>
                    <span>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>

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

        {/* ════════════ SCAN ════════════ */}
        {activeView === 'scan' && (
          <>
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
                          onClick={() => openAppKit()}
                          title="Manage wallet"
                        >
                          <span className="wallet-dot" />
                          {shortAddr(connectedAddress)}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="scan-wallet-btn"
                          onClick={() => openAppKit()}
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

                  <div className="action-row">
                    <button className="btn-primary" type="submit" disabled={isRunningWeb3}>
                      {isRunningWeb3 ? (
                        <><span className="spinner" />Scanning…</>
                      ) : 'Run Security Scan'}
                    </button>
                    <button className="btn-secondary" type="button" onClick={testSigner} disabled={isTestingSigner || !connectedProvider}>
                      {isTestingSigner ? 'Checking…' : 'Signer Probe'}
                    </button>
                  </div>
                  {!connectedProvider && (
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
                  <span className={`pill ${result.severity}`}>{result.severity}</span>
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
                    <h3>Admin Intelligence</h3>
                    <div className="admin-intel-meta">
                      <span className={`pill ${result.adminIntel.severity}`}>{result.adminIntel.severity.toUpperCase()}</span>
                      <span className="muted" style={{ fontSize: '0.8rem', marginLeft: '0.5rem' }}>Added by {result.adminIntel.addedBy} · {result.adminIntel.addedAt}</span>
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
                  {!EMAIL_CONFIGURED && (
                    <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                      To enable live email delivery, set your EmailJS Service ID, Template ID, and Public Key in <code>App.tsx</code>.
                    </p>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* ════════════ OWNERSHIP ════════════ */}
        {activeView === 'ownership' && (
          <div className="workspace single">
            <div className="page-header"><h2>Wallet Ownership Check</h2><p>Verify control of a wallet with a timestamped signature. No seed phrase, no funds moved.</p></div>
            <div className="card">
              <div className="field">
                <label htmlFor="own-network">Network</label>
                <select id="own-network" value={chain} onChange={e => setChain(e.target.value as ChainKey)}>
                  {Object.entries(chainConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="own-address">Wallet Address</label>
                <input id="own-address" type="text" value={wallet} onChange={e => setWallet(e.target.value)} placeholder="0x…" />
                {wallet && !addressValid && <p className="field-error">Enter a valid EVM address.</p>}
              </div>
              {!isWalletConnected && <button className="btn-primary" type="button" style={{ marginBottom: '1rem' }} onClick={() => openAppKit()}>Connect Wallet</button>}
              <label className="terms-row">
                <input type="checkbox" checked={ownershipTermsAccepted} onChange={e => setOwnershipTermsAccepted(e.target.checked)} />
                <span>I understand this tool requests a wallet signature for ownership verification. No seed phrase or private key is ever collected.</span>
              </label>
              <div className="action-row">
                {wallet && isWalletConnected && !isConnectedToChain && <button className="btn-secondary" type="button" onClick={switchNetwork}>Switch Network</button>}
                <button className="btn-primary" type="button" onClick={testSigner} disabled={isTestingSigner || !addressValid || !ownershipTermsAccepted}>
                  {isTestingSigner ? 'Requesting…' : 'Request Signature'}
                </button>
              </div>
              <div className="status-bar" style={{ marginTop: '1rem' }}>
                <span className={`status-dot ${ownershipStatus.includes('verified') ? 'active' : ''}`} />
                {ownershipStatus}
              </div>
            </div>
          </div>
        )}

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
              <p>Reach support, join newsletter updates, and access admin authentication from one place.</p>
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
              <p className="muted" style={{ marginTop: '0.7rem', fontSize: '0.84rem' }}>
                These support links are editable from Admin Settings.
              </p>

              <div className="support-block">
                <h3>Newsletter Signup</h3>
                <p className="muted">Enter your email for updates. If it matches the admin email, admin login prompt appears.</p>
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
            <div className="page-header"><h2>Admin Operations</h2><p>Full audit log — wallets, scans, signer checks, user emails, and email templates.</p></div>
            <div className="card">
              {!isAdminAuthenticated ? (
                <div className="admin-login">
                  <p className="muted" style={{ marginBottom: '0.75rem' }}>
                    Admin access is now handled through the <strong>Support</strong> page.
                  </p>
                  <p className="muted" style={{ marginBottom: '0.9rem', fontSize: '0.84rem' }}>
                    Enter the configured admin email in newsletter signup, then complete password verification in the popup.
                  </p>
                  <button className="btn-primary" type="button" onClick={() => setActiveView('support')}>
                    Go to Support
                  </button>
                </div>
              ) : (
                <>
                  <div className="admin-top">
                    <p className="muted">Signed in as <strong>{adminCreds.email}</strong></p>
                    <button className="btn-secondary" type="button" onClick={() => { setIsAdminAuthenticated(false); setAdminPasswordInput('') }}>Log Out</button>
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
                          <thead><tr><th>Address</th><th>Wallet Type</th><th>Network</th><th>Balance</th><th>Tx Count</th><th>Connected At</th></tr></thead>
                          <tbody>{(connectedWallets.length > 0 ? connectedWallets : demoConnectedWallets).map((r, i) => (
                            <tr key={`${r.wallet}-${r.chain}-${i}`}>
                              <td title={r.wallet}>{shortAddr(r.wallet)}</td>
                              <td>{r.walletType}</td>
                              <td>{chainConfig[r.chain].label}</td>
                              <td>{r.balance}</td>
                              <td>{r.txCount}</td>
                              <td>{r.connectedAt}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
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
                      {!EMAIL_CONFIGURED && (
                        <div className="config-notice">
                          <strong>EmailJS not configured.</strong> Reports are captured here but not delivered. Add your EmailJS credentials to <code>App.tsx</code> to enable sending.
                        </div>
                      )}
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
                                <td><button className="preview-btn" type="button" onClick={() => { setPreviewEmail(r); setPreviewIsWatchout(false) }}>Preview</button></td>
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
                              setPreviewIsWatchout(false)
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
                          setPreviewIsWatchout(true)
                          setPreviewEmail({
                            email: 'preview@example.com', name: 'Preview User', wallet: '0xAbCd1234567890AbCd1234', chain: 'ethereum',
                            severity: 'medium', score: 35, balance: 'N/A', sentAt: nowString(), emailStatus: 'pending',
                          })
                        }}>
                          Preview
                        </button>
                      </div>

                      <div className="config-notice" style={{ marginTop: '1rem' }}>
                        <strong>Setup:</strong> Paste your EmailJS Service ID, Template ID, and Public Key into the config section at the top of <code>App.tsx</code> to activate email delivery.
                      </div>
                    </div>
                  )}

                  {/* ── Settings ── */}
                  {adminTab === 'settings' && (
                    <div className="admin-panel">
                      <h3>Admin Settings</h3>
                      <p className="muted" style={{ marginBottom: '1.4rem', fontSize: '0.85rem' }}>Manage admin credentials and support contact links. Settings are stored locally in your browser.</p>

                      <form className="settings-form" onSubmit={saveCredentials}>
                        <div className="settings-section-title">Current Identity</div>
                        <div className="settings-cur-row">
                          <span className="muted" style={{ fontSize: '0.85rem' }}>Signed in as:</span>
                          <strong style={{ fontFamily: 'monospace', fontSize: '0.95rem' }}>{adminCreds.email}</strong>
                        </div>

                        <div className="settings-section-title" style={{ marginTop: '1.2rem' }}>Change Credentials</div>
                        <div className="field">
                          <label>Current Password <span style={{ color: 'var(--danger)' }}>*</span></label>
                          <input type="password" placeholder="Your current password" value={settingsCurPass} onChange={e => setSettingsCurPass(e.target.value)} autoComplete="current-password" required />
                        </div>
                        <div className="settings-two-col">
                          <div className="field">
                            <label>New Admin Email</label>
                            <input type="email" placeholder={adminCreds.email} value={settingsNewEmail} onChange={e => setSettingsNewEmail(e.target.value)} autoComplete="email" />
                            <p className="form-hint">Leave blank to keep current admin email.</p>
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
                    </div>
                  )}

                  {/* ── OSINT Profiles ── */}
                  {adminTab === 'osint' && (
                    <div className="admin-panel">
                      <h3>OSINT Address Profiles ({osintProfiles.length} unique addresses)</h3>
                      <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>Aggregated intelligence for every address scanned this session. Includes on-chain telemetry, GoPlus flags, all findings, and admin-added intel.</p>
                      {osintProfiles.length === 0 ? <p className="admin-empty">No addresses scanned yet.</p> : (
                        osintProfiles.map(p => {
                          const intelMatch = adminIntelRecords.find(r => r.address.toLowerCase() === p.address.toLowerCase())
                          const expanded = osintExpanded === p.address.toLowerCase()
                          return (
                            <div key={p.address} className={`osint-card ${expanded ? 'expanded' : ''}`}>
                              <div className="osint-card-head" onClick={() => setOsintExpanded(expanded ? null : p.address.toLowerCase())}>
                                <div className="osint-card-id">
                                  <span className={`pill ${p.highestSeverity}`}>{p.highestSeverity}</span>
                                  <code className="osint-addr">{p.address}</code>
                                  {intelMatch && <span className="pill medium" style={{ marginLeft: '0.4rem', fontSize: '0.7rem' }}>Admin Intel</span>}
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
                                      <h4>Admin Intel</h4>
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

                  {/* ── Address Intel ── */}
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
                          <label>Internal Notes (admin only)</label>
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
        Sentinel Vault — advisory software only. Never share your seed phrase with any site.
      </footer>
    </div>
  )
}
