/**
 * electron/run-state.test.ts
 *
 * O app não tem como se reabrir depois de uma queda dura (nada vive fora do
 * processo), mas pode DIZER que a última execução não terminou direito: o
 * registro em arquivo passa a mostrar "reabriu depois de uma queda" no
 * diagnóstico do suporte.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  markStarted,
  markCleanExit,
  allowCrashRelaunch,
  CRASH_RELAUNCH_MAX,
  CRASH_RELAUNCH_WINDOW_MS,
} from './run-state'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zuppy-run-state-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('run-state', () => {
  it('primeira execução: nada a reportar', () => {
    expect(markStarted(dir, 100)).toEqual({ previousEndedUnexpectedly: false, previousStartedAt: null })
  })

  it('saída limpa: a próxima execução não vê queda', () => {
    markStarted(dir, 100)
    markCleanExit(dir)
    expect(markStarted(dir, 200).previousEndedUnexpectedly).toBe(false)
  })

  it('sem saída limpa: a próxima execução vê a queda e quando a anterior começou', () => {
    markStarted(dir, 100)
    const second = markStarted(dir, 200)
    expect(second.previousEndedUnexpectedly).toBe(true)
    expect(second.previousStartedAt).toBe(100)
  })

  it('marcador ilegível conta como queda e é substituído, sem lançar', () => {
    fs.writeFileSync(path.join(dir, 'running.json'), '{não é json')
    expect(markStarted(dir, 300)).toEqual({ previousEndedUnexpectedly: true, previousStartedAt: null })
    expect(markStarted(dir, 400).previousStartedAt).toBe(300)
  })

  it('pasta inexistente/sem permissão nunca derruba o app', () => {
    const missing = path.join(dir, 'nao-existe', 'fundo')
    expect(() => markStarted(missing, 1)).not.toThrow()
    expect(() => markCleanExit(missing)).not.toThrow()
  })

  it('markCleanExit sem marcador não lança', () => {
    expect(() => markCleanExit(dir)).not.toThrow()
  })
})

describe('allowCrashRelaunch', () => {
  it('permite até o teto dentro da janela e depois recusa', () => {
    for (let i = 0; i < CRASH_RELAUNCH_MAX; i++) {
      expect(allowCrashRelaunch(dir, 1000 + i)).toBe(true)
    }
    expect(allowCrashRelaunch(dir, 2000)).toBe(false)
  })

  it('passada a janela, volta a permitir', () => {
    for (let i = 0; i < CRASH_RELAUNCH_MAX; i++) allowCrashRelaunch(dir, 1000 + i)
    expect(allowCrashRelaunch(dir, 1000 + CRASH_RELAUNCH_WINDOW_MS + 10)).toBe(true)
  })

  it('histórico corrompido não impede nem trava: recomeça do zero', () => {
    fs.writeFileSync(path.join(dir, 'crash-relaunch.json'), 'lixo')
    expect(allowCrashRelaunch(dir, 5000)).toBe(true)
  })

  it('não consegue registrar a tentativa: não reabre (sem teto garantido)', () => {
    expect(allowCrashRelaunch(path.join(dir, 'nao-existe', 'fundo'), 1)).toBe(false)
  })
})
