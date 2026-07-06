/**
 * electron/logger.ts
 * Lightweight structured logger that writes to stdout/stderr and to
 * electron-store so the renderer can display recent logs.
 */

import { addLog, type PrintLog } from './store'

type Level = 'info' | 'warn' | 'error' | 'debug'

function timestamp(): string {
  return new Date().toISOString()
}

function write(level: Level, scope: string, message: string, meta?: unknown): void {
  const line = `[${timestamp()}] [${level.toUpperCase()}] [${scope}] ${message}${
    meta !== undefined ? ' ' + JSON.stringify(meta) : ''
  }`

  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
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
