/**
 * electron/text-layout.ts
 * Layout puro (sem I/O, sem instância de impressora) para montar linhas
 * ESC/POS que nunca excedem a largura física do papel.
 *
 * Por que isto existe: `node-thermal-printer`'s `tableCustom()` calcula a
 * largura de cada coluna como `this.config.width * obj.width` SEM
 * arredondar, e preenche o preenchimento com
 * `for (let j = 0; j < spaces; j++)` onde `spaces` é fracionário — o que
 * sempre arredonda PRA CIMA. Com o split 0.65/0.35 usado nas comandas:
 *   - 32 colunas (58mm): 20,8 vira 21 + 11,2 vira 12 → 33 caracteres
 *   - 48 colunas (80mm): 31,2 vira 32 + 16,8 vira 17 → 49 caracteres
 * Em ambos os casos a linha estoura a largura física e a impressora quebra
 * no meio — inclusive no meio de um valor monetário (ex.: "R$ 16,0" numa
 * linha e "0" na seguinte). `tableCustom` também trunca texto que não cabe
 * via `.substring()`, descartando caracteres.
 *
 * As funções abaixo usam só matemática inteira e nunca cortam o bloco da
 * direita (preço, código) no meio: se não cabe, ele desce inteiro para a
 * linha seguinte.
 */

/** Garante um inteiro >= 1 (largura de papel nunca é <= 0 na prática). */
function safeColumns(columns: number): number {
  const n = Math.floor(columns)
  return n > 0 ? n : 1
}

/**
 * Quebra um bloco de texto livre em linhas que nunca excedem `columns`
 * caracteres. Quebra por espaço (palavra inteira vai para a linha
 * seguinte quando não cabe); só parte uma palavra no meio quando ela
 * sozinha já é maior que `columns` — e mesmo assim nunca descarta
 * caracteres, só distribui em mais linhas.
 */
export function wrapText(text: string, columns: number): string[] {
  const width = safeColumns(columns)
  if (text.length === 0) return ['']

  // Tokeniza preservando TUDO: sequências de não-espaço e sequências de
  // espaço viram tokens separados, então nenhum caractere do texto original
  // é perdido ao remontar.
  const tokens = text.match(/\S+|\s+/g) ?? [text]
  const lines: string[] = []
  let current = ''

  for (const token of tokens) {
    if (current.length + token.length <= width) {
      current += token
      continue
    }

    const isWhitespace = /^\s+$/.test(token)
    if (isWhitespace) {
      // O espaço que não coube só empurraria uma linha em branco à toa no
      // início da próxima linha — quebra aqui e descarta esse espaço (não é
      // conteúdo, é separador).
      lines.push(current)
      current = ''
      continue
    }

    // Palavra não cabe no restante da linha atual: fecha a linha corrente
    // (se tiver algo) antes de decidir o que fazer com a palavra.
    if (current.length > 0) {
      lines.push(current)
      current = ''
    }

    if (token.length > width) {
      // Palavra gigante sem espaço: parte por caractere, width por width,
      // sem descartar nada. O resto vira o início da próxima linha.
      let rest = token
      while (rest.length > width) {
        lines.push(rest.slice(0, width))
        rest = rest.slice(width)
      }
      current = rest
    } else {
      current = token
    }
  }

  if (current.length > 0 || lines.length === 0) lines.push(current)
  return lines
}

/**
 * Monta um par esquerda/direita (ex.: "2x Pizza" / "R$ 32,00") dentro de
 * `columns` caracteres. `right` é um bloco indivisível (dinheiro, código):
 * NUNCA é cortado. Quando as duas partes não cabem juntas na mesma linha,
 * `left` é quebrado por palavra (via wrapText) e `right` desce inteiro,
 * sozinho, alinhado à direita na linha seguinte.
 *
 * Quando cabem juntos: `left` + espaços + `right`, somando EXATAMENTE
 * `columns` caracteres.
 */
export function layoutTwoColumns(
  left: string,
  right: string,
  columns: number,
): string[] {
  const width = safeColumns(columns)
  const leftLines = wrapText(left, width)
  const lastLeftLine = leftLines[leftLines.length - 1] ?? ''

  const fitsTogether = lastLeftLine.length + 1 + right.length <= width

  if (fitsTogether) {
    const gap = width - lastLeftLine.length - right.length
    const merged = `${lastLeftLine}${' '.repeat(gap)}${right}`
    return [...leftLines.slice(0, -1), merged]
  }

  // Não cabem juntos: right desce sozinho, alinhado à direita. padStart não
  // corta nada — se right já for >= width, sai do jeito que é (inteiro).
  const rightLine = right.padStart(width, ' ')
  return [...leftLines, rightLine]
}

/**
 * Colunas efetivas de um cabeçalho impresso em tamanho dobrado
 * (`printer.setTextSize(1, 1)`), que ocupa o DOBRO da largura por
 * caractere. Nenhum código descontava essa metade — foi assim que
 * "Pastel dos Amigos" (17 chars) saiu quebrado em "Pastel dos Amig" +
 * "os" numa impressora de 32 colunas normais (16 colunas em tamanho
 * dobrado).
 */
export function doubleWidthColumns(columns: number): number {
  return safeColumns(Math.floor(safeColumns(columns) / 2))
}
