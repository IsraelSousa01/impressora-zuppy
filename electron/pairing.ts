/**
 * electron/pairing.ts
 * Pareamento MANUAL: o dono copia o código da impressora na tela do Zuppy e
 * manda este app usá-lo.
 *
 * O caminho normal continua sendo o zero-config — a tela do Zuppy acha o app
 * na porta local e chama POST /configure. Este aqui é o resgate, e ele existe
 * porque a porta pode não ser achável: numa máquina com duas impressoras a
 * segunda instância sobe em 7848+, e se todas as portas da faixa estiverem
 * ocupadas não há servidor local nenhum para a tela encontrar. O pareamento
 * pela bandeja não depende de porta, então é justamente o que funciona quando
 * o caminho principal falha.
 *
 * O "código de pareamento" É o device_token (um UUID). Por isso ele nunca
 * aparece em log — só mascarado, como no POST /configure.
 */

import { clipboard } from 'electron'

import { getConfig, setConfig } from './store'
import { resolveApiBaseUrl } from './config'
import { requestPrinterSession, PrinterAuthError, connect, disconnect } from './realtime'
import { formatDeviceLabel, type PrinterDestination } from './destination'
import { createLogger, maskDeviceToken } from './logger'

const log = createLogger('PAIRING')

/** UUID canônico, que é a forma do device_token emitido pelo Zuppy. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type PairingFailureReason = 'invalid_code' | 'rejected' | 'unreachable'

export type PairingResult =
  | {
      ok: true
      /** "Cozinha — Podrão", para mostrar ao dono. */
      label: string | null
      destination: PrinterDestination | null
    }
  | { ok: false; reason: PairingFailureReason; message: string }

/**
 * Lê o código colado como entrada suja: vem de um Ctrl+C que pode ter pegado
 * aspas, espaço ou quebra de linha junto. Devolve o UUID em minúsculas, ou
 * `null` se não for um código — validar ANTES de chamar o servidor evita
 * mandar para a API o que quer que estivesse na área de transferência.
 */
export function parsePairingCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null

  const cleaned = raw.trim().replace(/^["'<]+|[">']+$/g, '').trim().toLowerCase()
  return UUID_PATTERN.test(cleaned) ? cleaned : null
}

/**
 * Texto que o dono do restaurante lê quando o pareamento falha. Sem jargão e
 * sempre com o próximo passo — quem está lendo isso está com a comanda parada.
 */
function describeFailure(err: unknown): { reason: PairingFailureReason; message: string } {
  const status = err instanceof PrinterAuthError ? err.httpStatus : null

  if (status === 401 || status === 403 || status === 404) {
    return {
      reason: 'rejected',
      message:
        'O Zuppy não reconheceu este código. Ele pode já ter sido usado ou trocado — ' +
        'abra a tela de Impressão no Zuppy e copie o código de novo.',
    }
  }

  if (status !== null) {
    return {
      reason: 'rejected',
      message: `O Zuppy recusou o pareamento (erro ${status}). Tente de novo em alguns minutos.`,
    }
  }

  return {
    reason: 'unreachable',
    message: 'Não consegui falar com o Zuppy agora. Confira a internet deste computador e tente de novo.',
  }
}

/**
 * Pareia este app com o código informado.
 *
 * Valida o código NO SERVIDOR antes de gravar qualquer coisa: um código errado
 * não pode derrubar a impressora que já estava funcionando. Só depois de a
 * sessão ser emitida o device_token novo entra no store.
 *
 * Não toca em `api_url`: um código colado não carrega origem nenhuma, então
 * não tem como dizer para qual Zuppy este app fala. O destino continua sendo o
 * do último pareamento (ou o default de produção).
 */
export async function pairWithCode(rawCode: string | null | undefined): Promise<PairingResult> {
  const code = parsePairingCode(rawCode)
  if (code === null) {
    log.warn('Pareamento manual: o texto colado não é um código de impressora')
    return {
      ok: false,
      reason: 'invalid_code',
      message:
        'O texto copiado não é um código de impressora. Na tela de Impressão do Zuppy, ' +
        'copie o código da impressora e tente de novo.',
    }
  }

  const cfg = getConfig()

  try {
    log.info(`Pareamento manual: validando código ${maskDeviceToken(code)} no Zuppy…`)
    const session = await requestPrinterSession(code, {
      apiBaseUrl: resolveApiBaseUrl(cfg),
      paperSize: cfg.paper_size,
      columns: cfg.columns,
    })

    setConfig({
      device_token: code,
      session_token: session.session_token,
      session_expires_at: session.expires_at,
      tenant_id: session.tenant_id,
      tenant_name: session.tenant_name,
      auto_print: session.auto_print,
      destination: session.destination,
    })

    const label = formatDeviceLabel({
      destination: session.destination,
      tenant_name: session.tenant_name,
    })
    log.info(`Pareamento manual concluído${label ? `: ${label}` : ''}`)

    // Mesma sequência do POST /configure: derruba o loop antigo (que ainda
    // usava a identidade anterior) e sobe outro com a nova.
    await disconnect()
    await connect()

    return { ok: true, label, destination: session.destination }
  } catch (err) {
    const failure = describeFailure(err)
    log.error(
      `Pareamento manual falhou (${failure.reason}):`,
      err instanceof Error ? err.message : String(err)
    )
    return { ok: false, ...failure }
  }
}

/**
 * Pareia usando o que estiver na área de transferência — o "colar código" da
 * bandeja. Copiar no Zuppy e clicar em um item de menu é o caminho mais curto
 * que existe para quem não é técnico: nada de digitar UUID, nada de terminal.
 */
export async function pairFromClipboard(): Promise<PairingResult> {
  return pairWithCode(clipboard.readText())
}
