/**
 * electron/updater.ts
 * Estado do update baixado + decisão de instalar na "janela segura".
 *
 * Contexto: o electron-updater baixa a atualização (autoDownload) mas o app
 * roda 24/7 na loja (auto-start, o lojista nunca fecha) — então
 * autoInstallOnAppQuit nunca dispara e o instalador novo fica parado no
 * disco indefinidamente. Este módulo fecha esse buraco: instala sozinho
 * quando a loja está fechada e não há comanda pendente; fora disso apenas
 * expõe o estado (via /status) para o painel avisar o lojista.
 *
 * Padrão do repo: a DECISÃO é função pura (`shouldInstallNow`), separada do
 * efeito (`installNow`) — mesmo desenho de `decideRenderPath` e
 * `resolveNextPollIntervalMs`, o que permite testar sem Electron.
 *
 * Sinais (quem os fornece é realtime.ts, após cada poll bem-sucedido):
 *  - storeClosed: o servidor dita o ritmo do polling via `next_poll_ms`
 *    (3s com a loja ativa, 30s fechada) — ritmo >= 30s ⇒ loja fechada.
 *  - queueEmpty: fila local de impressão sem jobs (print-queue.ts).
 *  - queueQuiet: derivado AQUI, dos eventos da fila. Existe porque
 *    `getQueueStatus().length === 0` mente durante uma impressão: o
 *    processQueue tira o job da fila ANTES de imprimir, então o mesmo tick
 *    que entregou uma comanda vê a fila "vazia" com o papel ainda saindo.
 *    Reiniciar nesse instante violaria "nunca instalar com comanda na fila".
 */

import { queueEvents } from './print-queue'
import { createLogger } from './logger'

const log = createLogger('UPDATER')

// ─── Constantes dos sinais ────────────────────────────────────────────────────

/**
 * Ritmo de poll que o servidor usa com a loja FECHADA (realtime.ts: 3s ativa,
 * 30s fechada). Na dúvida (valores intermediários), trata como aberta — nunca
 * instalar é o erro barato; instalar no movimento é o caro.
 */
export const STORE_CLOSED_POLL_INTERVAL_MS = 30000

/**
 * Janela de silêncio exigida da fila antes de instalar: cobre a impressão em
 * andamento (job já fora da fila) e o retry em backoff (job fora da fila por
 * até 16s, ver BACKOFF_MS em print-queue.ts). 60s = 2 ciclos de poll de loja
 * fechada, com folga sobre o maior backoff.
 */
export const QUEUE_QUIET_WINDOW_MS = 60000

// ─── Estado ───────────────────────────────────────────────────────────────────

let downloadedVersion: string | null = null
let downloadedAtIso: string | null = null
/** Trava contra quitAndInstall duplo enquanto o app ainda está encerrando. */
let installInitiated = false
/**
 * Última atividade da fila de impressão. Nasce em "agora" (boot do app):
 * conservador de propósito — dá tempo do crash-recovery restaurar jobs antes
 * da primeira janela segura possível.
 */
let lastQueueActivityAtMs = Date.now()

// A assinatura vive no topo do módulo para valer desde o boot — antes do
// restoreQueue do crash-recovery emitir os primeiros eventos.
const recordQueueActivity = (): void => {
  lastQueueActivityAtMs = Date.now()
}
queueEvents.on('queueUpdate', recordQueueActivity)
queueEvents.on('jobRetry', recordQueueActivity)
queueEvents.on('jobDone', recordQueueActivity)

// ─── Decisão (funções puras) ──────────────────────────────────────────────────

export interface InstallSignals {
  /** Há um update baixado aguardando instalação? */
  updateReady: boolean
  /** Loja fechada segundo o ritmo de poll ditado pelo servidor? */
  storeClosed: boolean
  /** Fila local de impressão sem jobs enfileirados? */
  queueEmpty: boolean
  /** Fila sem QUALQUER atividade (add/retry/done) na janela de silêncio? */
  queueQuiet: boolean
}

export interface InstallDecision {
  install: boolean
  /** Motivo legível, para log — diagnóstico de loja em campo sem adivinhação. */
  reason: string
}

/**
 * Decide se é seguro instalar AGORA. Regras de segurança operacional:
 *  - nunca com a loja aberta (o restart derruba a impressão por segundos);
 *  - nunca com comanda na fila, mesmo de madrugada;
 *  - nunca com a fila "recém-mexida" (impressão/retry em voo, ver queueQuiet);
 *  - sem update baixado, nunca.
 */
export function shouldInstallNow(signals: InstallSignals): InstallDecision {
  if (!signals.updateReady) {
    return { install: false, reason: 'sem update baixado' }
  }
  if (!signals.storeClosed) {
    return { install: false, reason: 'loja aberta — nunca reiniciar durante o movimento' }
  }
  if (!signals.queueEmpty) {
    return { install: false, reason: 'comanda pendente na fila de impressão' }
  }
  if (!signals.queueQuiet) {
    return {
      install: false,
      reason: `fila com atividade há menos de ${QUEUE_QUIET_WINDOW_MS / 1000}s (impressão/retry pode estar em voo)`,
    }
  }
  return { install: true, reason: 'loja fechada + fila vazia e quieta + update pronto' }
}

/** Ritmo de poll >= o de loja fechada ⇒ loja fechada. Na dúvida, aberta. */
export function isStoreClosedPollInterval(pollIntervalMs: number): boolean {
  return pollIntervalMs >= STORE_CLOSED_POLL_INTERVAL_MS
}

/** A fila está sem atividade há pelo menos a janela de silêncio? */
export function isQueueQuiet(
  lastActivityAtMs: number,
  nowMs: number,
  quietWindowMs: number = QUEUE_QUIET_WINDOW_MS
): boolean {
  return nowMs - lastActivityAtMs >= quietWindowMs
}

// ─── Estado exposto (para /status e para o painel) ───────────────────────────

export interface DownloadedUpdateState {
  /** Há um instalador novo baixado aguardando? */
  updateReady: boolean
  /** Versão baixada (null se nenhuma). */
  version: string | null
  /** ISO de quando o download terminou — o painel usa pra "esperando há muito". */
  downloadedAt: string | null
}

/** Chamado pelo handler de `update-downloaded` do electron-updater (main.ts). */
export function registerDownloadedUpdate(
  version: string,
  downloadedAt: string = new Date().toISOString()
): void {
  downloadedVersion = version
  downloadedAtIso = downloadedAt
  log.info(`Update v${version} baixado — aguardando janela segura para instalar`)
}

export function getUpdateState(): DownloadedUpdateState {
  return {
    updateReady: downloadedVersion !== null,
    version: downloadedVersion,
    downloadedAt: downloadedAtIso,
  }
}

// ─── Efeitos ──────────────────────────────────────────────────────────────────

export type InstallResult = { ok: true; version: string } | { ok: false; error: string }

/**
 * Instala o update baixado: encerra o app e roda o instalador em silêncio,
 * religando o app ao final (quitAndInstall(isSilent=true, isForceRunAfter=true)
 * — app headless de loja, ninguém pode precisar clicar em wizard).
 *
 * Usado em dois caminhos: a janela segura automática e o botão "atualizar
 * agora" do painel (POST /install-update — única exceção à regra de loja
 * fechada, porque é ato explícito do lojista).
 *
 * `import()` dinâmico de propósito: mantém este módulo importável fora do
 * Electron (vitest) sem carregar o electron-updater.
 */
export async function installNow(): Promise<InstallResult> {
  if (downloadedVersion === null) {
    return { ok: false, error: 'Nenhuma atualização baixada' }
  }
  if (installInitiated) {
    return { ok: false, error: 'Instalação já iniciada' }
  }
  installInitiated = true
  try {
    const { autoUpdater } = await import('electron-updater')
    log.info(`Instalando update v${downloadedVersion} (quitAndInstall silencioso + relaunch)`)
    autoUpdater.quitAndInstall(true, true)
    return { ok: true, version: downloadedVersion }
  } catch (err) {
    // Libera a trava: uma falha aqui não pode aposentar as próximas janelas.
    installInitiated = false
    const message = err instanceof Error ? err.message : String(err)
    log.error(`quitAndInstall falhou: ${message}`)
    return { ok: false, error: message }
  }
}

export interface SafeWindowSignals {
  storeClosed: boolean
  queueEmpty: boolean
}

/**
 * Ponto de entrada chamado por realtime.ts após cada poll bem-sucedido.
 * Compõe os sinais externos com o estado interno (update pronto? fila
 * quieta?) e, se — e só se — a janela for segura, dispara a instalação.
 * Nunca lança: o caller é o caminho crítico que imprime pedidos reais.
 * Retorna a decisão para log/teste.
 */
export function maybeInstallOnSafeWindow(signals: SafeWindowSignals): InstallDecision {
  const decision = shouldInstallNow({
    updateReady: downloadedVersion !== null,
    storeClosed: signals.storeClosed,
    queueEmpty: signals.queueEmpty,
    queueQuiet: isQueueQuiet(lastQueueActivityAtMs, Date.now()),
  })

  if (decision.install) {
    log.info(`Janela segura detectada: ${decision.reason}`)
    installNow()
      .then((result) => {
        if (!result.ok) log.error(`Instalação na janela segura falhou: ${result.error}`)
      })
      .catch((err) =>
        log.error(
          `Instalação na janela segura lançou: ${err instanceof Error ? err.message : String(err)}`
        )
      )
  }

  return decision
}

// ─── Test-only ────────────────────────────────────────────────────────────────

/** Zera todo o estado do módulo. Só para testes. */
export function resetUpdaterStateForTests(): void {
  downloadedVersion = null
  downloadedAtIso = null
  installInitiated = false
  lastQueueActivityAtMs = Date.now()
}
