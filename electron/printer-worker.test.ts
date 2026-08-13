/**
 * electron/printer-worker.test.ts
 *
 * Cobre o worker PowerShell PERSISTENTE de impressão RAW (printer.ts):
 *
 *  Parte pura (roda em qualquer OS):
 *   - buildPrintWorkerRequestLine / parsePrintWorkerResponseLine: o protocolo
 *     de 1 linha por mensagem (campos base64 → ASCII puro, imune a codepage).
 *   - invariantes do script PowerShell embutido: template literal SEM crase
 *     (escape do PS) e SEM interpolação JS — um caractere desses corromperia
 *     o script em silêncio.
 *
 *  Parte de integração (só Windows — spawna powershell.exe DE VERDADE, mas
 *  aponta pra impressora inexistente: o custo/fluxo real acontece até o
 *  OpenPrinter falhar, sem gastar papel):
 *   - falha alto quando a impressora não existe (nunca OK sem imprimir);
 *   - um ERR de impressão NÃO derruba o worker (pid permanece);
 *   - RECUPERAÇÃO: worker morto (kill) → o envio seguinte respawna sozinho;
 *   - concorrência: envios simultâneos não embaralham respostas.
 *
 * `printer.ts` importa `./store`, que instancia `electron-store` no topo do
 * módulo — mocka-se só pra permitir o import fora do Electron (mesmo padrão
 * de print-queue.test.ts).
 */
import { describe, it, expect, vi, afterAll } from 'vitest'

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

const {
  buildPrintWorkerRequestLine,
  parsePrintWorkerResponseLine,
  PRINT_WORKER_PS_SOURCE,
  printRawDocument,
  getPrintWorkerPidForTests,
  killPrintWorkerForTests,
} = await import('./printer')

describe('buildPrintWorkerRequestLine', () => {
  it('monta id TAB printer(b64) TAB bytes(b64), sem vazar o nome cru', () => {
    const line = buildPrintWorkerRequestLine('7', 'POS80 Printer', Buffer.from([0x1b, 0x40]))
    const parts = line.split('\t')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe('7')
    expect(line).not.toContain('POS80 Printer')
    expect(Buffer.from(parts[1], 'base64').toString('utf8')).toBe('POS80 Printer')
    expect(Buffer.from(parts[2], 'base64')).toEqual(Buffer.from([0x1b, 0x40]))
  })

  it('nome de impressora com acento e espaço sobrevive ao roundtrip UTF-8/base64', () => {
    const nome = 'Impressão Térmica — Cozinha'
    const line = buildPrintWorkerRequestLine('1', nome, Buffer.from('x'))
    const parts = line.split('\t')
    expect(Buffer.from(parts[1], 'base64').toString('utf8')).toBe(nome)
  })

  it('linha é ASCII pura (imune a codepage do console do PowerShell)', () => {
    const line = buildPrintWorkerRequestLine('2', 'Impressão ñ', Buffer.from('áéí çã', 'utf8'))
    // eslint-disable-next-line no-control-regex
    expect(/^[\x09\x20-\x7e]+$/.test(line)).toBe(true)
  })
})

describe('parsePrintWorkerResponseLine', () => {
  it('OK: resolve com o id correto', () => {
    expect(parsePrintWorkerResponseLine('42\tOK\t128')).toEqual({ id: '42', status: 'ok' })
  })

  it('ERR: decodifica a mensagem base64 (UTF-8, com acento)', () => {
    const msg = 'OpenPrinter falhou (err=1801) — impressora não existe'
    const line = `9\tERR\t${Buffer.from(msg, 'utf8').toString('base64')}`
    expect(parsePrintWorkerResponseLine(line)).toEqual({ id: '9', status: 'error', message: msg })
  })

  it('ERR sem campo de mensagem: erro genérico, nunca undefined', () => {
    const parsed = parsePrintWorkerResponseLine('3\tERR')
    expect(parsed).toEqual({
      id: '3',
      status: 'error',
      message: 'erro desconhecido do worker de impressao',
    })
  })

  it('READY e lixo não são respostas: null (caller loga, não trava)', () => {
    expect(parsePrintWorkerResponseLine('READY')).toBeNull()
    expect(parsePrintWorkerResponseLine('qualquer coisa sem tab')).toBeNull()
    expect(parsePrintWorkerResponseLine('5\tWAT\tx')).toBeNull()
  })
})

describe('PRINT_WORKER_PS_SOURCE (invariantes do script embutido)', () => {
  it('sem crase: crase é o caractere de escape do PowerShell E delimitador do template literal', () => {
    expect(PRINT_WORKER_PS_SOURCE).not.toContain('`')
  })

  it('sem interpolação JS ("$" + "{"): o template é literal, nada pode ser interpolado', () => {
    expect(PRINT_WORKER_PS_SOURCE).not.toContain('$' + '{')
  })

  it('compila o C# UMA única vez (um único Add-Type) e tem o loop de stdin', () => {
    expect(PRINT_WORKER_PS_SOURCE.match(/Add-Type/g)).toHaveLength(1)
    expect(PRINT_WORKER_PS_SOURCE).toContain('[Console]::In.ReadLine()')
    expect(PRINT_WORKER_PS_SOURCE).toContain("[Console]::Out.WriteLine('READY')")
  })
})

// ─── Integração: powershell.exe real, impressora inexistente ─────────────────

const GHOST_PRINTER = 'Zuppy Impressora Inexistente 7847'
const ESC_POS_DOC = Buffer.from([0x1b, 0x40, ...Buffer.from('ZUPPY TESTE\n', 'ascii')])
const INTEGRATION_TIMEOUT_MS = 60000

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não satisfeita no prazo')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.runIf(process.platform === 'win32')('worker de impressão (integração Windows)', () => {
  afterAll(() => {
    // Sem isto o powershell vivo (pipes abertos) segura o processo do vitest.
    killPrintWorkerForTests()
  })

  it(
    'impressora inexistente: falha ALTO com o erro do OpenPrinter — nunca sucesso sem imprimir',
    async () => {
      await expect(printRawDocument(GHOST_PRINTER, ESC_POS_DOC)).rejects.toThrow(
        /OpenPrinter falhou/,
      )
    },
    INTEGRATION_TIMEOUT_MS,
  )

  it(
    'um ERR de impressão NÃO derruba o worker: o pid permanece o mesmo',
    async () => {
      await expect(printRawDocument(GHOST_PRINTER, ESC_POS_DOC)).rejects.toThrow(
        /OpenPrinter falhou/,
      )
      const pid = getPrintWorkerPidForTests()
      expect(pid).not.toBeNull()
      await expect(printRawDocument(GHOST_PRINTER, ESC_POS_DOC)).rejects.toThrow(
        /OpenPrinter falhou/,
      )
      expect(getPrintWorkerPidForTests()).toBe(pid)
    },
    INTEGRATION_TIMEOUT_MS,
  )

  it(
    'RECUPERAÇÃO: worker morto (kill) → o envio seguinte respawna sozinho e funciona',
    async () => {
      await expect(printRawDocument(GHOST_PRINTER, ESC_POS_DOC)).rejects.toThrow(
        /OpenPrinter falhou/,
      )
      const pidAntes = getPrintWorkerPidForTests()
      expect(pidAntes).not.toBeNull()

      // Simula crash/kill do usuário/reciclagem do Windows.
      process.kill(pidAntes!)
      await waitFor(() => getPrintWorkerPidForTests() === null, 10000)

      // O envio seguinte precisa funcionar (respawn sob demanda): a falha tem
      // de ser DE IMPRESSORA (OpenPrinter), não "worker morto".
      await expect(printRawDocument(GHOST_PRINTER, ESC_POS_DOC)).rejects.toThrow(
        /OpenPrinter falhou/,
      )
      const pidDepois = getPrintWorkerPidForTests()
      expect(pidDepois).not.toBeNull()
      expect(pidDepois).not.toBe(pidAntes)
    },
    INTEGRATION_TIMEOUT_MS,
  )

  it(
    'concorrência: envios simultâneos não embaralham — cada um recebe a própria resposta',
    async () => {
      const resultados = await Promise.allSettled([
        printRawDocument(GHOST_PRINTER, ESC_POS_DOC),
        printRawDocument(GHOST_PRINTER, ESC_POS_DOC),
        printRawDocument(GHOST_PRINTER, ESC_POS_DOC),
      ])
      for (const resultado of resultados) {
        expect(resultado.status).toBe('rejected')
        if (resultado.status === 'rejected') {
          expect(String(resultado.reason)).toMatch(/OpenPrinter falhou/)
        }
      }
    },
    INTEGRATION_TIMEOUT_MS,
  )
})
