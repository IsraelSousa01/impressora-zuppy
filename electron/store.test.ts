/**
 * electron/store.test.ts
 *
 * Cobre DUAS coisas de que depende "nada quebra para quem já tem o app":
 *
 *  1. o store é criado na primeira LEITURA, nunca no import do módulo. O main
 *     escolhe a pasta de dados desta instância (profile) no começo do boot, e
 *     os imports são avaliados antes do corpo do main — um store criado no
 *     import ficaria preso à pasta default e as duas instâncias voltariam a
 *     dividir device_token e session_token;
 *  2. o arquivo continua sendo `zuppy-impressora.json`, sem nenhum caminho
 *     forçado: na instância default a pasta também é a de sempre, então o app
 *     já instalado lê a mesma config e não repareia nada.
 */
import { describe, it, expect, vi } from 'vitest'

const construcoes: Array<Record<string, unknown>> = []

vi.mock('electron-store', () => {
  class MockElectronStore<T extends Record<string, unknown>> {
    private data: T
    constructor(opts: { defaults: T; name?: string }) {
      construcoes.push(opts as unknown as Record<string, unknown>)
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

const store = await import('./store')

describe('criação preguiçosa do store', () => {
  it('importar o módulo NÃO cria o store (a pasta de dados ainda não foi decidida)', () => {
    expect(construcoes).toHaveLength(0)
  })

  it('a primeira leitura cria; as seguintes reaproveitam o mesmo', () => {
    expect(store.getConfig()).toEqual({})
    expect(construcoes).toHaveLength(1)

    store.setConfig({ tenant_name: 'Podrão' })
    store.getLogs()
    store.loadPendingQueue()
    expect(construcoes).toHaveLength(1)
    expect(store.getConfig().tenant_name).toBe('Podrão')
  })

  it('arquivo e defaults inalterados — a config de hoje continua sendo lida', () => {
    expect(construcoes[0]).toEqual({
      name: 'zuppy-impressora',
      defaults: { config: {}, logs: [], pendingQueue: [] },
    })
    // Sem `cwd`: quem decide a pasta é o `userData` escolhido pelo main.
    expect(construcoes[0]).not.toHaveProperty('cwd')
  })
})

describe('config', () => {
  it('setConfig mescla raso e isConfigured olha o device_token', () => {
    expect(store.isConfigured()).toBe(false)
    store.setConfig({ device_token: 'tok', destination: { id: 'd', name: 'Cozinha', purpose: null } })
    expect(store.isConfigured()).toBe(true)
    expect(store.getConfig().tenant_name).toBe('Podrão')
    expect(store.getConfig().destination?.name).toBe('Cozinha')
  })

  it('destination volta a null quando o servidor deixa de mandar destino', () => {
    store.setConfig({ destination: null })
    expect(store.getConfig().destination).toBeNull()
  })
})
