/**
 * electron/destination.ts
 * A impressora NOMEADA que este app atende ("Cozinha", "Bar", "Balcão").
 *
 * O servidor passou a emitir um device_token por destino, e o
 * POST /api/printer/auth responde, de forma ADITIVA, com quem é o destino
 * daquele token. Token legado da loja continua vindo sem `destination` — e
 * nesse caso tudo segue como sempre foi (o nome da loja é a única identidade).
 *
 * Funções puras: o que chega do servidor é validado aqui antes de virar
 * config gravada ou texto na bandeja.
 */

/** Destino (impressora nomeada) ao qual este device_token pertence. */
export interface PrinterDestination {
  id: string
  /** Nome que o dono deu à impressora na tela do Zuppy: "Cozinha". */
  name: string
  /** Finalidade declarada no Zuppy (`kitchen`, `bar`…); pode não vir. */
  purpose: string | null
}

/** String não vazia depois de aparar — `id`/`name` em branco não identificam nada. */
function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Lê o `destination` da resposta do handshake. Campo opcional: ausente,
 * `null` ou malformado ⇒ `null`, que é o comportamento de hoje (sem destino).
 *
 * Valida em vez de confiar porque o valor é gravado no disco e depois exibido:
 * um `name` que não seja string viraria "[object Object]" na bandeja, e um
 * destino sem `id` não serve para nada.
 */
export function parsePrinterDestination(raw: unknown): PrinterDestination | null {
  if (raw === null || typeof raw !== 'object') return null

  const candidate = raw as Record<string, unknown>
  const id = readNonEmptyString(candidate.id)
  const name = readNonEmptyString(candidate.name)
  if (id === null || name === null) return null

  return { id, name, purpose: readNonEmptyString(candidate.purpose) }
}

/**
 * Como esta instância se chama para um humano:
 *
 *   "Cozinha — Podrão"  destino + loja (o caso novo, várias impressoras)
 *   "Cozinha"           destino sem nome de loja gravado
 *   "Podrão"            sem destino: exatamente o que se mostrava antes
 *   null                nada pareado ainda
 *
 * O nome do destino vem primeiro porque é ele que distingue DUAS instâncias na
 * mesma máquina — que é o problema que o dono tem na frente dele.
 */
export function formatDeviceLabel(cfg: {
  destination?: PrinterDestination | null
  tenant_name?: string | null
}): string | null {
  const destinationName = cfg.destination?.name ?? null
  const tenantName = readNonEmptyString(cfg.tenant_name)

  if (destinationName === null) return tenantName
  return tenantName === null ? destinationName : `${destinationName} — ${tenantName}`
}
