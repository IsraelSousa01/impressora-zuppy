/**
 * electron/sleep-guard.ts
 * Impede o Windows de suspender o computador enquanto a loja está aberta.
 *
 * Problema: o computador dorme depois do fechamento (ou no meio da tarde, sem
 * ninguém mexendo), a loja abre e a comanda não sai — o app dormiu junto.
 *
 * Regras:
 *  - segura SÓ com loja aberta e sessão ativa (`shouldKeepAwake`);
 *  - usa `prevent-app-suspension`: o sistema não suspende, mas a TELA continua
 *    apagando normalmente. Consumo: o de um computador ligado e ocioso (sem
 *    CPU extra, sem processo novo); em notebook na bateria a carga dura menos
 *    com a loja aberta. Loja fechada, nada é segurado;
 *  - o bloqueio expira sozinho se os sinais pararem (`SLEEP_GUARD_STALE_MS`):
 *    o app nunca prende o computador por causa de um sinal velho.
 *
 * O sinal vem do polling (evento `poll-ok` de electron/realtime.ts). A decisão
 * e o controle são puros e testáveis; quem fala com o Electron é o main.
 */

export interface SleepSignals {
  hasSession: boolean
  storeClosed: boolean
}

/** Sem sinal por este tempo, solta. O poll mais lento é 60 s; 5 min dá folga a um backoff. */
export const SLEEP_GUARD_STALE_MS = 5 * 60_000

export interface SleepBlockerApi {
  start(): number
  stop(id: number): void
}

export function shouldKeepAwake(signals: SleepSignals): boolean {
  return signals.hasSession && !signals.storeClosed
}

export function createSleepGuard(api: SleepBlockerApi) {
  let blockerId: number | null = null
  let staleTimer: ReturnType<typeof setTimeout> | null = null

  function clearStale(): void {
    if (staleTimer !== null) {
      clearTimeout(staleTimer)
      staleTimer = null
    }
  }

  function release(): void {
    clearStale()
    if (blockerId === null) return
    const id = blockerId
    blockerId = null
    try {
      api.stop(id)
    } catch {
      // soltar nunca lança: o id some do nosso lado de qualquer forma
    }
  }

  function update(signals: SleepSignals): void {
    if (!shouldKeepAwake(signals)) {
      release()
      return
    }

    if (blockerId === null) {
      try {
        blockerId = api.start()
      } catch {
        // Não conseguir segurar o sono não pode afetar a impressão.
        return
      }
    }

    clearStale()
    staleTimer = setTimeout(release, SLEEP_GUARD_STALE_MS)
  }

  return {
    update,
    release,
    isActive: (): boolean => blockerId !== null,
  }
}
