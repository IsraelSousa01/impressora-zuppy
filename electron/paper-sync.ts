/**
 * electron/paper-sync.ts
 * Papel da impressora escolhido NO PAINEL do Zuppy (1.5.1).
 *
 * Até a 1.5.0 o papel (`paper_size`) só mudava pelo computador da loja
 * (`POST /configure`, chamado pelo Gestor aberto naquela máquina). Uma loja que
 * trocou de impressora e ficou com o papel errado gravado aqui só se resolvia
 * com alguém no computador dela. Agora o servidor manda, no poll, o papel que
 * o dono escolheu no painel (inclusive em sessão de suporte):
 *
 *   printer_paper_size: { value: "58mm" | "80mm", set_at: "<ISO 8601>" }
 *
 * Contrato (servidor: zuppy-food `app/api/printer/jobs/route.ts`):
 *  - campo aditivo e opcional; ausente = nada muda (servidor antigo, loja sem
 *    escolha no painel, impressora nomeada, resposta fora do carimbo);
 *  - `set_at` é o instante da escolha no painel, no relógio do SERVIDOR.
 *
 * Regra do app: cada escolha do painel é aplicada UMA vez. O app guarda o
 * último `set_at` que já viu (`paper_size_panel_set_at`) e só age quando chega
 * um mais novo. Assim:
 *  - uma troca feita depois no computador da loja continua valendo até a
 *    próxima escolha no painel (ninguém fica revertendo o outro a cada poll);
 *  - só se comparam horários do servidor entre si: relógio errado no
 *    computador da loja não muda a decisão.
 */

import type { AppConfig } from './store'

export type PaperSize = '80mm' | '58mm'

/** Papel escolhido no painel, como o servidor o manda. */
export interface PanelPaperSize {
  value: PaperSize
  /** `set_at` original (o app o guarda tal como veio, para comparar com o próximo). */
  setAt: string
  setAtMs: number
}

export type PanelPaperDecision =
  | { action: 'none'; reason: string }
  /** O papel já é esse: só registra que esta escolha do painel foi vista. */
  | { action: 'record'; setAt: string }
  /** Troca o papel desta estação. */
  | { action: 'apply'; value: PaperSize; setAt: string }

/** `printer_paper_size` da resposta do poll, ou `null` se ausente ou inválido. */
export function parsePanelPaperSize(raw: unknown): PanelPaperSize | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { value, set_at } = raw as { value?: unknown; set_at?: unknown }
  if (value !== '80mm' && value !== '58mm') return null
  if (typeof set_at !== 'string' || set_at.length === 0 || set_at.length > 64) return null
  const setAtMs = Date.parse(set_at)
  if (!Number.isFinite(setAtMs)) return null
  return { value, setAt: set_at, setAtMs }
}

/**
 * O que fazer com a escolha do painel. Papel local ausente vale 80mm (o mesmo
 * default de `paperWidthMm()` em printer.ts).
 */
export function decidePanelPaperSize(input: {
  field: PanelPaperSize | null
  currentPaperSize: PaperSize | undefined
  lastAppliedSetAt: string | undefined
}): PanelPaperDecision {
  const { field, lastAppliedSetAt } = input
  if (!field) return { action: 'none', reason: 'sem escolha do painel na resposta' }

  if (lastAppliedSetAt !== undefined) {
    if (field.setAt === lastAppliedSetAt) return { action: 'none', reason: 'escolha do painel já vista' }
    const lastMs = Date.parse(lastAppliedSetAt)
    if (Number.isFinite(lastMs) && field.setAtMs <= lastMs) {
      return { action: 'none', reason: 'escolha do painel mais antiga que a já vista' }
    }
  }

  const current = input.currentPaperSize ?? '80mm'
  if (current === field.value) return { action: 'record', setAt: field.setAt }
  return { action: 'apply', value: field.value, setAt: field.setAt }
}

/**
 * Patch do store para uma decisão. Ao trocar o papel, a calibração local de
 * colunas (`columns`) é descartada: ela foi medida na impressora/papel anterior
 * e, enviada no handshake, faria o servidor seguir montando na largura velha.
 */
export function panelPaperPatch(decision: PanelPaperDecision): Partial<AppConfig> | null {
  if (decision.action === 'record') return { paper_size_panel_set_at: decision.setAt }
  if (decision.action === 'apply') {
    return { paper_size: decision.value, paper_size_panel_set_at: decision.setAt, columns: undefined }
  }
  return null
}
