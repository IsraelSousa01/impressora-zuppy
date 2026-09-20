import { describe, expect, it } from 'vitest'

import {
  enumerateWindowsPrinters,
  listWindowsPrinterNames,
  parseWindowsPrinterNames,
} from './windows-printer-list'

describe('parseWindowsPrinterNames', () => {
  it('normaliza linhas do PowerShell, preserva acentos e remove duplicatas', () => {
    expect(
      parseWindowsPrinterNames(
        'EPSON TM-T20X Receipt\r\n  Impressora Térmica — Cozinha  \r\nEPSON TM-T20X Receipt\r\n\r\n',
      ),
    ).toEqual(['EPSON TM-T20X Receipt', 'Impressora Térmica — Cozinha'])
  })

  it('aceita também a saída legada Name= sem transformar o cabeçalho em impressora', () => {
    expect(parseWindowsPrinterNames('Name=EPSON TM-T20X Receipt\nName=\nName\n')).toEqual([
      'EPSON TM-T20X Receipt',
    ])
  })
})

describe('listWindowsPrinterNames', () => {
  it('usa Get-Printer como caminho principal', async () => {
    const commands: string[] = []

    const printers = await listWindowsPrinterNames(async (command) => {
      commands.push(command)
      return { stdout: 'EPSON TM-T20X Receipt\r\nMicrosoft Print to PDF\r\n' }
    })

    expect(printers).toEqual(['EPSON TM-T20X Receipt', 'Microsoft Print to PDF'])
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('Get-Printer')
  })

  it('usa Get-CimInstance quando Get-Printer falha', async () => {
    const commands: string[] = []

    const printers = await listWindowsPrinterNames(async (command) => {
      commands.push(command)
      if (commands.length === 1) throw new Error('Get-Printer indisponível')
      return { stdout: 'EPSON TM-T20X Receipt\r\n' }
    })

    expect(printers).toEqual(['EPSON TM-T20X Receipt'])
    expect(commands).toHaveLength(2)
    expect(commands[1]).toContain('Get-CimInstance')
  })

  it('retorna lista vazia somente quando os caminhos suportados falham', async () => {
    const printers = await listWindowsPrinterNames(async () => {
      throw new Error('falha do sistema')
    })

    expect(printers).toEqual([])
  })
})

describe('enumerateWindowsPrinters', () => {
  it('sem erro quando lista normalmente', async () => {
    const result = await enumerateWindowsPrinters(async () => ({
      stdout: 'EPSON TM-T20X Receipt\r\n',
    }))

    expect(result).toEqual({ printers: ['EPSON TM-T20X Receipt'], error: null })
  })

  it('sem erro quando o Windows realmente não tem impressoras', async () => {
    const result = await enumerateWindowsPrinters(async () => ({ stdout: '\r\n' }))

    expect(result).toEqual({ printers: [], error: null })
  })

  it('reporta o motivo quando todos os comandos falham (falha ≠ sem impressoras)', async () => {
    let call = 0
    const result = await enumerateWindowsPrinters(async () => {
      call += 1
      throw new Error(`falha ${call}`)
    })

    expect(result).toEqual({ printers: [], error: 'falha 2' })
  })

  it('não reporta erro quando o segundo comando funciona', async () => {
    let call = 0
    const result = await enumerateWindowsPrinters(async () => {
      call += 1
      if (call === 1) throw new Error('sem PrintManagement')
      return { stdout: 'EPSON TM-T20X Receipt\r\n' }
    })

    expect(result.error).toBeNull()
    expect(result.printers).toEqual(['EPSON TM-T20X Receipt'])
  })
})
