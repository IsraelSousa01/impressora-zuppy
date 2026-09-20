/**
 * electron/tray.ts
 * Ícone da bandeja (system tray) e menu de contexto.
 *
 * Mostra SÓ a marca Zuppy — sem bolinha colorida de conexão. O status real de
 * conexão vive na tela de Impressão do Gestor (fonte da verdade); a bolinha na
 * bandeja confundia e às vezes ficava desatualizada (dizia "desconectado"
 * mesmo funcionando), então foi removida a pedido.
 */

import { Tray, Menu, nativeImage, app, dialog } from 'electron'
import path from 'path'
import { getConfig } from './store'
import { formatDeviceLabel } from './destination'
import { pairFromClipboard } from './pairing'
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

/**
 * Profile desta instância, quando há um. Só aparece na bandeja de quem roda
 * várias instâncias: com dois ícones iguais ao lado do relógio, o dono precisa
 * de algo que diga qual é qual antes mesmo de o pareamento acontecer.
 * Instância default (profile `null`) mostra exatamente o texto de sempre.
 */
let instanceProfile: string | null = null

// ─── Pareamento pelo código copiado ───────────────────────────────────────────

/**
 * "Colar código": o dono copia o código na tela de Impressão do Zuppy e clica
 * aqui. Feedback sempre em caixa de diálogo — um pareamento que falha calado
 * vira chamado de suporte com a comanda parada.
 */
async function pairFromClipboardAndReport(): Promise<void> {
  const result = await pairFromClipboard()

  if (result.ok) {
    updateTray()
    dialog.showMessageBox({
      type: 'info',
      title: 'Zuppy Impressora',
      message: 'Impressora pareada!',
      detail: result.label
        ? `Este computador agora imprime para: ${result.label}.`
        : 'Este computador está pareado e já pode imprimir.',
      buttons: ['OK'],
    })
    return
  }

  dialog.showMessageBox({
    type: 'warning',
    title: 'Zuppy Impressora',
    message: 'Não consegui parear',
    detail: result.message,
    buttons: ['OK'],
  })
}

// ─── Menu de contexto ──────────────────────────────────────────────────────────

/** Título do menu: com profile, diz QUAL instância é esta. */
function trayTitle(): string {
  return instanceProfile === null ? 'Zuppy Impressora' : `Zuppy Impressora (${instanceProfile})`
}

function buildContextMenu(): Menu {
  const cfg = getConfig()
  // Só quando existe destino: sem impressora nomeada há uma instância por
  // máquina e nada a desambiguar — a bandeja fica idêntica à de hoje.
  const deviceLabel = cfg.destination ? formatDeviceLabel(cfg) : null

  return Menu.buildFromTemplate([
    {
      label: trayTitle(),
      enabled: false,
    },
    { type: 'separator' },
    ...(deviceLabel ? [{ label: deviceLabel, enabled: false } as const] : []),
    {
      label: `Impressora: ${cfg.printer_name ?? '(não selecionada)'}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Parear com o código copiado',
      click: () => {
        // O click do Electron não espera promise: um erro aqui morreria sem
        // rastro e sem resposta nenhuma para quem clicou.
        pairFromClipboardAndReport().catch((err) => {
          log.error('Pareamento pela bandeja falhou', err)
          dialog.showMessageBox({
            type: 'error',
            title: 'Zuppy Impressora',
            message: 'Não consegui parear',
            detail: 'Tente de novo. Se continuar, chame o suporte da Zuppy.',
            buttons: ['OK'],
          })
        })
      },
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
export function createTray(opts: { profile?: string | null } = {}): Tray {
  if (tray) return tray

  instanceProfile = opts.profile ?? null
  tray = new Tray(brandIcon())
  tray.setToolTip(trayTitle())
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
