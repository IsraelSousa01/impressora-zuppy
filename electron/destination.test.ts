/**
 * electron/destination.test.ts
 *
 * Cobre a leitura do campo `destination` do handshake (impressora nomeada) e
 * o rótulo que o dono lê na bandeja. Duas razões para validar em vez de
 * confiar: o valor é GRAVADO no disco (um destino malformado ficaria lá) e
 * depois EXIBIDO (um `name` não-string viraria "[object Object]" no menu).
 *
 * `destination.ts` é puro — roda sem mock de electron.
 */
import { describe, it, expect } from 'vitest'

import { parsePrinterDestination, formatDeviceLabel } from './destination'

describe('parsePrinterDestination', () => {
  it('destino completo: passa inteiro', () => {
    expect(parsePrinterDestination({ id: 'd-1', name: 'Cozinha', purpose: 'kitchen' })).toEqual({
      id: 'd-1',
      name: 'Cozinha',
      purpose: 'kitchen',
    })
  })

  it('ausente / null: sem destino — é o token legado da loja', () => {
    expect(parsePrinterDestination(undefined)).toBeNull()
    expect(parsePrinterDestination(null)).toBeNull()
  })

  it('purpose ausente ou vazio vira null, mas o destino continua válido', () => {
    expect(parsePrinterDestination({ id: 'd-1', name: 'Bar' })).toEqual({
      id: 'd-1',
      name: 'Bar',
      purpose: null,
    })
    expect(parsePrinterDestination({ id: 'd-1', name: 'Bar', purpose: '  ' })?.purpose).toBeNull()
  })

  it('sem id ou sem name: não é destino', () => {
    expect(parsePrinterDestination({ name: 'Cozinha' })).toBeNull()
    expect(parsePrinterDestination({ id: 'd-1' })).toBeNull()
    expect(parsePrinterDestination({ id: 'd-1', name: '   ' })).toBeNull()
    expect(parsePrinterDestination({ id: 42, name: 'Cozinha' })).toBeNull()
    expect(parsePrinterDestination({ id: 'd-1', name: { pt: 'Cozinha' } })).toBeNull()
  })

  it('tipo errado no lugar do objeto: não quebra', () => {
    for (const lixo of ['Cozinha', 42, true, []]) {
      expect(parsePrinterDestination(lixo)).toBeNull()
    }
  })

  it('apara espaços de id e name', () => {
    expect(parsePrinterDestination({ id: ' d-1 ', name: ' Cozinha ' })).toEqual({
      id: 'd-1',
      name: 'Cozinha',
      purpose: null,
    })
  })
})

describe('formatDeviceLabel', () => {
  const destino = { id: 'd-1', name: 'Cozinha', purpose: 'kitchen' }

  it('destino + loja: "Cozinha — Podrão"', () => {
    expect(formatDeviceLabel({ destination: destino, tenant_name: 'Podrão' })).toBe(
      'Cozinha — Podrão'
    )
  })

  it('sem destino: o nome da loja, como sempre foi', () => {
    expect(formatDeviceLabel({ tenant_name: 'Podrão' })).toBe('Podrão')
    expect(formatDeviceLabel({ destination: null, tenant_name: 'Podrão' })).toBe('Podrão')
  })

  it('destino sem nome de loja gravado: só o destino', () => {
    expect(formatDeviceLabel({ destination: destino })).toBe('Cozinha')
    expect(formatDeviceLabel({ destination: destino, tenant_name: '  ' })).toBe('Cozinha')
  })

  it('nada pareado ainda: null', () => {
    expect(formatDeviceLabel({})).toBeNull()
    expect(formatDeviceLabel({ destination: null, tenant_name: null })).toBeNull()
  })
})
