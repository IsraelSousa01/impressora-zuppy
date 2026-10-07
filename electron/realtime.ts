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
 *   6. Versão do app diferente da que emitiu a sessão guardada ⇒ UM handshake
 *      novo, para o servidor registrar a versão que está mesmo instalada
 *      (ver isSessionFromOtherAppVersion).
 *   7. Sinal de acordar (1.5.0, ver wake.ts): todo poll manda
 *      `X-Printer-App-Version` e `X-Printer-Wake`; com o sinal saudável o poll
 *      de segurança vai a `next_poll_ms_with_wake` (30 s) e cada sinal dispara
 *      um poll imediato (`wakeNow`, um por vez, com intervalo mínimo). Sem sinal
 *      saudável, nada muda: ritmo de `next_poll_ms`, como na 1.4.0.
 */

import { EventEmitter } from 'events'
import { app } from 'electron'
import { getConfig, setConfig, isConfigured, type AppConfig } from './store'
import { addToQueue, getQueueStatus, queueEvents } from './print-queue'
import { maybeInstallOnSafeWindow, isStoreClosedForUpdate } from './updater'
import type { RenderedComanda } from './printer'
import { createLogger } from './logger'
import { resolveApiBaseUrl } from './config'
import { parsePrinterDestination, type PrinterDestination } from './destination'
import { decidePanelPaperSize, panelPaperPatch, parsePanelPaperSize, type PaperSize } from './paper-sync'
import {
  WakeController,
  NEXT_POLL_MS_WITH_WAKE,
  choosePollIntervalMs,
  reconnectJitterMs,
  type PollTrigger,
  type WakeSocketFactory,
} from './wake'

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

// Sinal de acordar. Intervalo mínimo entre o início de um tick e um poll fora
// do ritmo (sinal, repoll): uma enxurrada de sinais falsos (o canal é público
// para quem tem o tópico) nunca passa de 1 poll a cada 2 s — abaixo da carga do
// poll de 3 s de hoje e do limite de 120/min por sessão no servidor.
export const MIN_OUT_OF_PACE_POLL_GAP_MS = 2000
/** Poll do sinal voltou vazio (o job pode não estar visível ainda): repoll único depois disto. */
export const EMPTY_SIGNAL_REPOLL_MS = 2000
/**
 * Depois de reportar falha de impressão (PATCH concluído): a nova tentativa no
 * servidor é `pending → pending` e não emite sinal; com o poll a 30 s ela atrasaria.
 */
export const FAILED_JOB_REPOLL_MS = 2000

// ─── Exported event emitter ───────────────────────────────────────────────────

/** Emits 'connected' | 'disconnected' | 'error' for the tray icon and renderer */
export const realtimeEvents = new EventEmitter()

// ─── State ────────────────────────────────────────────────────────────────────

let activeController: AbortController | null = null
let pollTimeout: ReturnType<typeof setTimeout> | null = null
let consecutiveFailures = 0
let isClientActive = false
let isCurrentlyConnected = false
/** Último `next_poll_ms` aceito do servidor (contrato: ausente ⇒ mantém o anterior). */
let currentPollIntervalMs = DEFAULT_POLL_INTERVAL_MS
/** Último `next_poll_ms_with_wake` aceito (mesmo contrato e mesmo clamp). */
let pollIntervalWithWakeMs = NEXT_POLL_MS_WITH_WAKE
/** Último `store_closed` recebido; `null` = o servidor não manda (regra antiga da janela segura). */
let lastStoreClosed: boolean | null = null
/**
 * Geração do tick rodando (do início ao agendamento do próximo); `null` =
 * nenhum. Amarrada à geração: um tick antigo, preso num `authenticate()` que o
 * disconnect não aborta, não "libera" o tick novo ao terminar.
 */
let inFlightGeneration: number | null = null

function isTickInFlight(): boolean {
  return inFlightGeneration !== null && inFlightGeneration === pollGeneration
}
/** Pedido de poll fora do ritmo que chegou com um tick em voo: vira o próximo tick. */
let pendingOutOfPace: { trigger: PollTrigger; delayMs: number } | null = null
/** Quando o timer atual dispara (infinito = nenhum agendado). */
let pollTimerFireAtMs = Number.POSITIVE_INFINITY
let lastTickStartedAtMs = Number.NEGATIVE_INFINITY

const wake = new WakeController({
  onSignal: () => wakeNow(),
  onHealthChange: (healthy) => handleWakeHealthChange(healthy),
})
/**
 * Geração do loop: connect() e disconnect() incrementam; um tick antigo que
 * acorda de um await compara a própria geração e se encerra sem reagendar.
 * Junto com o timer único (pollTimeout) e o guard de isClientActive, é o que
 * garante que nunca existem dois loops de polling simultâneos.
 */
let pollGeneration = 0
/**
 * Já tentamos, neste ciclo de conexão, refazer o handshake por causa de uma
 * versão nova? Uma tentativa por ciclo basta — o app reinicia ao se atualizar,
 * e connect() só roda de novo no boot, no /configure ou no pareamento — e é o
 * que impede que um `/auth` recusado (token revogado, 5xx) vire uma tentativa
 * a cada tick enquanto a sessão boa segue imprimindo.
 */
let appVersionHandshakeAttempted = false
/**
 * Última tentativa de levar o papel ao servidor: para QUAL papel e quando.
 * Repetir a mesma tentativa espera `PAPER_HANDSHAKE_RETRY_MS`; um papel novo
 * (outra troca) tenta na hora.
 */
let lastPaperHandshakeAttempt: { paperSize: PaperSize; atMs: number } | null = null
/**
 * Intervalo entre tentativas de levar o MESMO papel ao servidor enquanto ele
 * estiver diferente do da sessão: um `/auth` fora do ar não pode virar uma
 * tentativa por tick, nem deixar o servidor com o papel velho até a sessão expirar.
 */
export const PAPER_HANDSHAKE_RETRY_MS = 10 * 60_000

/**
 * O servidor ainda está com outro papel para esta estação? Sessão sem
 * `session_paper_size` (emitida antes da 1.5.1) conta como "não sei" ⇒ não:
 * o handshake de versão da atualização já grava o campo.
 */
export function needsPaperHandshake(cfg: Partial<AppConfig>): boolean {
  if (!cfg.session_token || cfg.session_paper_size === undefined) return false
  return (cfg.paper_size ?? '80mm') !== cfg.session_paper_size
}

function shouldAttemptPaperHandshake(cfg: Partial<AppConfig>, nowMs: number): boolean {
  if (!needsPaperHandshake(cfg)) return false
  const paperSize = cfg.paper_size ?? '80mm'
  const last = lastPaperHandshakeAttempt
  return !last || last.paperSize !== paperSize || nowMs - last.atMs >= PAPER_HANDSHAKE_RETRY_MS
}

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
  pollTimerFireAtMs = Number.POSITIVE_INFINITY
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

/** Sessão emitida pelo POST /api/printer/auth para um device_token. */
export interface PrinterSession {
  session_token: string
  expires_at: string
  tenant_id: string
  tenant_name: string
  auto_print: boolean
  /** Impressora nomeada deste token; `null` no token legado da loja. */
  destination: PrinterDestination | null
}

/** Falha do handshake com o status HTTP preservado, quando houve resposta. */
export class PrinterAuthError extends Error {
  constructor(message: string, readonly httpStatus: number | null) {
    super(message)
    this.name = 'PrinterAuthError'
  }
}

/**
 * Troca UM device_token por uma sessão no servidor. Não lê nem grava o store:
 * é o handshake cru, para o loop de polling (que usa o token já pareado) e
 * para o pareamento manual (que precisa validar um código colado ANTES de
 * gravar qualquer coisa).
 *
 * Lança `PrinterAuthError` em qualquer desfecho que não seja sessão emitida.
 */
export async function requestPrinterSession(
  deviceToken: string,
  opts: { apiBaseUrl: string; paperSize?: '80mm' | '58mm'; columns?: number }
): Promise<PrinterSession> {
  const url = `${opts.apiBaseUrl}/api/printer/auth`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      // O corpo leva o device_token: seguir um redirect reenviaria o segredo
      // pro destino da redireção. O endpoint legítimo nunca redireciona (a
      // base já é canonizada na gravação do pareamento) — se redirecionar,
      // é erro, não caminho feliz.
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_token: deviceToken,
        paper_size: opts.paperSize,
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
        ...(opts.columns !== undefined && { columns: opts.columns }),
      }),
    })
  } catch (err) {
    // Sem resposta: DNS, offline, TLS, redirect barrado. Não é token errado.
    throw new PrinterAuthError(err instanceof Error ? err.message : String(err), null)
  }

  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, MAX_LOGGED_BODY_CHARS)
    throw new PrinterAuthError(`Auth API returned ${res.status}: ${errText}`, res.status)
  }

  const data = (await res.json()) as {
    session_token: string
    expires_at: string
    tenant_id: string
    tenant_name: string
    auto_print: boolean
    /** Aditivo: servidor antigo (ou token legado da loja) não manda. */
    destination?: unknown
  }

  return {
    session_token: data.session_token,
    expires_at: data.expires_at,
    tenant_id: data.tenant_id,
    tenant_name: data.tenant_name,
    auto_print: data.auto_print,
    destination: parsePrinterDestination(data.destination),
  }
}

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
    const session = await requestPrinterSession(cfg.device_token, {
      apiBaseUrl: resolveApiBaseUrl(cfg),
      paperSize: cfg.paper_size,
      columns: cfg.columns,
    })

    setConfig({
      session_token: session.session_token,
      session_expires_at: session.expires_at,
      tenant_id: session.tenant_id,
      tenant_name: session.tenant_name,
      auto_print: session.auto_print,
      // Sempre reescrito (inclusive para `null`): quem diz a que impressora
      // este token pertence é o servidor. Um destino gravado que o servidor
      // não confirma mais não pode sobreviver na bandeja.
      destination: session.destination,
      // A versão que ESTE handshake acabou de reportar (requestPrinterSession
      // manda `app_version` no corpo). Guardada junto com a sessão porque é
      // ela que diz, no próximo boot, se o app atualizou desde então.
      session_app_version: app.getVersion(),
      // O papel que ESTE handshake reportou (mesmo valor de `paperSize` acima).
      session_paper_size: cfg.paper_size ?? '80mm',
    })

    log.info(
      `Authenticated successfully for tenant ${session.tenant_name} (${session.tenant_id})` +
        (session.destination ? ` — impressora "${session.destination.name}"` : '')
    )
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Authentication failed:', message)
    realtimeEvents.emit('error', err)
    return false
  }
}

// ─── Versão do app reportada ao servidor ──────────────────────────────────────

/**
 * A sessão guardada foi emitida por OUTRA versão do app?
 *
 * O servidor só aprende a versão no handshake (`printer_sessions.app_version`),
 * e o app reusa o `session_token` salvo enquanto ele vale (~30 dias) — então,
 * sem esta comparação, o painel mostra a versão de semanas atrás (medido em
 * produção: lojas em 1.2.0 com sessão de 21 e 27 dias) e a trava
 * `PRINTER_MIN_APP_VERSION` decidiria sobre um dado mentiroso.
 *
 * Sem sessão guardada ⇒ false: o fluxo normal já vai autenticar e reportar.
 * `session_app_version` ausente ⇒ true: é a frota inteira no primeiro boot
 * depois desta correção, que faz UM handshake e passa a gravar o campo.
 */
export function isSessionFromOtherAppVersion(
  cfg: Partial<AppConfig>,
  currentAppVersion: string
): boolean {
  if (!cfg.session_token) return false
  return cfg.session_app_version !== currentAppVersion
}

/**
 * Refaz o handshake com o único fim de registrar a versão nova no servidor.
 *
 * Nunca lança e nunca descarta a sessão que está imprimindo: `authenticate()`
 * só toca no store quando o servidor responde, então uma falha aqui deixa a
 * sessão boa no lugar e o tick segue normalmente — reportar versão jamais pode
 * custar uma comanda. Falhou, fica para o próximo boot (o app reinicia ao se
 * atualizar) ou para o re-handshake natural de quando a sessão expirar.
 */
async function reauthenticateToReportAppVersion(): Promise<void> {
  appVersionHandshakeAttempted = true
  log.info(`App agora na versão ${app.getVersion()}; refazendo o handshake para reportá-la…`)
  await reauthenticateKeepingSession('versão')
}

/**
 * Handshake novo sem descartar a sessão que está imprimindo (ver acima):
 * falhou, a sessão atual segue valendo e o tick continua.
 */
async function reauthenticateKeepingSession(reason: string): Promise<void> {
  try {
    if (await authenticate()) return
  } catch (err) {
    // authenticate() emite 'error' no realtimeEvents e, sem nenhum listener
    // registrado, o EventEmitter RELANÇA — mesmo motivo do try/catch do tick.
    log.error(
      `Re-handshake (${reason}) lançou:`,
      err instanceof Error ? err.message : String(err)
    )
  }

  log.warn(`Não deu para refazer o handshake (${reason}) agora; a sessão atual continua valendo.`)
}

// ─── Poll de jobs pendentes ───────────────────────────────────────────────────

type PollResult =
  | { status: 'ok'; jobCount: number }
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
  signal: AbortSignal,
  trigger: PollTrigger,
  pollStartedAtMs: number
): Promise<PollResult> {
  const url = `${apiBaseUrl}/api/printer/jobs`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      // Sinal de acordar (aditivos: servidor sem a feature ignora). A versão é
      // a mesma que o handshake e o /status local reportam.
      'X-Printer-App-Version': app.getVersion(),
      'X-Printer-Wake': wake.requestHeader(),
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
      /** Sinal de acordar: o servidor esperava um sinal por este job. */
      wake_expected?: unknown
    }>
    /** Ritmo pedido pelo servidor; só vem quando ele recalcula (máx. 1×/min) */
    next_poll_ms?: number
    // Aditivos do sinal de acordar (só com o header e a loja na flag).
    next_poll_ms_with_wake?: unknown
    store_closed?: unknown
    wake?: unknown
    wake_missed_recorded?: unknown
    /** Papel escolhido no painel (1.5.1, ver paper-sync.ts). */
    printer_paper_size?: unknown
  }

  const jobs = Array.isArray(data.jobs) ? data.jobs : []
  if (jobs.length > 0) {
    log.info(`Poll: found ${jobs.length} pending print jobs`)
    for (const job of jobs) {
      addToQueue(job.id, job.order_id, job.order, job.render, job.resolved_columns)
    }
  }

  // Contrato: `next_poll_ms` só é considerado em resposta 200 — por isso a
  // leitura vive aqui, depois de todos os early-returns de status.
  currentPollIntervalMs = resolveNextPollIntervalMs(data.next_poll_ms, currentPollIntervalMs)
  pollIntervalWithWakeMs = resolveNextPollIntervalMs(data.next_poll_ms_with_wake, pollIntervalWithWakeMs)
  // `store_closed` viaja na mesma cadência do `next_poll_ms`: ausente numa
  // resposta SEM `next_poll_ms` ⇒ mantém o último; ausente numa resposta COM
  // `next_poll_ms` ⇒ o servidor deixou de mandá-lo (flag desligada) e a janela
  // segura volta à regra da 1.4.0 — um `false` velho travaria a atualização
  // para sempre num app que roda 24/7.
  if (typeof data.store_closed === 'boolean') lastStoreClosed = data.store_closed
  else if (typeof data.next_poll_ms === 'number') lastStoreClosed = null

  // Depois de enfileirar: nada do sinal pode custar uma comanda (handlePollResponse nunca lança).
  wake.handlePollResponse({
    wake: data.wake,
    jobs,
    wakeMissedRecorded: data.wake_missed_recorded,
    trigger,
    pollStartedAtMs,
  })

  // Depois de enfileirar: a troca de papel vale a partir do próximo job
  // (os já enfileirados decidem a largura na hora de imprimir, com o papel atual).
  applyPanelPaperSize(data.printer_paper_size)

  return { status: 'ok', jobCount: jobs.length }
}

/**
 * Papel escolhido no painel: aplica (uma vez por escolha) e pede um
 * handshake novo para o servidor registrar o papel desta estação. Nunca lança:
 * papel jamais pode custar uma comanda.
 */
function applyPanelPaperSize(raw: unknown): void {
  try {
    if (raw === undefined) return
    const cfg = getConfig()
    const decision = decidePanelPaperSize({
      field: parsePanelPaperSize(raw),
      currentPaperSize: cfg.paper_size,
      lastAppliedSetAt: cfg.paper_size_panel_set_at,
    })
    const patch = panelPaperPatch(decision)
    if (!patch) return
    if (decision.action === 'apply' && cfg.session_paper_size === undefined) {
      // Sessão de antes da 1.5.1: o servidor tem o papel que ESTA estação
      // reportava até agora. Guardá-lo deixa a diferença visível e o handshake
      // do papel acontece (needsPaperHandshake), sem flag em memória.
      patch.session_paper_size = cfg.paper_size ?? '80mm'
    }
    setConfig(patch)
    if (decision.action === 'apply') {
      log.info(`Papel trocado pelo painel: ${cfg.paper_size ?? '80mm'} → ${decision.value}`)
    }
  } catch (err) {
    log.error('Papel do painel (ignorado):', err instanceof Error ? err.message : String(err))
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

/** Gatilho do tick agendado; mutável porque um sinal pode "adotar" um tick já agendado. */
let pollTimerTrigger: PollTrigger = 'safety'

function scheduleNextPoll(generation: number, delayMs: number, trigger: PollTrigger = 'safety'): void {
  if (!isClientActive || generation !== pollGeneration) return
  clearPollTimer()
  pollTimerFireAtMs = Date.now() + delayMs
  pollTimerTrigger = trigger
  pollTimeout = setTimeout(() => {
    pollTimeout = null
    pollTimerFireAtMs = Number.POSITIVE_INFINITY
    pollTick(generation, pollTimerTrigger).catch((err) => {
      // pollTick trata os próprios erros; isto é a última linha de defesa pra
      // uma rejeição inesperada não matar a cadeia de polling.
      log.error('pollTick promise rejection:', err instanceof Error ? err.message : String(err))
      handlePollFailure(generation, null)
    })
  }, delayMs)
}

/** Ritmo do próximo poll de segurança: o do sinal só com o sinal saudável. */
function safetyPollIntervalMs(): number {
  let healthy = false
  try {
    healthy = wake.isHealthy()
  } catch {
    healthy = false
  }
  return choosePollIntervalMs({
    healthy,
    serverPollMs: currentPollIntervalMs,
    withWakeMs: pollIntervalWithWakeMs,
  })
}

/**
 * Pede um poll fora do ritmo (sinal, repoll). Garantias:
 *  - um ciclo por vez: com um tick em voo, vira "repoll pendente" e roda
 *    quando ele terminar;
 *  - intervalo mínimo `MIN_OUT_OF_PACE_POLL_GAP_MS` desde o início do último tick;
 *  - nunca fura backoff de erro nem `Retry-After` de 429 (com falha em curso, ignora);
 *  - com um tick já agendado para antes, não cria outro (sinais simultâneos = 1 GET).
 */
function requestPoll(trigger: PollTrigger, delayMs: number): void {
  if (!isClientActive || consecutiveFailures > 0) return
  if (isTickInFlight()) {
    if (!pendingOutOfPace || trigger === 'signal') pendingOutOfPace = { trigger, delayMs }
    return
  }
  const now = Date.now()
  const fireAt = Math.max(now + delayMs, lastTickStartedAtMs + MIN_OUT_OF_PACE_POLL_GAP_MS)
  if (pollTimerFireAtMs <= fireAt) {
    // O tick já agendado cobre o pedido. Um sinal o marca como tal: ele deixa
    // de ser poll de segurança (não conta sinal perdido; vazio, ganha repoll).
    if (trigger === 'signal') pollTimerTrigger = 'signal'
    return
  }
  scheduleNextPoll(pollGeneration, fireAt - now, trigger)
}

/** Chegou um sinal de acordar: um poll agora (com as garantias de `requestPoll`). */
export function wakeNow(): void {
  try {
    requestPoll('signal', 0)
  } catch (err) {
    log.error('wakeNow falhou (ignorado):', err instanceof Error ? err.message : String(err))
  }
}

/**
 * O sinal deixou de ser saudável (socket caiu, heartbeat parou, sinal
 * perdido): o poll de segurança agendado pode estar a até 30 s. Volta ao ritmo
 * de hoje JÁ, com jitter de 0 a 5 s — uma queda do Realtime atinge a frota
 * inteira ao mesmo tempo e não pode virar uma rajada sincronizada.
 */
function handleWakeHealthChange(healthy: boolean): void {
  try {
    if (healthy || !isClientActive || isTickInFlight() || consecutiveFailures > 0) return
    const delay = reconnectJitterMs()
    if (pollTimerFireAtMs <= Date.now() + delay) return
    scheduleNextPoll(pollGeneration, delay, 'catchup')
  } catch (err) {
    log.error('Reagendar após queda do sinal falhou (ignorado):', err instanceof Error ? err.message : String(err))
  }
}

// Contrato do sinal: depois de reportar falha de impressão, repoll curto. O
// evento sai quando o PATCH de confirmação termina, para o repoll não chegar
// antes de o servidor devolver o job a `pending` (rede lenta da loja).
queueEvents.on('jobFailureReported', () => {
  try {
    requestPoll('repoll', FAILED_JOB_REPOLL_MS)
  } catch (err) {
    log.error('Repoll após falha falhou (ignorado):', err instanceof Error ? err.message : String(err))
  }
})

/**
 * Próximo tick depois de uma 200: o pedido fora do ritmo que chegou durante o
 * tick; ou o repoll único de um poll de sinal vazio; ou o poll de segurança.
 */
function scheduleAfterOkPoll(generation: number, trigger: PollTrigger, jobCount: number): void {
  const pending = pendingOutOfPace
  pendingOutOfPace = null
  if (pending) {
    const gapLeftMs = lastTickStartedAtMs + MIN_OUT_OF_PACE_POLL_GAP_MS - Date.now()
    scheduleNextPoll(generation, Math.max(pending.delayMs, gapLeftMs, 0), pending.trigger)
    return
  }
  if (trigger === 'signal' && jobCount === 0) {
    scheduleNextPoll(generation, EMPTY_SIGNAL_REPOLL_MS, 'repoll')
    return
  }
  scheduleNextPoll(generation, safetyPollIntervalMs(), 'safety')
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
      // O `next_poll_ms` do SERVIDOR, nunca o ritmo escolhido pelo app: com o
      // sinal saudável o app polla a 30 s com a loja aberta.
      storeClosed: isStoreClosedForUpdate(lastStoreClosed, currentPollIntervalMs),
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
async function pollTick(generation: number, trigger: PollTrigger): Promise<void> {
  if (!isClientActive || generation !== pollGeneration) return
  inFlightGeneration = generation
  try {
    await runPollTick(generation, trigger)
  } finally {
    if (inFlightGeneration === generation) inFlightGeneration = null
  }
}

async function runPollTick(generation: number, trigger: PollTrigger): Promise<void> {
  lastTickStartedAtMs = Date.now()
  // Um pedido anterior a este tick é atendido por ele.
  pendingOutOfPace = null

  let cfg = getConfig()

  // Atualizou desde o handshake que emitiu esta sessão: um handshake novo
  // (e só um por execução) põe a versão certa no servidor. Sem mudança de
  // versão, isto é uma comparação de string — nenhuma requisição a mais.
  if (!appVersionHandshakeAttempted && isSessionFromOtherAppVersion(cfg, app.getVersion())) {
    await reauthenticateToReportAppVersion()
    if (!isClientActive || generation !== pollGeneration) return
    cfg = getConfig()
  }

  // Papel diferente do que o servidor tem (trocado pelo painel ou pelo
  // computador da loja): um handshake novo leva o papel (e a ausência de
  // calibração) ao servidor, que passa a montar a comanda na largura nova.
  // Falhou, tenta de novo depois de PAPER_HANDSHAKE_RETRY_MS — nunca por tick.
  if (shouldAttemptPaperHandshake(cfg, Date.now())) {
    lastPaperHandshakeAttempt = { paperSize: cfg.paper_size ?? '80mm', atMs: Date.now() }
    await reauthenticateKeepingSession('papel da estação mudou')
    if (!isClientActive || generation !== pollGeneration) return
    cfg = getConfig()
  }

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
      controller.signal,
      trigger,
      lastTickStartedAtMs
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
      scheduleAfterOkPoll(generation, trigger, result.jobCount)
      // Depois de já ter agendado o próximo tick: nada aqui afeta o loop.
      reportUpdateSafeWindowSignals()
      return
    case 'unauthorized':
      // Sessão expirada/revogada: zera e re-autentica no próximo tick.
      log.warn('Jobs poll unauthorized (401). Invalidating session and re-authenticating…')
      setConfig({ session_token: undefined })
      // Os tópicos eram da sessão revogada: a próxima 200 entrega os da nova.
      wake.reset('sessão inválida (401)')
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
      if (result.httpStatus === 403) wake.reset('assinatura encerrada (403)')
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
  appVersionHandshakeAttempted = false
  lastPaperHandshakeAttempt = null
  pendingOutOfPace = null
  lastTickStartedAtMs = Number.NEGATIVE_INFINITY
  // A janela segura da conexão anterior (outra loja, outro pareamento) não vale.
  lastStoreClosed = null
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
  pendingOutOfPace = null
  wake.reset('polling parado')

  if (isCurrentlyConnected) {
    isCurrentlyConnected = false
    realtimeEvents.emit('disconnected')
  }
}

/** Só para testes: socket do sinal falso e leitura do estado dele. */
export function _setWakeSocketFactoryForTests(factory: WakeSocketFactory): void {
  wake.setSocketFactoryForTests(factory)
}

export function _getWakeForTests(): WakeController {
  return wake
}

/** O "loja fechada" que a próxima 200 entregaria à janela segura de atualização. */
export function _getUpdateStoreClosedForTests(): boolean {
  return isStoreClosedForUpdate(lastStoreClosed, currentPollIntervalMs)
}

/**
 * Returns whether the polling client is currently connected successfully.
 */
export function getConnectionStatus(): boolean {
  return isCurrentlyConnected
}
