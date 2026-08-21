/**
 * electron/realtime.ts
 * Polling client for pending print jobs.
 * Decoupled from direct Supabase database access (pure API client).
 *
 * Substituiu o stream SSE (GET /api/printer/jobs/stream) na 1.0.8: na Vercel,
 * uma conexão SSE aberta 24/7 é cobrada como memória provisionada durante toda
 * a requisição (~98,7% do custo de compute do projeto, ~US$ 27/mês por
 * impressora). Polling curto paga só pelos segundos de cada chamada.
 *
 * Flow:
 *   1. connect() starts the polling loop (cadeia de setTimeout, nunca
 *      setInterval — uma chamada lenta não pode empilhar a próxima por cima).
 *   2. authenticate() exchanges device_token for session_token.
 *   3. Cada tick: GET /api/printer/jobs → enfileira os jobs pendentes (o mesmo
 *      fetch que era o catch-up de reconexão na era do SSE; o 1º tick logo
 *      após autenticar continua fazendo esse papel de catch-up).
 *   4. O servidor dita o ritmo via `next_poll_ms` (3s com a loja ativa, 30s
 *      fechada). Campo opcional e clampado — ver resolveNextPollIntervalMs.
 *   5. 401 invalida a sessão e re-autentica; 429 respeita Retry-After;
 *      erro de rede/5xx entra em backoff exponencial.
 */

import { EventEmitter } from 'events'
import { app } from 'electron'
import { getConfig, setConfig, isConfigured } from './store'
import { addToQueue, getQueueStatus } from './print-queue'
import { maybeInstallOnSafeWindow, isStoreClosedPollInterval } from './updater'
import type { RenderedComanda } from './printer'
import { createLogger } from './logger'
import { resolveApiBaseUrl } from './config'

const log = createLogger('JOBS-POLL')

const BACKOFF_DELAYS = [2000, 5000, 10000, 30000, 60000] // Retry backoffs

// Ritmo do polling. O default vale só até o servidor mandar `next_poll_ms`;
// o clamp protege a frota de um valor absurdo vindo do servidor.
const DEFAULT_POLL_INTERVAL_MS = 3000
const MIN_POLL_INTERVAL_MS = 1000
const MAX_POLL_INTERVAL_MS = 60000

// 429: teto pro Retry-After — um header errado não pode congelar a impressora.
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000

// Teto do corpo de resposta ecoado em log: o suficiente pra ver a mensagem de
// erro da API, curto o bastante pra uma página HTML de erro não afogar o log
// que o suporte lê no computador da loja.
const MAX_LOGGED_BODY_CHARS = 200

// 'disconnected' só depois de falhas consecutivas: com tick de ~3s, um poll
// perdido não é queda real; piscar o status no Gestor a cada blip de rede
// confunde o dono. Na prática: 1ª falha segue "connected", 2ª derruba.
const CONSECUTIVE_FAILURES_BEFORE_DISCONNECTED = 2

// ─── Exported event emitter ───────────────────────────────────────────────────

/** Emits 'connected' | 'disconnected' | 'error' for the tray icon and renderer */
export const realtimeEvents = new EventEmitter()

// ─── State ────────────────────────────────────────────────────────────────────

let activeController: AbortController | null = null
let pollTimeout: ReturnType<typeof setTimeout> | null = null
let consecutiveFailures = 0
let isClientActive = false
let isCurrentlyConnected = false
/** Último ritmo aceito do servidor (contrato: ausente ⇒ mantém o anterior). */
let currentPollIntervalMs = DEFAULT_POLL_INTERVAL_MS
/**
 * Geração do loop: connect() e disconnect() incrementam; um tick antigo que
 * acorda de um await compara a própria geração e se encerra sem reagendar.
 * Junto com o timer único (pollTimeout) e o guard de isClientActive, é o que
 * garante que nunca existem dois loops de polling simultâneos.
 */
let pollGeneration = 0

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBackoffDelay(): number {
  const delay = BACKOFF_DELAYS[consecutiveFailures] ?? 60000
  consecutiveFailures++
  return delay
}

function clearPollTimer(): void {
  if (pollTimeout) {
    clearTimeout(pollTimeout)
    pollTimeout = null
  }
}

/**
 * Contrato do `next_poll_ms`: opcional — o servidor só manda quando recalcula
 * (no máx. 1×/min). Ausente ou inválido ⇒ mantém o último valor conhecido.
 * Presente ⇒ clamp em [1000, 60000] — nunca confiança cega no número.
 */
export function resolveNextPollIntervalMs(nextPollMs: unknown, lastKnownMs: number): number {
  if (typeof nextPollMs !== 'number' || !Number.isFinite(nextPollMs)) return lastKnownMs
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.round(nextPollMs)))
}

/**
 * Retry-After de um 429: segundos (forma comum) ou HTTP-date. Inválido ⇒ null
 * (o caller cai no backoff exponencial). Clampado pra nem virar retry
 * imediato nem congelar a impressora por horas.
 */
export function parseRetryAfterMs(header: string | null, nowMs: number = Date.now()): number | null {
  if (!header) return null
  const trimmed = header.trim()
  const asSeconds = Number(trimmed)
  const rawMs = trimmed !== '' && Number.isFinite(asSeconds)
    ? asSeconds * 1000
    : Date.parse(trimmed) - nowMs
  if (Number.isNaN(rawMs)) return null
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_POLL_INTERVAL_MS, rawMs))
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
    const url = `${resolveApiBaseUrl(cfg)}/api/printer/auth`
    const res = await fetch(url, {
      method: 'POST',
      // O corpo leva o device_token: seguir um redirect reenviaria o segredo
      // pro destino da redireção. O endpoint legítimo nunca redireciona (a
      // base já é canonizada na gravação do pareamento) — se redirecionar,
      // é erro, não caminho feliz.
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_token: cfg.device_token,
        paper_size: cfg.paper_size,
        // Versão do app instalada nesta loja — fonte canônica do Electron
        // (a mesma que o /status local reporta). Campo OPCIONAL no servidor:
        // servidor antigo simplesmente ignora. Sem isto é impossível saber
        // quais lojas rodam versão velha (2 de 3 ficaram na 1.0.7, em
        // streaming ~91% mais caro, sem ninguém perceber).
        app_version: app.getVersion(),
        // `columns` só vai quando o usuário calibrou de verdade (ver
        // AppConfig.columns em store.ts) — nunca inferido a partir de
        // paper_size. Mandar um palpite como se fosse medição é o erro que
        // o servidor foi corrigido para não cometer.
        ...(cfg.columns !== undefined && { columns: cfg.columns }),
      }),
    })

    if (!res.ok) {
      const errText = (await res.text().catch(() => '')).slice(0, MAX_LOGGED_BODY_CHARS)
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

// ─── Poll de jobs pendentes ───────────────────────────────────────────────────

type PollResult =
  | { status: 'ok' }
  | { status: 'unauthorized' }
  | { status: 'rate_limited'; retryAfterMs: number | null }
  | { status: 'server_error'; httpStatus: number }
  | { status: 'network_error' }

/**
 * Busca os jobs pendentes e enfileira cada um. Era o fetch de "catch-up" da
 * reconexão do SSE — hoje é o corpo de cada tick do polling. Usa `fetch` de
 * propósito (o cliente HTTP clássico não completava conexões com a nuvem no
 * ambiente do Electron). Erros de rede propagam para o caller.
 *
 * Campos novos no JSON são opcionais: o servidor evolui de forma aditiva.
 *
 * Recebe a base da API pronta em vez de reler o store: `getConfig()` faz
 * readFileSync + JSON.parse a cada chamada, e o caller já tem a config em mão
 * neste mesmo tick (a cada 3 s, para sempre, em cada loja).
 */
async function fetchAndEnqueuePendingJobs(
  apiBaseUrl: string,
  sessionToken: string,
  signal: AbortSignal
): Promise<PollResult> {
  const url = `${apiBaseUrl}/api/printer/jobs`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
    signal,
  })

  if (res.status === 401) return { status: 'unauthorized' }
  if (res.status === 429) {
    return {
      status: 'rate_limited',
      retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
    }
  }
  if (!res.ok) return { status: 'server_error', httpStatus: res.status }

  const data = (await res.json()) as {
    jobs?: Array<{
      id: string
      order_id: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      order: any
      render?: RenderedComanda[]
      resolved_columns?: number
    }>
    /** Ritmo pedido pelo servidor; só vem quando ele recalcula (máx. 1×/min) */
    next_poll_ms?: number
  }

  if (data.jobs && data.jobs.length > 0) {
    log.info(`Poll: found ${data.jobs.length} pending print jobs`)
    for (const job of data.jobs) {
      addToQueue(job.id, job.order_id, job.order, job.render, job.resolved_columns)
    }
  }

  // Contrato: `next_poll_ms` só é considerado em resposta 200 — por isso a
  // leitura vive aqui, depois de todos os early-returns de status.
  currentPollIntervalMs = resolveNextPollIntervalMs(data.next_poll_ms, currentPollIntervalMs)

  return { status: 'ok' }
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

function scheduleNextPoll(generation: number, delayMs: number): void {
  if (!isClientActive || generation !== pollGeneration) return
  clearPollTimer()
  pollTimeout = setTimeout(() => {
    pollTick(generation).catch((err) => {
      // pollTick trata os próprios erros; isto é a última linha de defesa pra
      // uma rejeição inesperada não matar a cadeia de polling.
      log.error('pollTick promise rejection:', err instanceof Error ? err.message : String(err))
      handlePollFailure(generation, null)
    })
  }, delayMs)
}

/**
 * Pós-tick OK: entrega ao updater os sinais da janela segura de instalação
 * (loja fechada = ritmo de poll de loja fechada ditado pelo servidor; fila
 * local vazia). Blindado de propósito: uma falha do updater NUNCA pode
 * derrubar o polling que imprime pedidos reais.
 */
function reportUpdateSafeWindowSignals(): void {
  try {
    maybeInstallOnSafeWindow({
      storeClosed: isStoreClosedPollInterval(currentPollIntervalMs),
      queueEmpty: getQueueStatus().length === 0,
    })
  } catch (err) {
    log.error('Updater signal error (ignorado):', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Falha de um tick: agenda retry (backoff exponencial, ou o delay explícito
 * de um Retry-After) e emite 'disconnected' só quando a falha persiste.
 */
function handlePollFailure(generation: number, delayOverrideMs: number | null): void {
  const backoffDelay = getBackoffDelay()
  if (isCurrentlyConnected && consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_DISCONNECTED) {
    isCurrentlyConnected = false
    realtimeEvents.emit('disconnected')
  }
  const delay = delayOverrideMs ?? backoffDelay
  log.info(`Scheduling next poll attempt in ${delay}ms…`)
  scheduleNextPoll(generation, delay)
}

/**
 * Um tick do polling: autentica se não houver sessão, busca/enfileira os jobs
 * pendentes e agenda o próximo tick. Ao voltar ao normal depois de falhas,
 * zera o backoff e retoma o ritmo ditado pelo servidor.
 */
async function pollTick(generation: number): Promise<void> {
  if (!isClientActive || generation !== pollGeneration) return

  let cfg = getConfig()
  if (!cfg.session_token) {
    let authenticated = false
    try {
      authenticated = await authenticate()
    } catch (err) {
      // authenticate() emite 'error' no realtimeEvents — sem nenhum listener
      // registrado o EventEmitter RELANÇA o erro; isso não pode matar o loop.
      log.error('authenticate() threw:', err instanceof Error ? err.message : String(err))
    }
    if (!isClientActive || generation !== pollGeneration) return
    if (!authenticated) {
      handlePollFailure(generation, null)
      return
    }
    cfg = getConfig()
  }

  const controller = new AbortController()
  activeController = controller
  let result: PollResult
  try {
    result = await fetchAndEnqueuePendingJobs(
      resolveApiBaseUrl(cfg),
      cfg.session_token!,
      controller.signal
    )
  } catch (err) {
    // abort() proposital (disconnect/reconfigure) não é erro real
    if (controller.signal.aborted) return
    log.error('Jobs poll request error:', err instanceof Error ? err.message : String(err))
    result = { status: 'network_error' }
  } finally {
    if (activeController === controller) activeController = null
  }

  if (!isClientActive || generation !== pollGeneration) return

  switch (result.status) {
    case 'ok':
      consecutiveFailures = 0
      if (!isCurrentlyConnected) {
        isCurrentlyConnected = true
        realtimeEvents.emit('connected')
      }
      scheduleNextPoll(generation, currentPollIntervalMs)
      // Depois de já ter agendado o próximo tick: nada aqui afeta o loop.
      reportUpdateSafeWindowSignals()
      return
    case 'unauthorized':
      // Sessão expirada/revogada: zera e re-autentica no próximo tick.
      log.warn('Jobs poll unauthorized (401). Invalidating session and re-authenticating…')
      setConfig({ session_token: undefined })
      handlePollFailure(generation, null)
      return
    case 'rate_limited':
      log.warn(
        `Jobs poll rate-limited (429). Retry-After: ${result.retryAfterMs ?? 'ausente (backoff)'}`
      )
      handlePollFailure(generation, result.retryAfterMs)
      return
    case 'server_error':
      log.error(`Jobs poll returned status code ${result.httpStatus}`)
      handlePollFailure(generation, null)
      return
    case 'network_error':
      handlePollFailure(generation, null)
      return
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Starts the authentication and polling loop.
 */
export async function connect(): Promise<void> {
  if (!isConfigured()) {
    log.warn('Cannot connect: app is not configured')
    return
  }

  if (isClientActive) return
  isClientActive = true

  log.info('Starting print jobs polling client…')
  consecutiveFailures = 0
  clearPollTimer()
  const generation = ++pollGeneration

  // Primeiro tick imediato (autentica e faz o catch-up dos jobs pendentes).
  // Disparado em segundo plano — NÃO dá await: connect() é chamado pelo POST
  // /configure, e um fetch pendurado travaria o "salvar impressora/papel"
  // (foi o que quebrou na 1.0.1, quando connect() esperava o loop do SSE).
  scheduleNextPoll(generation, 0)
}

/**
 * Stops the polling loop and clears all timers.
 */
export async function disconnect(): Promise<void> {
  log.info('Stopping print jobs polling client…')
  isClientActive = false
  // Invalida qualquer tick em voo: ao acordar de um await ele vê a geração
  // nova e se encerra sem reagendar.
  pollGeneration++

  clearPollTimer()

  if (activeController) {
    activeController.abort()
    activeController = null
  }

  if (isCurrentlyConnected) {
    isCurrentlyConnected = false
    realtimeEvents.emit('disconnected')
  }
}

/**
 * Returns whether the polling client is currently connected successfully.
 */
export function getConnectionStatus(): boolean {
  return isCurrentlyConnected
}
