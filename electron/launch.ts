/**
 * electron/launch.ts
 * O que "abrir o app com ele já aberto" significa: o atalho do Windows e o
 * link `zuppy-impressora://abrir` que o navegador chama.
 *
 * Tudo aqui é função pura sobre argv/estado. Quem mostra a janelinha e registra
 * o protocolo (dialog, app.setAsDefaultProtocolClient) é o main — assim a
 * decisão é testável sem Electron (mesmo desenho de electron/instance.ts).
 *
 * Segurança: o link vem do NAVEGADOR, e qualquer página pode pedi-lo. Por isso
 * ele só serve para abrir a janelinha. Nada na URL é interpretado: nem
 * parâmetro, nem caminho, nem fragmento. Um destino que não seja exatamente
 * `abrir` não faz nada.
 */

/** Esquema registrado no Windows (briefing do épico, tabela "Limites do app"). */
export const PROTOCOL_SCHEME = 'zuppy-impressora'

/** Único destino reconhecido do link. */
const OPEN_TARGET = 'abrir'

export type LaunchRequest =
  /** Mostrar a janelinha "está aberto". */
  | { kind: 'open' }
  /** Pedido do nosso esquema que não é o atalho de abrir: não faz nada. */
  | { kind: 'ignore' }

/**
 * Lê o argv de uma segunda abertura (ou da primeira).
 *
 *  - sem URL do nosso esquema (clique no atalho do app) → `open`;
 *  - `zuppy-impressora://abrir` → `open`, ignorando query e fragmento;
 *  - qualquer outra forma do nosso esquema → `ignore`.
 *
 * A primeira URL do nosso esquema decide; as demais são descartadas. Nunca lança.
 */
export function parseLaunchRequest(argv: readonly string[]): LaunchRequest {
  const raw = argv.find((arg) => arg.toLowerCase().startsWith(`${PROTOCOL_SCHEME}:`))
  if (raw === undefined) return { kind: 'open' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: 'ignore' }
  }

  const isPlainOpen =
    url.protocol === `${PROTOCOL_SCHEME}:` &&
    url.hostname.toLowerCase() === OPEN_TARGET &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    (url.pathname === '' || url.pathname === '/')

  return isPlainOpen ? { kind: 'open' } : { kind: 'ignore' }
}

/**
 * Na PRIMEIRA abertura do processo: só mostra a janelinha quando o app foi
 * aberto pelo link (o navegador o iniciou e o lojista espera uma resposta).
 * Subir sozinho com o Windows também não leva URL e não pode abrir caixa de
 * diálogo na cara de ninguém.
 */
export function shouldShowNoticeOnBoot(argv: readonly string[]): boolean {
  const cameFromLink = argv.some((arg) => arg.toLowerCase().startsWith(`${PROTOCOL_SCHEME}:`))
  return cameFromLink && parseLaunchRequest(argv).kind === 'open'
}

// ─── Texto da janelinha ───────────────────────────────────────────────────────

export interface OpenNoticeState {
  /** O app já foi pareado com uma loja (tem device_token). */
  configured: boolean
  /** O polling está falando com o Zuppy neste instante. */
  connected: boolean
  /** Impressora escolhida; `null` = ainda nenhuma. */
  printer: string | null
}

export interface OpenNotice {
  message: string
  detail: string
}

const WHERE_IT_LIVES = 'Pode fechar esta janela: o app continua trabalhando na bandeja, ao lado do relógio.'

/**
 * Texto da janelinha. Só diz "imprimindo" quando é verdade: pareado, com
 * impressora e conectado. Uma janela que afirma "imprimindo" com a internet
 * fora faria o lojista confiar num app parado.
 */
export function describeOpenNotice(state: OpenNoticeState): OpenNotice {
  if (!state.configured) {
    return {
      message: 'Zuppy Impressora está aberto',
      detail:
        'Ele ainda não está ligado a uma loja. No Zuppy, na tela de Impressão, copie o código de conexão ' +
        'e clique em "Parear com o código copiado" no ícone da bandeja, ao lado do relógio.',
    }
  }

  if (!state.connected) {
    return {
      message: 'Zuppy Impressora está aberto, mas sem conexão com o Zuppy',
      detail:
        'Confira a internet deste computador. Os pedidos voltam a imprimir sozinhos quando a conexão voltar. ' +
        WHERE_IT_LIVES,
    }
  }

  if (!state.printer) {
    return {
      message: 'Zuppy Impressora está aberto',
      detail:
        'Ele está conectado, mas ainda não tem impressora escolhida. Escolha a impressora na tela de Impressão do Zuppy.',
    }
  }

  return {
    message: 'Zuppy Impressora está aberto e imprimindo',
    detail: `Impressora: ${state.printer}. ${WHERE_IT_LIVES}`,
  }
}

// ─── Uma janelinha por vez ────────────────────────────────────────────────────

/**
 * Controle de "uma janelinha por vez, sem rajada". Uma página (ou um atalho
 * clicado dez vezes) que peça o link em sequência não pode empilhar dez caixas
 * de diálogo na tela do caixa.
 */
export function createNoticeThrottle(opts: { minGapMs: number }) {
  let open = false
  let lastFinishedAtMs = Number.NEGATIVE_INFINITY

  return {
    /** Pode mostrar agora? Se sim, marca como aberta. */
    tryStart(nowMs: number): boolean {
      if (open) return false
      if (nowMs - lastFinishedAtMs < opts.minGapMs) return false
      open = true
      return true
    },
    /** A janelinha foi fechada. */
    finish(nowMs: number): void {
      open = false
      lastFinishedAtMs = nowMs
    },
  }
}
