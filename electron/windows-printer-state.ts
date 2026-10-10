/**
 * electron/windows-printer-state.ts
 * Estado da impressora segundo o WINDOWS (offline, sem papel, parada...), para
 * o `/status` local. Quando a comanda não sai por causa fora do Zuppy
 * (computador da impressora desligado, cabo, sem papel), é daqui que o Zuppy
 * sabe — em vez de culpar o app.
 *
 * Duas regras de projeto:
 *
 *  1. O nome da impressora vem de configuração (e, no /configure, de um POST do
 *     navegador): NUNCA é interpolado no comando. Vai por variável de ambiente
 *     e o script só a lê. Sem concatenação, sem injeção de PowerShell.
 *  2. Coletar custa um processo PowerShell (centenas de ms). O `/status` é
 *     consultado a cada poucos segundos pela tela do Zuppy, então a leitura é
 *     assíncrona e em cache: `get()` responde na hora com o último valor e, se
 *     ele estiver velho, dispara UMA coleta em segundo plano. Sem ninguém
 *     perguntando, nenhum processo roda.
 *
 * Fonte: `Win32_Printer` (WorkOffline, PrinterStatus, DetectedErrorState,
 * PrinterState) e a contagem de `Win32_PrintJob` da fila daquela impressora.
 */

import { execFile } from 'node:child_process'

export type PrinterStateStatus =
  | 'ok'
  | 'offline'
  | 'paper_out'
  | 'paper_jam'
  | 'door_open'
  | 'stopped'
  | 'error'
  | 'not_found'
  | 'unknown'

/** Campo aditivo do `/status`. */
export interface PrinterStateReport {
  status: PrinterStateStatus
  /** Trabalhos na fila do Windows; `null` = não deu para contar. */
  queued_jobs: number | null
  /** Quando o Windows foi consultado (ISO). */
  checked_at: string
}

export interface RawPrinterState {
  WorkOffline?: unknown
  PrinterStatus?: unknown
  DetectedErrorState?: unknown
  PrinterState?: unknown
}

const COMMAND_TIMEOUT_MS = 8_000
/** Cache: dentro disto, `/status` não dispara coleta nenhuma. */
export const PRINTER_STATE_TTL_MS = 30_000

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Traduz os campos do Windows. `PrinterStatus`: 3 ociosa, 4 imprimindo,
 * 5 aquecendo, 6 parada, 7 offline. `DetectedErrorState`: 3 pouco papel (ainda
 * imprime), 4 sem papel, 7 tampa aberta, 8 papel preso, 9 offline, 10 pede
 * serviço. `PrinterState` (bitmask): 1 pausada, 2 erro, 8 papel preso, 16 sem
 * papel, 128 offline.
 */
export function classifyPrinterState(raw: RawPrinterState): PrinterStateStatus {
  const offline = raw.WorkOffline
  const status = num(raw.PrinterStatus)
  const error = num(raw.DetectedErrorState)
  const bits = num(raw.PrinterState)

  const nothingKnown =
    typeof offline !== 'boolean' && status === null && error === null && bits === null
  if (nothingKnown) return 'unknown'

  if (offline === true || status === 7 || error === 9 || (bits !== null && (bits & 128) !== 0)) {
    return 'offline'
  }
  if (error === 4 || (bits !== null && (bits & 16) !== 0)) return 'paper_out'
  if (error === 8 || (bits !== null && (bits & 8) !== 0)) return 'paper_jam'
  if (error === 7) return 'door_open'
  if (status === 6 || (bits !== null && (bits & 1) !== 0)) return 'stopped'
  if (error === 10 || error === 6 || error === 11 || error === 1 || (bits !== null && (bits & 2) !== 0)) {
    return 'error'
  }
  return 'ok'
}

export interface ParsedPrinterState {
  status: PrinterStateStatus
  queuedJobs: number | null
}

/** Saída JSON do script. Lixo/vazio ⇒ `null`: sem inventar um estado. */
export function parsePrinterStateOutput(stdout: string): ParsedPrinterState | null {
  const text = stdout.trim()
  if (text === '') return null

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const raw = data as RawPrinterState & { Found?: unknown; Jobs?: unknown }

  if (raw.Found === false) return { status: 'not_found', queuedJobs: null }

  const jobs = num(raw.Jobs)
  return {
    status: classifyPrinterState(raw),
    queuedJobs: jobs !== null && jobs >= 0 && Number.isInteger(jobs) ? jobs : null,
  }
}

/**
 * O script LÊ o nome de `$env:ZUPPY_PRINTER_NAME`. Nada do nome aparece no
 * texto do comando. A fila é contada pelo prefixo `Nome,` que o Win32_PrintJob
 * usa (`"Impressora, 12"`), por comparação ordinal — sem `-Filter` nem curinga
 * (`-like`) com o nome, que pode ter `[`, `*` ou `?`.
 */
const PRINTER_STATE_SCRIPT =
  "$n = $env:ZUPPY_PRINTER_NAME; " +
  "$ErrorActionPreference = 'Stop'; " +
  "$p = Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Name -eq $n } | Select-Object -First 1; " +
  "if ($null -eq $p) { '{\"Found\":false}' } else { " +
  "$prefix = $n + ','; " +
  "$j = @(Get-CimInstance -ClassName Win32_PrintJob -ErrorAction SilentlyContinue | " +
  "Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) }).Count; " +
  "[pscustomobject]@{ Found = $true; WorkOffline = $p.WorkOffline; PrinterStatus = $p.PrinterStatus; " +
  "DetectedErrorState = $p.DetectedErrorState; PrinterState = $p.PrinterState; Jobs = $j } | ConvertTo-Json -Compress }"

export interface PrinterStateInvocation {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function buildPrinterStateInvocation(printerName: string): PrinterStateInvocation {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', PRINTER_STATE_SCRIPT],
    env: { ...process.env, ZUPPY_PRINTER_NAME: printerName },
  }
}

/** Executa a coleta e devolve o stdout. Injetável nos testes. */
export type PrinterStateRunner = (printerName: string) => Promise<string>

export const runPrinterStateCommand: PrinterStateRunner = (printerName) =>
  new Promise((resolve, reject) => {
    const inv = buildPrinterStateInvocation(printerName)
    execFile(
      inv.file,
      inv.args,
      { env: inv.env, timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })

export interface PrinterStateMonitorOptions {
  run?: PrinterStateRunner
  now?: () => number
  ttlMs?: number
}

export function createPrinterStateMonitor(options: PrinterStateMonitorOptions = {}) {
  const run = options.run ?? runPrinterStateCommand
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? PRINTER_STATE_TTL_MS

  let cache: { printer: string; report: PrinterStateReport; at: number } | null = null
  let inFlight: Promise<void> | null = null

  function refresh(printerName: string): void {
    if (inFlight) return
    inFlight = (async () => {
      try {
        const parsed = parsePrinterStateOutput(await run(printerName))
        if (parsed) {
          const at = now()
          cache = {
            printer: printerName,
            at,
            report: {
              status: parsed.status,
              queued_jobs: parsed.queuedJobs,
              checked_at: new Date(at).toISOString(),
            },
          }
        }
      } catch {
        // Mantém o último estado bom; o /status não pode falhar por isto.
      } finally {
        inFlight = null
      }
    })()
  }

  return {
    /** Último estado conhecido da impressora (`null` = ainda não coletado). Nunca bloqueia. */
    get(printerName: string | null | undefined): PrinterStateReport | null {
      if (!printerName) return null
      const fresh = cache !== null && cache.printer === printerName && now() - cache.at < ttlMs
      if (!fresh) refresh(printerName)
      return cache !== null && cache.printer === printerName ? cache.report : null
    },
    /** Só para testes: espera a coleta em voo. */
    async settled(): Promise<void> {
      if (inFlight) await inFlight
    },
  }
}
