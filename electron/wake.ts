/**
 * electron/wake.ts
 * "Sinal de acordar" (1.5.0): um canal Broadcast do Supabase Realtime avisa
 * "tem comanda nova, busque agora", e o poll vira rede de segurança (30 s em
 * vez de 3 s). O contrato do servidor vive no zuppy-food, `lib/printer/wake.ts`.
 *
 * Princípios (nenhuma loja pode parar de imprimir):
 *  - O sinal é OTIMIZAÇÃO, nunca dependência. Sem sinal saudável, o poll segue
 *    no ritmo de hoje (`next_poll_ms`). Toda falha daqui cai nesse ritmo.
 *  - Tudo em try/catch: nada deste módulo pode derrubar o laço de poll.
 *  - Segredos: o tópico (credencial de leitura do canal da loja) e a anon key
 *    nunca vão a log, ao /status local nem a mensagem de erro. A URL também não
 *    (a URL do socket leva a anon key na query string).
 *  - O payload e o nome do evento são IGNORADOS: qualquer mensagem no canal só
 *    agenda um poll autenticado (e limitado, ver `requestPoll` em realtime.ts).
 *    O app não usa Presence e não envia nada pelo canal.
 *
 * Fluxo:
 *  1. Todo poll manda `X-Printer-Wake: v=<versão>;state=joined|degraded|off;missed=<n>`.
 *  2. A 200 pode trazer `wake` (completo, ou só `{ version }` quando o `v` bate).
 *     Completo e válido ⇒ abre o socket e assina `printer-wake:<topic>` de cada loja.
 *  3. Sinal saudável = todos os canais `joined` + heartbeat em dia + nenhum sinal
 *     perdido nos últimos 10 min. Só aí o poll vai a `next_poll_ms_with_wake`.
 *  4. Sinal perdido: job com `wake_expected` achado por poll de SEGURANÇA, sem
 *     sinal nos 15 s anteriores nem nos 5 s seguintes, com o canal ligado há mais
 *     de 60 s (antes disso o job pode ser catch-up). Conta, reporta em `missed` e
 *     volta ao ritmo de hoje por 10 min.
 *  5. Duas 200 seguidas sem `wake` ⇒ derruba o socket e esquece a versão (`v=`
 *     vazio até receber um `wake` completo).
 */

import { RealtimeClient } from '@supabase/supabase-js'
import { createLogger } from './logger'

const log = createLogger('WAKE')

// ─── Constantes do contrato (espelham zuppy-food lib/printer/wake.ts) ─────────

/** Ritmo de poll com o sinal saudável, quando o servidor não manda `next_poll_ms_with_wake`. */
export const NEXT_POLL_MS_WITH_WAKE = 30_000

/** Idade máxima de um job para o servidor marcá-lo `wake_expected`. */
export const WAKE_EXPECTED_WINDOW_MS = 60_000

/** Prefixo do canal: o nome completo é `printer-wake:<topic>`. */
export const PRINTER_WAKE_CHANNEL_PREFIX = 'printer-wake:'

/** O servidor não interpreta `X-Printer-Wake` acima disto. */
export const WAKE_HEADER_MAX_LENGTH = 512

const TOPICS_VERSION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const TOPIC_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUPABASE_HOST_PATTERN = /^[a-z0-9]{1,63}\.supabase\.co$/
const MAX_WAKE_TOPICS = 100
const MAX_ANON_KEY_LENGTH = 4096
const MISSED_MAX = 1_000_000

// ─── Constantes do app ────────────────────────────────────────────────────────

/** Sinal perdido: nenhum sinal nesta janela antes do poll de segurança que achou o job. */
export const MISSED_SIGNAL_LOOKBACK_MS = 15_000
/**
 * Carência depois do poll: o poll pode ter achado o job ANTES de o sinal dele
 * chegar (corrida de rede). Sinal nesta janela cancela a contagem.
 */
export const MISSED_SIGNAL_GRACE_MS = 5_000
/** Com 1 sinal perdido, ritmo de hoje por este tempo. */
export const MISSED_PENALTY_MS = 10 * 60_000
/** Respostas 200 seguidas sem `wake` toleradas antes de derrubar o socket (falha transitória do servidor). */
export const WAKE_ABSENT_TOLERANCE = 2
/** Intervalo do heartbeat do socket; sem `ok` por mais que `HEARTBEAT_STALE_MS`, o sinal não é saudável. */
export const HEARTBEAT_INTERVAL_MS = 25_000
export const HEARTBEAT_STALE_MS = 65_000
/** Teto do jitter dos polls de reconexão (e do reconnect do socket). */
export const RECONNECT_JITTER_MAX_MS = 5_000
/** Conferência periódica da saúde (heartbeat parado, fim da penalidade): sem I/O. */
const HEALTH_CHECK_INTERVAL_MS = 5_000
/** Backoff do reconnect do socket (a mais o jitter). */
const SOCKET_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type WakeState = 'joined' | 'degraded' | 'off'

/** O que disparou um poll. Só o de segurança (`safety`) conta sinal perdido. */
export type PollTrigger = 'safety' | 'signal' | 'repoll' | 'catchup'

export interface WakeTopic {
  tenant_id: string
  topic: string
}

export type ParsedWakeField =
  | { kind: 'absent' }
  | { kind: 'version'; version: string }
  | { kind: 'full'; version: string; endpoint: string; anonKey: string; topics: WakeTopic[] }
  | { kind: 'invalid'; reason: string; version: string | null }

export type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR'

export interface WakeSocketHandlers {
  /** Qualquer mensagem em qualquer canal. Sem payload: ele é ignorado. */
  onSignal(): void
  onChannelStatus(channelIndex: number, status: ChannelStatus): void
  onHeartbeat(status: string): void
}

export interface WakeSocket {
  close(): void
}

export interface WakeSocketConfig {
  endpoint: string
  anonKey: string
  channelNames: string[]
}

export type WakeSocketFactory = (config: WakeSocketConfig, handlers: WakeSocketHandlers) => WakeSocket

// ─── Decisões puras ───────────────────────────────────────────────────────────

/**
 * `wake.url` só é aceita como `https://<ref>.supabase.co` (sem porta, usuário,
 * caminho, query ou fragmento). Devolve o endpoint do socket
 * (`wss://<ref>.supabase.co/realtime/v1`) ou `null`. Um servidor comprometido
 * ou um proxy não consegue apontar o app (e a anon key) para outro host.
 */
export function resolveRealtimeEndpoint(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length > 256) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.port) return null
  if (url.pathname !== '/' || url.search || url.hash) return null
  if (!SUPABASE_HOST_PATTERN.test(url.hostname)) return null
  // `new URL` normaliza caixa; o texto original também tem de ser exato
  // (sem espaço, sem caminho "//", sem barra invertida).
  if (rawUrl !== `https://${url.hostname}` && rawUrl !== `https://${url.hostname}/`) return null
  return `wss://${url.hostname}/realtime/v1`
}

function parseTopics(raw: unknown): WakeTopic[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WAKE_TOPICS) return null
  const topics: WakeTopic[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const { tenant_id, topic } = item as { tenant_id?: unknown; topic?: unknown }
    if (typeof tenant_id !== 'string' || tenant_id.length === 0 || tenant_id.length > 64) return null
    if (typeof topic !== 'string' || !TOPIC_PATTERN.test(topic)) return null
    topics.push({ tenant_id, topic: topic.toLowerCase() })
  }
  return topics
}

/** Lê o campo `wake` da 200 do poll. O motivo de `invalid` nunca carrega valor recebido. */
export function parseWakeField(raw: unknown): ParsedWakeField {
  if (raw === undefined || raw === null) return { kind: 'absent' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'não é objeto', version: null }
  const field = raw as Record<string, unknown>
  const version =
    typeof field.version === 'string' && TOPICS_VERSION_PATTERN.test(field.version) ? field.version : null
  if (version === null) return { kind: 'invalid', reason: 'version ausente ou inválida', version: null }

  const hasPayload = 'url' in field || 'anon_key' in field || 'topics' in field
  if (!hasPayload) return { kind: 'version', version }

  const endpoint = resolveRealtimeEndpoint(field.url)
  if (endpoint === null) return { kind: 'invalid', reason: 'url fora de https://<ref>.supabase.co', version }
  const anonKey = field.anon_key
  if (typeof anonKey !== 'string' || anonKey.length === 0 || anonKey.length > MAX_ANON_KEY_LENGTH || /\s/.test(anonKey)) {
    return { kind: 'invalid', reason: 'anon_key inválida', version }
  }
  const topics = parseTopics(field.topics)
  if (topics === null) return { kind: 'invalid', reason: 'topics inválidos', version }
  return { kind: 'full', version, endpoint, anonKey, topics }
}

/** Header `X-Printer-Wake`. Versão vazia = "não tenho tópicos, mande o conjunto completo". */
export function buildWakeHeader(input: { version: string | null; state: WakeState; missed: number }): string {
  const missed = Math.min(MISSED_MAX, Math.max(0, Math.floor(input.missed)))
  const header = `v=${input.version ?? ''};state=${input.state};missed=${missed}`
  if (header.length <= WAKE_HEADER_MAX_LENGTH) return header
  return `v=;state=${input.state};missed=${missed}`
}

/**
 * Ritmo do próximo poll de segurança. Com o sinal saudável, o do servidor para
 * esse caso (nunca mais rápido que o `next_poll_ms`); senão, o de hoje.
 */
export function choosePollIntervalMs(input: {
  healthy: boolean
  serverPollMs: number
  withWakeMs: number
}): number {
  if (!input.healthy) return input.serverPollMs
  return Math.max(input.withWakeMs, input.serverPollMs)
}

/**
 * Quantos jobs deste poll o sinal deveria ter entregue e não entregou.
 * Só conta poll de SEGURANÇA (o disparado por sinal, o repoll e o de
 * reconexão ficam de fora), com todos os canais ligados desde antes da janela
 * `wake_expected` (jobs mais velhos que a conexão são catch-up) e sem sinal
 * nos `MISSED_SIGNAL_LOOKBACK_MS` anteriores ao início do poll. Pedido
 * agendado e job devolvido pelo backlog já vêm `wake_expected: false` do servidor.
 */
export function countMissedSignals(input: {
  jobs: ReadonlyArray<{ wake_expected?: unknown }>
  trigger: PollTrigger
  pollStartedAtMs: number
  joinedSinceMs: number | null
  lastSignalAtMs: number | null
}): number {
  if (input.trigger !== 'safety') return 0
  if (input.joinedSinceMs === null) return 0
  if (input.joinedSinceMs > input.pollStartedAtMs - WAKE_EXPECTED_WINDOW_MS) return 0
  if (input.lastSignalAtMs !== null && input.lastSignalAtMs >= input.pollStartedAtMs - MISSED_SIGNAL_LOOKBACK_MS) {
    return 0
  }
  return input.jobs.filter((job) => job.wake_expected === true).length
}

/** Jitter uniforme em [0, max). */
export function reconnectJitterMs(random: () => number = Math.random, max = RECONNECT_JITTER_MAX_MS): number {
  const value = random()
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.floor(Math.min(value, 0.999999) * max)
}

// ─── Socket real (Supabase Realtime) ──────────────────────────────────────────

/** Nome que só leva o tipo do erro: a mensagem do realtime-js pode trazer a URL com a anon key. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err
}

/**
 * Abre o socket e assina um canal Broadcast público por tópico, ouvindo
 * QUALQUER evento. Sem logger do realtime-js (ele loga a URL com a apikey).
 */
export const createRealtimeWakeSocket: WakeSocketFactory = (config, handlers) => {
  const client = new RealtimeClient(config.endpoint, {
    params: { apikey: config.anonKey },
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatCallback: (status) => handlers.onHeartbeat(String(status)),
    reconnectAfterMs: (tries: number) =>
      (SOCKET_RECONNECT_DELAYS_MS[tries - 1] ?? SOCKET_RECONNECT_DELAYS_MS[SOCKET_RECONNECT_DELAYS_MS.length - 1]) +
      reconnectJitterMs(),
  })
  config.channelNames.forEach((name, index) => {
    const channel = client.channel(name, {
      config: { broadcast: { self: false, ack: false }, presence: { enabled: false }, private: false },
    })
    channel.on('broadcast', { event: '*' }, () => handlers.onSignal())
    channel.subscribe((status) => handlers.onChannelStatus(index, status as ChannelStatus))
  })
  return {
    close() {
      client.removeAllChannels().catch((err: unknown) => log.warn(`removeAllChannels falhou (${errorName(err)})`))
      client.disconnect().catch((err: unknown) => log.warn(`disconnect do socket falhou (${errorName(err)})`))
    },
  }
}

// ─── Controlador ──────────────────────────────────────────────────────────────

export interface WakeControllerDeps {
  socketFactory?: WakeSocketFactory
  /** Mudança de "sinal saudável"; realtime.ts reagenda o poll. */
  onHealthChange?: (healthy: boolean) => void
  /** Chegou um sinal: realtime.ts dispara um poll (`wakeNow`). */
  onSignal?: () => void
}

interface Subscription {
  id: number
  version: string
  socket: WakeSocket
  joined: boolean[]
  joinedSinceMs: number | null
  heartbeatOk: boolean
  lastHeartbeatOkAtMs: number
}

/** O que realtime.ts passa de cada 200 do poll. */
export interface WakePollResponse {
  wake: unknown
  jobs: ReadonlyArray<{ wake_expected?: unknown }>
  wakeMissedRecorded: unknown
  trigger: PollTrigger
  pollStartedAtMs: number
}

export class WakeController {
  private socketFactory: WakeSocketFactory
  private readonly onHealthChange: (healthy: boolean) => void
  private readonly onSignalCallback: () => void

  private subscription: Subscription | null = null
  private subscriptionSeq = 0
  /** Versão que o app declara em `v=`: a assinada, ou a recusada (para o servidor não reenviar os tópicos a cada poll). */
  private knownVersion: string | null = null
  private absentStreak = 0
  private missed = 0
  private penaltyUntilMs = 0
  private lastSignalAtMs: number | null = null
  private pendingMissed: Array<{ count: number; timer: ReturnType<typeof setTimeout> }> = []
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private lastReportedHealthy = false

  constructor(deps: WakeControllerDeps = {}) {
    this.socketFactory = deps.socketFactory ?? createRealtimeWakeSocket
    this.onHealthChange = deps.onHealthChange ?? (() => {})
    this.onSignalCallback = deps.onSignal ?? (() => {})
  }

  /** Só para testes: troca o socket real por um falso. */
  setSocketFactoryForTests(factory: WakeSocketFactory): void {
    this.socketFactory = factory
  }

  // ── Leitura ──

  state(now: number = Date.now()): WakeState {
    const sub = this.subscription
    if (!sub) return 'off'
    const allJoined = sub.joined.length > 0 && sub.joined.every(Boolean)
    const heartbeatFresh = sub.heartbeatOk && now - sub.lastHeartbeatOkAtMs <= HEARTBEAT_STALE_MS
    return allJoined && heartbeatFresh ? 'joined' : 'degraded'
  }

  isHealthy(now: number = Date.now()): boolean {
    return this.state(now) === 'joined' && now >= this.penaltyUntilMs
  }

  missedCount(): number {
    return this.missed
  }

  /** Valor do header `X-Printer-Wake` para o próximo poll. Nunca lança. */
  requestHeader(): string {
    try {
      return buildWakeHeader({ version: this.knownVersion, state: this.state(), missed: this.missed })
    } catch {
      return 'v=;state=off;missed=0'
    }
  }

  // ── Entrada: resposta do poll ──

  /** Chamado em toda 200 do poll. Nunca lança. */
  handlePollResponse(response: WakePollResponse): void {
    try {
      this.acknowledgeMissed(response.wakeMissedRecorded)
      this.detectMissed(response)
      this.applyWakeField(parseWakeField(response.wake))
    } catch (err) {
      log.error(`Falha ao processar o sinal (ignorada, o poll segue): ${errorName(err)}`)
    } finally {
      this.reportHealthIfChanged()
    }
  }

  /** 401/403 ou desconexão: derruba o socket e esquece a versão. Nunca lança. */
  reset(reason: string): void {
    try {
      if (this.subscription) log.info(`Sinal desligado: ${reason}`)
      this.closeSubscription()
      this.knownVersion = null
      this.absentStreak = 0
    } catch (err) {
      log.error(`Falha ao desligar o sinal: ${errorName(err)}`)
    } finally {
      this.reportHealthIfChanged()
    }
  }

  // ── Interno ──

  private acknowledgeMissed(raw: unknown): void {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return
    this.missed = Math.max(0, this.missed - raw)
  }

  private detectMissed(response: WakePollResponse): void {
    const count = countMissedSignals({
      jobs: response.jobs,
      trigger: response.trigger,
      pollStartedAtMs: response.pollStartedAtMs,
      joinedSinceMs: this.subscription?.joinedSinceMs ?? null,
      lastSignalAtMs: this.lastSignalAtMs,
    })
    if (count === 0) return
    // Confirmação adiada: se o sinal chegar logo depois do poll, foi corrida, não perda.
    const entry = {
      count,
      timer: setTimeout(() => this.commitMissed(entry), MISSED_SIGNAL_GRACE_MS),
    }
    this.pendingMissed.push(entry)
  }

  private commitMissed(entry: { count: number; timer: ReturnType<typeof setTimeout> }): void {
    try {
      const index = this.pendingMissed.indexOf(entry)
      if (index < 0) return
      this.pendingMissed.splice(index, 1)
      this.missed = Math.min(MISSED_MAX, this.missed + entry.count)
      this.penaltyUntilMs = Date.now() + MISSED_PENALTY_MS
      log.warn(`Sinal perdido: ${entry.count} comanda(s) achada(s) pelo poll de segurança; ritmo de hoje por 10 min`)
    } catch (err) {
      log.error(`Falha ao contar sinal perdido: ${errorName(err)}`)
    } finally {
      this.reportHealthIfChanged()
    }
  }

  private cancelPendingMissed(): void {
    for (const entry of this.pendingMissed) clearTimeout(entry.timer)
    this.pendingMissed = []
  }

  private applyWakeField(field: ParsedWakeField): void {
    if (field.kind === 'absent') {
      this.absentStreak++
      if (this.absentStreak >= WAKE_ABSENT_TOLERANCE) {
        if (this.subscription) log.info('Servidor parou de oferecer o sinal; voltando ao poll de hoje')
        this.closeSubscription()
        this.knownVersion = null
      }
      return
    }
    this.absentStreak = 0

    if (field.kind === 'version') {
      // Só `{ version }`: o servidor achou que já temos este conjunto. Versão
      // diferente da nossa (corrida) ⇒ esquece, para receber o completo.
      if (field.version !== this.knownVersion) this.knownVersion = null
      return
    }

    if (field.kind === 'invalid') {
      log.warn(`wake recusado (${field.reason}); poll segue no ritmo de hoje`)
      this.closeSubscription()
      this.knownVersion = field.version
      return
    }

    if (this.subscription && this.subscription.version === field.version) {
      this.knownVersion = field.version
      return
    }
    this.openSubscription(field)
  }

  private openSubscription(field: Extract<ParsedWakeField, { kind: 'full' }>): void {
    this.closeSubscription()
    this.knownVersion = field.version
    const id = ++this.subscriptionSeq
    const now = Date.now()
    const channelNames = field.topics.map((t) => `${PRINTER_WAKE_CHANNEL_PREFIX}${t.topic}`)
    const handlers: WakeSocketHandlers = {
      onSignal: () => this.handleSignal(id),
      onChannelStatus: (index, status) => this.handleChannelStatus(id, index, status),
      onHeartbeat: (status) => this.handleHeartbeat(id, status),
    }
    // O objeto entra ANTES de abrir: o factory pode chamar os handlers de forma síncrona.
    const sub: Subscription = {
      id,
      version: field.version,
      socket: { close() {} },
      joined: channelNames.map(() => false),
      joinedSinceMs: null,
      heartbeatOk: true,
      lastHeartbeatOkAtMs: now,
    }
    this.subscription = sub
    try {
      sub.socket = this.socketFactory(
        { endpoint: field.endpoint, anonKey: field.anonKey, channelNames },
        handlers
      )
      log.info(`Sinal: assinando ${channelNames.length} canal(is)`)
      this.startHealthTimer()
    } catch (err) {
      log.error(`Não deu para abrir o socket do sinal (${errorName(err)}); poll segue no ritmo de hoje`)
      this.subscription = null
    }
  }

  private closeSubscription(): void {
    this.cancelPendingMissed()
    this.stopHealthTimer()
    const sub = this.subscription
    this.subscription = null
    if (!sub) return
    try {
      sub.socket.close()
    } catch (err) {
      log.warn(`Falha ao fechar o socket do sinal (${errorName(err)})`)
    }
  }

  private current(id: number): Subscription | null {
    return this.subscription && this.subscription.id === id ? this.subscription : null
  }

  private handleSignal(id: number): void {
    try {
      if (!this.current(id)) return
      this.lastSignalAtMs = Date.now()
      this.cancelPendingMissed()
      this.onSignalCallback()
    } catch (err) {
      log.error(`Falha ao tratar o sinal (${errorName(err)})`)
    }
  }

  private handleChannelStatus(id: number, index: number, status: ChannelStatus): void {
    try {
      const sub = this.current(id)
      if (!sub || index < 0 || index >= sub.joined.length) return
      const wasAllJoined = sub.joined.every(Boolean)
      sub.joined[index] = status === 'SUBSCRIBED'
      const allJoined = sub.joined.every(Boolean)
      if (allJoined && !wasAllJoined) {
        sub.joinedSinceMs = Date.now()
        // Ligou (ou religou): o heartbeat conta a partir daqui.
        sub.heartbeatOk = true
        sub.lastHeartbeatOkAtMs = sub.joinedSinceMs
        log.info('Sinal ligado')
      } else if (!allJoined && wasAllJoined) {
        sub.joinedSinceMs = null
        log.warn(`Sinal caiu (canal ${status}); poll volta ao ritmo de hoje`)
      }
    } catch (err) {
      log.error(`Falha ao tratar status do canal (${errorName(err)})`)
    } finally {
      this.reportHealthIfChanged()
    }
  }

  private handleHeartbeat(id: number, status: string): void {
    try {
      const sub = this.current(id)
      if (!sub) return
      if (status === 'ok') {
        sub.heartbeatOk = true
        sub.lastHeartbeatOkAtMs = Date.now()
      } else if (status === 'timeout' || status === 'error' || status === 'disconnected') {
        if (sub.heartbeatOk) log.warn(`Heartbeat do sinal: ${status}`)
        sub.heartbeatOk = false
      }
    } catch (err) {
      log.error(`Falha ao tratar heartbeat (${errorName(err)})`)
    } finally {
      this.reportHealthIfChanged()
    }
  }

  private startHealthTimer(): void {
    if (this.healthTimer) return
    this.healthTimer = setInterval(() => this.reportHealthIfChanged(), HEALTH_CHECK_INTERVAL_MS)
    this.healthTimer.unref?.()
  }

  private stopHealthTimer(): void {
    if (!this.healthTimer) return
    clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private reportHealthIfChanged(): void {
    let healthy = false
    try {
      healthy = this.isHealthy()
    } catch {
      healthy = false
    }
    if (healthy === this.lastReportedHealthy) return
    this.lastReportedHealthy = healthy
    try {
      this.onHealthChange(healthy)
    } catch (err) {
      log.error(`onHealthChange lançou (${errorName(err)})`)
    }
  }
}
