/**
 * electron/pairing.test.ts
 *
 * Cobre o pareamento manual (o "colar código" da bandeja), que é o caminho de
 * resgate quando a tela do Zuppy não acha o app numa porta:
 *
 *   - parsePairingCode: o texto vem de um Ctrl+C, então é entrada suja; e o
 *     código É o device_token, então nada que não seja um código sai desta
 *     máquina em direção à API.
 *   - pairWithCode: valida NO SERVIDOR antes de gravar — código errado não
 *     pode derrubar a impressora que já estava funcionando.
 *   - o código nunca aparece inteiro no log (é segredo, como no /configure).
 *
 * `electron` e `electron-store` são mockados só para permitir o import fora do
 * Electron (mesmo padrão de http-server.test.ts). `./realtime` é mockado
 * porque o que interessa aqui é o que o pareamento FAZ com a resposta do
 * handshake, não o handshake em si.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const clipboardText = { value: '' }

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  clipboard: { readText: () => clipboardText.value },
}))

vi.mock('electron-store', () => {
  class MockElectronStore<T extends Record<string, unknown>> {
    private data: T
    constructor(opts: { defaults: T }) {
      this.data = { ...opts.defaults }
    }
    get<K extends keyof T>(key: K): T[K] {
      return this.data[key]
    }
    set<K extends keyof T>(key: K, value: T[K]): void {
      this.data[key] = value
    }
  }
  return { default: MockElectronStore }
})

vi.mock('./realtime', () => {
  class PrinterAuthError extends Error {
    constructor(
      message: string,
      readonly httpStatus: number | null
    ) {
      super(message)
      this.name = 'PrinterAuthError'
    }
  }
  return {
    PrinterAuthError,
    requestPrinterSession: vi.fn(),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  }
})

const { parsePairingCode, pairWithCode, pairFromClipboard } = await import('./pairing')
const { requestPrinterSession, PrinterAuthError, connect, disconnect } = await import('./realtime')
const { getConfig, setConfig } = await import('./store')

const CODIGO = '3f0d1f2e-8a41-4c9b-9d12-7b6a5c4e3d21'
const CODIGO_ANTIGO = '11111111-2222-4333-8444-555555555555'

const SESSAO_COZINHA = {
  session_token: 'sess-abc',
  expires_at: '2026-01-01T00:00:00.000Z',
  tenant_id: 'tenant-1',
  tenant_name: 'Podrão',
  auto_print: true,
  destination: { id: 'dest-1', name: 'Cozinha', purpose: 'kitchen' },
}

const pedirSessao = vi.mocked(requestPrinterSession)

beforeEach(() => {
  vi.clearAllMocks()
  clipboardText.value = ''
  // Estado de uma loja JÁ funcionando: é ela que não pode quebrar.
  setConfig({
    device_token: CODIGO_ANTIGO,
    session_token: 'sess-antiga',
    tenant_id: 'tenant-antigo',
    tenant_name: 'Loja Antiga',
    printer_name: 'EPSON TM-T20',
    paper_size: '58mm',
    api_url: 'https://dev.zuppyfood.com.br',
    destination: null,
  })
})

describe('parsePairingCode', () => {
  it('aceita o UUID como o Zuppy mostra', () => {
    expect(parsePairingCode(CODIGO)).toBe(CODIGO)
  })

  it('aceita o que o Ctrl+C costuma trazer junto: espaço, quebra de linha, aspas, maiúscula', () => {
    expect(parsePairingCode(`  ${CODIGO}\n`)).toBe(CODIGO)
    expect(parsePairingCode(`"${CODIGO}"`)).toBe(CODIGO)
    expect(parsePairingCode(CODIGO.toUpperCase())).toBe(CODIGO)
  })

  it('rejeita o que não é código', () => {
    for (const lixo of [
      '',
      '   ',
      'código da impressora',
      '3f0d1f2e8a414c9b9d127b6a5c4e3d21',
      `${CODIGO} e mais coisa`,
      'https://www.zuppyfood.com.br/gestor/impressao',
      null,
      undefined,
      12345,
    ]) {
      expect(parsePairingCode(lixo as string | null | undefined)).toBeNull()
    }
  })
})

describe('pairWithCode', () => {
  it('código válido: grava a identidade nova e reconecta o polling', async () => {
    pedirSessao.mockResolvedValueOnce(SESSAO_COZINHA)

    const result = await pairWithCode(` ${CODIGO} `)

    expect(result).toEqual({
      ok: true,
      label: 'Cozinha — Podrão',
      destination: SESSAO_COZINHA.destination,
    })

    const cfg = getConfig()
    expect(cfg.device_token).toBe(CODIGO)
    expect(cfg.session_token).toBe('sess-abc')
    expect(cfg.tenant_name).toBe('Podrão')
    expect(cfg.destination).toEqual(SESSAO_COZINHA.destination)
    // A versão vai junto da sessão: é o que o servidor acabou de registrar e o
    // que evita o polling refazer este mesmo handshake no tick seguinte.
    expect(cfg.session_app_version).toBe('0.0.0-test')

    // Mesma sequência do POST /configure: derruba o loop antigo e sobe o novo.
    expect(disconnect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledOnce()
  })

  it('manda ao handshake o papel e a calibração já gravados', async () => {
    pedirSessao.mockResolvedValueOnce(SESSAO_COZINHA)
    setConfig({ columns: 42 })

    await pairWithCode(CODIGO)

    expect(pedirSessao).toHaveBeenCalledWith(CODIGO, {
      // A base da API continua sendo a do último pareamento: um código colado
      // não carrega origem nenhuma.
      apiBaseUrl: 'https://dev.zuppyfood.com.br',
      paperSize: '58mm',
      columns: 42,
    })
    expect(getConfig().api_url).toBe('https://dev.zuppyfood.com.br')
  })

  it('token legado (sem destination): rótulo é o nome da loja, como sempre foi', async () => {
    pedirSessao.mockResolvedValueOnce({ ...SESSAO_COZINHA, destination: null })

    const result = await pairWithCode(CODIGO)

    expect(result).toEqual({ ok: true, label: 'Podrão', destination: null })
    expect(getConfig().destination).toBeNull()
  })

  it('texto que não é código: nem chama o servidor, nem toca no store', async () => {
    const result = await pairWithCode('isso aqui não é código')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_code')
    expect(pedirSessao).not.toHaveBeenCalled()
    expect(getConfig().device_token).toBe(CODIGO_ANTIGO)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('servidor recusa o código: a impressora que já funcionava continua intacta', async () => {
    pedirSessao.mockRejectedValueOnce(new PrinterAuthError('Auth API returned 401: nope', 401))

    const result = await pairWithCode(CODIGO)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('rejected')
      expect(result.message).toMatch(/copie o código de novo/i)
    }

    const cfg = getConfig()
    expect(cfg.device_token).toBe(CODIGO_ANTIGO)
    expect(cfg.session_token).toBe('sess-antiga')
    expect(cfg.tenant_name).toBe('Loja Antiga')
    expect(disconnect).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('erro 5xx: recusa com o número do erro, sem prometer que é o código', async () => {
    pedirSessao.mockRejectedValueOnce(new PrinterAuthError('Auth API returned 503: ', 503))

    const result = await pairWithCode(CODIGO)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/erro 503/)
  })

  it('sem internet: fala de internet, não de código errado', async () => {
    pedirSessao.mockRejectedValueOnce(new PrinterAuthError('fetch failed', null))

    const result = await pairWithCode(CODIGO)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unreachable')
      expect(result.message).toMatch(/internet/i)
    }
    expect(getConfig().device_token).toBe(CODIGO_ANTIGO)
  })
})

describe('pairFromClipboard', () => {
  it('usa o que está na área de transferência', async () => {
    pedirSessao.mockResolvedValueOnce(SESSAO_COZINHA)
    clipboardText.value = `${CODIGO}\r\n`

    const result = await pairFromClipboard()

    expect(result.ok).toBe(true)
    expect(pedirSessao).toHaveBeenCalledWith(CODIGO, expect.anything())
  })

  it('área de transferência vazia: recusa sem chamar o servidor', async () => {
    const result = await pairFromClipboard()

    expect(result.ok).toBe(false)
    expect(pedirSessao).not.toHaveBeenCalled()
  })
})

describe('o código de pareamento é segredo', () => {
  const escritas: string[] = []
  let spies: ReturnType<typeof vi.spyOn>[] = []

  beforeEach(() => {
    escritas.length = 0
    const capturar = (...args: unknown[]): void => {
      escritas.push(args.map(String).join(' '))
    }
    spies = [
      vi.spyOn(console, 'log').mockImplementation(capturar),
      vi.spyOn(console, 'warn').mockImplementation(capturar),
      vi.spyOn(console, 'error').mockImplementation(capturar),
    ]
  })

  afterEach(() => {
    for (const spy of spies) spy.mockRestore()
  })

  it('nem no sucesso nem na falha o token inteiro vai para o log', async () => {
    pedirSessao.mockResolvedValueOnce(SESSAO_COZINHA)
    await pairWithCode(CODIGO)

    pedirSessao.mockRejectedValueOnce(new PrinterAuthError('Auth API returned 401: ', 401))
    await pairWithCode(CODIGO)

    expect(escritas.length).toBeGreaterThan(0)
    const tudo = escritas.join('\n')
    expect(tudo).not.toContain(CODIGO)
    // Mascarado como no POST /configure: só os 4 últimos caracteres.
    expect(tudo).toContain('…3d21')
    expect(tudo).not.toContain('sess-abc')
  })
})
