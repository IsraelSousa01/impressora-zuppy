/**
 * electron/print-queue.test.ts
 *
 * Cobre a decisão do cutover de 58mm (decideRenderPath): quando os bytes
 * já renderizados pelo servidor (`render[]`) são usados vs. quando o app
 * cai no build local (`printOrder`), comparando `resolved_columns` (largura
 * em que o servidor montou os bytes) com a largura real desta estação.
 *
 * `print-queue.ts` importa `./printer` → `./store`, que instancia
 * `electron-store` no topo do módulo — e `electron-store` exige rodar
 * dentro do Electron (ou receber `projectName`) pra resolver o diretório de
 * dados. Mocka-se o módulo aqui só pra permitir o import fora do Electron;
 * `decideRenderPath` em si não toca o store (recebe `stationCols` já
 * resolvido como parâmetro).
 */
import { describe, it, expect, vi } from 'vitest'

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

const { decideRenderPath } = await import('./print-queue')

describe('decideRenderPath', () => {
  it('sem render[] do servidor: build local, independente de resolved_columns', () => {
    const decision = decideRenderPath(32, 48, false)
    expect(decision.useServerRender).toBe(false)
  })

  it('resolved_columns ausente (servidor antigo): fallback conservador, build local', () => {
    const decision = decideRenderPath(undefined, 48, true)
    expect(decision.useServerRender).toBe(false)
    expect(decision.reason).toMatch(/servidor antigo/)
  })

  it('resolved_columns menor que a estação: usa os bytes do servidor', () => {
    const decision = decideRenderPath(32, 48, true)
    expect(decision.useServerRender).toBe(true)
  })

  it('resolved_columns igual à estação: usa os bytes do servidor (cabe exatamente)', () => {
    const decision = decideRenderPath(48, 48, true)
    expect(decision.useServerRender).toBe(true)
  })

  it('resolved_columns maior que a estação: bytes largos demais, cai no build local', () => {
    const decision = decideRenderPath(48, 32, true)
    expect(decision.useServerRender).toBe(false)
    expect(decision.reason).toMatch(/maior que a estação/)
  })

  it('estação calibrada em 58mm (columns=32) e render em 48: não cabe, build local', () => {
    // Estação 58mm calibrada a 32 colunas; servidor montou pra uma estação de 48
    // (80mm) — bytes estourariam a impressora física de 58mm.
    const decision = decideRenderPath(48, 32, true)
    expect(decision.useServerRender).toBe(false)
  })

  it('estação sem calibração em 58mm (deriva paperWidthMm → 32): render em 32 cabe', () => {
    const decision = decideRenderPath(32, 32, true)
    expect(decision.useServerRender).toBe(true)
  })

  it('estação sem calibração em 80mm (deriva paperWidthMm → 48): render em 48 cabe', () => {
    const decision = decideRenderPath(48, 48, true)
    expect(decision.useServerRender).toBe(true)
  })
})
