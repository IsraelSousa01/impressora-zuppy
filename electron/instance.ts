/**
 * electron/instance.ts
 * Identidade desta INSTÂNCIA do app: em que porta o servidor local escuta e em
 * qual pasta de dados (profile) ela escreve.
 *
 * Existe porque uma máquina pode atender MAIS DE UMA impressora: desde que o
 * Zuppy passou a nomear impressoras por finalidade (Cozinha, Bar…), cada
 * destino tem o próprio device_token e precisa do próprio app rodando. Duas
 * instâncias na mesma pasta de dados dividiriam device_token e session_token —
 * a segunda derrubaria a primeira.
 *
 * Tudo aqui é função pura sobre argv/env. Quem APLICA (app.setPath, listen,
 * setLoginItemSettings) é o main — assim a decisão é testável sem Electron.
 *
 * Regra número um: instância sem nenhum argumento é a de hoje. Porta 7847,
 * profile `null`, pasta de dados intocada, login item com o mesmo nome e sem
 * args. Quem já tem o app instalado não repareia nada.
 */

/** Porta histórica do servidor local — a do pareamento zero-config do Gestor. */
export const DEFAULT_LOCAL_PORT = 7847

/**
 * Quantas portas consecutivas tentar quando a pedida está ocupada: 7847..7850
 * no default. Curto de propósito — é uma faixa que o Gestor consegue varrer
 * para achar as impressoras desta máquina, e quatro instâncias na mesma
 * máquina já é mais do que qualquer restaurante da base tem.
 */
export const PORT_SEARCH_SPAN = 4

/** Porta privilegiada (<1024) exigiria admin no Windows; fora de cogitação. */
const MIN_PORT = 1024
const MAX_PORT = 65535

/** O profile vira sufixo de pasta; nome longo só atrapalha o suporte a ler. */
const MAX_PROFILE_LENGTH = 24

export interface InstanceIdentity {
  /** Porta PEDIDA (argv/env/default). A efetiva pode diferir — ver resolvePortCandidates. */
  requestedPort: number
  /** `null` = instância default (a pasta de dados de hoje). */
  profile: string | null
  /** O main loga cada uma: argumento inválido nunca é descartado em silêncio. */
  warnings: string[]
}

/**
 * Lê `--flag=valor` ou `--flag valor` do argv. Aceita as duas formas porque o
 * atalho do Windows costuma usar `=` e quem testa no terminal usa espaço.
 */
function readFlag(argv: readonly string[], flag: string): string | undefined {
  const prefix = `--${flag}=`
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
    if (arg === `--${flag}`) return argv[i + 1]
  }
  return undefined
}

/**
 * Porta pedida a partir de texto cru (argv ou env). Valor sem sentido não vira
 * porta: devolve `null` e deixa um aviso para o caller cair no default.
 */
function parseRequestedPort(raw: string, warnings: string[]): number | null {
  const port = Number(raw.trim())
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    warnings.push(
      `Porta "${raw}" ignorada (esperado inteiro entre ${MIN_PORT} e ${MAX_PORT}); usando ${DEFAULT_LOCAL_PORT}`
    )
    return null
  }
  return port
}

/**
 * Normaliza o nome do profile para algo que possa virar sufixo de PASTA:
 * minúsculas, só `[a-z0-9-]`, curto e sem `-` nas pontas.
 *
 * É a barreira de path traversal: de `--profile=../../..` não sobra nada que
 * escape da pasta de dados. O nome nunca é concatenado sem passar por aqui.
 */
export function sanitizeProfileName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, MAX_PROFILE_LENGTH)
    .replace(/^-+|-+$/g, '')
}

/**
 * Profile desta instância:
 *
 *  1. `--profile=nome` / `ZUPPY_PROFILE`, quando dá um nome utilizável;
 *  2. senão, derivado da porta PEDIDA (`porta-7848`) — assim um atalho com só
 *     `--port=7848` já ganha pasta própria, sem o dono ter que entender dois
 *     conceitos. Derivar da porta pedida (e não da efetiva) é o que mantém o
 *     profile determinístico: se a porta pedida estiver ocupada e o app cair
 *     na seguinte, a pasta de dados continua sendo a mesma de sempre;
 *  3. porta default e nenhum nome ⇒ `null`, a instância de hoje.
 *
 * Efeito colateral bom de (2): abrir DUAS vezes o mesmo atalho dá o mesmo
 * profile, logo a mesma pasta de dados, logo o single-instance lock do
 * Electron (que é por pasta de dados) barra a segunda cópia — exatamente o
 * que se quer.
 */
function resolveProfile(
  rawProfile: string | undefined,
  requestedPort: number,
  warnings: string[]
): string | null {
  if (rawProfile !== undefined) {
    const sanitized = sanitizeProfileName(rawProfile)
    if (sanitized !== '') return sanitized
    warnings.push(`Profile "${rawProfile}" não tem nenhum caractere utilizável; ignorado`)
  }

  return requestedPort === DEFAULT_LOCAL_PORT ? null : `porta-${requestedPort}`
}

/** Decide porta pedida e profile a partir do argv e do ambiente. */
export function resolveInstanceIdentity(
  argv: readonly string[],
  env: Record<string, string | undefined>
): InstanceIdentity {
  const warnings: string[] = []

  const rawPort = readFlag(argv, 'port') ?? env.ZUPPY_LOCAL_PORT
  const requestedPort =
    (rawPort !== undefined ? parseRequestedPort(rawPort, warnings) : null) ?? DEFAULT_LOCAL_PORT

  const rawProfile = readFlag(argv, 'profile') ?? env.ZUPPY_PROFILE
  const profile = resolveProfile(rawProfile, requestedPort, warnings)

  return { requestedPort, profile, warnings }
}

/**
 * Portas a tentar, em ordem: a pedida e as seguintes da faixa curta. A
 * primeira livre vence.
 *
 * Por que tentar a seguinte em vez de falhar: a porta ocupada quase sempre é
 * OUTRA instância da própria Zuppy (a impressora da cozinha já ligada), e
 * exigir que o dono do restaurante edite atalho a cada impressora nova
 * transformaria um caso comum em chamado de suporte. A porta efetiva vai para
 * o log e para o GET /status — nunca é escolhida em silêncio.
 */
export function resolvePortCandidates(requestedPort: number): number[] {
  const candidates: number[] = []
  for (let offset = 0; offset < PORT_SEARCH_SPAN; offset++) {
    const port = requestedPort + offset
    if (port <= MAX_PORT) candidates.push(port)
  }
  return candidates
}

/**
 * Pasta de dados desta instância. Profile `null` devolve a pasta default
 * INTACTA — é o que garante que o app já instalado continue lendo o mesmo
 * `zuppy-impressora.json` de sempre.
 *
 * Concatena em vez de `path.join(dir, entradaDoUsuário)`: mesmo que o
 * saneamento falhasse, não há separador de caminho vindo do usuário para
 * escapar da pasta.
 */
export function resolveUserDataPath(defaultUserDataPath: string, profile: string | null): string {
  return profile === null ? defaultUserDataPath : `${defaultUserDataPath}-${profile}`
}

/** O que o main passa para `app.setLoginItemSettings`. */
export interface LoginItemSettings {
  openAtLogin: boolean
  openAsHidden: boolean
  name: string
  /** Só existe em instância com profile — ver resolveLoginItemSettings. */
  args?: string[]
}

/**
 * Registro de auto-start desta instância.
 *
 * Instância com profile precisa de NOME PRÓPRIO e dos ARGS: o nome porque o
 * registro do Windows é uma chave por nome (duas instâncias com o mesmo nome
 * sobrescrevem uma à outra e só uma volta depois do reboot), e os args porque
 * sem eles a segunda impressora voltaria como instância default e brigaria
 * pela porta e pela pasta de dados da primeira.
 *
 * Instância default devolve exatamente o objeto de hoje, sem `args`.
 */
export function resolveLoginItemSettings(
  identity: Pick<InstanceIdentity, 'profile' | 'requestedPort'>
): LoginItemSettings {
  const base = { openAtLogin: true, openAsHidden: true }

  if (identity.profile === null) {
    return { ...base, name: 'Zuppy Impressora' }
  }

  return {
    ...base,
    name: `Zuppy Impressora (${identity.profile})`,
    args: [`--profile=${identity.profile}`, `--port=${identity.requestedPort}`],
  }
}
