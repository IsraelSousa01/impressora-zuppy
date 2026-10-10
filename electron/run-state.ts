/**
 * electron/run-state.ts
 * Marcador de "esta execução do app terminou direito?".
 *
 * Contexto: nada dentro do processo reabre o app depois de uma queda dura
 * (kill pelo Gerenciador de Tarefas, falta de energia, crash nativo). As
 * defesas que existem são: o Windows reabre o app no próximo login (login item,
 * electron/main.ts → configureAutoStart) e o instalador/atualizador reabre
 * depois de atualizar (nsis `runAfterFinish`, `quitAndInstall`).
 * O que ESTE arquivo acrescenta é visibilidade: ao subir, o app sabe se a
 * execução anterior caiu e registra isso no log do suporte.
 *
 * Nunca lança: um disco cheio ou sem permissão não pode impedir o app de imprimir.
 */

import fs from 'node:fs'
import path from 'node:path'

const MARKER_FILE = 'running.json'

export interface PreviousRun {
  /** A execução anterior não chegou ao `before-quit`. */
  previousEndedUnexpectedly: boolean
  /** Epoch (ms) do início da execução anterior, quando legível. */
  previousStartedAt: number | null
}

/**
 * Chamado no boot: lê o marcador deixado pela execução anterior e grava o desta.
 * Marcador presente = a anterior não saiu pelo caminho limpo.
 */
export function markStarted(userDataDir: string, nowMs: number = Date.now()): PreviousRun {
  const file = path.join(userDataDir, MARKER_FILE)
  let result: PreviousRun = { previousEndedUnexpectedly: false, previousStartedAt: null }

  try {
    if (fs.existsSync(file)) {
      let startedAt: number | null = null
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { startedAt?: unknown }
        if (typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)) {
          startedAt = parsed.startedAt
        }
      } catch {
        // marcador ilegível (escrita interrompida): continua sendo uma queda
      }
      result = { previousEndedUnexpectedly: true, previousStartedAt: startedAt }
    }
  } catch {
    return result
  }

  try {
    fs.writeFileSync(file, JSON.stringify({ startedAt: nowMs }), 'utf8')
  } catch {
    // sem marcador a próxima execução apenas não saberá — não é motivo de falha
  }
  return result
}

/** Chamado no `before-quit`: apaga o marcador, a execução terminou direito. */
export function markCleanExit(userDataDir: string): void {
  try {
    fs.rmSync(path.join(userDataDir, MARKER_FILE), { force: true })
  } catch {
    // idem markStarted
  }
}

// ─── Reabrir depois de um erro inesperado ─────────────────────────────────────

const RELAUNCH_FILE = 'crash-relaunch.json'

/** No máximo 3 reaberturas por erro dentro de 10 min: além disso é laço, não conserto. */
export const CRASH_RELAUNCH_MAX = 3
export const CRASH_RELAUNCH_WINDOW_MS = 10 * 60_000

/**
 * Um erro inesperado do processo principal pode reabrir o app? Registra a
 * tentativa. Passou do teto na janela ⇒ `false` (o app encerra e o Windows o
 * reabre no próximo login): um erro que acontece no boot não pode virar um
 * laço de reaberturas consumindo a máquina da loja.
 */
export function allowCrashRelaunch(userDataDir: string, nowMs: number = Date.now()): boolean {
  const file = path.join(userDataDir, RELAUNCH_FILE)
  let recent: number[] = []

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (Array.isArray(parsed)) {
      recent = parsed.filter(
        (t): t is number => typeof t === 'number' && Number.isFinite(t) && nowMs - t < CRASH_RELAUNCH_WINDOW_MS,
      )
    }
  } catch {
    // sem histórico legível = sem reaberturas recentes
  }

  if (recent.length >= CRASH_RELAUNCH_MAX) return false

  try {
    fs.writeFileSync(file, JSON.stringify([...recent, nowMs]), 'utf8')
  } catch {
    // Sem como registrar a tentativa não dá para garantir o teto: não reabre.
    return false
  }
  return true
}
