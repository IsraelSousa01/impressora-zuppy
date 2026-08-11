/**
 * electron/http-server.test.ts
 *
 * Cobre a barreira de entrada do POST /print-raw (validatePrintRawDocument):
 * o endpoint aceita bytes arbitrários vindos do navegador, então TUDO é
 * entrada não confiável — base64 estrito, teto de tamanho decodificado e
 * exigência do init ESC/POS (0x1B 0x40) antes de qualquer byte chegar à
 * impressora.
 *
 * `http-server.ts` importa `electron` (app.getVersion no /status) e, via
 * `./store`, o `electron-store` — ambos exigem rodar dentro do Electron.
 * Mocka-se os dois só pra permitir o import fora do Electron (mesmo padrão
 * de print-queue.test.ts); a função testada é pura e não toca nenhum deles.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
  },
}))

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

const { validatePrintRawDocument, PRINT_RAW_MAX_DECODED_BYTES } = await import(
  './http-server'
)

const ESC_POS_INIT = Buffer.from([0x1b, 0x40])

/** Documento ESC/POS mínimo e legítimo: init + texto. */
function validDocumentBase64(payload = 'CALIBRACAO 48 COLS\n'): string {
  return Buffer.concat([ESC_POS_INIT, Buffer.from(payload, 'ascii')]).toString('base64')
}

describe('validatePrintRawDocument', () => {
  it('ausente / não-string / vazio: rejeita pedindo o campo', () => {
    for (const input of [undefined, null, 123, {}, [], '']) {
      const result = validatePrintRawDocument(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/bytes_base64/)
    }
  })

  it('base64 com caracteres fora do alfabeto: rejeita antes de decodificar', () => {
    // Buffer.from é leniente e ignoraria o lixo em silêncio — a validação
    // estrita existe exatamente pra barrar isso.
    const result = validatePrintRawDocument('não é@base64!')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not valid base64/)
  })

  it('base64 com comprimento não múltiplo de 4: rejeita', () => {
    const result = validatePrintRawDocument('abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not valid base64/)
  })

  it('base64 válido mas sem o init ESC/POS: rejeita sem imprimir', () => {
    const semInit = Buffer.from('lixo arbitrario', 'ascii').toString('base64')
    const result = validatePrintRawDocument(semInit)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/0x1B 0x40/)
  })

  it('documento de 1 byte (só ESC, sem @): rejeita', () => {
    const result = validatePrintRawDocument(Buffer.from([0x1b]).toString('base64'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/0x1B 0x40/)
  })

  it('acima do teto de tamanho: rejeita citando o limite', () => {
    const gigante = Buffer.alloc(PRINT_RAW_MAX_DECODED_BYTES + 1, 0x20)
    ESC_POS_INIT.copy(gigante)
    const result = validatePrintRawDocument(gigante.toString('base64'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/too large/)
  })

  it('exatamente no teto: aceita (limite é inclusivo)', () => {
    const noLimite = Buffer.alloc(PRINT_RAW_MAX_DECODED_BYTES, 0x20)
    ESC_POS_INIT.copy(noLimite)
    const result = validatePrintRawDocument(noLimite.toString('base64'))
    expect(result.ok).toBe(true)
  })

  it('documento legítimo: aceita e devolve os bytes idênticos ao original', () => {
    const original = Buffer.concat([
      ESC_POS_INIT,
      Buffer.from('REGUA |----+----1----+----2|\n', 'ascii'),
    ])
    const result = validatePrintRawDocument(original.toString('base64'))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytes.equals(original)).toBe(true)
  })

  it('documento mínimo (só o init, 2 bytes): aceita', () => {
    const result = validatePrintRawDocument(ESC_POS_INIT.toString('base64'))
    expect(result.ok).toBe(true)
  })
})
