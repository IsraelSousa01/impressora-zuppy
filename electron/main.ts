/**
 * electron/main.ts
 * Electron main process – entry point.
 *
 * Responsibilities:
 *  1. Single-instance lock
 *  2. Auto-start with Windows (Login Items)
 *  3. System tray icon (Pure headless - no settings window)
 *  4. HTTP server on localhost (7847 na instância default)
 *  5. Polling de print jobs na API do Zuppy
 *  6. Print queue crash-recovery
 *  7. Auto-updater
 *  8. Atalho `zuppy-impressora://abrir` e janelinha "está aberto"
 */

import { app, ipcMain, powerSaveBlocker } from 'electron'
import { autoUpdater } from 'electron-updater'
import fs from 'fs'

import { getConfig, isConfigured, getLogs, setConfig } from './store'
import { loadPendingQueue } from './store'
import { startHttpServer, stopHttpServer, getBoundPort } from './http-server'
import { connect, disconnect, realtimeEvents, getConnectionStatus } from './realtime'
import { createSleepGuard } from './sleep-guard'
import { restoreQueue, getQueueStatus } from './print-queue'
import { registerDownloadedUpdate } from './updater'
import { enumeratePrinters, listPrinters, testPrint } from './printer'
import { createTray, updateTray, destroyTray } from './tray'
import { showOpenNotice } from './open-notice'
import { PROTOCOL_SCHEME, parseLaunchRequest, shouldShowNoticeOnBoot } from './launch'
import { markStarted, markCleanExit, allowCrashRelaunch } from './run-state'
import { formatDeviceLabel } from './destination'
import { createLogger, initFileLog } from './logger'
import {
  resolveInstanceIdentity,
  resolvePortCandidates,
  resolveUserDataPath,
  resolveLoginItemSettings,
} from './instance'

const log = createLogger('MAIN')

const IS_DEV = !app.isPackaged

// ─── Identidade desta instância ───────────────────────────────────────────────

/**
 * Porta e profile ANTES de qualquer outra coisa — o resto do boot depende
 * disso. Sem argumento nenhum devolve a instância de hoje (porta 7847,
 * profile `null`, pasta de dados intocada).
 */
const instance = resolveInstanceIdentity(process.argv, process.env)


/**
 * Pasta de dados própria por profile. Tem que acontecer AQUI, antes do
 * single-instance lock e de qualquer leitura de config, por dois motivos:
 *
 *  - o lock do Electron é por pasta de dados, então é ele que impede duas
 *    cópias do MESMO profile (e permite duas de profiles diferentes);
 *  - o store lê `userData` na primeira leitura de config (electron/store.ts),
 *    e é o que separa device_token e session_token de cada impressora.
 *
 * Profile `null` não chama setPath: a instância default continua exatamente
 * na pasta de sempre.
 */
if (instance.profile !== null) {
  const userDataPath = resolveUserDataPath(app.getPath('userData'), instance.profile)
  fs.mkdirSync(userDataPath, { recursive: true })
  app.setPath('userData', userDataPath)
}

// ─── Single instance lock ─────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  log.warn('Another instance is already running – quitting')
  app.quit()
} else {
  /**
   * Registro em arquivo (o console do app instalado se perde). Só quem ganhou o
   * lock abre o arquivo: a segunda cópia podaria/rotacionaria o arquivo em uso
   * pela primeira. Nome por profile: duas instâncias na mesma máquina não
   * escrevem no mesmo arquivo. Falhar aqui nunca impede o app de subir.
   */
  try {
    const logFileName =
      instance.profile === null ? 'zuppy-impressora' : `zuppy-impressora-${instance.profile}`
    initFileLog(app.getPath('logs'), logFileName)
  } catch (err) {
    console.error('Registro em arquivo indisponível:', err instanceof Error ? err.message : String(err))
  }

  for (const warning of instance.warnings) {
    log.warn(warning)
  }
  if (instance.profile !== null) {
    log.info(`Instância "${instance.profile}" — dados em ${app.getPath('userData')}`)
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle('get-status', () => {
    const { getConnectionStatus } = require('./realtime') as typeof import('./realtime')
    const cfg = getConfig()
    const queueStatus = getQueueStatus()
    const logs = getLogs()

    return {
      status: isConfigured()
        ? getConnectionStatus()
          ? 'connected'
          : 'disconnected'
        : 'not_configured',
      version: app.getVersion(),
      printer: cfg.printer_name ?? null,
      paper_size: cfg.paper_size ?? '80mm',
      queue: queueStatus.length,
      lastPrint: logs[0] ?? null,
      tenant_name: cfg.tenant_name ?? null,
      tenant_id: cfg.tenant_id ?? null,
      connected: getConnectionStatus(),
      // Aditivos, espelhando o GET /status do servidor local.
      port: getBoundPort(),
      profile: instance.profile,
      destination: cfg.destination ?? null,
      display_name: formatDeviceLabel(cfg),
    }
  })

  ipcMain.handle('get-config', () => {
    const cfg = getConfig()
    const { session_token: _s, device_token: _d, ...safe } = cfg as Record<string, unknown>
    void _s
    void _d
    return safe
  })

  ipcMain.handle('get-logs', () => getLogs())

  ipcMain.handle('get-printers', () => listPrinters())
  ipcMain.handle('enumerate-printers', () => enumeratePrinters())

  ipcMain.handle('save-config', async (_event, patch: Record<string, unknown>) => {
    // `api_url` decide para QUAL Zuppy este app manda o device_token, e o único
    // caminho que pode gravá-lo é o POST /configure — lá ele passa pela
    // allowlist e precisa bater com o `Origin` do pareamento. Aqui a chave é
    // descartada: a janela de configurações não tem por que mexer nisso.
    const { api_url: _apiUrlIgnored, ...safePatch } = patch
    void _apiUrlIgnored

    setConfig(safePatch as Parameters<typeof setConfig>[0])

    // Reconnect with new config if device token was updated — lendo o patch
    // que foi REALMENTE gravado, não o original.
    if (safePatch.device_token) {
      await disconnect()
      await connect()
    }

    updateTray()
    return { ok: true }
  })

  ipcMain.handle('test-print', async (_event, printerName?: string) => {
    const cfg = getConfig()
    const target = printerName ?? cfg.printer_name
    if (!target) throw new Error('No printer specified or configured')
    await testPrint(target)
    return { ok: true }
  })
}

// ─── Auto-updater ─────────────────────────────────────────────────────────────

function setupAutoUpdater(): void {
  if (IS_DEV) {
    log.info('Skipping auto-updater in dev mode')
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoUpdater.logger = {
    info:  (msg: unknown) => log.info(`[updater] ${msg}`),
    warn:  (msg: unknown) => log.warn(`[updater] ${msg}`),
    error: (msg: unknown) => log.error(`[updater] ${msg}`),
    debug: (msg: unknown) => log.debug(`[updater] ${msg}`),
  } as unknown as typeof autoUpdater.logger

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    log.info('Update available', info)
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded', info)
    // Registra no updater.ts: o app roda 24/7 (auto-start, lojista nunca
    // fecha), então autoInstallOnAppQuit sozinho deixaria o instalador
    // parado no disco pra sempre. A instalação acontece na janela segura
    // (loja fechada + fila vazia — ver maybeInstallOnSafeWindow) ou sob
    // demanda pelo painel (POST /install-update).
    registerDownloadedUpdate(info.version)
  })

  autoUpdater.on('error', (err) => {
    log.error('Auto-updater error', err)
  })

  // Check for updates every 4 hours
  const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
  autoUpdater.checkForUpdates().catch((err) => log.error('Initial update check failed', err))
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => log.error('Periodic update check failed', err))
  }, CHECK_INTERVAL_MS)
}

// ─── Auto-start with Windows ──────────────────────────────────────────────────

function configureAutoStart(): void {
  if (IS_DEV) return

  // Instância com profile volta do reboot com os PRÓPRIOS argumentos e sob
  // nome próprio no registro; a default registra exatamente o de sempre.
  // Ver resolveLoginItemSettings (electron/instance.ts).
  const settings = resolveLoginItemSettings(instance)
  app.setLoginItemSettings(settings)

  log.info(`Auto-start configured (${settings.name})`)
}

// ─── Computador acordado com a loja aberta ────────────────────────────────────

/**
 * `prevent-app-suspension`: o sistema não suspende, a tela apaga normalmente.
 * Ligado/desligado pelo sinal de cada consulta bem-sucedida (ver
 * electron/sleep-guard.ts e o evento `poll-ok` de electron/realtime.ts).
 */
const sleepGuard = createSleepGuard({
  start: () => powerSaveBlocker.start('prevent-app-suspension'),
  stop: (id) => powerSaveBlocker.stop(id),
})

function setupSleepGuard(): void {
  realtimeEvents.on('poll-ok', (signals: { storeClosed: boolean; hasSession: boolean }) => {
    const wasActive = sleepGuard.isActive()
    sleepGuard.update(signals)
    if (wasActive !== sleepGuard.isActive()) {
      log.info(
        sleepGuard.isActive()
          ? 'Loja aberta: computador mantido acordado'
          : 'Loja fechada: computador liberado para dormir',
      )
    }
  })
  // Polling PARADO de propósito (pareamento trocado, app saindo): nada de
  // segurar o computador sem sessão. Queda de internet NÃO solta aqui — é
  // justamente quando o computador não pode dormir com a loja aberta; um sinal
  // velho expira sozinho (SLEEP_GUARD_STALE_MS).
  realtimeEvents.on('stopped', () => sleepGuard.release())
}

// ─── Atalho que o navegador chama ──────────────────────────────────────────────

/**
 * Registra `zuppy-impressora://abrir` no Windows. Só no app empacotado (em dev
 * registraria o electron.exe) e só na instância default: o registro é um só por
 * máquina e as instâncias com profile não podem disputá-lo. Falhar aqui não
 * pode impedir o app de imprimir.
 */
function registerProtocolClient(): void {
  if (IS_DEV || instance.profile !== null) return
  try {
    const ok = app.setAsDefaultProtocolClient(PROTOCOL_SCHEME)
    log.info(`Atalho ${PROTOCOL_SCHEME}://abrir ${ok ? 'registrado' : 'não registrado'}`)
  } catch (err) {
    log.error('Registrar o atalho do navegador falhou', err)
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

// Segunda abertura (clique no atalho, ou o navegador chamando
// `zuppy-impressora://abrir`) com o app já rodando: mostra a janelinha em vez de
// calar. O argv vem do navegador e é validado em parseLaunchRequest.
app.on('second-instance', (_event, argv) => {
  const request = parseLaunchRequest(argv)
  if (request.kind === 'ignore') {
    log.warn('Segunda abertura com link não reconhecido — ignorada')
    return
  }
  log.info('Second instance detected - app is already running in tray')
  showOpenNotice()
})

app.on('window-all-closed', () => {
  // Keep running in the tray even if any dummy windows are closed — a simples
  // presença deste listener (sem chamar app.quit()) impede o encerramento.
})

/**
 * Erro inesperado no processo principal. Sem handler o Electron abre uma caixa
 * "A JavaScript error occurred in the main process" e o app headless fica
 * parado atrás dela, sem imprimir. Aqui: registra (só a mensagem, nunca o
 * objeto) e reabre limpo, com teto de reaberturas (allowCrashRelaunch) para um
 * erro de boot não virar laço. Acima do teto o app SEGUE VIVO: sair deixaria a
 * loja sem impressão e sem ninguém para reabrir. Queda dura (kill, falta de
 * energia) nenhum código do processo trata: aí vale o auto-start do Windows.
 */
function handleUncaughtException(err: unknown): void {
  log.error('Erro inesperado:', err instanceof Error ? err.message : String(err))
  if (IS_DEV) return

  const userData = app.getPath('userData')
  if (!allowCrashRelaunch(userData)) {
    log.error('Reaberturas demais em pouco tempo; sigo rodando sem reabrir')
    return
  }

  // O marcador de execução FICA: o próximo boot registra que a anterior caiu.
  // O link do navegador não é argumento a repetir na reabertura.
  const args = process.argv.slice(1).filter((a) => !a.toLowerCase().startsWith(`${PROTOCOL_SCHEME}:`))
  // O novo processo precisa do lock; o Electron o inicia só depois deste sair.
  app.releaseSingleInstanceLock()
  app.relaunch({ args })
  app.exit(1)
}

process.on('uncaughtException', handleUncaughtException)
// Promessa rejeitada solta: o estado do processo segue são, só registra.
process.on('unhandledRejection', (reason) => {
  log.error('Promessa rejeitada sem tratamento:', reason instanceof Error ? reason.message : String(reason))
})

app.on('before-quit', async () => {
  // A segunda cópia (sem o lock) também passa por aqui ao sair: ela não é dona
  // do marcador, do servidor local nem do polling da primeira.
  if (!gotLock) return

  log.info('App quitting…')
  markCleanExit(app.getPath('userData'))
  sleepGuard.release()
  destroyTray()
  await stopHttpServer()
  await disconnect()
})

app.whenReady().then(async () => {
  log.info(`Zuppy Impressora v${app.getVersion()} starting (Headless Mode)`)

  const previousRun = markStarted(app.getPath('userData'))
  if (previousRun.previousEndedUnexpectedly) {
    log.warn(
      'A execução anterior não terminou normalmente ' +
        `(iniciada em ${previousRun.previousStartedAt ? new Date(previousRun.previousStartedAt).toISOString() : 'horário desconhecido'})`,
    )
  }

  // Register IPC handlers
  registerIpcHandlers()

  // Create tray (headless - sair e parear pelo código copiado)
  createTray({ profile: instance.profile })

  // Start HTTP server — a porta pedida primeiro, as vizinhas se ela estiver
  // ocupada (outra impressora desta mesma máquina).
  try {
    await startHttpServer(resolvePortCandidates(instance.requestedPort))
  } catch (err) {
    // Não é fatal: o polling não passa por este servidor, então o app continua
    // imprimindo. O que fica indisponível é o pareamento pela tela do Zuppy —
    // e para isso existe o "Parear com o código copiado" na bandeja.
    log.error('Servidor local não subiu (pareamento pela tela do Zuppy indisponível)', err)
  }

  // Restore any jobs that survived a crash
  const pendingIds = loadPendingQueue()
  if (pendingIds.length > 0) {
    log.info(`Restoring ${pendingIds.length} pending jobs from last session`)
    restoreQueue(pendingIds)
  }

  // Start polling Zuppy for print jobs if already configured
  if (isConfigured()) {
    connect().catch((err) => log.error('Initial polling connection failed', err))
  } else {
    log.info('App not yet configured – waiting for POST /configure')
  }

  // Auto-updater
  setupAutoUpdater()

  // Auto-start registration
  configureAutoStart()

  // Computador acordado com a loja aberta
  setupSleepGuard()

  // Atalho do navegador
  registerProtocolClient()
  // Aberto PELO link (app ainda fechado): o lojista espera uma resposta.
  if (gotLock && shouldShowNoticeOnBoot(process.argv)) showOpenNoticeWhenKnown()
})

/**
 * Recém-aberto, o app ainda não consultou o servidor: mostrar a janelinha agora
 * diria "sem conexão" por engano. Espera a primeira conexão (no máx. 8 s); sem
 * pareamento não há o que esperar.
 */
const OPEN_NOTICE_WAIT_MS = 8_000

function showOpenNoticeWhenKnown(): void {
  if (!isConfigured() || getConnectionStatus()) {
    showOpenNotice()
    return
  }

  let shown = false
  const show = (): void => {
    if (shown) return
    shown = true
    clearTimeout(timer)
    realtimeEvents.off('connected', show)
    showOpenNotice()
  }
  const timer = setTimeout(show, OPEN_NOTICE_WAIT_MS)
  realtimeEvents.on('connected', show)
}
