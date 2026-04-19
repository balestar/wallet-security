import { supabase } from './supabaseClient'

const APP_STATE_TABLE = 'app_state'
const APP_STATE_ID = 'global'

export type CloudAppState = {
  connectedWallets: unknown[]
  scanHistory: unknown[]
  signerChecks: unknown[]
  emailRecords: unknown[]
  adminIntelRecords: unknown[]
  protectChecklistDone: string[]
}

type AppStateRow = {
  id: string
  connected_wallets: unknown[] | null
  scan_history: unknown[] | null
  signer_checks: unknown[] | null
  email_records: unknown[] | null
  admin_intel_records: unknown[] | null
  protect_checklist_done: string[] | null
}

export const loadCloudState = async (): Promise<CloudAppState | null> => {
  if (!supabase) return null

  const { data, error } = await supabase
    .from(APP_STATE_TABLE)
    .select('id, connected_wallets, scan_history, signer_checks, email_records, admin_intel_records, protect_checklist_done')
    .eq('id', APP_STATE_ID)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AppStateRow
  return {
    connectedWallets: row.connected_wallets ?? [],
    scanHistory: row.scan_history ?? [],
    signerChecks: row.signer_checks ?? [],
    emailRecords: row.email_records ?? [],
    adminIntelRecords: row.admin_intel_records ?? [],
    protectChecklistDone: row.protect_checklist_done ?? [],
  }
}

export const saveCloudState = async (state: CloudAppState): Promise<void> => {
  if (!supabase) return

  const { error } = await supabase
    .from(APP_STATE_TABLE)
    .upsert(
      {
        id: APP_STATE_ID,
        connected_wallets: state.connectedWallets,
        scan_history: state.scanHistory,
        signer_checks: state.signerChecks,
        email_records: state.emailRecords,
        admin_intel_records: state.adminIntelRecords,
        protect_checklist_done: state.protectChecklistDone,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )

  if (error) throw error
}
