/**
 * electron/quit-guard.test.ts
 *
 * "Sair" na bandeja derruba a impressão da loja. O lojista fecha sem querer
 * (e o app fica escondido, então ele nem percebe): a caixa de confirmação diz
 * a consequência real, e o botão preferido é o que NÃO sai.
 */
import { describe, it, expect } from 'vitest'
import { buildQuitConfirmation } from './quit-guard'

describe('buildQuitConfirmation', () => {
  it('app pareado: avisa que os pedidos deixam de imprimir e o padrão é continuar', () => {
    const c = buildQuitConfirmation({ configured: true, queueLength: 0 })
    expect(c).not.toBeNull()
    expect(c!.message).toMatch(/pedidos deixam de imprimir/i)
    expect(c!.buttons).toEqual(['Continuar imprimindo', 'Sair mesmo'])
    expect(c!.defaultId).toBe(0)
    expect(c!.cancelId).toBe(0)
    expect(c!.quitButtonIndex).toBe(1)
  })

  it('comandas na fila entram no aviso (singular e plural)', () => {
    expect(buildQuitConfirmation({ configured: true, queueLength: 1 })!.detail).toMatch(
      /1 comanda ainda não imprimiu/,
    )
    expect(buildQuitConfirmation({ configured: true, queueLength: 3 })!.detail).toMatch(
      /3 comandas ainda não imprimiram/,
    )
  })

  it('sem fila, o aviso não inventa comanda parada', () => {
    expect(buildQuitConfirmation({ configured: true, queueLength: 0 })!.detail).not.toMatch(/comanda ainda/)
  })

  it('app sem pareamento não imprime nada: sai direto, sem perguntar', () => {
    expect(buildQuitConfirmation({ configured: false, queueLength: 0 })).toBeNull()
  })
})
