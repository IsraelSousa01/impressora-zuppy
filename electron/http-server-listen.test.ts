/**
 * electron/http-server-listen.test.ts
 *
 * Integração do servidor local SUBINDO de verdade (socket real em 127.0.0.1),
 * porque é o que a mudança de porta por instância quebra se estiver errada:
 *
 *   - porta ocupada não mata o app: cai na próxima da faixa e diz qual ficou;
 *   - a validação de `Host` acompanha a porta EFETIVA — com a porta errada na
 *     comparação, ou todo request legítimo vira 403, ou a barreira de DNS
 *     rebinding deixa de valer;
 *   - o GET /status conta em que porta respondeu, que é como a tela do Zuppy
 *     distingue duas impressoras na mesma máquina;
 *   - as respostas se identificam como este app (header + campo no corpo), que
 *     é o que impede um processo qualquer escutando numa porta da faixa de ser
 *     promovido a impressora da loja e receber o device_token — inclusive as
 *     rotas que não existiam quando o marcador nasceu (o `/printers` que passou
 *     a devolver o erro da enumeração, e qualquer rota futura).
 *
 * O módulo `./printer` é mockado: o `/printers` de verdade chama o PowerShell
 * da máquina (`Get-Printer`), e o que este arquivo testa é o servidor, não a
 * enumeração — essa tem teste próprio em windows-printer-list.test.ts.
 *
 * Usa portas altas (45800+) de propósito: a 7847 pode estar ocupada pelo app
 * de verdade rodando nesta máquina, e o teste não pode depender disso.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'http'
import net from 'net'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
    isPackaged: false,
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

/**
 * Enumeração de impressoras controlada pelo teste. `error` != null com lista
 * vazia é o caso que motivou a correção: Windows 11 sem `wmic` devolvia lista
 * vazia e o dono não conseguia escolher impressora nenhuma.
 */
const enumeracao = vi.hoisted(() => ({
  printers: ['EPSON TM-T20'] as string[],
  error: null as string | null,
}))

vi.mock('./printer', () => ({
  enumeratePrinters: async () => ({ printers: enumeracao.printers, error: enumeracao.error }),
  getPrinterEnumerationError: () => enumeracao.error,
  testPrint: async () => undefined,
  printRawDocument: async () => undefined,
}))

const { startHttpServer, stopHttpServer, getBoundPort } = await import('./http-server')
const { setConfig } = await import('./store')

const PORTA_BASE = 45830

/** Ocupa uma porta como faria outra instância da Zuppy já rodando. */
function ocuparPorta(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const squatter = net.createServer()
    squatter.once('error', reject)
    squatter.listen(port, '127.0.0.1', () => resolve(squatter))
  })
}

function fecharServidor(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

/**
 * GET no servidor local com controle total sobre o header `Host` e sobre
 * headers extras (`Origin`, para exercitar o CORS). Devolve também os headers
 * da RESPOSTA: o marcador de identidade do app é um deles.
 */
function get(
  port: number,
  path: string,
  host?: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { ...(host === undefined ? {} : { Host: host }), ...extraHeaders },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

const ocupadas: net.Server[] = []

afterEach(async () => {
  enumeracao.printers = ['EPSON TM-T20']
  enumeracao.error = null
  await stopHttpServer()
  while (ocupadas.length > 0) {
    await fecharServidor(ocupadas.pop()!)
  }
})

describe('startHttpServer — porta por instância', () => {
  it('porta livre: sobe nela e responde', async () => {
    const porta = PORTA_BASE

    await expect(startHttpServer([porta])).resolves.toBe(porta)
    expect(getBoundPort()).toBe(porta)
    const { status, body } = await get(porta, '/ping')
    expect(status).toBe(200)
    // `ok` continua sendo o campo do health check; o marcador entrou ao lado.
    expect(JSON.parse(body)).toEqual({ ok: true, zuppy_printer_app: 1 })
  })

  it('porta ocupada: cai na próxima da faixa em vez de morrer', async () => {
    const porta = PORTA_BASE + 1
    ocupadas.push(await ocuparPorta(porta))

    const efetiva = await startHttpServer([porta, porta + 1, porta + 2])

    expect(efetiva).toBe(porta + 1)
    expect(getBoundPort()).toBe(porta + 1)
    await expect(get(efetiva, '/ping')).resolves.toMatchObject({ status: 200 })
  })

  it('faixa inteira ocupada: falha dizendo a faixa e o que fazer', async () => {
    const porta = PORTA_BASE + 10
    ocupadas.push(await ocuparPorta(porta))
    ocupadas.push(await ocuparPorta(porta + 1))

    await expect(startHttpServer([porta, porta + 1])).rejects.toThrow(
      /Nenhuma porta livre entre 45840 e 45841/
    )
    expect(getBoundPort()).toBeNull()
  })

  it('Host acompanha a porta EFETIVA: a porta pedida não vale mais', async () => {
    const pedida = PORTA_BASE + 20
    ocupadas.push(await ocuparPorta(pedida))

    const efetiva = await startHttpServer([pedida, pedida + 1])
    expect(efetiva).toBe(pedida + 1)

    // Loopback na porta em que o servidor realmente escuta: passa.
    await expect(get(efetiva, '/ping', `127.0.0.1:${efetiva}`)).resolves.toMatchObject({
      status: 200,
    })
    await expect(get(efetiva, '/ping', `localhost:${efetiva}`)).resolves.toMatchObject({
      status: 200,
    })

    // Porta antiga no Host (ou domínio de terceiro): 403, a barreira de DNS
    // rebinding continua de pé com porta dinâmica.
    await expect(get(efetiva, '/ping', `localhost:${pedida}`)).resolves.toMatchObject({
      status: 403,
    })
    await expect(get(efetiva, '/ping', `evil.com:${efetiva}`)).resolves.toMatchObject({
      status: 403,
    })
  })

  it('GET /status conta a porta desta instância e a impressora nomeada', async () => {
    const porta = PORTA_BASE + 30
    setConfig({
      tenant_name: 'Podrão',
      printer_name: 'EPSON TM-T20',
      destination: { id: 'dest-1', name: 'Cozinha', purpose: 'kitchen' },
    })

    await startHttpServer([porta])
    const { status, body } = await get(porta, '/status')
    const payload = JSON.parse(body) as Record<string, unknown>

    expect(status).toBe(200)
    expect(payload.port).toBe(porta)
    expect(payload.destination).toEqual({ id: 'dest-1', name: 'Cozinha', purpose: 'kitchen' })
    expect(payload.display_name).toBe('Cozinha — Podrão')
    // `tenant_name` continua significando a LOJA — quem já lê esse campo não
    // pode ver o sentido dele mudar.
    expect(payload.tenant_name).toBe('Podrão')
  })

  it('sem argumento nenhum, a lista default é a porta de sempre (7847)', async () => {
    // Não sobe servidor: só congela o contrato do default. A 7847 pode estar
    // ocupada pelo app de verdade nesta máquina.
    const { HTTP_PORT } = await import('./http-server')
    expect(HTTP_PORT).toBe(7847)
  })
})

describe('identidade do app nas respostas', () => {
  const ORIGEM_ZUPPY = 'https://gestordepedidos.zuppyfood.com.br'

  it('GET /status: marcador no header E no corpo', async () => {
    const porta = PORTA_BASE + 40
    await startHttpServer([porta])

    const { status, body, headers } = await get(porta, '/status')
    const payload = JSON.parse(body) as Record<string, unknown>

    expect(status).toBe(200)
    // Nome e valor EXATOS: é por eles que o Zuppy separa este app de um
    // processo qualquer que escutou na porta da faixa.
    expect(headers['x-zuppy-printer-app']).toBe('1')
    expect(payload.zuppy_printer_app).toBe(1)
  })

  it('GET /ping: mesmo marcador, para a sonda barata', async () => {
    const porta = PORTA_BASE + 41
    await startHttpServer([porta])

    const { body, headers } = await get(porta, '/ping')

    expect(headers['x-zuppy-printer-app']).toBe('1')
    expect(JSON.parse(body)).toMatchObject({ zuppy_printer_app: 1 })
  })

  it('header de identidade é exposto ao JS da página do Zuppy', async () => {
    // Sem Access-Control-Expose-Headers o header CHEGA mas o fetch da página
    // não consegue lê-lo — a checagem do outro lado falharia em produção e
    // passaria aqui se o teste olhasse só a presença do header.
    const porta = PORTA_BASE + 42
    await startHttpServer([porta])

    const { headers } = await get(porta, '/status', undefined, { Origin: ORIGEM_ZUPPY })

    expect(String(headers['access-control-expose-headers']).toLowerCase()).toContain(
      'x-zuppy-printer-app'
    )
  })

  it('GET /status: forma validável e nenhum campo antigo perdido', async () => {
    const porta = PORTA_BASE + 43
    setConfig({ paper_size: '58mm' })
    await startHttpServer([porta])

    const { body } = await get(porta, '/status')
    const payload = JSON.parse(body) as Record<string, unknown>

    // Contrato do /status: o marcador é ADITIVO. Nenhum destes nomes pode
    // sumir nem mudar de sentido — app novo continua falando com Gestor
    // antigo, e Gestor novo com app antigo.
    for (const campo of [
      'status',
      'version',
      'printer',
      'printer_list_error',
      'paper_size',
      'queue',
      'lastPrint',
      'tenant_name',
      'tenant_id',
      'port',
      'destination',
      'display_name',
      'api_url',
      'connected',
      'update',
    ]) {
      expect(payload).toHaveProperty(campo)
    }

    expect(typeof payload.version).toBe('string')
    expect(payload.paper_size).toBe('58mm')
  })

  it('paper_size fora dos dois valores conhecidos não vaza para o /status', async () => {
    const porta = PORTA_BASE + 44
    // Valor que só um /configure antigo (ou adulterado) gravaria: o app
    // imprime a 80 mm nesse caso, então é 80mm que ele deve declarar.
    setConfig({ paper_size: 'A4' as unknown as '80mm' })
    await startHttpServer([porta])

    const { body } = await get(porta, '/status')

    expect((JSON.parse(body) as Record<string, unknown>).paper_size).toBe('80mm')
  })

  it('GET /printers: lista servida com o marcador, na forma nova (printers + error)', async () => {
    // A rota mudou de forma DEPOIS do marcador nascer (passou a devolver
    // `error`). Se a identidade estivesse em cada rota, e não num middleware,
    // é aqui que ela teria sumido.
    const porta = PORTA_BASE + 45
    await startHttpServer([porta])

    const { status, body, headers } = await get(porta, '/printers')

    expect(status).toBe(200)
    expect(headers['x-zuppy-printer-app']).toBe('1')
    expect(JSON.parse(body)).toEqual({ printers: ['EPSON TM-T20'], error: null })
  })

  it('falha ao listar impressoras: /printers e /status contam o motivo', async () => {
    // Lista vazia SEM motivo seria lida como "esta máquina não tem impressora";
    // com o motivo, a tela pede o nome digitado em vez de mentir.
    enumeracao.printers = []
    enumeracao.error = 'Get-Printer não encontrado'

    const porta = PORTA_BASE + 46
    await startHttpServer([porta])

    const printers = await get(porta, '/printers')
    expect(JSON.parse(printers.body)).toEqual({
      printers: [],
      error: 'Get-Printer não encontrado',
    })

    const status = await get(porta, '/status')
    expect((JSON.parse(status.body) as Record<string, unknown>).printer_list_error).toBe(
      'Get-Printer não encontrado'
    )
  })

  it('rota que não existe também se identifica: nenhuma resposta nasce anônima', async () => {
    // O marcador vem de um middleware único, antes do router. Congelar o 404
    // aqui é o que garante que uma rota ADICIONADA amanhã já nasça marcada,
    // sem ninguém lembrar de marcá-la.
    const porta = PORTA_BASE + 47
    await startHttpServer([porta])

    const { status, headers } = await get(porta, '/rota-que-nao-existe')

    expect(status).toBe(404)
    expect(headers['x-zuppy-printer-app']).toBe('1')
  })
})
