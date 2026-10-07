/**
 * electron/paper-sync.test.ts
 * Papel escolhido no painel (1.5.1): leitura do campo e decisão de aplicar.
 */
import { describe, it, expect } from 'vitest'
import { decidePanelPaperSize, panelPaperPatch, parsePanelPaperSize } from './paper-sync'

const T1 = '2026-10-08T12:00:00.000Z'
const T2 = '2026-10-08T12:05:00+00:00'

describe('parsePanelPaperSize', () => {
  it('campo válido', () => {
    expect(parsePanelPaperSize({ value: '80mm', set_at: T1 })).toEqual({ value: '80mm', setAt: T1, setAtMs: Date.parse(T1) })
    expect(parsePanelPaperSize({ value: '58mm', set_at: T2 })?.value).toBe('58mm')
  })

  it.each([
    ['ausente', undefined],
    ['null', null],
    ['string', '80mm'],
    ['array', []],
    ['papel desconhecido', { value: '76mm', set_at: T1 }],
    ['papel em número', { value: 80, set_at: T1 }],
    ['sem set_at', { value: '80mm' }],
    ['set_at inválido', { value: '80mm', set_at: 'ontem' }],
    ['set_at vazio', { value: '80mm', set_at: '' }],
  ])('%s: null', (_nome, raw) => {
    expect(parsePanelPaperSize(raw)).toBeNull()
  })
})

describe('decidePanelPaperSize', () => {
  const campo = (value: '80mm' | '58mm', setAt: string) => parsePanelPaperSize({ value, set_at: setAt })

  it('sem campo: nada', () => {
    expect(decidePanelPaperSize({ field: null, currentPaperSize: '58mm', lastAppliedSetAt: undefined }).action).toBe('none')
  })

  it('escolha nova e papel diferente: troca (o caso da loja que ficou com 58mm)', () => {
    expect(decidePanelPaperSize({ field: campo('80mm', T1), currentPaperSize: '58mm', lastAppliedSetAt: undefined })).toEqual({
      action: 'apply',
      value: '80mm',
      setAt: T1,
    })
  })

  it('escolha nova e o papel já é esse: só registra', () => {
    expect(decidePanelPaperSize({ field: campo('58mm', T1), currentPaperSize: '58mm', lastAppliedSetAt: undefined })).toEqual({
      action: 'record',
      setAt: T1,
    })
  })

  it('papel local ausente vale 80mm', () => {
    expect(decidePanelPaperSize({ field: campo('80mm', T1), currentPaperSize: undefined, lastAppliedSetAt: undefined }).action).toBe('record')
    expect(decidePanelPaperSize({ field: campo('58mm', T1), currentPaperSize: undefined, lastAppliedSetAt: undefined }).action).toBe('apply')
  })

  it('a mesma escolha já vista: nada, mesmo que alguém tenha trocado o papel na loja depois', () => {
    expect(decidePanelPaperSize({ field: campo('80mm', T1), currentPaperSize: '58mm', lastAppliedSetAt: T1 }).action).toBe('none')
  })

  it('escolha mais antiga que a já vista (resposta atrasada): nada', () => {
    expect(decidePanelPaperSize({ field: campo('58mm', T1), currentPaperSize: '80mm', lastAppliedSetAt: T2 }).action).toBe('none')
  })

  it('escolha mais nova depois de uma troca local: o painel vale de novo', () => {
    expect(decidePanelPaperSize({ field: campo('80mm', T2), currentPaperSize: '58mm', lastAppliedSetAt: T1 }).action).toBe('apply')
  })

  it('compara por instante, não por texto (formatos diferentes do mesmo instante)', () => {
    const mesmoInstante = '2026-10-08T09:00:00-03:00'
    expect(decidePanelPaperSize({ field: campo('58mm', mesmoInstante), currentPaperSize: '80mm', lastAppliedSetAt: T1 }).action).toBe('none')
  })
})

describe('panelPaperPatch', () => {
  it('apply: troca o papel, guarda a escolha e descarta a calibração da impressora anterior', () => {
    expect(panelPaperPatch({ action: 'apply', value: '80mm', setAt: T1 })).toEqual({
      paper_size: '80mm',
      paper_size_panel_set_at: T1,
      columns: undefined,
    })
  })

  it('record: só guarda a escolha', () => {
    expect(panelPaperPatch({ action: 'record', setAt: T1 })).toEqual({ paper_size_panel_set_at: T1 })
  })

  it('none: nada', () => {
    expect(panelPaperPatch({ action: 'none', reason: 'x' })).toBeNull()
  })
})
