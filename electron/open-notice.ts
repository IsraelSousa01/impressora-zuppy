/**
 * electron/open-notice.ts
 * A janelinha "Zuppy Impressora está aberto e imprimindo".
 *
 * O app é headless (só bandeja): clicar no atalho com ele já aberto não mostrava
 * nada, e o lojista concluía que o app não abriu. Uma caixa de diálogo do
 * sistema basta — sem renderer, sem preload, sem superfície nova de ataque.
 * O texto e o "uma por vez" são decididos em electron/launch.ts (puro e testado).
 */

import { dialog } from 'electron'
import { getConfig, isConfigured } from './store'
import { getConnectionStatus } from './realtime'
import { createLogger } from './logger'
import { createNoticeThrottle, describeOpenNotice } from './launch'

const log = createLogger('OPEN')

/** Depois de fechada, a próxima janelinha só pode aparecer 1,5 s depois. */
const NOTICE_MIN_GAP_MS = 1500

const throttle = createNoticeThrottle({ minGapMs: NOTICE_MIN_GAP_MS })

/** Mostra a janelinha, a menos que já haja uma na tela. Nunca lança. */
export function showOpenNotice(): void {
  if (!throttle.tryStart(Date.now())) return

  try {
    const notice = describeOpenNotice({
      configured: isConfigured(),
      connected: getConnectionStatus(),
      printer: getConfig().printer_name ?? null,
    })

    dialog
      .showMessageBox({
        type: 'info',
        title: 'Zuppy Impressora',
        message: notice.message,
        detail: notice.detail,
        buttons: ['OK'],
      })
      .catch((err) => log.error('Janelinha de abertura falhou', err))
      .finally(() => throttle.finish(Date.now()))
  } catch (err) {
    throttle.finish(Date.now())
    log.error('Janelinha de abertura falhou', err)
  }
}
