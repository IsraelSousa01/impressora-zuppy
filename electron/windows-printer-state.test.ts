/**
 * electron/windows-printer-state.test.ts
 *
 * O app lê do Windows se a impressora está offline, sem papel, parada... e o
 * Zuppy usa isso para dizer "a causa está fora do Zuppy". Campo ADITIVO no
 * /status; o servidor/Zuppy antigos o ignoram.
 *
 * Duas decisões que os testes travam:
 *  - o NOME da impressora vem de configuração (e de um POST do navegador):
 *    nunca entra interpolado no comando do PowerShell, só por variável de
 *    ambiente;
 *  - ler o estado custa um processo PowerShell: fica em cache e nunca atrasa
 *    o /status (que é consultado a cada poucos segundos pela tela do Zuppy).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  classifyPrinterState,
  parsePrinterStateOutput,
  buildPrinterStateInvocation,
  createPrinterStateMonitor,
  PRINTER_STATE_TTL_MS,
  type PrinterStateRunner,
} from './windows-printer-state'

describe('classifyPrinterState', () => {
  const idle = { WorkOffline: false, PrinterStatus: 3, DetectedErrorState: 2, PrinterState: 0 }

  it('ociosa e sem erro: ok', () => {
    expect(classifyPrinterState(idle)).toBe('ok')
  })

  it('imprimindo/aquecendo: ok', () => {
    expect(classifyPrinterState({ ...idle, PrinterStatus: 4 })).toBe('ok')
    expect(classifyPrinterState({ ...idle, PrinterStatus: 5 })).toBe('ok')
  })

  it('WorkOffline, status 7 ou erro 9: offline', () => {
    expect(classifyPrinterState({ ...idle, WorkOffline: true })).toBe('offline')
    expect(classifyPrinterState({ ...idle, PrinterStatus: 7 })).toBe('offline')
    expect(classifyPrinterState({ ...idle, DetectedErrorState: 9 })).toBe('offline')
  })

  it('sem papel: erro 4 ou bit de papel esgotado', () => {
    expect(classifyPrinterState({ ...idle, DetectedErrorState: 4 })).toBe('paper_out')
    expect(classifyPrinterState({ ...idle, PrinterState: 16 })).toBe('paper_out')
  })

  it('papel acabando (erro 3) ainda imprime: ok', () => {
    expect(classifyPrinterState({ ...idle, DetectedErrorState: 3 })).toBe('ok')
  })

  it('papel preso e tampa aberta', () => {
    expect(classifyPrinterState({ ...idle, DetectedErrorState: 8 })).toBe('paper_jam')
    expect(classifyPrinterState({ ...idle, DetectedErrorState: 7 })).toBe('door_open')
  })

  it('parada/pausada', () => {
    expect(classifyPrinterState({ ...idle, PrinterStatus: 6 })).toBe('stopped')
    expect(classifyPrinterState({ ...idle, PrinterState: 1 })).toBe('stopped')
  })

  it('outros erros do Windows', () => {
    expect(classifyPrinterState({ ...idle, DetectedErrorState: 10 })).toBe('error')
    expect(classifyPrinterState({ ...idle, PrinterState: 2 })).toBe('error')
  })

  it('offline vence sem-papel (a causa a tratar primeiro)', () => {
    expect(classifyPrinterState({ ...idle, WorkOffline: true, DetectedErrorState: 4 })).toBe('offline')
  })

  it('campos ausentes ou de tipo errado: unknown, nunca lança', () => {
    expect(classifyPrinterState({})).toBe('unknown')
    expect(classifyPrinterState({ WorkOffline: 'sim', PrinterStatus: 'x' } as never)).toBe('unknown')
  })
})

describe('parsePrinterStateOutput', () => {
  it('objeto único com a contagem da fila', () => {
    const out = JSON.stringify({
      Found: true,
      WorkOffline: false,
      PrinterStatus: 3,
      DetectedErrorState: 2,
      PrinterState: 0,
      Jobs: 2,
    })
    expect(parsePrinterStateOutput(out)).toEqual({ status: 'ok', queuedJobs: 2 })
  })

  it('impressora que o Windows não conhece: not_found', () => {
    expect(parsePrinterStateOutput(JSON.stringify({ Found: false }))).toEqual({
      status: 'not_found',
      queuedJobs: null,
    })
  })

  it('saída vazia ou lixo: null (sem inventar estado)', () => {
    expect(parsePrinterStateOutput('')).toBeNull()
    expect(parsePrinterStateOutput('Get-CimInstance : erro')).toBeNull()
  })

  it('Jobs inválido vira null', () => {
    const out = JSON.stringify({ Found: true, WorkOffline: false, PrinterStatus: 3, Jobs: -4 })
    expect(parsePrinterStateOutput(out)?.queuedJobs).toBeNull()
  })
})

describe('buildPrinterStateInvocation', () => {
  it('o nome da impressora NUNCA entra no comando: vai por variável de ambiente', () => {
    const evil = `X'; Remove-Item C:\\ -Recurse; '`
    const inv = buildPrinterStateInvocation(evil)
    expect(inv.args.join(' ')).not.toContain(evil)
    expect(inv.args.join(' ')).not.toContain('Remove-Item')
    expect(inv.env.ZUPPY_PRINTER_NAME).toBe(evil)
    expect(inv.file).toBe('powershell.exe')
    expect(inv.args).toContain('-NoProfile')
    expect(inv.args).toContain('-NonInteractive')
  })
})

describe('createPrinterStateMonitor', () => {
  const okOutput = JSON.stringify({ Found: true, WorkOffline: false, PrinterStatus: 3, DetectedErrorState: 2, Jobs: 0 })

  function monitorWith(run: PrinterStateRunner, clock: { now: number }) {
    return createPrinterStateMonitor({ run, now: () => clock.now })
  }

  it('sem impressora configurada: null e nenhum processo', () => {
    const run = vi.fn<PrinterStateRunner>()
    const m = monitorWith(run, { now: 0 })
    expect(m.get(null)).toBeNull()
    expect(m.get('')).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('primeira leitura devolve null na hora e dispara a coleta; a seguinte vem do cache', async () => {
    const run = vi.fn<PrinterStateRunner>(async () => okOutput)
    const clock = { now: 1_000 }
    const m = monitorWith(run, clock)

    expect(m.get('EPSON')).toBeNull()
    await m.settled()
    expect(run).toHaveBeenCalledTimes(1)

    const state = m.get('EPSON')
    expect(state).toEqual({ status: 'ok', queued_jobs: 0, checked_at: new Date(1_000).toISOString() })
    expect(run).toHaveBeenCalledTimes(1) // cache fresco: sem novo processo
  })

  it('cache vencido devolve o valor velho e atualiza em segundo plano, uma coleta por vez', async () => {
    const run = vi.fn<PrinterStateRunner>(async () => okOutput)
    const clock = { now: 0 }
    const m = monitorWith(run, clock)
    m.get('EPSON')
    await m.settled()

    clock.now = PRINTER_STATE_TTL_MS + 1
    expect(m.get('EPSON')).not.toBeNull()
    m.get('EPSON')
    m.get('EPSON')
    await m.settled()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('trocar de impressora não devolve o estado da anterior', async () => {
    const run = vi.fn<PrinterStateRunner>(async () => okOutput)
    const m = monitorWith(run, { now: 0 })
    m.get('EPSON')
    await m.settled()
    expect(m.get('BEMATECH')).toBeNull()
  })

  it('falha do PowerShell mantém o último estado bom e nunca lança', async () => {
    let falhar = false
    const run = vi.fn<PrinterStateRunner>(async () => {
      if (falhar) throw new Error('timeout')
      return okOutput
    })
    const clock = { now: 0 }
    const m = monitorWith(run, clock)
    m.get('EPSON')
    await m.settled()

    falhar = true
    clock.now = PRINTER_STATE_TTL_MS + 1
    m.get('EPSON')
    await m.settled()
    expect(m.get('EPSON')?.status).toBe('ok')
  })
})
