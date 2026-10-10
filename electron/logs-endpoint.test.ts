/**
 * electron/logs-endpoint.test.ts
 *
 * GET /logs devolve o registro em arquivo ao diagnóstico do Zuppy. Mesmo
 * filtrado, quem lê é decidido pelo `Origin` (que o navegador preenche): sem
 * Origin, ou de fora da allowlist, é 403 — mais rígido que /status.
 *
 * Também sobe o servidor de verdade (socket real) para provar o caminho
 * ponta a ponta: linha logada com dado de cliente sai do endpoint já filtrada.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', isPackaged: true },
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

vi.mock('./printer', () => ({
  enumeratePrinters: async () => ({ printers: [], error: null }),
  getPrinterEnumerationError: () => null,
  testPrint: async () => undefined,
  printRawDocument: async () => undefined,
}))

const { isLogReadAllowed, parseLogsLines, LOGS_MAX_LINES, startHttpServer, stopHttpServer } = await import(
  './http-server'
)
const { initFileLog, createLogger, _resetFileLogForTests } = await import('./logger')

describe('isLogReadAllowed', () => {
  const empacotado = { allowLocalOrigin: false }

  it('página do Zuppy pode', () => {
    expect(isLogReadAllowed('https://www.zuppyfood.com.br', empacotado)).toBe(true)
    expect(isLogReadAllowed('https://gestordepedidos.zuppyfood.com.br', empacotado)).toBe(true)
  })

  it('sem Origin NEGA (diferente do /status)', () => {
    expect(isLogReadAllowed(undefined, empacotado)).toBe(false)
    expect(isLogReadAllowed('', empacotado)).toBe(false)
  })

  it('origem de fora do Zuppy nega', () => {
    expect(isLogReadAllowed('https://evil.test', empacotado)).toBe(false)
    expect(isLogReadAllowed('https://zuppyfood.com.br.evil.test', empacotado)).toBe(false)
    expect(isLogReadAllowed('null', empacotado)).toBe(false)
  })

  it('localhost só fora do app empacotado', () => {
    expect(isLogReadAllowed('http://localhost:3000', empacotado)).toBe(false)
    expect(isLogReadAllowed('http://localhost:3000', { allowLocalOrigin: true })).toBe(true)
  })
})

describe('parseLogsLines', () => {
  it('padrão e teto', () => {
    expect(parseLogsLines(undefined)).toBe(LOGS_MAX_LINES)
    expect(parseLogsLines('abc')).toBe(LOGS_MAX_LINES)
    expect(parseLogsLines('-5')).toBe(LOGS_MAX_LINES)
    expect(parseLogsLines('1.5')).toBe(LOGS_MAX_LINES)
    expect(parseLogsLines('999999')).toBe(LOGS_MAX_LINES)
    expect(parseLogsLines('20')).toBe(20)
  })
})

function get(
  port: number,
  pathname: string,
  headers: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('GET /logs (servidor real)', () => {
  let dir: string | null = null

  afterEach(async () => {
    await stopHttpServer()
    _resetFileLogForTests()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('403 sem Origin; 200 com Origin do Zuppy e conteúdo já sem dado de cliente nem token', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zuppy-logs-endpoint-'))
    initFileLog(dir, 'teste')
    const log = createLogger('TESTE')
    log.info('Job 89dea3b3-04af-4c2e-9d11-0a8adf09c63a completed')
    log.error('Resposta inesperada: {"customer_name":"Maria da Silva","customer_phone":"11987654321","device_token":"zd_live_9f8e7d6c5b4a"}')
    log.debug('GET /status')

    const port = await startHttpServer([45870])

    const semOrigin = await get(port, '/logs', {})
    expect(semOrigin.status).toBe(403)

    const deFora = await get(port, '/logs', { origin: 'https://evil.test' })
    expect(deFora.status).toBe(500) // barrado pelo CORS antes de chegar à rota

    const ok = await get(port, '/logs?lines=50', { origin: 'https://www.zuppyfood.com.br' })
    expect(ok.status).toBe(200)
    const body = ok.body as { zuppy_printer_app: number; lines: string[]; truncated: boolean }
    expect(body.zuppy_printer_app).toBe(1)
    const text = body.lines.join('\n')
    expect(text).toContain('Job 89dea3b3-04af-4c2e-9d11-0a8adf09c63a completed')
    expect(text).not.toContain('Maria')
    expect(text).not.toContain('11987654321')
    expect(text).not.toContain('zd_live_9f8e7d6c5b4a')
    expect(text).not.toContain('GET /status') // debug não vai ao arquivo
  })
})
