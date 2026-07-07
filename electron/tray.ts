/**
 * electron/tray.ts
 * Ícone da bandeja (system tray) e menu de contexto.
 *
 * Mostra SÓ a marca Zuppy — sem bolinha colorida de conexão. O status real de
 * conexão vive na tela de Impressão do Gestor (fonte da verdade); a bolinha na
 * bandeja confundia e às vezes ficava desatualizada (dizia "desconectado"
 * mesmo funcionando), então foi removida a pedido.
 */

import { Tray, Menu, nativeImage, app } from 'electron'
import path from 'path'
import { getConfig } from './store'
import { createLogger } from './logger'

const log = createLogger('TRAY')

// ─── Ícone ────────────────────────────────────────────────────────────────────

/** Ícone da marca Zuppy pra bandeja (sem cor de status). */
function brandIcon(): Electron.NativeImage {
  const iconPath = path.join(__dirname, '..', '..', 'resources', 'icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    log.warn(`Tray icon vazio em ${iconPath}, caindo pro icon.ico`)
    return nativeImage.createFromPath(
      path.join(__dirname, '..', '..', 'resources', 'icon.ico'),
    )
  }
  return icon
}

// ─── Estado ───────────────────────────────────────────────────────────────────

let tray: Tray | null = null

// ─── Menu de contexto ──────────────────────────────────────────────────────────

function buildContextMenu(): Menu {
  const cfg = getConfig()

  return Menu.buildFromTemplate([
    {
      label: 'Zuppy Impressora',
      enabled: false,
    },
    { type: 'separator' },
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

// ─── API pública ────────────────────────────────────────────────────────────────

/** Cria e mostra o ícone da bandeja. */
export function createTray(): Tray {
  if (tray) return tray

  tray = new Tray(brandIcon())
  tray.setToolTip('Zuppy Impressora')
  tray.setContextMenu(buildContextMenu())

  log.info('Tray icon created')
  return tray
}

/**
 * Re-renderiza o menu da bandeja (ex.: quando a impressora selecionada muda).
 * Mantido porque o main chama isso — não mexe mais em cor/status.
 */
export function updateTray(): void {
  if (!tray) {
    log.warn('updateTray called before tray was created')
    return
  }
  tray.setContextMenu(buildContextMenu())
}

/** Destrói o ícone da bandeja (no quit). */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
    log.info('Tray destroyed')
  }
}
