/**
 * electron/realtime.test.ts
 *
 * Cobre o polling client (1.0.8, cutover SSE → polling):
 *
 *   - resolveNextPollIntervalMs: contrato do `next_poll_ms` do servidor —
 *     opcional (ausente mantém o último valor conhecido), clampado em
 *     [1000, 60000], nunca confiança cega no número.
 *   - parseRetryAfterMs: Retry-After de um 429 em segundos ou HTTP-date,
 *     com clamp pra não virar retry imediato nem congelar a impressora.
 *   - requestPrinterSession: o handshake cru (POST /api/printer/auth) que o
 *     polling e o pareamento manual dividem — o campo ADITIVO `destination`
 *     (impressora nomeada, ausente no token legado da loja) e a distinção
 *     entre "servidor recusou" e "não deu pra falar com o servidor".
 *   - isSessionFromOtherAppVersion + o loop: depois de o app se atualizar, o
 *     servidor só aprende a versão nova se houver um handshake novo — e esse
 *     handshake não pode custar requisição a quem NÃO atualizou, nem virar
 *     loop na frota que ainda não tem a versão guardada.
 *
 * `realtime.ts` importa `electron` (app.getVersion no handshake de auth) e,
 * via `./store`/`./print-queue`, o `electron-store` — ambos exigem rodar
 * dentro do Electron. Mocka-se os dois só pra permitir o import fora do
 * Electron (mesmo padrão de http-server.test.ts); as funções de ritmo são
 * puras e não tocam nenhum deles, e o handshake roda com `fetch` stubado.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type { AppConfig } from './store'

/** Versão "instalada" nesta máquina de teste — mutável, porque o app atualiza. */
const versaoDoApp = vi.hoisted(() => ({ atual: '0.0.0-test' }))

vi.mock('electron', () => ({
  app: {
    getVersion: () => versaoDoApp.atual,
  },
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

const {
  resolveNextPollIntervalMs,
  parseRetryAfterMs,
  requestPrinterSession,
  PrinterAuthError,
  isSessionFromOtherAppVersion,
  connect,
  disconnect,
} = await import('./realtime')
const { getConfig, setConfig } = await import('./store')

describe('resolveNextPollIntervalMs', () => {
  it('ausente (undefined): mantém o último valor conhecido', () => {
    expect(resolveNextPollIntervalMs(undefined, 30000)).toBe(30000)
  })

  it('valor não-numérico (servidor evoluiu o campo): mantém o último valor', () => {
    expect(resolveNextPollIntervalMs('3000', 5000)).toBe(5000)
    expect(resolveNextPollIntervalMs(null, 5000)).toBe(5000)
    expect(resolveNextPollIntervalMs(NaN, 5000)).toBe(5000)
    expect(resolveNextPollIntervalMs(Infinity, 5000)).toBe(5000)
  })

  it('valor válido dentro da faixa: adota o ritmo do servidor', () => {
    expect(resolveNextPollIntervalMs(3000, 30000)).toBe(3000)
    expect(resolveNextPollIntervalMs(30000, 3000)).toBe(30000)
  })

  it('abaixo do piso: clampa em 1000 (nunca martelar o servidor)', () => {
    expect(resolveNextPollIntervalMs(200, 3000)).toBe(1000)
    expect(resolveNextPollIntervalMs(-5000, 3000)).toBe(1000)
  })

  it('acima do teto: clampa em 60000 (impressora nunca dorme por minutos)', () => {
    expect(resolveNextPollIntervalMs(600000, 3000)).toBe(60000)
  })
})

describe('parseRetryAfterMs', () => {
  it('header ausente: null (caller cai no backoff exponencial)', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('')).toBeNull()
  })

  it('segundos: converte pra ms', () => {
    expect(parseRetryAfterMs('30')).toBe(30000)
  })

  it('segundos abaixo do piso: clampa em 1000 (sem retry imediato)', () => {
    expect(parseRetryAfterMs('0')).toBe(1000)
  })

  it('segundos acima do teto: clampa em 5 minutos', () => {
    expect(parseRetryAfterMs('86400')).toBe(5 * 60 * 1000)
  })

  it('HTTP-date: calcula o delta a partir de agora', () => {
    const now = Date.parse('2026-08-10T12:00:00Z')
    expect(parseRetryAfterMs('Mon, 10 Aug 2026 12:00:30 GMT', now)).toBe(30000)
  })

  it('lixo não parseável: null (caller cai no backoff)', () => {
    expect(parseRetryAfterMs('em breve')).toBeNull()
  })
})


describe('requestPrinterSession — handshake POST /api/printer/auth', () => {
  const RESPOSTA_BASE = {
    session_token: 'sess-abc',
    expires_at: '2026-01-01T00:00:00.000Z',
    tenant_id: 'tenant-1',
    tenant_name: 'Podrão',
    auto_print: true,
  }

  const fetchMock = vi.fn()

  function responder(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('devolve a sessão e a impressora nomeada quando o servidor manda destination', async () => {
    fetchMock.mockResolvedValueOnce(
      responder(200, {
        ...RESPOSTA_BASE,
        destination: { id: 'dest-1', name: 'Cozinha', purpose: 'kitchen' },
      })
    )

    const session = await requestPrinterSession('tok-1', {
      apiBaseUrl: 'https://dev.zuppyfood.com.br',
    })

    expect(session.session_token).toBe('sess-abc')
    expect(session.destination).toEqual({ id: 'dest-1', name: 'Cozinha', purpose: 'kitchen' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://dev.zuppyfood.com.br/api/printer/auth')
  })

  it('servidor sem o campo (ou token legado da loja): destination null, tudo o mais igual', async () => {
    fetchMock.mockResolvedValueOnce(responder(200, RESPOSTA_BASE))

    const session = await requestPrinterSession('tok-1', { apiBaseUrl: 'https://x.zuppyfood.com.br' })

    expect(session.destination).toBeNull()
    expect(session.tenant_name).toBe('Podrão')
  })

  it('destination malformado não vira destino (ia para o disco e para a bandeja)', async () => {
    fetchMock.mockResolvedValueOnce(
      responder(200, { ...RESPOSTA_BASE, destination: { name: 'Cozinha' } })
    )

    const session = await requestPrinterSession('tok-1', { apiBaseUrl: 'https://x.zuppyfood.com.br' })

    expect(session.destination).toBeNull()
  })

  it('o corpo leva o token, o papel e a versão; columns só quando calibrado; nunca segue redirect', async () => {
    fetchMock.mockResolvedValueOnce(responder(200, RESPOSTA_BASE))
    await requestPrinterSession('tok-1', {
      apiBaseUrl: 'https://x.zuppyfood.com.br',
      paperSize: '58mm',
    })

    const init = fetchMock.mock.calls[0][1] as { body: string; redirect: string }
    expect(init.redirect).toBe('error')
    expect(JSON.parse(init.body)).toEqual({
      device_token: 'tok-1',
      paper_size: '58mm',
      app_version: '0.0.0-test',
    })

    fetchMock.mockResolvedValueOnce(responder(200, RESPOSTA_BASE))
    await requestPrinterSession('tok-1', { apiBaseUrl: 'https://x.zuppyfood.com.br', columns: 42 })
    const comColunas = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body)
    expect(comColunas.columns).toBe(42)
  })

  it('resposta de erro: PrinterAuthError com o status (o pareamento distingue código errado de rede)', async () => {
    fetchMock.mockResolvedValueOnce(responder(401, { error: 'invalid token' }))

    await expect(
      requestPrinterSession('tok-1', { apiBaseUrl: 'https://x.zuppyfood.com.br' })
    ).rejects.toMatchObject({ name: 'PrinterAuthError', httpStatus: 401 })
  })

  it('sem resposta (offline, DNS, redirect barrado): PrinterAuthError sem status', async () => {
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'))

    const erro = await requestPrinterSession('tok-1', {
      apiBaseUrl: 'https://x.zuppyfood.com.br',
    }).catch((err: unknown) => err)

    expect(erro).toBeInstanceOf(PrinterAuthError)
    expect((erro as InstanceType<typeof PrinterAuthError>).httpStatus).toBeNull()
  })
})

describe('isSessionFromOtherAppVersion — a sessão guardada foi emitida por outra versão?', () => {
  const COM_SESSAO = { session_token: 'sess-boa' }

  it('versão igual à guardada: nada a refazer', () => {
    expect(
      isSessionFromOtherAppVersion({ ...COM_SESSAO, session_app_version: '1.3.1' }, '1.3.1')
    ).toBe(false)
  })

  it('app atualizou desde o handshake: o servidor está com a versão velha', () => {
    expect(
      isSessionFromOtherAppVersion({ ...COM_SESSAO, session_app_version: '1.3.0' }, '1.3.1')
    ).toBe(true)
  })

  it('sem versão guardada (toda a frota hoje): conta como diferente, para gravar de uma vez', () => {
    expect(isSessionFromOtherAppVersion(COM_SESSAO, '1.3.1')).toBe(true)
  })

  it('sem sessão guardada: falso — a autenticação normal já reporta a versão', () => {
    expect(isSessionFromOtherAppVersion({ session_app_version: '1.3.0' }, '1.3.1')).toBe(false)
    expect(isSessionFromOtherAppVersion({}, '1.3.1')).toBe(false)
  })
})

describe('polling: reportar a versão nova sem custar requisição a quem não atualizou', () => {
  const SESSAO_EMITIDA = {
    session_token: 'sess-nova',
    expires_at: '2099-01-01T00:00:00.000Z',
    tenant_id: 'tenant-1',
    tenant_name: 'Podrão',
    auto_print: true,
  }

  const fetchMock = vi.fn()

  function responder(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }

  /** Estado de uma loja que JÁ está imprimindo: é ela que não pode quebrar. */
  function semearLojaImprimindo(extra: Partial<AppConfig>): void {
    setConfig({
      device_token: 'dev-tok-1',
      printer_name: 'EPSON TM-T20',
      paper_size: '80mm',
      tenant_id: 'tenant-1',
      tenant_name: 'Podrão',
      session_token: 'sess-boa',
      session_expires_at: '2099-01-01T00:00:00.000Z',
      session_app_version: undefined,
      ...extra,
    })
  }

  function chamadas(sufixo: string): Array<[string, RequestInit]> {
    return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(sufixo)) as Array<
      [string, RequestInit]
    >
  }

  /** Roda `n` ticks do loop: o 1º é imediato, os seguintes a cada 3s. */
  async function rodarTicks(n: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 1; i < n; i++) await vi.advanceTimersByTimeAsync(3000)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/api/printer/auth')
        ? responder(200, SESSAO_EMITIDA)
        : responder(200, { jobs: [], next_poll_ms: 3000 })
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    await disconnect()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    versaoDoApp.atual = '0.0.0-test'
  })

  it('versão igual à guardada: zero handshake — os mesmos requests de hoje', async () => {
    versaoDoApp.atual = '1.3.1'
    semearLojaImprimindo({ session_app_version: '1.3.1' })

    await connect()
    await rodarTicks(3)

    expect(chamadas('/api/printer/auth')).toHaveLength(0)
    expect(chamadas('/api/printer/jobs')).toHaveLength(3)
    expect(getConfig().session_token).toBe('sess-boa')
  })

  it('app atualizou: exatamente UM handshake, com a versão nova no corpo e no store', async () => {
    versaoDoApp.atual = '1.3.1'
    semearLojaImprimindo({ session_app_version: '1.3.0' })

    await connect()
    await rodarTicks(4)

    const handshakes = chamadas('/api/printer/auth')
    expect(handshakes).toHaveLength(1)
    expect(JSON.parse(String(handshakes[0][1].body)).app_version).toBe('1.3.1')
    expect(getConfig().session_app_version).toBe('1.3.1')
    expect(getConfig().session_token).toBe('sess-nova')
    // O tick do re-handshake também buscou os jobs: nada de comanda atrasada.
    expect(chamadas('/api/printer/jobs')).toHaveLength(4)
  })

  it('sessão sem versão guardada (a frota hoje): um handshake no 1º boot e nada de loop', async () => {
    versaoDoApp.atual = '1.3.1'
    semearLojaImprimindo({})

    await connect()
    await rodarTicks(5)

    expect(chamadas('/api/printer/auth')).toHaveLength(1)
    expect(chamadas('/api/printer/jobs')).toHaveLength(5)
    expect(getConfig().session_app_version).toBe('1.3.1')
  })

  it('handshake recusado: a sessão boa segue imprimindo e não vira tentativa por tick', async () => {
    versaoDoApp.atual = '1.3.1'
    semearLojaImprimindo({ session_app_version: '1.3.0' })
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/api/printer/auth')
        ? responder(500, { error: 'boom' })
        : responder(200, { jobs: [], next_poll_ms: 3000 })
    )

    await connect()
    await rodarTicks(4)

    expect(chamadas('/api/printer/auth')).toHaveLength(1)
    expect(getConfig().session_token).toBe('sess-boa')
    expect(getConfig().session_app_version).toBe('1.3.0')
    const jobs = chamadas('/api/printer/jobs')
    expect(jobs).toHaveLength(4)
    expect((jobs[0][1].headers as Record<string, string>).Authorization).toBe('Bearer sess-boa')
  })
})
