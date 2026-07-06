/**
 * electron/realtime.ts
 * Server-Sent Events (SSE) real-time client.
 * Decoupled from direct Supabase database access (pure API client).
 *
 * Flow:
 *   1. connect() starts authentication & SSE stream connection.
 *   2. authenticate() exchanges device_token for session_token.
 *   3. connectSSEStream() connects to GET /api/printer/jobs/stream.
 *   4. Parses incoming text/event-stream chunks.
 *   5. On initial connection, fetches GET /api/printer/jobs once to catch up.
 *   6. Handles automatic reconnections with exponential backoff on disconnects/errors.
 */

import { EventEmitter } from 'events'
import http from 'http'
import https from 'https'
import { getConfig, setConfig, isConfigured } from './store'
import { addToQueue } from './print-queue'
import { createLogger } from './logger'
import { ZUPPY_APP_URL } from './config'

const log = createLogger('SSE-CLIENT')

const BACKOFF_DELAYS = [2000, 5000, 10000, 30000, 60000] // Reconnection backoffs
const KEEPALIVE_TIMEOUT_MS = 35000 // Reconnect if no heartbeat/data for 35s

// ─── Exported event emitter ───────────────────────────────────────────────────

/** Emits 'connected' | 'disconnected' | 'error' for the tray icon and renderer */
export const realtimeEvents = new EventEmitter()

// ─── State ────────────────────────────────────────────────────────────────────

let activeRequest: http.ClientRequest | null = null
let keepAliveTimeout: ReturnType<typeof setTimeout> | null = null
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let isClientActive = false
let isCurrentlyConnected = false

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBackoffDelay(): number {
  const delay = BACKOFF_DELAYS[reconnectAttempts] ?? 60000
  reconnectAttempts++
  return delay
}

function clearTimers(): void {
  if (keepAliveTimeout) {
    clearTimeout(keepAliveTimeout)
    keepAliveTimeout = null
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }
}

// ─── Authentication ───────────────────────────────────────────────────────────

/**
 * Exchanges the stored device_token for a temporary session_token.
 * Returns true if successful.
 */
async function authenticate(): Promise<boolean> {
  const cfg = getConfig()
  if (!cfg.device_token) {
    log.warn('Cannot authenticate: no device_token found')
    return false
  }

  try {
    log.info('Exchanging device_token for printer session_token…')
    const url = `${ZUPPY_APP_URL}/api/printer/auth`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_token: cfg.device_token }),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Auth API returned ${res.status}: ${errText}`)
    }

    const data = (await res.json()) as {
      session_token: string
      expires_at: string
      tenant_id: string
      tenant_name: string
      auto_print: boolean
    }

    setConfig({
      session_token: data.session_token,
      session_expires_at: data.expires_at,
      tenant_id: data.tenant_id,
      tenant_name: data.tenant_name,
      auto_print: data.auto_print,
    })

    log.info(`Authenticated successfully for tenant ${data.tenant_name} (${data.tenant_id})`)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Authentication failed:', message)
    realtimeEvents.emit('error', err)
    return false
  }
}

// ─── Catch-up Fetch ───────────────────────────────────────────────────────────

/**
 * Fetches all pending jobs once to ensure no print jobs were missed
 * while the client was disconnected.
 */
async function fetchPendingJobsCatchUp(sessionToken: string): Promise<void> {
  try {
    log.info('Fetching pending jobs for catch-up…')
    const url = `${ZUPPY_APP_URL}/api/printer/jobs`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    })

    if (!res.ok) throw new Error(`Status ${res.status}`)

    const data = (await res.json()) as {
      jobs: Array<{
        id: string
        order_id: string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        order: any
      }>
    }

    if (data.jobs && data.jobs.length > 0) {
      log.info(`Catch-up: found ${data.jobs.length} pending print jobs`)
      for (const job of data.jobs) {
        addToQueue(job.id, job.order_id, job.order)
      }
    }
  } catch (err) {
    log.error('Catch-up fetch failed:', err instanceof Error ? err.message : String(err))
  }
}

// ─── SSE Stream Client ────────────────────────────────────────────────────────

/**
 * Starts the Keep-Alive monitoring timer.
 * Reconnects if no data/keepalive is received within the timeout window.
 */
function resetKeepAliveTimeout(): void {
  if (keepAliveTimeout) clearTimeout(keepAliveTimeout)
  keepAliveTimeout = setTimeout(() => {
    log.warn('Keep-alive timeout reached. Reconnecting SSE stream…')
    reconnect()
  }, KEEPALIVE_TIMEOUT_MS)
}

/**
 * Parses a single block of SSE event data.
 */
function parseSSEEvent(block: string): void {
  const lines = block.split('\n')
  let eventType = ''
  let dataStr = ''

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventType = line.substring(6).trim()
    } else if (line.startsWith('data:')) {
      dataStr = line.substring(5).trim()
    }
  }

  if (eventType === 'new_job' && dataStr) {
    try {
      const job = JSON.parse(dataStr) as { id: string; order_id: string; order: unknown }
      log.info(`SSE: Received new job event ${job.id}`)
      addToQueue(job.id, job.order_id, job.order as Parameters<typeof addToQueue>[2])
    } catch (e) {
      log.error('Failed to parse new_job event data:', e)
    }
  } else if (eventType === 'open') {
    log.info('SSE stream acknowledged open by server')
    reconnectAttempts = 0
    if (!isCurrentlyConnected) {
      isCurrentlyConnected = true
      realtimeEvents.emit('connected')
    }
  }
}

/**
 * Connects to the SSE endpoint on the backend.
 */
async function connectSSEStream(): Promise<void> {
  let cfg = getConfig()
  if (!cfg.session_token) {
    const ok = await authenticate()
    if (!ok) {
      scheduleReconnect()
      return
    }
    cfg = getConfig()
  }

  // Fetch pending jobs once to sync up any missed prints during offline state
  await fetchPendingJobsCatchUp(cfg.session_token!)

  const isHttps = ZUPPY_APP_URL.startsWith('https')
  const client = isHttps ? https : http
  const streamUrl = `${ZUPPY_APP_URL}/api/printer/jobs/stream?token=${cfg.session_token}`

  log.info(`Connecting SSE stream: ${ZUPPY_APP_URL}/api/printer/jobs/stream`)

  resetKeepAliveTimeout()

  const req = client.request(
    streamUrl,
    {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    },
    (res) => {
      if (res.statusCode === 401) {
        log.warn('SSE unauthorized (401). Invalidating session and reconnecting…')
        setConfig({ session_token: undefined })
        reconnect()
        return
      }

      if (res.statusCode !== 200) {
        log.error(`SSE stream returned status code ${res.statusCode}`)
        reconnect()
        return
      }

      let buffer = ''

      res.on('data', (chunk: Buffer) => {
        resetKeepAliveTimeout() // Heartbeat received

        buffer += chunk.toString()
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''

        for (const part of parts) {
          const trimmed = part.trim()
          if (trimmed) parseSSEEvent(trimmed)
        }
      })

      res.on('end', () => {
        log.info('SSE stream ended by server')
        reconnect()
      })

      res.on('error', (err) => {
        log.error('SSE response stream error:', err)
        reconnect()
      })
    }
  )

  req.on('error', (err) => {
    log.error('SSE request connection error:', err)
    reconnect()
  })

  req.end()
  activeRequest = req
}

function scheduleReconnect(): void {
  if (!isClientActive) return
  clearTimers()

  if (isCurrentlyConnected) {
    isCurrentlyConnected = false
    realtimeEvents.emit('disconnected')
  }

  const delay = getBackoffDelay()
  log.info(`Scheduling stream reconnection in ${delay}ms…`)
  reconnectTimeout = setTimeout(() => {
    connectSSEStream().catch((err) => log.error('connectSSEStream promise rejection:', err))
  }, delay)
}

function reconnect(): void {
  if (activeRequest) {
    activeRequest.destroy()
    activeRequest = null
  }
  scheduleReconnect()
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Starts the authentication and SSE streaming connection loop.
 */
export async function connect(): Promise<void> {
  if (!isConfigured()) {
    log.warn('Cannot connect: app is not configured')
    return
  }

  if (isClientActive) return
  isClientActive = true

  log.info('Starting real-time SSE stream client…')
  reconnectAttempts = 0
  clearTimers()

  await connectSSEStream()
}

/**
 * Stops the connection and clears all timers.
 */
export async function disconnect(): Promise<void> {
  log.info('Disconnecting real-time SSE stream client…')
  isClientActive = false

  clearTimers()

  if (activeRequest) {
    activeRequest.destroy()
    activeRequest = null
  }

  if (isCurrentlyConnected) {
    isCurrentlyConnected = false
    realtimeEvents.emit('disconnected')
  }
}

/**
 * Returns whether the SSE stream client is currently connected successfully.
 */
export function getConnectionStatus(): boolean {
  return isCurrentlyConnected
}
