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
 *
 * Roda no processo principal, que imprime pedidos: tem que ser LINEAR no
 * tamanho da linha. Por isso (a) a linha é cortada ANTES de filtrar e (b) as
 * regexes só capturam uma "palavra" curta e limitada, e a decisão "essa chave é
 * sensível?" é uma função — nada de quantificadores aninhados.
 */

export const MAX_LOG_LINE_LENGTH = 2000

const REDACTED = '[redigido]'

/** Trechos que tornam uma chave sensível (comparação em minúsculas, sem acento). */
const SENSITIVE_FRAGMENTS = [
  'token', 'secret', 'password', 'passwd', 'senha', 'authorization', 'apikey', 'api_key',
  'api-key', 'anon_key', 'cookie',
  'customer', 'cliente', 'recipient', 'destinatario',
  'phone', 'telefone', 'celular', 'whatsapp', 'fone',
  'address', 'endereco', 'street', 'logradouro', 'bairro', 'neighborhood', 'complement',
  'cep', 'zip', 'postal',
  'email', 'e-mail', 'mail',
  'cpf', 'cnpj', 'documento', 'document',
] as const

/** Chaves que são sensíveis só quando são EXATAMENTE isto (evita `username_len`, `filename`...). */
const SENSITIVE_EXACT = new Set(['name', 'nome', 'sobrenome', 'rua', 'rg', 'cidade', 'city'])

/**
 * Chaves cujo valor o suporte PRECISA ler e que não identificam um cliente:
 * a impressora do Windows e a loja/destino do pareamento.
 */
const READABLE_EXACT = new Set([
  'printer_name', 'printername', 'printer', 'tenant_name', 'destination_name',
  'display_name', 'profile', 'order_number', 'scope',
])

function isSensitiveKey(rawKey: string): boolean {
  const key = rawKey
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  if (READABLE_EXACT.has(key)) return false
  if (SENSITIVE_EXACT.has(key)) return true
  // `first_name`, `customerName`, `nome_cliente`: o último segmento decide o "name".
  const lastSegment = key.split(/[^a-z0-9]+/).pop() ?? ''
  if (lastSegment === 'name' || lastSegment === 'nome') return true
  return SENSITIVE_FRAGMENTS.some((fragment) => key.includes(fragment))
}

/** Uma palavra de chave: limitada, só o alfabeto de chaves. */
const KEY = '[A-Za-z_][A-Za-z0-9_.-]{0,63}'

/** "chave": "valor" (JSON), aspas simples ou duplas, valor string/número. */
const JSON_PAIR = new RegExp(
  `(["'])(${KEY})\\1\\s*:\\s*(?:"(?:[^"\\\\]|\\\\.){0,300}"|'(?:[^'\\\\]|\\\\.){0,300}'|-?[\\w.+-]{1,64})`,
  'g',
)

/** chave=valor solto (querystring, texto de erro). */
const EQ_PAIR = new RegExp(`(?<![\\w.-])(${KEY})=([^&\\s,;"']{1,200})`, 'g')

/** `chave: ` em texto livre. Só a chave é consumida: o valor é tratado à parte (redactColonValues). */
const COLON_KEY = new RegExp(`(?<![\\w.-])(${KEY})\\s*:\\s+`, 'g')
const COLON_VALUE_END = /[,;{}"'[\]]/
const COLON_VALUE_MAX = 80

/**
 * `cliente: Joao Silva, endereco: Rua X`. Varre chave a chave (e não par a par)
 * para que um prefixo inofensivo (`falhou: cliente: ...`) não engula a chave
 * sensível que vem logo depois.
 */
function redactColonValues(text: string): string {
  let result = ''
  let cursor = 0
  COLON_KEY.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = COLON_KEY.exec(text)) !== null) {
    const valueStart = match.index + match[0].length
    if (!isSensitiveKey(match[1])) continue

    const window = text.slice(valueStart, valueStart + COLON_VALUE_MAX)
    const endInWindow = window.search(COLON_VALUE_END)
    const valueEnd = valueStart + (endInWindow === -1 ? window.length : endInWindow)

    result += text.slice(cursor, valueStart) + REDACTED
    cursor = valueEnd
    COLON_KEY.lastIndex = valueEnd
  }
  return result + text.slice(cursor)
}

const BEARER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{1,2000}/gi
const JWT = /\beyJ[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{0,2000}/g
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g
/** 32+ caracteres base64/hex/url-safe sem hífen interno: token ou hash, nunca UUID (que tem hífens). */
const OPAQUE = /\b[A-Za-z0-9_+/=]{32,}\b/g
/** CEP com hífen. Sem hífen são 8 dígitos e indistinguíveis de número qualquer. */
const CEP = /(?<![\w-])\d{5}-\d{3}(?![\w-])/g
/** Telefone: dígitos com separadores comuns; só vale com 10+ dígitos de fato. */
const PHONE = /(?<![\w.:-])\+?\d[\d\s().-]{8,24}\d(?![\w:-])/g

function redactPhones(text: string): string {
  return text.replace(PHONE, (match) => {
    const digits = match.replace(/\D/g, '').length
    // Datas (2026-10-10 = 8 dígitos) e números de pedido/portas ficam de fora.
    return digits >= 10 && digits <= 15 ? REDACTED : match
  })
}

/** Corta em `MAX_LOG_LINE_LENGTH` sem deixar um pedaço de segredo na ponta. */
function clamp(line: string): string {
  if (line.length <= MAX_LOG_LINE_LENGTH) return line
  let cut = line.slice(0, MAX_LOG_LINE_LENGTH)
  const lastSpace = cut.lastIndexOf(' ')
  // A palavra partida ao meio pode ser metade de um token: descarta-a.
  if (lastSpace > MAX_LOG_LINE_LENGTH - 200) cut = cut.slice(0, lastSpace)
  return `${cut} [cortado]`
}

/** Linha única, sem segredo nem dado de cliente, com tamanho limitado. */
export function scrubLogLine(line: string): string {
  // Primeiro o corte: o filtro nunca vê mais que ~2 KB, qualquer que seja a entrada.
  let out = clamp(line.replace(/[\r\n]+/g, ' '))

  // JSON dentro de string JSON (`meta` string): desescapa um nível só para filtrar.
  out = out.replace(/\\(["'])/g, '$1')

  out = out.replace(BEARER, REDACTED)
  out = out.replace(JWT, REDACTED)
  out = out.replace(JSON_PAIR, (match, quote: string, key: string) =>
    isSensitiveKey(key) ? `${quote}${key}${quote}:"${REDACTED}"` : match,
  )
  out = out.replace(EQ_PAIR, (match, key: string) => (isSensitiveKey(key) ? `${key}=${REDACTED}` : match))
  out = redactColonValues(out)
  out = out.replace(EMAIL, REDACTED)
  out = out.replace(CEP, REDACTED)
  out = out.replace(OPAQUE, REDACTED)
  out = redactPhones(out)

  return out
}
