/**
 * electron/realtime.test.ts
 *
 * Cobre as regras puras do polling client (1.0.8, cutover SSE → polling):
 *
 *   - resolveNextPollIntervalMs: contrato do `next_poll_ms` do servidor —
 *     opcional (ausente mantém o último valor conhecido), clampado em
 *     [1000, 60000], nunca confiança cega no número.
 *   - parseRetryAfterMs: Retry-After de um 429 em segundos ou HTTP-date,
 *     com clamp pra não virar retry imediato nem congelar a impressora.
 *
 * `realtime.ts` importa `electron` (app.getVersion no handshake de auth) e,
 * via `./store`/`./print-queue`, o `electron-store` — ambos exigem rodar
 * dentro do Electron. Mocka-se os dois só pra permitir o import fora do
 * Electron (mesmo padrão de http-server.test.ts); as funções testadas são
 * puras e não tocam nenhum deles.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
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

const { resolveNextPollIntervalMs, parseRetryAfterMs } = await import('./realtime')

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
