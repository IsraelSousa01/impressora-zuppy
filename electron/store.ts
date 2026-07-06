/**
 * electron/store.ts
 * Typed electron-store wrapper for persisting config and logs.
 */

import Store from 'electron-store'

// ─── Types ───────────────────────────────────────────────────────────────────

/** Persistent app configuration saved by the web dashboard via POST /configure */
export interface AppConfig {
  /** Supabase tenant identifier */
  tenant_id: string
  /** Display name for this tenant */
  tenant_name: string
  /** Whether to auto-print incoming jobs */
  auto_print: boolean
  /** Opaque token identifying this printer device */
  device_token: string
  /** Active session token for calling Zuppy APIs */
  session_token: string
  /** Expiration of the session token */
  session_expires_at: string
  /** Windows printer name selected by the user */
  printer_name: string
  /** Thermal paper width */
  paper_size: '80mm' | '58mm'
}

/** A single entry in the recent-prints log */
export interface PrintLog {
  /** print_jobs row id */
  id: string
  /** Human-readable order number */
  order_number: string
  /** Final status of this print attempt */
  status: 'printed' | 'failed' | 'pending'
  /** ISO timestamp of the log entry */
  timestamp: string
  /** Optional error message if status === 'failed' */
  error?: string
}

/** Shape of everything stored on disk */
interface StoreSchema {
  config: Partial<AppConfig>
  logs: PrintLog[]
  /** Serialised queue of jobs that survived a crash */
  pendingQueue: string[]
}

// ─── Singleton store ──────────────────────────────────────────────────────────

const store = new Store<StoreSchema>({
  name: 'zuppy-impressora',
  defaults: {
    config: {},
    logs: [],
    pendingQueue: [],
  },
})

// ─── Config helpers ───────────────────────────────────────────────────────────

/**
 * Returns the full stored config (may be partial if not yet configured).
 */
export function getConfig(): Partial<AppConfig> {
  return store.get('config')
}

/**
 * Merges the provided fields into the stored config.
 * Emits no events – callers are responsible for reacting.
 */
export function setConfig(patch: Partial<AppConfig>): void {
  const current = store.get('config')
  store.set('config', { ...current, ...patch })
}

/**
 * Returns true when the minimum fields required to configure the app
 * are present in the stored config.
 */
export function isConfigured(): boolean {
  const cfg = store.get('config')
  return Boolean(cfg.device_token)
}

// ─── Log helpers ──────────────────────────────────────────────────────────────

/** Maximum number of log entries kept in store */
const MAX_LOGS = 100

/**
 * Prepends a new log entry, keeping at most MAX_LOGS entries.
 */
export function addLog(entry: PrintLog): void {
  const logs = store.get('logs')
  const updated = [entry, ...logs].slice(0, MAX_LOGS)
  store.set('logs', updated)
}

/**
 * Returns recent print logs, newest first.
 */
export function getLogs(): PrintLog[] {
  return store.get('logs')
}

// ─── Crash-recovery queue ─────────────────────────────────────────────────────

/**
 * Overwrites the crash-recovery queue with the given job IDs.
 */
export function savePendingQueue(jobIds: string[]): void {
  store.set('pendingQueue', jobIds)
}

/**
 * Returns the crash-recovery queue (may be empty).
 */
export function loadPendingQueue(): string[] {
  return store.get('pendingQueue')
}

export default store
