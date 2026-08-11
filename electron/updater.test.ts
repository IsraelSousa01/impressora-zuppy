/**
 * electron/updater.test.ts
 *
 * Cobre a janela segura de instalação de update:
 *
 *   - shouldInstallNow: decisão PURA — loja aberta nunca instala; comanda na
 *     fila nunca instala; fila recém-mexida nunca instala; sem update baixado
 *     nunca instala; só instala com loja fechada + fila vazia e quieta.
 *   - isStoreClosedPollInterval: loja fechada = ritmo de poll >= 30s (o
 *     servidor dita 3s ativa / 30s fechada via next_poll_ms; na dúvida,
 *     trata como aberta).
 *   - isQueueQuiet: janela de silêncio da fila — cobre a impressão em voo
 *     (job já fora da fila enquanto o papel sai) e o retry em backoff.
 *   - registerDownloadedUpdate/getUpdateState: estado exposto no /status.
 *   - maybeInstallOnSafeWindow/installNow: efeito só dispara na janela
 *     segura; quitAndInstall silencioso + relaunch; trava contra disparo
 *     duplo.
 *
 * `updater.ts` importa `./print-queue` → `./store`, que instancia
 * `electron-store` no topo do módulo (exige Electron) — mocka-se igual aos
 * outros testes. `electron-updater` é mockado pra capturar o quitAndInstall
 * sem Electron (o updater.ts só o carrega via import dinâmico em installNow).
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

vi.mock('electron-updater', () => ({
  autoUpdater: {
    quitAndInstall: vi.fn(),
  },
}))

const {
  shouldInstallNow,
  isStoreClosedPollInterval,
  isQueueQuiet,
  registerDownloadedUpdate,
  getUpdateState,
  maybeInstallOnSafeWindow,
  installNow,
  resetUpdaterStateForTests,
  QUEUE_QUIET_WINDOW_MS,
  STORE_CLOSED_POLL_INTERVAL_MS,
} = await import('./updater')
const { queueEvents } = await import('./print-queue')
const { autoUpdater } = await import('electron-updater')

const quitAndInstall = vi.mocked(autoUpdater.quitAndInstall)

/** Sinais todos favoráveis — cada teste nega UM deles pra provar o veto. */
const SAFE = { updateReady: true, storeClosed: true, queueEmpty: true, queueQuiet: true }

beforeEach(() => {
  vi.useFakeTimers()
  resetUpdaterStateForTests()
  quitAndInstall.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('shouldInstallNow (decisão pura)', () => {
  it('sem update baixado: nunca, mesmo com loja fechada e fila vazia', () => {
    const decision = shouldInstallNow({ ...SAFE, updateReady: false })
    expect(decision.install).toBe(false)
    expect(decision.reason).toMatch(/sem update/)
  })

  it('loja aberta: não instala (restart derrubaria a impressão no movimento)', () => {
    const decision = shouldInstallNow({ ...SAFE, storeClosed: false })
    expect(decision.install).toBe(false)
    expect(decision.reason).toMatch(/loja aberta/)
  })

  it('comanda na fila: não instala, mesmo com a loja fechada', () => {
    const decision = shouldInstallNow({ ...SAFE, queueEmpty: false })
    expect(decision.install).toBe(false)
    expect(decision.reason).toMatch(/comanda pendente/)
  })

  it('fila com atividade recente (impressão/retry em voo): não instala', () => {
    const decision = shouldInstallNow({ ...SAFE, queueQuiet: false })
    expect(decision.install).toBe(false)
    expect(decision.reason).toMatch(/atividade/)
  })

  it('loja fechada + fila vazia e quieta + update pronto: instala', () => {
    const decision = shouldInstallNow(SAFE)
    expect(decision.install).toBe(true)
  })
})

describe('isStoreClosedPollInterval', () => {
  it('ritmo de loja ativa (3s): aberta', () => {
    expect(isStoreClosedPollInterval(3000)).toBe(false)
  })

  it('ritmo de loja fechada (30s): fechada', () => {
    expect(isStoreClosedPollInterval(STORE_CLOSED_POLL_INTERVAL_MS)).toBe(true)
  })

  it('acima de 30s (clamp permite até 60s): fechada', () => {
    expect(isStoreClosedPollInterval(60000)).toBe(true)
  })

  it('logo abaixo de 30s: na dúvida, aberta (nunca instalar é o erro barato)', () => {
    expect(isStoreClosedPollInterval(29999)).toBe(false)
  })
})

describe('isQueueQuiet', () => {
  it('atividade dentro da janela: não está quieta', () => {
    expect(isQueueQuiet(1000, 1000 + QUEUE_QUIET_WINDOW_MS - 1)).toBe(false)
  })

  it('exatamente na janela: quieta (limite inclusivo)', () => {
    expect(isQueueQuiet(1000, 1000 + QUEUE_QUIET_WINDOW_MS)).toBe(true)
  })

  it('janela customizada é respeitada', () => {
    expect(isQueueQuiet(0, 5000, 10000)).toBe(false)
    expect(isQueueQuiet(0, 10000, 10000)).toBe(true)
  })
})

describe('registerDownloadedUpdate / getUpdateState', () => {
  it('estado inicial: nenhum update pronto', () => {
    expect(getUpdateState()).toEqual({ updateReady: false, version: null, downloadedAt: null })
  })

  it('após registrar: expõe versão e desde quando (para o /status e o painel)', () => {
    registerDownloadedUpdate('1.0.10', '2026-08-11T03:00:00.000Z')
    expect(getUpdateState()).toEqual({
      updateReady: true,
      version: '1.0.10',
      downloadedAt: '2026-08-11T03:00:00.000Z',
    })
  })
})

describe('maybeInstallOnSafeWindow (efeito)', () => {
  it('janela segura completa: dispara quitAndInstall silencioso + relaunch', async () => {
    registerDownloadedUpdate('1.0.10')
    vi.advanceTimersByTime(QUEUE_QUIET_WINDOW_MS)

    const decision = maybeInstallOnSafeWindow({ storeClosed: true, queueEmpty: true })

    expect(decision.install).toBe(true)
    await vi.waitFor(() => expect(quitAndInstall).toHaveBeenCalledWith(true, true))
  })

  it('loja aberta: não dispara, mesmo com update pronto e fila quieta', async () => {
    registerDownloadedUpdate('1.0.10')
    vi.advanceTimersByTime(QUEUE_QUIET_WINDOW_MS)

    const decision = maybeInstallOnSafeWindow({ storeClosed: false, queueEmpty: true })

    expect(decision.install).toBe(false)
    await vi.runAllTimersAsync()
    expect(quitAndInstall).not.toHaveBeenCalled()
  })

  it('sem update baixado: não dispara nem com a janela perfeita', async () => {
    vi.advanceTimersByTime(QUEUE_QUIET_WINDOW_MS)

    const decision = maybeInstallOnSafeWindow({ storeClosed: true, queueEmpty: true })

    expect(decision.install).toBe(false)
    await vi.runAllTimersAsync()
    expect(quitAndInstall).not.toHaveBeenCalled()
  })

  it('evento da fila dentro da janela de silêncio veta a instalação', () => {
    registerDownloadedUpdate('1.0.10')
    vi.advanceTimersByTime(QUEUE_QUIET_WINDOW_MS)
    // Simula a fila mexendo (ex.: catch-up entregou uma comanda que está
    // imprimindo AGORA — fora da fila, mas com papel saindo).
    queueEvents.emit('queueUpdate', { length: 0 })

    const decision = maybeInstallOnSafeWindow({ storeClosed: true, queueEmpty: true })

    expect(decision.install).toBe(false)
    expect(decision.reason).toMatch(/atividade/)
  })

  it('a janela de silêncio reabre depois que a fila para de mexer', async () => {
    registerDownloadedUpdate('1.0.10')
    queueEvents.emit('jobDone', { jobId: 'x', status: 'printed' })
    vi.advanceTimersByTime(QUEUE_QUIET_WINDOW_MS)

    const decision = maybeInstallOnSafeWindow({ storeClosed: true, queueEmpty: true })

    expect(decision.install).toBe(true)
    // Aguarda o efeito assíncrono terminar DENTRO deste teste — senão a
    // chamada de quitAndInstall vaza pro teste seguinte.
    await vi.waitFor(() => expect(quitAndInstall).toHaveBeenCalled())
  })
})

describe('installNow', () => {
  it('sem update baixado: recusa sem tocar o quitAndInstall', async () => {
    const result = await installNow()
    expect(result).toEqual({ ok: false, error: 'Nenhuma atualização baixada' })
    expect(quitAndInstall).not.toHaveBeenCalled()
  })

  it('com update baixado: instala em silêncio e religa o app', async () => {
    registerDownloadedUpdate('1.0.10')
    const result = await installNow()
    expect(result).toEqual({ ok: true, version: '1.0.10' })
    expect(quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
  })

  it('disparo duplo: a segunda chamada é travada (app já está encerrando)', async () => {
    registerDownloadedUpdate('1.0.10')
    await installNow()
    const second = await installNow()
    expect(second).toEqual({ ok: false, error: 'Instalação já iniciada' })
    expect(quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('quitAndInstall lançando: devolve erro e LIBERA a trava pra próxima janela', async () => {
    registerDownloadedUpdate('1.0.10')
    quitAndInstall.mockImplementationOnce(() => {
      throw new Error('spawn EPERM')
    })

    const failed = await installNow()
    expect(failed.ok).toBe(false)

    // A trava não pode ficar presa: a próxima janela segura deve funcionar.
    const retried = await installNow()
    expect(retried.ok).toBe(true)
  })
})
