/**
 * electron/tray.ts
 * System tray icon and context menu management.
 *
 * - Green circle = connected to Supabase Realtime
 * - Red circle   = not configured or disconnected
 * - Clicking "Configurações" opens/focuses the settings window
 */

import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron'
import path from 'path'
import { getConfig, isConfigured } from './store'
import { getConnectionStatus } from './realtime'
import { createLogger } from './logger'

const log = createLogger('TRAY')

// ─── Icon generation ──────────────────────────────────────────────────────────

/**
 * Loads a 16x16 status dot tray icon from the resources folder.
 * @param color 'green' | 'red' | 'orange'
 */
function getTrayIcon(color: 'green' | 'red' | 'orange'): Electron.NativeImage {
  const iconPath = path.join(__dirname, '..', '..', 'resources', `${color}.png`)
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    log.warn(`Tray icon empty at ${iconPath}, falling back to brand icon`)
    const fallbackPath = path.join(__dirname, '..', '..', 'resources', 'icon.ico')
    const fallback = nativeImage.createFromPath(fallbackPath)
    return fallback
  }
  return icon
}

// ─── Tray state ───────────────────────────────────────────────────────────────

let tray: Tray | null = null

/**
 * Returns the appropriate icon color based on current state.
 */
function getCurrentColor(): 'green' | 'red' | 'orange' {
  if (!isConfigured()) return 'red'
  if (getConnectionStatus()) return 'green'
  return 'orange'
}

/**
 * Returns the tooltip text for the tray icon.
 */
function getTooltip(): string {
  if (!isConfigured()) return 'Zuppy Impressora – Não configurado'
  const cfg = getConfig()
  if (getConnectionStatus()) {
    return `Zuppy Impressora – Conectado (${cfg.tenant_name ?? cfg.tenant_id})`
  }
  return 'Zuppy Impressora – Desconectado'
}

// ─── Context menu ─────────────────────────────────────────────────────────────

function buildContextMenu(): Menu {
  const cfg = getConfig()
  const connected = getConnectionStatus()

  return Menu.buildFromTemplate([
    {
      label: 'Zuppy Impressora',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: connected
        ? `✅ Conectado – ${cfg.tenant_name ?? cfg.tenant_id ?? ''}`
        : isConfigured()
        ? '🟠 Desconectado'
        : '🔴 Não configurado',
      enabled: false,
    },
    {
      label: `Impressora: ${cfg.printer_name ?? '(não selecionada)'}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        app.quit()
      },
    },
  ])
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates and shows the system tray icon.
 */
export function createTray(): Tray {
  if (tray) return tray

  const icon = getTrayIcon(getCurrentColor())

  tray = new Tray(icon)
  tray.setToolTip(getTooltip())
  tray.setContextMenu(buildContextMenu())

  log.info('Tray icon created')
  return tray
}

/**
 * Updates the tray icon and tooltip to reflect current connection state.
 * Call this whenever the Realtime connection status changes.
 */
export function updateTray(): void {
  if (!tray) {
    log.warn('updateTray called before tray was created')
    return
  }

  const color = getCurrentColor()
  const icon = getTrayIcon(color)
  tray.setImage(icon)
  tray.setToolTip(getTooltip())
  tray.setContextMenu(buildContextMenu())

  log.debug(`Tray updated: ${color}`)
}

/**
 * Destroys the tray icon (call on app quit).
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
    log.info('Tray destroyed')
  }
}
