/**
 * electron/text-layout.test.ts
 *
 * Cobre o bug comprovado por foto real: `tableCustom()` do
 * node-thermal-printer arredonda largura de coluna fracionária PRA CIMA
 * (spaces fracionário num `for (j < spaces; j++)`) e estoura a largura
 * física (32/48 colunas), partindo valores monetários no meio. Estes
 * testes garantem que o layout novo (matemática inteira, sem `tableCustom`)
 * nunca excede `columns` e nunca corta o bloco da direita.
 */
import { describe, it, expect } from 'vitest'
import { wrapText, layoutTwoColumns, doubleWidthColumns } from './text-layout'

describe('layoutTwoColumns', () => {
  it('linha exatamente na largura: junta numa única linha com o total exato de columns', () => {
    // 'TOTAL:' (6) + espaço (1) + 'R$ 100,00' (9) = 16 = columns
    const lines = layoutTwoColumns('TOTAL:', 'R$ 100,00', 16)
    expect(lines).toEqual(['TOTAL: R$ 100,00'])
    expect(lines[0]).toHaveLength(16)
  })

  it('linha 1 char acima da largura: quebra em duas linhas, right sozinho e alinhado à direita', () => {
    // Mesmo par do teste anterior, mas columns = 15 (1 a menos que os 16 necessários)
    const lines = layoutTwoColumns('TOTAL:', 'R$ 100,00', 15)
    expect(lines).toEqual(['TOTAL:', 'R$ 100,00'.padStart(15, ' ')])
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(15)
    // O valor nunca é cortado: aparece inteiro na última linha.
    expect(lines[lines.length - 1].endsWith('R$ 100,00')).toBe(true)
  })

  it('valor monetário nunca é partido ao meio quando left é longo (58mm, 32 colunas)', () => {
    const left = '3x Hamburguer Artesanal Especial da Casa com Bacon'
    const right = 'R$ 45,90'
    const lines = layoutTwoColumns(left, right, 32)

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(32)
    }
    // O valor aparece INTEIRO em alguma linha — nunca fatiado em duas.
    expect(lines.some((l) => l.endsWith(right))).toBe(true)
  })

  it('valor monetário nunca é partido ao meio quando left é longo (80mm, 48 colunas)', () => {
    const left = '2x Pizza Grande Meio a Meio Calabresa e Portuguesa'
    const right = 'R$ 129,80'
    const lines = layoutTwoColumns(left, right, 48)

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(48)
    }
    expect(lines.some((l) => l.endsWith(right))).toBe(true)
  })

  it('reproduz o caso real do bug: split 0.65/0.35 em 32 colunas não estoura mais', () => {
    // Antes (tableCustom com width:0.65/0.35): 20,8→21 + 11,2→12 = 33 chars.
    // Item pensado para ocupar quase toda a antiga "coluna esquerda" de 21.
    const lines = layoutTwoColumns('2x Combo Zuppy Duplo', 'R$ 16,00', 32)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(32)
    expect(lines.join('\n')).not.toMatch(/R\$ 16,0$/m)
    expect(lines.some((l) => l.endsWith('R$ 16,00'))).toBe(true)
  })

  it('acentuação: conta corretamente café/pão/açúcar na largura', () => {
    const lines = layoutTwoColumns('1x Pão de Açúcar Café', 'R$ 8,50', 32)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(32)
    expect(lines.some((l) => l.endsWith('R$ 8,50'))).toBe(true)
  })
})

describe('wrapText', () => {
  it('linha exatamente na largura: não quebra', () => {
    const text = '12345678901234567890' // 20 chars
    const lines = wrapText(text, 20)
    expect(lines).toEqual([text])
  })

  it('linha 1 char acima da largura: quebra em duas, sem descartar nada', () => {
    const text = '123456789012345678901' // 21 chars
    const lines = wrapText(text, 20)
    expect(lines).toEqual(['12345678901234567890', '1'])
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20)
    expect(lines.join('')).toBe(text)
  })

  it('quebra por palavra: prefere quebrar no espaço em vez de partir uma palavra', () => {
    const lines = wrapText('Rua das Flores 123 apto 45', 12)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12)
    // Nenhuma palavra foi partida no meio: cada palavra aparece inteira em
    // alguma linha.
    for (const word of ['Rua', 'das', 'Flores', '123', 'apto', '45']) {
      expect(lines.some((l) => l.includes(word))).toBe(true)
    }
  })

  it('palavra gigante sem espaço: parte por caractere sem descartar nenhum', () => {
    const giant = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS' // 35 chars, sem espaço
    const lines = wrapText(giant, 10)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10)
    expect(lines.join('')).toBe(giant)
    expect(lines.length).toBeGreaterThan(1)
  })

  it('acentuação: conta á/ç/õ como 1 caractere cada, não quebra à toa', () => {
    const text = 'Pão de Açúcar' // 13 chars
    const lines = wrapText(text, 13)
    expect(lines).toEqual([text])
  })

  it('texto vazio retorna uma linha vazia', () => {
    expect(wrapText('', 32)).toEqual([''])
  })
})

describe('doubleWidthColumns', () => {
  it('metade exata para larguras pares (32 e 48 colunas)', () => {
    expect(doubleWidthColumns(32)).toBe(16)
    expect(doubleWidthColumns(48)).toBe(24)
  })

  it('arredonda para baixo em larguras ímpares', () => {
    expect(doubleWidthColumns(33)).toBe(16)
  })

  it('nunca retorna menos que 1', () => {
    expect(doubleWidthColumns(1)).toBe(1)
    expect(doubleWidthColumns(0)).toBe(1)
  })

  it('reproduz o caso real: nome de loja de 17 chars quebra em 16 colunas (58mm)', () => {
    const columns = doubleWidthColumns(32) // 16
    const lines = wrapText('Pastel dos Amigos', columns) // 17 chars
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(16)
    expect(lines.length).toBeGreaterThan(1)
    // Nenhuma palavra foi partida no meio (o bug real partiu "Amigos" em "Amig"+"os").
    expect(lines.some((l) => l.includes('Amigos'))).toBe(true)
  })
})
