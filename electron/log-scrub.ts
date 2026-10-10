/**
 * electron/log-scrub.ts
 * Última barreira antes de uma linha de log ir para o ARQUIVO do disco da loja
 * (e, de lá, para o diagnóstico do suporte).
 *
 * A defesa principal é não logar dado sensível (todos os pontos de log foram
 * revisados e só carregam ids, número do pedido, nome da impressora e da loja).
 * Este filtro existe porque mensagens de erro ecoam corpos de resposta e
 * exceções de bibliotecas, onde o conteúdo não é nosso: um 500 do servidor com
 * o JSON do pedido, uma URL com querystring. Redigir a mais é barato; vazar
 * nome, telefone, endereço de cliente ou token não é.
 */

export const MAX_LOG_LINE_LENGTH = 2000

const REDACTED = '[redigido]'

/**
 * Chaves cujo VALOR nunca vai para o arquivo. Casa por trecho, sem caixa:
 * `customer_name`, `nome_cliente`, `deliveryAddress`, `SESSION_TOKEN`...
 * `order_number` e `printer_name` (nome da impressora) NÃO entram.
 */
const SENSITIVE_KEY =
  '(?:[a-z_.-]*(?:token|secret|password|senha|authorization|apikey|api_key|anon_key|cookie)[a-z_.-]*' +
  '|[a-z_.-]*(?:customer|cliente|client_name|recipient|destinatario)[a-z_.-]*' +
  '|(?:full_|first_|last_|user_|buyer_|contact_)?name|nome|sobrenome' +
  '|[a-z_.-]*(?:phone|telefone|celular|whatsapp|fone)[a-z_.-]*' +
  '|[a-z_.-]*(?:address|endereco|endereço|street|rua|logradouro|bairro|neighborhood|complement|complemento|cep|zip|postal)[a-z_.-]*' +
  '|[a-z_.-]*(?:e-?mail)[a-z_.-]*' +
  '|cpf|cnpj|document|documento|rg)'

/** "chave": "valor" (JSON), com aspas simples ou duplas, valor string/número. */
const JSON_PAIR = new RegExp(
  `(["'])(${SENSITIVE_KEY})\\1\\s*:\\s*(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|-?[\\w.+-]+)`,
  'gi',
)

/** chave=valor solto (querystring, texto de erro). */
const EQ_PAIR = new RegExp(`\\b(${SENSITIVE_KEY})=([^&\\s,;"']+)`, 'gi')

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** 32+ caracteres base64/hex/url-safe sem hífen interno: token ou hash, nunca UUID (que tem hífens). */
const OPAQUE = /\b[A-Za-z0-9_+/=]{32,}\b/g
/** Telefone: dígitos com separadores comuns; só vale com 10+ dígitos de fato. */
const PHONE = /(?<![\w.:])\+?\d[\d\s().-]{8,}\d(?![\w:])/g

function redactPhones(text: string): string {
  return text.replace(PHONE, (match) => {
    const digits = match.replace(/\D/g, '').length
    // Datas (2026-10-10 = 8 dígitos) e números de pedido/portas ficam de fora.
    return digits >= 10 && digits <= 15 ? REDACTED : match
  })
}

/** Linha única, sem segredo nem dado de cliente, com tamanho limitado. */
export function scrubLogLine(line: string): string {
  let out = line.replace(/[\r\n]+/g, ' ')

  out = out.replace(BEARER, `Bearer ${REDACTED}`)
  out = out.replace(JWT, REDACTED)
  out = out.replace(JSON_PAIR, (_m, quote: string, key: string) => `${quote}${key}${quote}:"${REDACTED}"`)
  out = out.replace(EQ_PAIR, (_m, key: string) => `${key}=${REDACTED}`)
  out = out.replace(EMAIL, REDACTED)
  out = out.replace(OPAQUE, REDACTED)
  out = redactPhones(out)

  if (out.length > MAX_LOG_LINE_LENGTH) {
    out = `${out.slice(0, MAX_LOG_LINE_LENGTH)} [cortado]`
  }
  return out
}
