/**
 * electron/main.ts
 * Electron main process – entry point.
 *
 * Responsibilities:
 *  1. Single-instance lock
 *  2. Auto-start with Windows (Login Items)
 *  3. System tray icon (Pure headless - no settings window)
 *  4. HTTP server on localhost:7847
 *  5. Connection to Zuppy SSE stream
 *  6. Print queue crash-recovery
 *  7. Auto-updater
 */

import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

import { getConfig, isConfigured, getLogs, setConfig } from './store'
import { loadPendingQueue } from './store'
import { startHttpServer, stopHttpServer } from './http-server'
import { connect, disconnect } from './realtime'
import { restoreQueue, getQueueStatus } from './print-queue'
import { listPrinters, testPrint } from './printer'
import { createTray, updateTray, destroyTray } from './tray'
import { createLogger } from './logger'

const log = createLogger('MAIN')

const IS_DEV = !app.isPackaged

// ─── Single instance lock ─────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  log.warn('Another instance is already running – quitting')
  app.quit()
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

  ipcMain.handle('save-config', async (_event, patch: Record<string, unknown>) => {
    setConfig(patch as Parameters<typeof setConfig>[0])

    // Reconnect with new config if device token was updated
    if (patch.device_token) {
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

  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true, // Start minimised to tray
    name: 'Zuppy Impressora',
  })

  log.info('Auto-start configured')
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on('second-instance', () => {
  log.info('Second instance detected - app is already running in tray')
})

app.on('window-all-closed', (e: Event) => {
  // Keep running in the tray even if any dummy windows are closed
  e.preventDefault()
})

app.on('before-quit', async () => {
  log.info('App quitting…')
  destroyTray()
  await stopHttpServer()
  await disconnect()
})

app.whenReady().then(async () => {
  log.info(`Zuppy Impressora v${app.getVersion()} starting (Headless Mode)`)

  // Register IPC handlers
  registerIpcHandlers()

  // Create tray (headless - only exit option)
  createTray()

  // Start HTTP server
  try {
    await startHttpServer()
  } catch (err) {
    log.error('Failed to start HTTP server', err)
  }

  // Restore any jobs that survived a crash
  const pendingIds = loadPendingQueue()
  if (pendingIds.length > 0) {
    log.info(`Restoring ${pendingIds.length} pending jobs from last session`)
    restoreQueue(pendingIds)
  }

  // Connect to Zuppy SSE stream if already configured
  if (isConfigured()) {
    connect().catch((err) => log.error('Initial SSE connection failed', err))
  } else {
    log.info('App not yet configured – waiting for POST /configure')
  }

  // Auto-updater
  setupAutoUpdater()

  // Auto-start registration
  configureAutoStart()
})
