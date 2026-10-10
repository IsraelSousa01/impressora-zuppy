/**
 * electron/log-scrub.test.ts
 *
 * O registro em arquivo sobrevive no disco da loja e é lido pelo diagnóstico do
 * suporte: NUNCA pode carregar token, nome, telefone ou endereço de cliente.
 * O scrub é a última barreira (os pontos de log já foram revisados um a um);
 * erro aqui é vazamento, então os testes usam o formato real das linhas.
 */
import { describe, it, expect } from 'vitest'
import { scrubLogLine, MAX_LOG_LINE_LENGTH } from './log-scrub'

describe('scrubLogLine — segredos', () => {
  it('Authorization: Bearer', () => {
    const out = scrubLogLine('[x] fetch falhou Authorization: Bearer abc.def-ghi_123456789')
    expect(out).not.toContain('abc.def')
    expect(out).toContain('[redigido]')
  })

  it('chaves JSON de token/senha, em qualquer caixa', () => {
    const out = scrubLogLine(
      'Auth API returned 500: {"device_token":"zd_live_9f8e7d6c5b4a","SESSION_TOKEN":"s3cr3t","ok":true}',
    )
    expect(out).not.toContain('zd_live_9f8e7d6c5b4a')
    expect(out).not.toContain('s3cr3t')
    expect(out).toContain('"ok":true')
  })

  it('key=value solto (querystring, mensagem de erro)', () => {
    const out = scrubLogLine('GET /x?device_token=abcdef123456&page=2 falhou')
    expect(out).not.toContain('abcdef123456')
    expect(out).toContain('page=2')
  })

  it('JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123DEF456'
    expect(scrubLogLine(`token ${jwt} recebido`)).not.toContain('eyJhbGci')
  })

  it('sequência longa opaca (token/hash) some; UUID de job continua legível', () => {
    const uuid = '89dea3b3-04af-4c2e-9d11-0a8adf09c63a'
    const out = scrubLogLine(`Job ${uuid} usou aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d`)
    expect(out).toContain(uuid)
    expect(out).not.toContain('aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d')
  })
})

describe('scrubLogLine — dado de cliente', () => {
  it('chaves JSON de nome, telefone, endereço, e-mail e documento', () => {
    const body =
      '{"customer_name":"Maria da Silva","customer_phone":"11987654321","address":"Rua das Flores, 100",' +
      '"email":"maria@example.com","cpf":"123.456.789-09","order_number":"123"}'
    const out = scrubLogLine(`Resposta inesperada: ${body}`)
    for (const leak of ['Maria', 'Silva', '11987654321', 'Flores', 'maria@example.com', '123.456.789-09']) {
      expect(out).not.toContain(leak)
    }
    expect(out).toContain('"order_number":"123"')
  })

  it('variantes pt-BR das chaves', () => {
    const out = scrubLogLine('{"nome_cliente":"João","telefone":"(11) 91234-5678","endereco":"Av. Brasil 5"}')
    for (const leak of ['João', '91234-5678', 'Av. Brasil']) expect(out).not.toContain(leak)
  })

  it('telefone e e-mail soltos no texto', () => {
    const out = scrubLogLine('falhou para +55 (11) 98765-4321 e fulano@loja.com.br')
    expect(out).not.toContain('98765-4321')
    expect(out).not.toContain('fulano@loja')
  })

  it('não confunde timestamp, porta e contagem com telefone', () => {
    const line = '[2026-10-10T05:25:45.665Z] [INFO] [HTTP] listening on 127.0.0.1:7847, 3 jobs, 1500ms'
    expect(scrubLogLine(line)).toBe(line)
  })
})

describe('scrubLogLine — forma da linha', () => {
  it('quebra de linha não forja uma linha nova de log', () => {
    const out = scrubLogLine('CORS blocked origin: https://evil.test\n[2026-01-01T00:00:00.000Z] [INFO] [X] falso')
    expect(out).not.toMatch(/[\r\n]/)
  })

  it('limita o tamanho de uma linha', () => {
    const out = scrubLogLine('a '.repeat(MAX_LOG_LINE_LENGTH))
    expect(out.length).toBeLessThanOrEqual(MAX_LOG_LINE_LENGTH + 20)
    expect(out.endsWith('[cortado]')).toBe(true)
  })

  it('texto limpo passa intacto', () => {
    const line = '[2026-10-10T05:25:45.665Z] [INFO] [PRINT] Job 89dea3b3-04af-4c2e-9d11-0a8adf09c63a → printed {"order":"1234"}'
    expect(scrubLogLine(line)).toBe(line)
  })
})
