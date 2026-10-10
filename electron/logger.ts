/**
 * electron/logger.ts
 * Lightweight structured logger that writes to stdout/stderr and to
 * electron-store so the renderer can display recent logs.
 */

import { addLog, type PrintLog } from './store'
import { createFileLog, type FileLog, type RecentLog } from './file-log'
import { scrubLogLine } from './log-scrub'

type Level = 'info' | 'warn' | 'error' | 'debug'

function timestamp(): string {
  return new Date().toISOString()
}

/**
 * Registro em arquivo (app instalado: o console se perde). Ligado pelo main com
 * `initFileLog`; sem isso (testes, dev) o logger só escreve no console.
 */
let fileLog: FileLog | null = null

/** Liga o registro em arquivo rotativo (~24 h / 5 MB) em `dir`. */
export function initFileLog(dir: string, baseName: string): void {
  fileLog = createFileLog({ dir, baseName })
}

/** Trecho recente do registro em arquivo, já filtrado. Vazio se não ligado. */
export function readRecentLog(maxLines: number): RecentLog {
  return fileLog ? fileLog.readRecent({ maxLines }) : { lines: [], truncated: false }
}

/** Só para testes. */
export function _resetFileLogForTests(): void {
  fileLog = null
}

function write(level: Level, scope: string, message: string, meta?: unknown): void {
  const line = `[${timestamp()}] [${level.toUpperCase()}] [${scope}] ${message}${
    meta !== undefined ? ' ' + JSON.stringify(meta) : ''
  }`

  // `debug` (uma linha por requisição HTTP) só no console: no arquivo é ruído.
  // O filtro é a última barreira — ver electron/log-scrub.ts.
  if (fileLog && level !== 'debug') fileLog.append(scrubLogLine(line))

  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

/**
 * Forma de um `device_token` que PODE aparecer no log: os 4 últimos
 * caracteres, e só quando o token é longo o bastante para que isso não seja
 * quase o token inteiro. Token curto vira `****`.
 *
 * Serve para o suporte distinguir "qual token esta máquina está usando" sem
 * que o segredo caia no arquivo de log da loja. `session_token` não passa por
 * aqui: esse nunca é logado, nem mascarado.
 */
export function maskDeviceToken(token: string): string {
  return token.length > 8 ? `…${token.slice(-4)}` : '****'
}

/** Creates a scoped logger instance */
export function createLogger(scope: string) {
  return {
    info: (msg: string, meta?: unknown) => write('info', scope, msg, meta),
    warn: (msg: string, meta?: unknown) => write('warn', scope, msg, meta),
    error: (msg: string, meta?: unknown) => write('error', scope, msg, meta),
    debug: (msg: string, meta?: unknown) => write('debug', scope, msg, meta),
  }
}

/**
 * Records a print result to both stdout and the persistent log store.
 */
export function logPrintResult(entry: PrintLog): void {
  write(entry.status === 'failed' ? 'error' : 'info', 'PRINT', `Job ${entry.id} → ${entry.status}`, {
    order: entry.order_number,
  })
  addLog(entry)
}
