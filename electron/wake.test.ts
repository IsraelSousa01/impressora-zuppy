/**
 * electron/wake.test.ts
 *
 * Cobre o "sinal de acordar" (1.5.0) sem rede e sem Supabase:
 *   - resolveRealtimeEndpoint: só `https://<ref>.supabase.co` abre socket;
 *   - parseWakeField / buildWakeHeader: o contrato com o servidor
 *     (zuppy-food lib/printer/wake.ts);
 *   - choosePollIntervalMs: 30 s só com o sinal saudável;
 *   - countMissedSignals: o detector de sinal perdido por `wake_expected`;
 *   - WakeController com socket FALSO: saúde, queda, ausência de `wake`,
 *     sinal perdido, reconhecimento de `missed`, nada de segredo em log.
 *
 * `logger` grava no electron-store (exige Electron): mocka-se como nos
 * outros testes.
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

const {
  resolveRealtimeEndpoint,
  parseWakeField,
  buildWakeHeader,
  choosePollIntervalMs,
  countMissedSignals,
  reconnectJitterMs,
  WakeController,
  WAKE_EXPECTED_WINDOW_MS,
  MISSED_SIGNAL_LOOKBACK_MS,
  MISSED_SIGNAL_GRACE_MS,
  MISSED_PENALTY_MS,
  HEARTBEAT_STALE_MS,
  WAKE_STUCK_RECREATE_MS,
} = await import('./wake')
type WakeSocketHandlers = import('./wake').WakeSocketHandlers
type WakeSocketConfig = import('./wake').WakeSocketConfig

const TOPICO_A = '11111111-2222-4333-8444-555555555555'
const TOPICO_B = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiJ9.anon.assinatura'

function wakeCompleto(version = 'v1', topics = [{ tenant_id: 't-1', topic: TOPICO_A }]) {
  return { url: 'https://xvloxrouxjrofygpbnyi.supabase.co', anon_key: ANON_KEY, topics, version }
}

describe('resolveRealtimeEndpoint — só https://<ref>.supabase.co abre socket', () => {
  it('url do projeto: endpoint wss do realtime', () => {
    expect(resolveRealtimeEndpoint('https://xvloxrouxjrofygpbnyi.supabase.co')).toBe(
      'wss://xvloxrouxjrofygpbnyi.supabase.co/realtime/v1'
    )
    expect(resolveRealtimeEndpoint('https://abc123.supabase.co/')).toBe('wss://abc123.supabase.co/realtime/v1')
  })

  it.each([
    ['http (sem TLS)', 'http://abc.supabase.co'],
    ['outro domínio', 'https://abc.evil.com'],
    ['sufixo enganoso', 'https://abc.supabase.co.evil.com'],
    ['subdomínio aninhado', 'https://a.b.supabase.co'],
    ['porta', 'https://abc.supabase.co:8443'],
    ['credencial na url', 'https://user:pass@abc.supabase.co'],
    ['caminho', 'https://abc.supabase.co/realtime/v1'],
    ['query', 'https://abc.supabase.co/?x=1'],
    ['fragmento', 'https://abc.supabase.co/#x'],
    ['wss direto', 'wss://abc.supabase.co'],
    ['maiúsculas', 'https://ABC.supabase.co'],
    ['espaço', ' https://abc.supabase.co'],
    ['vazio', ''],
  ])('%s: recusa', (_nome, url) => {
    expect(resolveRealtimeEndpoint(url)).toBeNull()
  })

  it('não-string: recusa', () => {
    expect(resolveRealtimeEndpoint(undefined)).toBeNull()
    expect(resolveRealtimeEndpoint(42)).toBeNull()
    expect(resolveRealtimeEndpoint({ href: 'https://abc.supabase.co' })).toBeNull()
  })
})

describe('parseWakeField — o campo `wake` da 200', () => {
  it('ausente: absent (flag desligada, sessão fora, falha transitória)', () => {
    expect(parseWakeField(undefined)).toEqual({ kind: 'absent' })
    expect(parseWakeField(null)).toEqual({ kind: 'absent' })
  })

  it('só { version }: o app já tem o conjunto', () => {
    expect(parseWakeField({ version: 'abc_123-x' })).toEqual({ kind: 'version', version: 'abc_123-x' })
  })

  it('completo e válido: endpoint, chave e tópicos', () => {
    const parsed = parseWakeField(wakeCompleto())
    expect(parsed).toMatchObject({
      kind: 'full',
      version: 'v1',
      endpoint: 'wss://xvloxrouxjrofygpbnyi.supabase.co/realtime/v1',
      anonKey: ANON_KEY,
      topics: [{ tenant_id: 't-1', topic: TOPICO_A }],
    })
  })

  it('url fora do Supabase: invalid, guardando a versão (o servidor não reenvia a cada poll)', () => {
    const parsed = parseWakeField({ ...wakeCompleto(), url: 'https://evil.com' })
    expect(parsed).toEqual({ kind: 'invalid', reason: expect.any(String), version: 'v1' })
  })

  it('o motivo da recusa nunca carrega o valor recebido (tópico, chave, url)', () => {
    const casos = [
      { ...wakeCompleto(), url: 'https://evil.com' },
      { ...wakeCompleto(), anon_key: 'tem espaço' },
      { ...wakeCompleto(), topics: [{ tenant_id: 't', topic: 'não-uuid' }] },
    ]
    for (const caso of casos) {
      const parsed = parseWakeField(caso)
      expect(parsed.kind).toBe('invalid')
      const reason = (parsed as { reason: string }).reason
      expect(reason).not.toContain('evil')
      expect(reason).not.toContain(TOPICO_A)
      expect(reason).not.toContain('espaço')
    }
  })

  it.each([
    ['version inválida', { ...wakeCompleto(), version: 'tem espaço' }],
    ['version ausente', { url: 'https://abc.supabase.co', anon_key: ANON_KEY, topics: [] }],
    ['topics vazio', { ...wakeCompleto(), topics: [] }],
    ['topics não-array', { ...wakeCompleto(), topics: 'x' }],
    ['anon_key vazia', { ...wakeCompleto(), anon_key: '' }],
    ['não é objeto', 'wake'],
    ['array', []],
  ])('%s: invalid', (_nome, raw) => {
    expect(parseWakeField(raw).kind).toBe('invalid')
  })

  it('mais de 100 tópicos: invalid (teto contra resposta absurda)', () => {
    const topics = Array.from({ length: 101 }, (_, i) => ({ tenant_id: `t-${i}`, topic: TOPICO_A }))
    expect(parseWakeField(wakeCompleto('v1', topics)).kind).toBe('invalid')
  })
})

describe('buildWakeHeader — X-Printer-Wake', () => {
  it('sem versão: v= vazio (o servidor manda o conjunto completo)', () => {
    expect(buildWakeHeader({ version: null, state: 'off', missed: 0 })).toBe('v=;state=off;missed=0')
  })

  it('com versão, estado e perdidos', () => {
    expect(buildWakeHeader({ version: 'abc', state: 'joined', missed: 3 })).toBe('v=abc;state=joined;missed=3')
  })

  it('missed é inteiro em [0, 1.000.000] (o servidor recusa fora disso)', () => {
    expect(buildWakeHeader({ version: null, state: 'degraded', missed: -5 })).toBe('v=;state=degraded;missed=0')
    expect(buildWakeHeader({ version: null, state: 'degraded', missed: 9e9 })).toBe(
      'v=;state=degraded;missed=1000000'
    )
  })

  it('nunca passa de 512 caracteres', () => {
    const header = buildWakeHeader({ version: 'x'.repeat(600), state: 'joined', missed: 1 })
    expect(header.length).toBeLessThanOrEqual(512)
    expect(header).toBe('v=;state=joined;missed=1')
  })
})

describe('choosePollIntervalMs — ritmo do poll de segurança', () => {
  it('sinal saudável: o ritmo com sinal (30 s)', () => {
    expect(choosePollIntervalMs({ healthy: true, serverPollMs: 3000, withWakeMs: 30000 })).toBe(30000)
  })

  it('sem sinal saudável: o ritmo de hoje', () => {
    expect(choosePollIntervalMs({ healthy: false, serverPollMs: 3000, withWakeMs: 30000 })).toBe(3000)
  })

  it('o sinal nunca deixa o poll mais rápido que o next_poll_ms', () => {
    expect(choosePollIntervalMs({ healthy: true, serverPollMs: 60000, withWakeMs: 30000 })).toBe(60000)
  })
})

describe('countMissedSignals — detector de sinal perdido', () => {
  const POLL = 1_000_000
  const LIGADO_HA_TEMPO = POLL - WAKE_EXPECTED_WINDOW_MS - 1
  const base = {
    jobs: [{ wake_expected: true }, { wake_expected: false }, {}],
    trigger: 'safety' as const,
    pollStartedAtMs: POLL,
    joinedSinceMs: LIGADO_HA_TEMPO,
    lastSignalAtMs: null,
  }

  it('poll de segurança achou job com wake_expected, sem sinal: conta só ele', () => {
    expect(countMissedSignals(base)).toBe(1)
  })

  it('wake_expected só vale como booleano true', () => {
    expect(countMissedSignals({ ...base, jobs: [{ wake_expected: 'true' }, { wake_expected: 1 }] })).toBe(0)
  })

  it.each(['signal', 'repoll', 'catchup'] as const)('poll %s: não conta', (trigger) => {
    expect(countMissedSignals({ ...base, trigger })).toBe(0)
  })

  it('canal não ligado: não conta (sem canal não se espera sinal)', () => {
    expect(countMissedSignals({ ...base, joinedSinceMs: null })).toBe(0)
  })

  it('canal ligado há menos que a janela wake_expected: pode ser catch-up, não conta', () => {
    expect(countMissedSignals({ ...base, joinedSinceMs: POLL - WAKE_EXPECTED_WINDOW_MS + 1 })).toBe(0)
  })

  it('sinal nos 15 s anteriores ao poll: não conta', () => {
    expect(countMissedSignals({ ...base, lastSignalAtMs: POLL - MISSED_SIGNAL_LOOKBACK_MS })).toBe(0)
    expect(countMissedSignals({ ...base, lastSignalAtMs: POLL - MISSED_SIGNAL_LOOKBACK_MS - 1 })).toBe(1)
  })
})

describe('reconnectJitterMs', () => {
  it('fica em [0, 5000)', () => {
    expect(reconnectJitterMs(() => 0)).toBe(0)
    expect(reconnectJitterMs(() => 0.5)).toBe(2500)
    expect(reconnectJitterMs(() => 0.9999999)).toBeLessThan(5000)
    expect(reconnectJitterMs(() => 1)).toBeLessThan(5000)
    expect(reconnectJitterMs(() => NaN)).toBe(0)
  })
})

// ─── Controlador com socket falso ─────────────────────────────────────────────

interface FakeSocket {
  config: WakeSocketConfig
  handlers: WakeSocketHandlers
  closed: boolean
  /** Todos os canais `SUBSCRIBED`. */
  joinAll(): void
}

function criarControlador() {
  const sockets: FakeSocket[] = []
  const saude: boolean[] = []
  const sinais: number[] = []
  const controller = new WakeController({
    socketFactory: (config, handlers) => {
      const socket: FakeSocket = {
        config,
        handlers,
        closed: false,
        joinAll() {
          config.channelNames.forEach((_, i) => handlers.onChannelStatus(i, 'SUBSCRIBED'))
        },
      }
      sockets.push(socket)
      return {
        close() {
          socket.closed = true
        },
      }
    },
    onHealthChange: (healthy) => saude.push(healthy),
    onSignal: () => sinais.push(Date.now()),
  })
  const responder = (wake: unknown, extra: Partial<Parameters<typeof controller.handlePollResponse>[0]> = {}) =>
    controller.handlePollResponse({
      wake,
      jobs: [],
      wakeMissedRecorded: undefined,
      trigger: 'safety',
      pollStartedAtMs: Date.now(),
      ...extra,
    })
  return { controller, sockets, saude, sinais, responder }
}

describe('WakeController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sem wake nunca recebido: off, v= vazio — a 1.5.0 fora da flag se comporta como a 1.4.0', () => {
    const { controller, sockets, responder } = criarControlador()
    responder(undefined)
    responder(undefined)
    expect(sockets).toHaveLength(0)
    expect(controller.state()).toBe('off')
    expect(controller.isHealthy()).toBe(false)
    expect(controller.requestHeader()).toBe('v=;state=off;missed=0')
  })

  it('wake completo: assina printer-wake:<topic> de cada loja no endpoint validado', () => {
    const { sockets, responder } = criarControlador()
    responder(
      wakeCompleto('v1', [
        { tenant_id: 't-1', topic: TOPICO_A },
        { tenant_id: 't-2', topic: TOPICO_B },
      ])
    )
    expect(sockets).toHaveLength(1)
    expect(sockets[0].config).toEqual({
      endpoint: 'wss://xvloxrouxjrofygpbnyi.supabase.co/realtime/v1',
      anonKey: ANON_KEY,
      channelNames: [`printer-wake:${TOPICO_A}`, `printer-wake:${TOPICO_B}`],
    })
  })

  it('url fora do Supabase: nenhum socket, e o header guarda a versão recusada', () => {
    const { controller, sockets, responder } = criarControlador()
    responder({ ...wakeCompleto(), url: 'https://evil.example.com' })
    expect(sockets).toHaveLength(0)
    expect(controller.requestHeader()).toBe('v=v1;state=off;missed=0')
  })

  it('saudável só com TODOS os canais joined; aí state=joined no header', () => {
    const { controller, sockets, saude, responder } = criarControlador()
    responder(wakeCompleto('v1', [
      { tenant_id: 't-1', topic: TOPICO_A },
      { tenant_id: 't-2', topic: TOPICO_B },
    ]))
    expect(controller.state()).toBe('degraded')
    sockets[0].handlers.onChannelStatus(0, 'SUBSCRIBED')
    expect(controller.isHealthy()).toBe(false)
    sockets[0].handlers.onChannelStatus(1, 'SUBSCRIBED')
    expect(controller.isHealthy()).toBe(true)
    expect(saude).toEqual([true])
    expect(controller.requestHeader()).toBe('v=v1;state=joined;missed=0')
  })

  it('canal caiu (socket morto): deixa de ser saudável na hora e avisa', () => {
    const { controller, sockets, saude, responder } = criarControlador()
    responder(wakeCompleto())
    sockets[0].joinAll()
    sockets[0].handlers.onChannelStatus(0, 'CHANNEL_ERROR')
    expect(controller.isHealthy()).toBe(false)
    expect(controller.state()).toBe('degraded')
    expect(saude).toEqual([true, false])
  })

  it('heartbeat timeout: não saudável; volta com o próximo ok', () => {
    const { controller, sockets, responder } = criarControlador()
    responder(wakeCompleto())
    sockets[0].joinAll()
    sockets[0].handlers.onHeartbeat('timeout')
    expect(controller.isHealthy()).toBe(false)
    sockets[0].handlers.onHeartbeat('ok')
    expect(controller.isHealthy()).toBe(true)
  })

  it('heartbeat parado (sem evento nenhum): a conferência periódica derruba a saúde', () => {
    const { controller, sockets, saude, responder } = criarControlador()
    responder(wakeCompleto())
    sockets[0].joinAll()
    vi.advanceTimersByTime(HEARTBEAT_STALE_MS + 5_001)
    expect(controller.isHealthy()).toBe(false)
    expect(saude).toEqual([true, false])
  })

  it('{ version } igual: mantém o socket; versão nova completa: troca o socket', () => {
    const { sockets, responder } = criarControlador()
    responder(wakeCompleto('v1'))
    responder({ version: 'v1' })
    expect(sockets).toHaveLength(1)
    expect(sockets[0].closed).toBe(false)
    responder(wakeCompleto('v2', [{ tenant_id: 't-1', topic: TOPICO_B }]))
    expect(sockets).toHaveLength(2)
    expect(sockets[0].closed).toBe(true)
    expect(sockets[1].closed).toBe(false)
  })

  it('resposta sem wake: tolera UMA (falha transitória); a segunda seguida desliga e esquece a versão', () => {
    const { controller, sockets, responder } = criarControlador()
    responder(wakeCompleto('v1'))
    sockets[0].joinAll()
    responder(undefined)
    expect(sockets[0].closed).toBe(false)
    expect(controller.requestHeader()).toBe('v=v1;state=joined;missed=0')
    responder(undefined)
    expect(sockets[0].closed).toBe(true)
    expect(controller.state()).toBe('off')
    expect(controller.isHealthy()).toBe(false)
    // Contrato: depois de derrubar, `v=` vazio até receber um wake completo.
    expect(controller.requestHeader()).toBe('v=;state=off;missed=0')
  })

  it('wake intercalado zera a contagem de ausências', () => {
    const { sockets, responder } = criarControlador()
    responder(wakeCompleto('v1'))
    responder(undefined)
    responder({ version: 'v1' })
    responder(undefined)
    expect(sockets[0].closed).toBe(false)
  })

  it('sinal: avisa o laço (wakeNow); o payload é ignorado — qualquer mensagem só agenda poll', () => {
    const { sockets, sinais, responder } = criarControlador()
    responder(wakeCompleto())
    sockets[0].handlers.onSignal()
    expect(sinais).toHaveLength(1)
  })

  it('sinal de um socket já trocado: ignorado', () => {
    const { sockets, sinais, responder } = criarControlador()
    responder(wakeCompleto('v1'))
    responder(wakeCompleto('v2'))
    sockets[0].handlers.onSignal()
    expect(sinais).toHaveLength(0)
  })

  it('reset (401/403/desconectar): fecha o socket e esquece a versão', () => {
    const { controller, sockets, responder } = criarControlador()
    responder(wakeCompleto('v1'))
    controller.reset('teste')
    expect(sockets[0].closed).toBe(true)
    expect(controller.requestHeader()).toBe('v=;state=off;missed=0')
  })

  it('socket que lança ao abrir: fica off, sem derrubar quem chamou', () => {
    const controller = new WakeController({
      socketFactory: () => {
        throw new Error('boom')
      },
    })
    expect(() =>
      controller.handlePollResponse({
        wake: wakeCompleto(),
        jobs: [],
        wakeMissedRecorded: undefined,
        trigger: 'safety',
        pollStartedAtMs: Date.now(),
      })
    ).not.toThrow()
    expect(controller.state()).toBe('off')
    // Esquece a versão: o próximo poll pede o conjunto e tenta de novo (nada de "off" silencioso).
    expect(controller.requestHeader()).toBe('v=;state=off;missed=0')
  })

  it('onHealthChange que lança não escapa', () => {
    const controller = new WakeController({
      socketFactory: (config, handlers) => {
        queueMicrotask(() => config.channelNames.forEach((_, i) => handlers.onChannelStatus(i, 'SUBSCRIBED')))
        return { close() {} }
      },
      onHealthChange: () => {
        throw new Error('boom')
      },
    })
    expect(() =>
      controller.handlePollResponse({
        wake: wakeCompleto(),
        jobs: [],
        wakeMissedRecorded: undefined,
        trigger: 'safety',
        pollStartedAtMs: Date.now(),
      })
    ).not.toThrow()
  })

  describe('watchdog: socket preso fora de joined é recriado', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0) // limite = 120 s, sem jitter
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('nunca entrou (realtime-js preso em CONNECTING): recria depois de ~2 min, com o mesmo wake', () => {
      const { sockets, responder } = criarControlador()
      responder(wakeCompleto())
      vi.advanceTimersByTime(WAKE_STUCK_RECREATE_MS - 5_000)
      expect(sockets).toHaveLength(1)
      vi.advanceTimersByTime(10_000)
      expect(sockets).toHaveLength(2)
      expect(sockets[0].closed).toBe(true)
      expect(sockets[1].config).toEqual(sockets[0].config)
    })

    it('caiu depois de ligado e não voltou: recria; o socket novo entrando volta a ficar saudável', () => {
      const { controller, sockets, responder } = criarControlador()
      responder(wakeCompleto())
      sockets[0].joinAll()
      vi.advanceTimersByTime(60_000)
      sockets[0].handlers.onHeartbeat('ok')
      sockets[0].handlers.onChannelStatus(0, 'CHANNEL_ERROR')
      vi.advanceTimersByTime(WAKE_STUCK_RECREATE_MS + 10_000)
      expect(sockets).toHaveLength(2)
      sockets[1].joinAll()
      expect(controller.isHealthy()).toBe(true)
      // Mantém a versão: o servidor segue respondendo só { version }.
      expect(controller.requestHeader()).toBe('v=v1;state=joined;missed=0')
    })

    it('ligado e saudável: nunca recria', () => {
      const { sockets, responder } = criarControlador()
      responder(wakeCompleto())
      sockets[0].joinAll()
      for (let t = 0; t < 10 * 60_000; t += 20_000) {
        vi.advanceTimersByTime(20_000)
        sockets[0].handlers.onHeartbeat('ok')
      }
      expect(sockets).toHaveLength(1)
    })

    it('queda curta que o realtime-js resolve sozinho: não recria', () => {
      const { sockets, responder } = criarControlador()
      responder(wakeCompleto())
      sockets[0].joinAll()
      sockets[0].handlers.onChannelStatus(0, 'CHANNEL_ERROR')
      vi.advanceTimersByTime(65_000) // maior degrau do reconnect + jitter
      sockets[0].handlers.onChannelStatus(0, 'SUBSCRIBED')
      vi.advanceTimersByTime(WAKE_STUCK_RECREATE_MS)
      expect(sockets).toHaveLength(1)
    })

    it('queda longa: uma tentativa nova a cada ~2 min, nunca uma rajada', () => {
      const { sockets, responder } = criarControlador()
      responder(wakeCompleto())
      vi.advanceTimersByTime(10 * 60_000)
      // 600 s / (120 s + até 5 s de cadência do tick) ⇒ 4 ou 5 recriações.
      expect(sockets.length - 1).toBeGreaterThanOrEqual(4)
      expect(sockets.length - 1).toBeLessThanOrEqual(5)
      expect(sockets.slice(0, -1).every((s) => s.closed)).toBe(true)
    })
  })

  describe('sinal perdido', () => {
    function ligadoHaMaisDeUmMinuto() {
      const ctx = criarControlador()
      ctx.responder(wakeCompleto())
      ctx.sockets[0].joinAll()
      vi.advanceTimersByTime(WAKE_EXPECTED_WINDOW_MS + 1)
      ctx.sockets[0].handlers.onHeartbeat('ok')
      return ctx
    }

    it('job wake_expected no poll de segurança: depois da carência, conta, reporta e volta ao ritmo de hoje por 10 min', () => {
      const { controller, saude, responder } = ligadoHaMaisDeUmMinuto()
      responder({ version: 'v1' }, { jobs: [{ wake_expected: true }] })
      // Durante a carência ainda não conta (o sinal pode estar a caminho).
      expect(controller.missedCount()).toBe(0)
      vi.advanceTimersByTime(MISSED_SIGNAL_GRACE_MS)
      expect(controller.missedCount()).toBe(1)
      expect(controller.isHealthy()).toBe(false)
      expect(saude).toEqual([true, false])
      expect(controller.requestHeader()).toBe('v=v1;state=joined;missed=1')
    })

    it('a penalidade acaba depois de 10 min com o canal saudável', () => {
      const { controller, sockets, responder } = ligadoHaMaisDeUmMinuto()
      responder({ version: 'v1' }, { jobs: [{ wake_expected: true }] })
      vi.advanceTimersByTime(MISSED_SIGNAL_GRACE_MS)
      for (let t = 0; t < MISSED_PENALTY_MS; t += 20_000) {
        vi.advanceTimersByTime(20_000)
        sockets[0].handlers.onHeartbeat('ok')
      }
      expect(controller.isHealthy()).toBe(true)
    })

    it('sinal chegando na carência: era corrida, não perda', () => {
      const { controller, sockets, responder } = ligadoHaMaisDeUmMinuto()
      responder({ version: 'v1' }, { jobs: [{ wake_expected: true }] })
      vi.advanceTimersByTime(1000)
      sockets[0].handlers.onSignal()
      vi.advanceTimersByTime(MISSED_SIGNAL_GRACE_MS)
      expect(controller.missedCount()).toBe(0)
      expect(controller.isHealthy()).toBe(true)
    })

    it('wake_missed_recorded: subtrai do contador (piso 0), preservando o que se perdeu depois', () => {
      const { controller, responder } = ligadoHaMaisDeUmMinuto()
      responder({ version: 'v1' }, { jobs: [{ wake_expected: true }, { wake_expected: true }] })
      vi.advanceTimersByTime(MISSED_SIGNAL_GRACE_MS)
      expect(controller.missedCount()).toBe(2)
      responder({ version: 'v1' }, { wakeMissedRecorded: 1, trigger: 'catchup' })
      expect(controller.missedCount()).toBe(1)
      responder({ version: 'v1' }, { wakeMissedRecorded: 5, trigger: 'catchup' })
      expect(controller.missedCount()).toBe(0)
    })

    it('wake_missed_recorded inválido: ignorado', () => {
      const { controller, responder } = ligadoHaMaisDeUmMinuto()
      responder({ version: 'v1' }, { jobs: [{ wake_expected: true }] })
      vi.advanceTimersByTime(MISSED_SIGNAL_GRACE_MS)
      responder({ version: 'v1' }, { wakeMissedRecorded: '1', trigger: 'catchup' })
      responder({ version: 'v1' }, { wakeMissedRecorded: -1, trigger: 'catchup' })
      responder({ version: 'v1' }, { wakeMissedRecorded: 0.5, trigger: 'catchup' })
      expect(controller.missedCount()).toBe(1)
    })
  })

  it('nenhum log leva tópico, anon key ou url', () => {
    const linhas: string[] = []
    const capturar = (...args: unknown[]) => linhas.push(args.map(String).join(' '))
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(capturar),
      vi.spyOn(console, 'warn').mockImplementation(capturar),
      vi.spyOn(console, 'error').mockImplementation(capturar),
    ]
    try {
      const { controller, sockets, responder } = criarControlador()
      responder({ ...wakeCompleto('v0'), url: 'https://evil.example.com' })
      responder(wakeCompleto('v1'))
      sockets[0].joinAll()
      sockets[0].handlers.onHeartbeat('timeout')
      sockets[0].handlers.onChannelStatus(0, 'CHANNEL_ERROR')
      sockets[0].handlers.onSignal()
      responder(undefined)
      responder(undefined)
      controller.reset('fim')
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
    expect(linhas.length).toBeGreaterThan(0)
    const tudo = linhas.join('\n')
    expect(tudo).not.toContain(TOPICO_A)
    expect(tudo).not.toContain(ANON_KEY)
    expect(tudo).not.toContain('xvloxrouxjrofygpbnyi')
    expect(tudo).not.toContain('evil.example.com')
  })
})
