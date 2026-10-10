/**
 * electron/sleep-guard.test.ts
 *
 * Computador que dorme depois do fechamento e a loja abre sem imprimir: o app
 * segura o sono SÓ enquanto a loja está aberta e há sessão. Nada fica preso
 * para sempre: sem sinal novo, o bloqueio solta sozinho.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shouldKeepAwake, createSleepGuard, SLEEP_GUARD_STALE_MS } from './sleep-guard'

function fakeBlocker() {
  let next = 1
  const active = new Set<number>()
  return {
    active,
    api: {
      start: vi.fn(() => {
        const id = next++
        active.add(id)
        return id
      }),
      stop: vi.fn((id: number) => {
        active.delete(id)
      }),
    },
  }
}

describe('shouldKeepAwake', () => {
  it('loja aberta com sessão: segura', () => {
    expect(shouldKeepAwake({ hasSession: true, storeClosed: false })).toBe(true)
  })
  it('loja fechada: solta', () => {
    expect(shouldKeepAwake({ hasSession: true, storeClosed: true })).toBe(false)
  })
  it('sem sessão: nunca segura, mesmo com a loja "aberta"', () => {
    expect(shouldKeepAwake({ hasSession: false, storeClosed: false })).toBe(false)
  })
})

describe('createSleepGuard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('liga ao abrir e desliga ao fechar, sem duplicar o bloqueio', () => {
    const b = fakeBlocker()
    const g = createSleepGuard(b.api)

    g.update({ hasSession: true, storeClosed: false })
    g.update({ hasSession: true, storeClosed: false })
    expect(b.api.start).toHaveBeenCalledTimes(1)
    expect(g.isActive()).toBe(true)

    g.update({ hasSession: true, storeClosed: true })
    expect(b.api.stop).toHaveBeenCalledTimes(1)
    expect(g.isActive()).toBe(false)
    expect(b.active.size).toBe(0)
  })

  it('perdeu a sessão: solta', () => {
    const b = fakeBlocker()
    const g = createSleepGuard(b.api)
    g.update({ hasSession: true, storeClosed: false })
    g.update({ hasSession: false, storeClosed: false })
    expect(g.isActive()).toBe(false)
  })

  it('sem sinal novo por um tempo, solta sozinho (nunca prende o computador)', () => {
    const b = fakeBlocker()
    const g = createSleepGuard(b.api)
    g.update({ hasSession: true, storeClosed: false })
    vi.advanceTimersByTime(SLEEP_GUARD_STALE_MS - 1)
    expect(g.isActive()).toBe(true)
    vi.advanceTimersByTime(2)
    expect(g.isActive()).toBe(false)
    expect(b.active.size).toBe(0)
  })

  it('cada sinal novo renova o prazo', () => {
    const b = fakeBlocker()
    const g = createSleepGuard(b.api)
    g.update({ hasSession: true, storeClosed: false })
    vi.advanceTimersByTime(SLEEP_GUARD_STALE_MS - 1000)
    g.update({ hasSession: true, storeClosed: false })
    vi.advanceTimersByTime(SLEEP_GUARD_STALE_MS - 1000)
    expect(g.isActive()).toBe(true)
  })

  it('release() solta na hora e é idempotente', () => {
    const b = fakeBlocker()
    const g = createSleepGuard(b.api)
    g.update({ hasSession: true, storeClosed: false })
    g.release()
    g.release()
    expect(b.api.stop).toHaveBeenCalledTimes(1)
  })

  it('falha do sistema ao ligar nunca lança', () => {
    const g = createSleepGuard({
      start: () => {
        throw new Error('boom')
      },
      stop: () => undefined,
    })
    expect(() => g.update({ hasSession: true, storeClosed: false })).not.toThrow()
    expect(g.isActive()).toBe(false)
  })
})
