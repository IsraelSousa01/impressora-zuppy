/**
 * electron/launch.test.ts
 *
 * O atalho `zuppy-impressora://abrir` chega do NAVEGADOR (qualquer página pode
 * pedir esse link): a URL só abre a janelinha, e qualquer outra coisa nela é
 * ignorada. Função pura — não precisa do Electron.
 */
import { describe, it, expect } from 'vitest'
import {
  PROTOCOL_SCHEME,
  parseLaunchRequest,
  describeOpenNotice,
  createNoticeThrottle,
  shouldShowNoticeOnBoot,
} from './launch'

const EXE = 'C:\\Users\\loja\\AppData\\Local\\Programs\\Zuppy Impressora\\Zuppy Impressora.exe'

describe('parseLaunchRequest', () => {
  it('sem URL nenhuma (clicou no atalho do app) abre a janelinha', () => {
    expect(parseLaunchRequest([EXE])).toEqual({ kind: 'open' })
    expect(parseLaunchRequest([EXE, '--profile=cozinha', '--port=7848'])).toEqual({ kind: 'open' })
  })

  it('zuppy-impressora://abrir abre a janelinha', () => {
    expect(parseLaunchRequest([EXE, 'zuppy-impressora://abrir'])).toEqual({ kind: 'open' })
    expect(parseLaunchRequest([EXE, 'zuppy-impressora://abrir/'])).toEqual({ kind: 'open' })
    expect(parseLaunchRequest([EXE, 'ZUPPY-IMPRESSORA://ABRIR'])).toEqual({ kind: 'open' })
  })

  it('parâmetros e fragmento da URL são ignorados, nunca interpretados', () => {
    expect(
      parseLaunchRequest([EXE, 'zuppy-impressora://abrir?device_token=abc&api_url=https://evil.test#x']),
    ).toEqual({ kind: 'open' })
  })

  it('o destino da URL é só "abrir": outro destino não abre nada', () => {
    expect(parseLaunchRequest([EXE, 'zuppy-impressora://configurar'])).toEqual({ kind: 'ignore' })
    expect(parseLaunchRequest([EXE, 'zuppy-impressora://sair'])).toEqual({ kind: 'ignore' })
    expect(parseLaunchRequest([EXE, 'zuppy-impressora://abrir/../sair'])).toEqual({ kind: 'ignore' })
    expect(parseLaunchRequest([EXE, 'zuppy-impressora://abrir.evil.test'])).toEqual({ kind: 'ignore' })
    expect(parseLaunchRequest([EXE, 'zuppy-impressora:abrir'])).toEqual({ kind: 'ignore' })
    expect(parseLaunchRequest([EXE, 'zuppy-impressora://'])).toEqual({ kind: 'ignore' })
  })

  it('URL com usuário/senha ou porta não é o atalho', () => {
    expect(parseLaunchRequest([EXE, 'zuppy-impressora://user:pass@abrir'])).toEqual({ kind: 'ignore' })
    expect(parseLaunchRequest([EXE, 'zuppy-impressora://abrir:8080'])).toEqual({ kind: 'ignore' })
  })

  it('URL de outro esquema no argv não vira atalho (e não derruba nada)', () => {
    expect(parseLaunchRequest([EXE, 'https://evil.test/abrir'])).toEqual({ kind: 'open' })
  })

  it('a primeira URL do nosso esquema decide; lixo no argv não lança', () => {
    expect(
      parseLaunchRequest([EXE, 'zuppy-impressora://sair', 'zuppy-impressora://abrir']),
    ).toEqual({ kind: 'ignore' })
    expect(() => parseLaunchRequest([EXE, 'zuppy-impressora://[::1'])).not.toThrow()
    expect(parseLaunchRequest([EXE, 'zuppy-impressora://[::1'])).toEqual({ kind: 'ignore' })
  })

  it('o esquema registrado é o do briefing', () => {
    expect(PROTOCOL_SCHEME).toBe('zuppy-impressora')
  })
})

describe('shouldShowNoticeOnBoot', () => {
  it('só quando o app foi aberto pelo link', () => {
    expect(shouldShowNoticeOnBoot([EXE, 'zuppy-impressora://abrir'])).toBe(true)
  })

  it('subir com o Windows (sem URL) não abre janelinha', () => {
    expect(shouldShowNoticeOnBoot([EXE])).toBe(false)
    expect(shouldShowNoticeOnBoot([EXE, '--profile=cozinha', '--port=7848'])).toBe(false)
  })

  it('link de destino desconhecido não abre janelinha', () => {
    expect(shouldShowNoticeOnBoot([EXE, 'zuppy-impressora://sair'])).toBe(false)
  })
})

describe('describeOpenNotice', () => {
  it('conectado: "está aberto e imprimindo"', () => {
    const n = describeOpenNotice({ configured: true, connected: true, printer: 'EPSON TM-T20' })
    expect(n.message).toBe('Zuppy Impressora está aberto e imprimindo')
    expect(n.detail).toContain('EPSON TM-T20')
    expect(n.detail).toContain('bandeja')
  })

  it('conectado sem impressora escolhida não finge que imprime', () => {
    const n = describeOpenNotice({ configured: true, connected: true, printer: null })
    expect(n.message).toBe('Zuppy Impressora está aberto')
    expect(n.detail).toMatch(/impressora/i)
  })

  it('pareado mas sem conexão: diz a verdade', () => {
    const n = describeOpenNotice({ configured: true, connected: false, printer: 'EPSON TM-T20' })
    expect(n.message).not.toMatch(/imprimindo/)
    expect(n.message).toMatch(/sem conexão/i)
  })

  it('sem pareamento: ensina o caminho, não diz que imprime', () => {
    const n = describeOpenNotice({ configured: false, connected: false, printer: null })
    expect(n.message).toBe('Zuppy Impressora está aberto')
    expect(n.detail).toMatch(/Parear com o código copiado/)
  })
})

describe('createNoticeThrottle', () => {
  it('não empilha janelinhas: pedido com uma aberta é ignorado', () => {
    const t = createNoticeThrottle({ minGapMs: 0 })
    expect(t.tryStart(1000)).toBe(true)
    expect(t.tryStart(1001)).toBe(false)
    t.finish(1002)
    expect(t.tryStart(1003)).toBe(true)
  })

  it('uma página que pede o atalho em rajada não vira spam de janelas', () => {
    const t = createNoticeThrottle({ minGapMs: 2000 })
    expect(t.tryStart(0)).toBe(true)
    t.finish(500)
    expect(t.tryStart(1000)).toBe(false) // 500 ms depois de fechar
    expect(t.tryStart(2600)).toBe(true) // passou o intervalo
  })
})
