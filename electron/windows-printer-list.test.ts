import { describe, expect, it } from 'vitest'

import { listWindowsPrinterNames, parseWindowsPrinterNames } from './windows-printer-list'

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
