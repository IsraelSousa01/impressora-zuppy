/**
 * electron/print-queue.ts
 * In-memory print queue with crash-recovery, retry logic, and event emission.
 * decoupled from direct Supabase database access (pure API client).
 *
 * Architecture:
 *   HTTP Polling -> queue.add(job, orderId, orderData)
 *     → processQueue()
 *        → printOrder() using pre-fetched orderData (or fetch via Zuppy API if missing)
 *        → confirmJobStatus() via PATCH /api/printer/jobs/[id]/confirm
 *        → on failure → exponential backoff retry (max 5 attempts)
 */

import { EventEmitter } from 'events'
import { printOrder, printRenderedComandas, type OrderData, type RenderedComanda } from './printer'
import { getConfig, savePendingQueue, addLog } from './store'
import { createLogger, logPrintResult } from './logger'
import { ZUPPY_APP_URL } from './config'

const log = createLogger('QUEUE')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PrintJob {
  /** UUID from print_jobs table */
  id: string
  /** Foreign key to orders table */
  order_id: string
  /** Human-readable order number (for logs) */
  order_number?: string
  /** Current retry count */
  retries: number
  /** ISO timestamp when the job entered the queue */
  enqueuedAt: string
  /** Pre-fetched order data from polling */
  order?: OrderData
  /** Comandas já renderizadas pelo servidor (M1 P2/P3). Se presente, imprime estes bytes em vez de montar local. */
  render?: RenderedComanda[]
  /** Já foi impresso? Trava reimpressão quando só o confirm falha e o job retenta. */
  printed?: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 5
/** Backoff delays in ms: 1s, 2s, 4s, 8s, 16s */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]

// ─── Queue state ──────────────────────────────────────────────────────────────

/** Exported event emitter so the tray/window can listen for updates */
export const queueEvents = new EventEmitter()

let queue: PrintJob[] = []
let processing = false

/**
 * IDs de jobs já impressos nesta sessão do app. Barra reimpressão quando o
 * mesmo job é re-entregue (ex.: catch-up de reconexão do stream). A fonte de
 * verdade cross-sessão é o status 'printed' no servidor (o catch-up só traz
 * 'pending'); isto cobre a janela até o confirm pegar.
 */
const printedJobIds = new Set<string>()

// ─── Queue persistence ────────────────────────────────────────────────────────

function persistQueue(): void {
  savePendingQueue(queue.map((j) => j.id))
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Fetches order data + server-rendered comandas from the Next.js API.
 * Used only when the enqueued job has no pre-fetched data (e.g. crash recovery).
 */
async function fetchJobData(orderId: string): Promise<{ order: OrderData; render?: RenderedComanda[] }> {
  const cfg = getConfig()
  if (!cfg.session_token) throw new Error('No printer session active')

  const url = `${ZUPPY_APP_URL}/api/printer/orders/${orderId}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${cfg.session_token}`,
    },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Order fetch API returned ${res.status}: ${text}`)
  }

  const data = (await res.json()) as { order: OrderData; render?: RenderedComanda[] }
  if (!data.order) throw new Error(`Order ${orderId} not returned by API`)

  return { order: data.order, render: data.render }
}

/**
 * Calls the Zuppy backend to confirm a job was printed successfully.
 */
async function confirmPrinted(jobId: string): Promise<void> {
  await confirmJobStatus(jobId, 'printed')
}

/**
 * Calls the Zuppy backend to mark a job as definitively failed.
 */
async function confirmFailed(jobId: string, errorMsg: string): Promise<void> {
  await confirmJobStatus(jobId, 'failed', errorMsg)
}

async function confirmJobStatus(
  jobId: string,
  status: 'printed' | 'failed',
  error?: string
): Promise<void> {
  const cfg = getConfig()
  if (!cfg.session_token) throw new Error('No printer session active')

  const url = `${ZUPPY_APP_URL}/api/printer/jobs/${jobId}/confirm`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.session_token}`,
    },
    body: JSON.stringify({
      status,
      ...(error ? { error } : {}),
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Confirm API returned ${res.status}: ${text}`)
  }
}

/**
 * Processes a single print job: fetch (if needed) → print → confirm.
 * On failure, reschedules with exponential backoff up to MAX_RETRIES.
 */
async function processJob(job: PrintJob): Promise<void> {
  const cfg = getConfig()
  const printerName = cfg.printer_name

  if (!printerName) {
    log.warn(`Job ${job.id}: no printer configured, skipping`)
    return
  }

  try {
    log.info(`Processing job ${job.id} (attempt ${job.retries + 1}/${MAX_RETRIES + 1})`)

    // Imprime UMA vez só. Se já imprimiu antes (retry porque só o confirm
    // falhou), NÃO reimprime — apenas re-tenta o confirm. É isto que impede o
    // loop de reimpressão quando o confirm dá erro (ex.: 401 do redirect).
    if (!job.printed) {
      // Garante o `order` disponível (fallback local sempre possível). Só busca
      // se faltar — crash-recovery restaura só os IDs; o servidor traz render[]
      // junto no fetch. fetchJobData lança se a API não devolver order.
      if (!job.order) {
        const fetched = await fetchJobData(job.order_id)
        job.order = fetched.order
        if (!job.render) job.render = fetched.render
      }
      job.order_number = String(job.order.order_number)

      // Cliente-burro: prefere os bytes já renderizados pelo servidor (comanda
      // configurável). Guard de papel: o servidor renderiza 48 col (80mm) hoje;
      // num 58mm cai no build local pra não sair torto (sync de largura vem depois).
      const paper58 = cfg.paper_size === '58mm'
      const renderable =
        Array.isArray(job.render) && job.render.length > 0 ? job.render : null
      if (renderable && !paper58) {
        await printRenderedComandas(renderable, printerName)
      } else {
        if (renderable && paper58) {
          log.info(`Job ${job.id}: render[] do servidor ignorado (papel 58mm), usando build local`)
        }
        await printOrder(job.order, printerName)
      }
      job.printed = true
      printedJobIds.add(job.id)
    }

    await confirmPrinted(job.id)

    logPrintResult({
      id: job.id,
      order_number: job.order_number ?? job.order_id,
      status: 'printed',
      timestamp: new Date().toISOString(),
    })

    queueEvents.emit('jobDone', { jobId: job.id, status: 'printed' })
    log.info(`Job ${job.id} completed`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`Job ${job.id} failed: ${message}`)

    if (job.retries < MAX_RETRIES) {
      job.retries += 1
      const delay = BACKOFF_MS[job.retries - 1] ?? 16000
      log.info(`Retrying job ${job.id} in ${delay}ms (retry ${job.retries}/${MAX_RETRIES})`)

      queueEvents.emit('jobRetry', { jobId: job.id, retries: job.retries, delay })

      // Put job back at the front of the queue after the delay
      setTimeout(() => {
        queue.unshift(job)
        persistQueue()
        processQueue()
      }, delay)
    } else {
      log.error(`Job ${job.id} exceeded max retries, dropping`)

      // Notify backend so it marks the job as failed (not stuck as pending)
      confirmFailed(job.id, message).catch((e) =>
        log.warn(`Failed to confirm job failure on backend: ${e}`)
      )

      logPrintResult({
        id: job.id,
        order_number: job.order_number ?? job.order_id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: message,
      })

      queueEvents.emit('jobDone', { jobId: job.id, status: 'failed' })
    }
  }
}

/**
 * Drains the queue sequentially.
 * Called whenever a new job is added or a retry fires.
 */
async function processQueue(): Promise<void> {
  if (processing || queue.length === 0) return
  processing = true

  while (queue.length > 0) {
    const job = queue.shift()!
    persistQueue()
    queueEvents.emit('queueUpdate', { length: queue.length })
    await processJob(job)
  }

  processing = false
  queueEvents.emit('queueUpdate', { length: 0 })
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Adds a new print job to the queue and starts processing.
 *
 * @param jobId   - UUID from print_jobs table
 * @param orderId - UUID of the related order
 * @param order   - Optional pre-fetched order data
 * @param render  - Optional server-rendered comandas (M1 P2/P3); imprime estes bytes se presente
 */
export function addToQueue(jobId: string, orderId: string, order?: OrderData, render?: RenderedComanda[]): void {
  // Já impresso nesta sessão (ex.: re-entrega pelo catch-up de reconexão) →
  // não reimprime.
  if (printedJobIds.has(jobId)) {
    log.warn(`Job ${jobId} já impresso, ignorando re-entrega`)
    return
  }
  // Deduplicate: don't add if already in queue
  if (queue.some((j) => j.id === jobId)) {
    log.warn(`Job ${jobId} already in queue, skipping`)
    return
  }

  const job: PrintJob = {
    id: jobId,
    order_id: orderId,
    retries: 0,
    enqueuedAt: new Date().toISOString(),
    order,
    render,
  }

  if (order) {
    job.order_number = String(order.order_number)
  }

  queue.push(job)
  persistQueue()

  addLog({
    id: jobId,
    order_number: job.order_number ?? orderId,
    status: 'pending',
    timestamp: job.enqueuedAt,
  })

  queueEvents.emit('queueUpdate', { length: queue.length })
  log.info(`Job ${jobId} added to queue (depth: ${queue.length})`)

  // Don't await – fire and forget
  processQueue().catch((err) => log.error('processQueue threw', err))
}

/**
 * Returns a snapshot of the current queue state.
 */
export function getQueueStatus(): { length: number; jobs: PrintJob[] } {
  return { length: queue.length, jobs: [...queue] }
}

/**
 * Restores persisted job IDs from a previous crash session.
 * Adds placeholder jobs that will be retried (and fetch their order data from API).
 *
 * @param jobIds - Array of job IDs from loadPendingQueue()
 */
export function restoreQueue(jobIds: string[]): void {
  if (jobIds.length === 0) return
  log.info(`Restoring ${jobIds.length} jobs from crash recovery`)

  for (const id of jobIds) {
    if (!queue.some((j) => j.id === id)) {
      queue.push({
        id,
        order_id: id, // We don't have the order_id; processJob will fetch via enqueued order_id if it matches or it will fail and fetch
        retries: 0,
        enqueuedAt: new Date().toISOString(),
      })
    }
  }

  persistQueue()
  processQueue().catch((err) => log.error('restoreQueue processQueue threw', err))
}
