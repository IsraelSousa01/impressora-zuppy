/**
 * electron/wake-socket.test.ts
 *
 * `createRealtimeWakeSocket` com o RealtimeClient MOCKADO: as opções que o app
 * passa ao realtime-js e a trava do cliente fechado (o phoenix pode reagendar a
 * reconexão depois do disconnect e deixar um socket órfão).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

const clientes = vi.hoisted(() => [] as Array<{
  endpoint: string
  options: Record<string, unknown> & { heartbeatCallback: (s: string) => void; reconnectAfterMs: (t: number) => number }
  canais: Array<{ name: string; opts: unknown; on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }>
  disconnect: ReturnType<typeof vi.fn>
  removeAllChannels: ReturnType<typeof vi.fn>
}>)

vi.mock('@supabase/supabase-js', () => {
  class RealtimeClient {
    canais: Array<{ name: string; opts: unknown; on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }> = []
    disconnect = vi.fn(async () => 'ok')
    removeAllChannels = vi.fn(async () => [])
    constructor(endpoint: string, options: never) {
      clientes.push({ endpoint, options, canais: this.canais, disconnect: this.disconnect, removeAllChannels: this.removeAllChannels })
    }
    channel(name: string, opts: unknown) {
      const canal = { name, opts, on: vi.fn(), subscribe: vi.fn() }
      canal.on.mockReturnValue(canal)
      this.canais.push(canal)
      return canal
    }
  }
  return { RealtimeClient }
})

const { createRealtimeWakeSocket, HEARTBEAT_INTERVAL_MS } = await import('./wake')

function abrir() {
  const handlers = { onSignal: vi.fn(), onChannelStatus: vi.fn(), onHeartbeat: vi.fn() }
  const socket = createRealtimeWakeSocket(
    { endpoint: 'wss://abc.supabase.co/realtime/v1', anonKey: 'anon', channelNames: ['printer-wake:t1', 'printer-wake:t2'] },
    handlers
  )
  return { socket, handlers, cliente: clientes[clientes.length - 1] }
}

describe('createRealtimeWakeSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clientes.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opções: apikey, heartbeat de 25 s, Broadcast público sem Presence, evento qualquer', () => {
    const { cliente } = abrir()
    expect(cliente.endpoint).toBe('wss://abc.supabase.co/realtime/v1')
    expect(cliente.options).toMatchObject({ params: { apikey: 'anon' }, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS })
    expect(cliente.options).not.toHaveProperty('logger') // o logger do realtime-js loga a URL com a apikey
    expect(cliente.canais.map((c) => c.name)).toEqual(['printer-wake:t1', 'printer-wake:t2'])
    for (const canal of cliente.canais) {
      expect(canal.opts).toEqual({ config: { broadcast: { self: false, ack: false }, presence: { enabled: false }, private: false } })
      expect(canal.on).toHaveBeenCalledWith('broadcast', { event: '*' }, expect.any(Function))
    }
  })

  it('reconnect do socket: degraus de 1 s a 60 s, com jitter de até 5 s', () => {
    const { cliente } = abrir()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((t) => cliente.options.reconnectAfterMs(t))).toEqual([
      1000, 2000, 5000, 10000, 30000, 60000, 60000, 60000,
    ])
    vi.restoreAllMocks()
  })

  it('aberto: heartbeat segue para o controlador', () => {
    const { cliente, handlers } = abrir()
    cliente.options.heartbeatCallback('ok')
    expect(handlers.onHeartbeat).toHaveBeenCalledWith('ok')
    expect(cliente.disconnect).not.toHaveBeenCalled()
  })

  it('close: remove canais e desconecta, e desconecta de novo 15 s depois', () => {
    const { socket, cliente } = abrir()
    socket.close()
    expect(cliente.removeAllChannels).toHaveBeenCalledTimes(1)
    expect(cliente.disconnect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(15_000)
    expect(cliente.disconnect).toHaveBeenCalledTimes(2)
  })

  it('cliente fechado que dá sinal de vida (reconectou sozinho): vira disconnect, nada chega ao controlador', () => {
    const { socket, cliente, handlers } = abrir()
    socket.close()
    cliente.options.heartbeatCallback('sent')
    expect(cliente.disconnect).toHaveBeenCalledTimes(2)
    expect(handlers.onHeartbeat).not.toHaveBeenCalled()
  })
})
