/**
 * electron/file-log.ts
 * Registro rotativo em arquivo: o console do app instalado se perde, o arquivo
 * fica para o suporte (via diagnóstico) ler.
 *
 *  - dois arquivos: `<base>.log` (ativo) e `<base>.1.log` (anterior). O ativo
 *    rotaciona ao passar de metade do teto, então o total nunca passa de
 *    `maxBytes` (5 MB);
 *  - retenção ~24 h: poda ao abrir e a cada hora; linhas mais velhas nunca são
 *    devolvidas na leitura, mesmo antes de a poda rodar;
 *  - nunca lança: um disco cheio ou uma pasta sem permissão não pode custar uma
 *    comanda;
 *  - o conteúdo já chega filtrado (electron/log-scrub.ts) — este módulo só
 *    cuida de arquivo.
 *
 * Sem dependência do Electron: a pasta e o relógio entram por parâmetro.
 */

import fs from 'node:fs'
import path from 'node:path'

export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000

/** Teto de vazão por janela de 1 min: 5 linhas iguais e 300 no total. */
export const THROTTLE_WINDOW_MS = 60_000
export const THROTTLE_PER_KEY_MAX = 5
export const THROTTLE_GLOBAL_MAX = 300

const TIMESTAMP = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/

export interface FileLogOptions {
  dir: string
  baseName: string
  now?: () => number
  maxBytes?: number
  maxAgeMs?: number
}

export interface RecentLog {
  /** Mais antiga primeiro. */
  lines: string[]
  /** Havia mais linhas dentro da janela do que `maxLines`. */
  truncated: boolean
}

/** Só `[a-z0-9._-]`: o nome nunca carrega separador de caminho. */
function safeBaseName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'zuppy-impressora'
}

function lineTimestamp(line: string): number | null {
  const match = TIMESTAMP.exec(line)
  if (!match) return null
  const t = Date.parse(match[1])
  return Number.isNaN(t) ? null : t
}

export function createFileLog(options: FileLogOptions) {
  const now = options.now ?? Date.now
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES
  const maxAgeMs = options.maxAgeMs ?? LOG_MAX_AGE_MS
  const base = safeBaseName(options.baseName)
  const activePath = path.join(options.dir, `${base}.log`)
  const previousPath = path.join(options.dir, `${base}.1.log`)

  let activeSize = 0
  let lastPruneAt = now()
  let dirReady = false

  function ensureDir(): boolean {
    if (dirReady) return true
    try {
      fs.mkdirSync(options.dir, { recursive: true })
      dirReady = true
    } catch {
      dirReady = false
    }
    return dirReady
  }

  function readLines(file: string): string[] {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')
    } catch {
      return []
    }
  }

  function isFresh(line: string, nowMs: number): boolean {
    const t = lineTimestamp(line)
    // Sem carimbo legível: mantém só se couber, mas a leitura não confia nela.
    return t === null ? true : nowMs - t <= maxAgeMs
  }

  function pruneFile(file: string, nowMs: number): number {
    const lines = readLines(file)
    if (lines.length === 0) return 0
    const kept = lines.filter((l) => isFresh(l, nowMs))
    try {
      if (kept.length === 0) {
        fs.rmSync(file, { force: true })
        return 0
      }
      if (kept.length !== lines.length) {
        const body = kept.join('\n') + '\n'
        fs.writeFileSync(file, body, 'utf8')
        return Buffer.byteLength(body)
      }
      return Buffer.byteLength(lines.join('\n') + '\n')
    } catch {
      return 0
    }
  }

  function prune(): void {
    try {
      const nowMs = now()
      lastPruneAt = nowMs
      if (!ensureDir()) return
      pruneFile(previousPath, nowMs)
      activeSize = pruneFile(activePath, nowMs)
    } catch {
      // nunca lança
    }
  }

  // Sobras da execução anterior (e o tamanho atual do arquivo ativo).
  prune()

  function rotate(): void {
    try {
      fs.rmSync(previousPath, { force: true })
      fs.renameSync(activePath, previousPath)
      activeSize = 0
    } catch {
      // Arquivo preso (antivírus, indexador): copia e esvazia no lugar. Nunca
      // apaga o ativo sem ter guardado o anterior.
      try {
        fs.copyFileSync(activePath, previousPath)
        fs.writeFileSync(activePath, '', 'utf8')
        activeSize = 0
      } catch {
        // sem como liberar espaço: o próximo append tenta de novo
      }
    }
  }

  // ── Teto de vazão: um site qualquer não pode inundar o arquivo e empurrar as
  // últimas 24 h para fora (cada requisição barrada pelo CORS vira linhas).
  let windowStartedAt = now()
  let globalCount = 0
  let suppressed = 0
  const perKey = new Map<string, number>()

  /** Chave da linha sem o carimbo: o que se repete, repete igual. */
  function throttleKey(line: string): string {
    return line.replace(TIMESTAMP, '').slice(0, 80)
  }

  function writeRaw(line: string): void {
    const body = line + '\n'
    const bytes = Buffer.byteLength(body)
    if (activeSize + bytes > maxBytes / 2) rotate()
    fs.appendFileSync(activePath, body, 'utf8')
    activeSize += bytes
  }

  /** Dentro do teto desta janela de 1 min? Ao virar a janela, registra quantas ficaram de fora. */
  function admit(line: string, nowMs: number): boolean {
    if (nowMs - windowStartedAt >= THROTTLE_WINDOW_MS) {
      if (suppressed > 0) {
        writeRaw(
          `[${new Date(nowMs).toISOString()}] [WARN] [LOG] ${suppressed} linha(s) repetida(s) omitida(s) no último minuto`,
        )
      }
      windowStartedAt = nowMs
      globalCount = 0
      suppressed = 0
      perKey.clear()
    }

    const key = throttleKey(line)
    const seen = perKey.get(key) ?? 0
    if (seen >= THROTTLE_PER_KEY_MAX || globalCount >= THROTTLE_GLOBAL_MAX) {
      suppressed++
      return false
    }
    perKey.set(key, seen + 1)
    globalCount++
    return true
  }

  function append(line: string): void {
    try {
      if (!ensureDir()) return
      const nowMs = now()
      if (nowMs - lastPruneAt >= PRUNE_EVERY_MS) prune()
      if (!admit(line, nowMs)) return

      const body = line + '\n'
      const bytes = Buffer.byteLength(body)
      if (activeSize + bytes > maxBytes / 2) rotate()

      fs.appendFileSync(activePath, body, 'utf8')
      activeSize += bytes
    } catch {
      // nunca lança
    }
  }

  function readRecent(opts: { maxLines: number }): RecentLog {
    try {
      const nowMs = now()
      const all = [...readLines(previousPath), ...readLines(activePath)].filter((l) => {
        const t = lineTimestamp(l)
        return t !== null && nowMs - t <= maxAgeMs
      })
      const maxLines = Math.max(1, Math.floor(opts.maxLines))
      const truncated = all.length > maxLines
      return { lines: truncated ? all.slice(all.length - maxLines) : all, truncated }
    } catch {
      return { lines: [], truncated: false }
    }
  }

  return { append, readRecent, prune }
}

export type FileLog = ReturnType<typeof createFileLog>
