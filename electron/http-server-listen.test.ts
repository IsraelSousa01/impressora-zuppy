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
 *     distingue duas impressoras na mesma máquina.
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

/** GET no servidor local com controle total sobre o header `Host`. */
function get(
  port: number,
  path: string,
  host?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: host === undefined ? {} : { Host: host },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

const ocupadas: net.Server[] = []

afterEach(async () => {
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
    await expect(get(porta, '/ping')).resolves.toEqual({ status: 200, body: '{"ok":true}' })
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
