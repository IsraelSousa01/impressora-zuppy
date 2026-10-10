/**
 * electron/file-log.test.ts
 *
 * Registro em arquivo do app instalado: o console some, o arquivo fica.
 * Retenção ~24 h / 5 MB, rotação por tamanho, poda por idade, leitura do
 * trecho recente. Nunca lança (log não pode derrubar a impressão).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createFileLog,
  LOG_MAX_BYTES,
  LOG_MAX_AGE_MS,
  THROTTLE_WINDOW_MS,
  THROTTLE_PER_KEY_MAX,
  THROTTLE_GLOBAL_MAX,
} from './file-log'

const T0 = Date.parse('2026-10-10T12:00:00.000Z')
let dir: string

function line(atMs: number, text: string): string {
  return `[${new Date(atMs).toISOString()}] [INFO] [T] ${text}`
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zuppy-file-log-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('createFileLog', () => {
  it('grava uma linha por registro e devolve o trecho recente em ordem', () => {
    let now = T0
    const log = createFileLog({ dir, baseName: 'app', now: () => now })
    log.append(line(now, 'um'))
    now += 1000
    log.append(line(now, 'dois'))

    const out = log.readRecent({ maxLines: 10 })
    expect(out.lines.map((l) => l.replace(/^\[[^\]]+\] \[INFO\] \[T\] /, ''))).toEqual(['um', 'dois'])
    expect(out.truncated).toBe(false)
  })

  it('maxLines devolve as MAIS recentes e marca truncated', () => {
    const log = createFileLog({ dir, baseName: 'app', now: () => T0 })
    for (let i = 0; i < 5; i++) log.append(line(T0, `n${i}`))
    const out = log.readRecent({ maxLines: 2 })
    expect(out.lines).toHaveLength(2)
    expect(out.lines[1]).toContain('n4')
    expect(out.truncated).toBe(true)
  })

  it('o tamanho total fica sob o teto: rotaciona para app.1.log', () => {
    const log = createFileLog({ dir, baseName: 'app', now: () => T0, maxBytes: 1000 })
    const big = 'x'.repeat(100)
    for (let i = 0; i < 40; i++) log.append(line(T0, `${i} ${big}`))

    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual(['app.1.log', 'app.log'])
    const total = files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0)
    expect(total).toBeLessThanOrEqual(1000 + 200)
    // o mais novo sempre está lá
    expect(log.readRecent({ maxLines: 1 }).lines[0]).toContain('39 ')
  })

  it('o teto padrão é 5 MB e a idade 24 h', () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(LOG_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('linhas com mais de 24 h não são devolvidas', () => {
    const log = createFileLog({ dir, baseName: 'app', now: () => T0 })
    log.append(line(T0 - LOG_MAX_AGE_MS - 1000, 'velha'))
    log.append(line(T0 - 1000, 'nova'))
    const out = log.readRecent({ maxLines: 10 })
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]).toContain('nova')
  })

  it('prune() remove do disco o que passou de 24 h', () => {
    let now = T0
    const log = createFileLog({ dir, baseName: 'app', now: () => now })
    log.append(line(now, 'antiga'))
    now += LOG_MAX_AGE_MS + 60_000
    log.append(line(now, 'recente'))
    log.prune()
    const raw = fs.readFileSync(path.join(dir, 'app.log'), 'utf8')
    expect(raw).not.toContain('antiga')
    expect(raw).toContain('recente')
  })

  it('ao criar já poda o que sobrou da execução anterior', () => {
    fs.writeFileSync(path.join(dir, 'app.log'), line(T0 - LOG_MAX_AGE_MS - 5000, 'de ontem') + '\n')
    const log = createFileLog({ dir, baseName: 'app', now: () => T0 })
    log.append(line(T0, 'hoje'))
    const raw = fs.readFileSync(path.join(dir, 'app.log'), 'utf8')
    expect(raw).not.toContain('de ontem')
  })

  it('pasta impossível de escrever nunca lança', () => {
    const blocked = path.join(dir, 'arquivo-no-lugar-da-pasta')
    fs.writeFileSync(blocked, 'x')
    const log = createFileLog({ dir: path.join(blocked, 'sub'), baseName: 'app', now: () => T0 })
    expect(() => log.append(line(T0, 'x'))).not.toThrow()
    expect(() => log.readRecent({ maxLines: 5 })).not.toThrow()
    expect(log.readRecent({ maxLines: 5 }).lines).toEqual([])
  })

  it('baseName não escapa da pasta', () => {
    const log = createFileLog({ dir, baseName: '../fora', now: () => T0 })
    log.append(line(T0, 'x'))
    expect(fs.readdirSync(dir).every((f) => !f.includes('..'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '..', 'fora.log'))).toBe(false)
  })
})

describe('teto de vazão (site que inunda o log)', () => {
  it('linha idêntica repetida: só as primeiras entram, e a janela seguinte registra quantas ficaram de fora', () => {
    let now = T0
    const log = createFileLog({ dir, baseName: 'app', now: () => now })

    for (let i = 0; i < 2000; i++) log.append(line(now, 'CORS blocked origin: https://evil.test'))
    const raw1 = fs.readFileSync(path.join(dir, 'app.log'), 'utf8')
    expect(raw1.split('\n').filter(Boolean)).toHaveLength(THROTTLE_PER_KEY_MAX)

    now += THROTTLE_WINDOW_MS + 1
    log.append(line(now, 'segue funcionando'))
    const raw2 = fs.readFileSync(path.join(dir, 'app.log'), 'utf8')
    expect(raw2).toMatch(/1995 linha\(s\) repetida\(s\) omitida\(s\)/)
    expect(raw2).toContain('segue funcionando')
  })

  it('linhas diferentes legítimas passam; o total por minuto tem teto', () => {
    const now = T0
    const log = createFileLog({ dir, baseName: 'app', now: () => now })
    for (let i = 0; i < THROTTLE_GLOBAL_MAX + 100; i++) log.append(line(now, `origem-${i}`))
    const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(THROTTLE_GLOBAL_MAX)
  })

  it('o inundador não expulsa o que já estava no arquivo', () => {
    let now = T0
    const log = createFileLog({ dir, baseName: 'app', now: () => now })
    log.append(line(now, 'Job importante concluído'))
    for (let i = 0; i < 5000; i++) log.append(line(now, `CORS blocked origin: https://x${i % 3}.test`))
    now += 1000
    expect(log.readRecent({ maxLines: 50 }).lines.some((l) => l.includes('Job importante'))).toBe(true)
  })
})
