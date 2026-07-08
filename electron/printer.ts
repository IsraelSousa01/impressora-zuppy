/**
 * electron/printer.ts
 * ESC/POS printing via node-thermal-printer.
 *
 * Exposes:
 *  - listPrinters()        → available Windows printer names
 *  - testPrint()           → prints a simple test page
 *  - printOrder()          → prints kitchen + operational tickets for an order
 *  - buildKitchenTicketBytes()    → ESC/POS bytes for kitchen (no prices)
 *  - buildOperationalTicketBytes() → ESC/POS bytes for full ticket with prices
 */

import {
  ThermalPrinter,
  PrinterTypes,
  CharacterSet,
  BreakLine,
} from 'node-thermal-printer'
import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLogger } from './logger'
import { getConfig } from './store'
import { ZUPPY_APP_URL } from './config'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
const log = createLogger('PRINTER')

/**
 * Impressão RAW no Windows SEM módulo nativo.
 *
 * O node-thermal-printer, pra falar com a impressora do Windows, exige o módulo
 * nativo `@thiagoelg/node-printer`, que precisa compilar com Visual Studio Build
 * Tools — a máquina da loja não tem. Então montamos a comanda com o
 * node-thermal-printer (getBuffer) e mandamos os bytes ESC/POS pro spooler do
 * Windows via winspool.drv, chamado de dentro de um PowerShell (P/Invoke C#).
 *
 * O script vai em base64 pra não sofrer com escaping (here-string + aspas).
 */
const RAW_PRINT_PS1_B64 =
  'cGFyYW0oCiAgW1BhcmFtZXRlcihNYW5kYXRvcnk9JHRydWUpXVtzdHJpbmddJFByaW50ZXJOYW1lLAogIFtQYXJhbWV0ZXIoTWFuZGF0b3J5PSR0cnVlKV1bc3RyaW5nXSREYXRhRmlsZQopCiRFcnJvckFjdGlvblByZWZlcmVuY2UgPSAnU3RvcCcKCkFkZC1UeXBlIC1UeXBlRGVmaW5pdGlvbiBAJwp1c2luZyBTeXN0ZW07CnVzaW5nIFN5c3RlbS5SdW50aW1lLkludGVyb3BTZXJ2aWNlczsKcHVibGljIGNsYXNzIFp1cHB5UmF3UHJpbnRlciB7CiAgW1N0cnVjdExheW91dChMYXlvdXRLaW5kLlNlcXVlbnRpYWwsIENoYXJTZXQ9Q2hhclNldC5Vbmljb2RlKV0KICBwdWJsaWMgc3RydWN0IERPQ0lORk8gewogICAgW01hcnNoYWxBcyhVbm1hbmFnZWRUeXBlLkxQV1N0cildIHB1YmxpYyBzdHJpbmcgcERvY05hbWU7CiAgICBbTWFyc2hhbEFzKFVubWFuYWdlZFR5cGUuTFBXU3RyKV0gcHVibGljIHN0cmluZyBwT3V0cHV0RmlsZTsKICAgIFtNYXJzaGFsQXMoVW5tYW5hZ2VkVHlwZS5MUFdTdHIpXSBwdWJsaWMgc3RyaW5nIHBEYXRhVHlwZTsKICB9CiAgW0RsbEltcG9ydCgid2luc3Bvb2wuZHJ2IiwgQ2hhclNldD1DaGFyU2V0LlVuaWNvZGUsIFNldExhc3RFcnJvcj10cnVlKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBPcGVuUHJpbnRlcihzdHJpbmcgc3JjLCBvdXQgSW50UHRyIGhQcmludGVyLCBJbnRQdHIgcGQpOwogIFtEbGxJbXBvcnQoIndpbnNwb29sLmRydiIsIFNldExhc3RFcnJvcj10cnVlKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBDbG9zZVByaW50ZXIoSW50UHRyIGhQcmludGVyKTsKICBbRGxsSW1wb3J0KCJ3aW5zcG9vbC5kcnYiLCBDaGFyU2V0PUNoYXJTZXQuVW5pY29kZSwgU2V0TGFzdEVycm9yPXRydWUpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBib29sIFN0YXJ0RG9jUHJpbnRlcihJbnRQdHIgaFByaW50ZXIsIGludCBsZXZlbCwgcmVmIERPQ0lORk8gZGkpOwogIFtEbGxJbXBvcnQoIndpbnNwb29sLmRydiIsIFNldExhc3RFcnJvcj10cnVlKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBFbmREb2NQcmludGVyKEludFB0ciBoUHJpbnRlcik7CiAgW0RsbEltcG9ydCgid2luc3Bvb2wuZHJ2IiwgU2V0TGFzdEVycm9yPXRydWUpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBib29sIFN0YXJ0UGFnZVByaW50ZXIoSW50UHRyIGhQcmludGVyKTsKICBbRGxsSW1wb3J0KCJ3aW5zcG9vbC5kcnYiLCBTZXRMYXN0RXJyb3I9dHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgRW5kUGFnZVByaW50ZXIoSW50UHRyIGhQcmludGVyKTsKICBbRGxsSW1wb3J0KCJ3aW5zcG9vbC5kcnYiLCBTZXRMYXN0RXJyb3I9dHJ1ZSldIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgV3JpdGVQcmludGVyKEludFB0ciBoUHJpbnRlciwgYnl0ZVtdIHBCeXRlcywgaW50IGR3Q291bnQsIG91dCBpbnQgZHdXcml0dGVuKTsKICBwdWJsaWMgc3RhdGljIHZvaWQgU2VuZChzdHJpbmcgcHJpbnRlciwgYnl0ZVtdIGJ5dGVzKSB7CiAgICBJbnRQdHIgaDsKICAgIGlmICghT3BlblByaW50ZXIocHJpbnRlciwgb3V0IGgsIEludFB0ci5aZXJvKSkgdGhyb3cgbmV3IEV4Y2VwdGlvbigiT3BlblByaW50ZXIgZmFsaG91IChlcnI9IiArIE1hcnNoYWwuR2V0TGFzdFdpbjMyRXJyb3IoKSArICIpIik7CiAgICB0cnkgewogICAgICBET0NJTkZPIGRpID0gbmV3IERPQ0lORk8oKTsgZGkucERvY05hbWUgPSAiWnVwcHkgQ29tYW5kYSI7IGRpLnBEYXRhVHlwZSA9ICJSQVciOwogICAgICBpZiAoIVN0YXJ0RG9jUHJpbnRlcihoLCAxLCByZWYgZGkpKSB0aHJvdyBuZXcgRXhjZXB0aW9uKCJTdGFydERvY1ByaW50ZXIgZmFsaG91IGVycj0iICsgTWFyc2hhbC5HZXRMYXN0V2luMzJFcnJvcigpKTsKICAgICAgdHJ5IHsKICAgICAgICBTdGFydFBhZ2VQcmludGVyKGgpOwogICAgICAgIGludCB3cml0dGVuOwogICAgICAgIGlmICghV3JpdGVQcmludGVyKGgsIGJ5dGVzLCBieXRlcy5MZW5ndGgsIG91dCB3cml0dGVuKSkgdGhyb3cgbmV3IEV4Y2VwdGlvbigiV3JpdGVQcmludGVyIGZhbGhvdSBlcnI9IiArIE1hcnNoYWwuR2V0TGFzdFdpbjMyRXJyb3IoKSk7CiAgICAgICAgRW5kUGFnZVByaW50ZXIoaCk7CiAgICAgIH0gZmluYWxseSB7IEVuZERvY1ByaW50ZXIoaCk7IH0KICAgIH0gZmluYWxseSB7IENsb3NlUHJpbnRlcihoKTsgfQogIH0KfQonQAoKJGJ5dGVzID0gW1N5c3RlbS5JTy5GaWxlXTo6UmVhZEFsbEJ5dGVzKCREYXRhRmlsZSkKW1p1cHB5UmF3UHJpbnRlcl06OlNlbmQoJFByaW50ZXJOYW1lLCAkYnl0ZXMpCldyaXRlLU91dHB1dCAoIk9LOiAiICsgJGJ5dGVzLkxlbmd0aCArICIgYnl0ZXMgLT4gJyIgKyAkUHJpbnRlck5hbWUgKyAiJyIpCg=='

/**
 * Manda o buffer ESC/POS pra impressora do Windows via spooler RAW.
 * Escreve o script + os bytes em arquivos temporários e chama o powershell.
 */
async function sendRawToWindowsPrinter(
  printerName: string,
  data: Buffer,
): Promise<void> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const binFile = join(tmpdir(), `zuppy-print-${stamp}.bin`)
  const ps1File = join(tmpdir(), `zuppy-rawprint-${stamp}.ps1`)
  try {
    await writeFile(binFile, data)
    await writeFile(ps1File, Buffer.from(RAW_PRINT_PS1_B64, 'base64'))
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ps1File,
        '-PrinterName',
        printerName,
        '-DataFile',
        binFile,
      ],
      { timeout: 20000 },
    )
  } finally {
    await unlink(binFile).catch(() => {})
    await unlink(ps1File).catch(() => {})
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrderItem {
  product_name: string
  half_product_name: string | null
  quantity: number
  subtotal: number
  addons: Array<{ name: string; price: number }> | null
  notes: string | null
}

export interface OrderData {
  id: string
  order_number: string | number
  status: string
  customer_name: string | null
  customer_phone: string | null
  customer_address: string | null
  customer_reference: string | null
  customer_lat: number | null
  customer_lng: number | null
  pickup_code: string | null
  payment_method: string | null
  subtotal: number
  discount: number
  total: number
  delivery_fee: number
  notes: string | null
  change_for: number | null
  created_at: string
  estimated_delivery_minutes: number | null
  order_items: OrderItem[]
}

/**
 * Comanda já renderizada pelo servidor (motor lib/comanda, M1 Parte 2/3).
 * O app só decodifica e imprime — não monta nada.
 */
export interface RenderedComanda {
  template: string
  bytes_base64: string
  copies: number
  render_hash?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the configured paper width in mm as a number */
function paperWidthMm(): 80 | 58 {
  const cfg = getConfig()
  return cfg.paper_size === '58mm' ? 58 : 80
}

/**
 * Cria um ThermalPrinter só pra MONTAR o buffer ESC/POS (getBuffer). A
 * interface `tcp://` é dummy e nunca é usada — nunca chamamos execute(); a
 * impressão real vai pelo spooler RAW do Windows (sendRawToWindowsPrinter).
 * Assim não dependemos do módulo nativo do node-thermal-printer.
 */
function createPrinter(): ThermalPrinter {
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: 'tcp://localhost:9100',
    characterSet: CharacterSet.PC858_EURO,
    breakLine: BreakLine.WORD,
    lineCharacter: '-',
    width: paperWidthMm() === 58 ? 32 : 48,
    removeSpecialCharacters: false,
  })
}

/** Formats a number as BRL currency string */
function brl(value: number): string {
  return `R$ ${value.toFixed(2).replace('.', ',')}`
}

/** Formats an ISO date string as DD/MM/YYYY HH:mm */
function formatDate(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Returns the payment method label in Portuguese */
function paymentLabel(method: string | null): string {
  const map: Record<string, string> = {
    credit_card: 'Cartão de Crédito',
    debit_card: 'Cartão de Débito',
    cash: 'Dinheiro',
    pix: 'PIX',
    voucher: 'Vale-Refeição',
  }
  return method ? (map[method] ?? method) : 'Não informado'
}

/**
 * Monta o link de rota (/nav) pro QR — curto DE PROPÓSITO (só as coordenadas,
 * ou o endereço se não houver GPS) pra o QR ficar compacto e fácil de
 * escanear. Só faz sentido em entrega (retirada não tem rota).
 */
function buildNavUrl(order: OrderData): string | null {
  if (order.pickup_code) return null
  const hasCoords = order.customer_lat != null && order.customer_lng != null
  const navDest = hasCoords
    ? `${order.customer_lat},${order.customer_lng}`
    : (order.customer_address ?? '')
  if (!navDest) return null
  return `${ZUPPY_APP_URL.replace(/\/+$/, '')}/nav?to=${encodeURIComponent(navDest)}`
}

// ─── ESC/POS Ticket Builders ──────────────────────────────────────────────────

/**
 * Builds ESC/POS bytes for the **kitchen ticket** (no prices, for the kitchen).
 */
export async function buildKitchenTicketBytes(
  printer: ThermalPrinter,
  order: OrderData,
): Promise<void> {
  printer.alignCenter()
  printer.bold(true)
  printer.setTextSize(1, 1)
  printer.println('*** COZINHA ***')
  printer.setTextNormal()
  printer.bold(false)
  printer.drawLine()

  printer.bold(true)
  printer.println(`PEDIDO #${order.order_number}`)
  printer.bold(false)
  printer.println(formatDate(order.created_at))
  printer.drawLine()

  // Items
  printer.alignLeft()
  for (const item of order.order_items) {
    printer.bold(true)
    const name = item.half_product_name
      ? `${item.product_name} / ${item.half_product_name}`
      : item.product_name
    printer.println(`${item.quantity}x ${name}`)
    printer.bold(false)

    // Add-ons
    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        printer.println(`  + ${addon.name}`)
      }
    }

    // Item notes
    if (item.notes) {
      // bold() no lugar de italic(): italic() nao existe nesta versao do
      // node-thermal-printer (crashava "printer.italic is not a function" em obs).
      printer.bold(true)
      printer.println(`  Obs: ${item.notes}`)
      printer.bold(false)
    }
  }

  printer.drawLine()

  // General notes
  if (order.notes) {
    printer.bold(true)
    printer.println('OBSERVAÇÕES:')
    printer.bold(false)
    printer.println(order.notes)
    printer.drawLine()
  }

  // Pickup vs Delivery
  if (order.pickup_code) {
    printer.alignCenter()
    printer.bold(true)
    printer.setTextSize(1, 1)
    printer.println(`RETIRADA: ${order.pickup_code}`)
    printer.setTextNormal()
    printer.bold(false)
  } else if (order.customer_address) {
    printer.alignLeft()
    printer.bold(true)
    printer.println('ENTREGA:')
    printer.bold(false)
    printer.println(order.customer_address)
    if (order.customer_reference) {
      printer.println(`Ref: ${order.customer_reference}`)
    }
  }

  printer.cut()
}

/**
 * Builds ESC/POS bytes for the **operational ticket** (full receipt with prices).
 */
export async function buildOperationalTicketBytes(
  printer: ThermalPrinter,
  order: OrderData,
): Promise<void> {
  const cfg = getConfig()

  printer.alignCenter()
  printer.bold(true)
  printer.setTextSize(1, 1)
  printer.println(cfg.tenant_name ?? 'Zuppy Food')
  printer.setTextNormal()
  printer.bold(false)
  printer.println('Comprovante do Pedido')
  printer.drawLine()

  printer.alignLeft()
  printer.bold(true)
  printer.println(`Pedido #${order.order_number}`)
  printer.bold(false)
  printer.println(formatDate(order.created_at))

  if (order.customer_name) {
    printer.println(`Cliente: ${order.customer_name}`)
  }
  if (order.customer_phone) {
    printer.println(`Tel: ${order.customer_phone}`)
  }
  printer.drawLine()

  // Items with prices
  for (const item of order.order_items) {
    const name = item.half_product_name
      ? `${item.product_name} / ${item.half_product_name}`
      : item.product_name

    printer.tableCustom([
      { text: `${item.quantity}x ${name}`, align: 'LEFT', width: 0.65 },
      { text: brl(item.subtotal), align: 'RIGHT', width: 0.35 },
    ])

    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        printer.tableCustom([
          { text: `  + ${addon.name}`, align: 'LEFT', width: 0.65 },
          { text: brl(addon.price), align: 'RIGHT', width: 0.35 },
        ])
      }
    }

    if (item.notes) {
      // bold() no lugar de italic(): italic() nao existe nesta versao do
      // node-thermal-printer (crashava "printer.italic is not a function" em obs).
      printer.bold(true)
      printer.println(`  Obs: ${item.notes}`)
      printer.bold(false)
    }
  }

  printer.drawLine()

  // Totals
  printer.tableCustom([
    { text: 'Subtotal:', align: 'LEFT', width: 0.6 },
    { text: brl(order.subtotal), align: 'RIGHT', width: 0.4 },
  ])

  if (order.delivery_fee > 0) {
    printer.tableCustom([
      { text: 'Taxa de entrega:', align: 'LEFT', width: 0.6 },
      { text: brl(order.delivery_fee), align: 'RIGHT', width: 0.4 },
    ])
  }

  if (order.discount > 0) {
    printer.tableCustom([
      { text: 'Desconto:', align: 'LEFT', width: 0.6 },
      { text: `-${brl(order.discount)}`, align: 'RIGHT', width: 0.4 },
    ])
  }

  printer.bold(true)
  printer.tableCustom([
    { text: 'TOTAL:', align: 'LEFT', width: 0.6 },
    { text: brl(order.total), align: 'RIGHT', width: 0.4 },
  ])
  printer.bold(false)
  printer.drawLine()

  // Payment
  printer.println(`Pagamento: ${paymentLabel(order.payment_method)}`)
  if (order.payment_method === 'cash' && order.change_for) {
    printer.println(`Troco para: ${brl(order.change_for)}`)
    const change = order.change_for - order.total
    printer.println(`Troco: ${brl(change > 0 ? change : 0)}`)
  }
  printer.drawLine()

  // Delivery info
  if (order.pickup_code) {
    printer.alignCenter()
    printer.bold(true)
    printer.println(`Código de Retirada: ${order.pickup_code}`)
    printer.bold(false)
  } else if (order.customer_address) {
    printer.alignLeft()
    printer.bold(true)
    printer.println('Endereço de Entrega:')
    printer.bold(false)
    printer.println(order.customer_address)
    if (order.customer_reference) {
      printer.println(`Referência: ${order.customer_reference}`)
    }

    // Rota até o cliente (QR do /nav) — só entrega. Link curto = QR compacto e
    // fácil de ler. Impressora sem suporte a QR nativo ignora (a via sai igual).
    const navUrl = buildNavUrl(order)
    if (navUrl) {
      printer.drawLine()
      printer.alignCenter()
      printer.println('Rota até o cliente:')
      printer.printQR(navUrl, { cellSize: 6, correction: 'M', model: 2 })
      printer.alignLeft()
    }
  }

  if (order.estimated_delivery_minutes) {
    printer.println(`Tempo estimado: ${order.estimated_delivery_minutes} min`)
  }

  if (order.notes) {
    printer.drawLine()
    printer.bold(true)
    printer.println('Observações:')
    printer.bold(false)
    printer.println(order.notes)
  }

  printer.drawLine()
  printer.alignCenter()
  printer.println('Obrigado pela preferência!')
  printer.println('Powered by Zuppy Food')
  printer.cut()
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the list of installed printer names from Windows.
 * Uses `wmic` as a fallback when the Electron API is unavailable.
 */
export async function listPrinters(): Promise<string[]> {
  try {
    // electron.webContents can list printers from the main process via
    // BrowserWindow, but we can also shell out to wmic for simplicity.
    const { stdout } = await execAsync(
      'wmic printer get name /format:list',
      { timeout: 8000 },
    )
    const names = stdout
      .split('\n')
      .map((l) => l.replace(/^Name=/, '').trim())
      .filter((l) => l.length > 0)
    return names
  } catch (err) {
    log.error('Failed to list printers via wmic', err)
    return []
  }
}

/**
 * Prints both kitchen and operational tickets for an order.
 *
 * @param order     - Fully hydrated order data including items
 * @param printerName - Windows printer name (e.g. "EPSON TM-T20III")
 */
export async function printOrder(
  order: OrderData,
  printerName: string,
): Promise<void> {
  log.info(`Printing order #${order.order_number} on "${printerName}"`)

  // ── Kitchen ticket ──
  const kitchenPrinter = createPrinter()
  await buildKitchenTicketBytes(kitchenPrinter, order)
  await sendRawToWindowsPrinter(printerName, kitchenPrinter.getBuffer())

  // Small gap between tickets
  await new Promise<void>((r) => setTimeout(r, 300))

  // ── Operational ticket ──
  const opPrinter = createPrinter()
  await buildOperationalTicketBytes(opPrinter, order)
  await sendRawToWindowsPrinter(printerName, opPrinter.getBuffer())

  log.info(`Order #${order.order_number} printed successfully`)
}

/**
 * Imprime comandas JÁ RENDERIZADAS pelo servidor (cliente-burro): decodifica os
 * bytes ESC/POS base64 e manda RAW pro spooler, × cópias, com gap entre elas.
 * Não monta nada — o servidor decide o layout (comanda configurável).
 */
export async function printRenderedComandas(
  render: RenderedComanda[],
  printerName: string,
): Promise<void> {
  log.info(`Printing ${render.length} pre-rendered comanda(s) on "${printerName}"`)
  let first = true
  let sent = 0
  for (const comanda of render) {
    if (!comanda?.bytes_base64) {
      log.warn(`Skipping comanda "${comanda?.template}" with empty bytes`)
      continue
    }
    const bytes = Buffer.from(comanda.bytes_base64, 'base64')
    // copies pode vir malformado do servidor (cliente-burro não confia): Number()
    // + guarda de finitude evita loop com NaN (rodaria 0×, sumindo a via).
    const n = Math.floor(Number(comanda.copies))
    const copies = Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 1
    for (let i = 0; i < copies; i++) {
      if (!first) await new Promise<void>((r) => setTimeout(r, 300))
      first = false
      await sendRawToWindowsPrinter(printerName, bytes)
      sent++
    }
  }
  // NUNCA reportar sucesso sem imprimir nada: se render[] veio mas nada saiu
  // (bytes vazios / payload malformado do servidor), falha ALTO → o job cai no
  // retry/confirmFailed em vez de virar "impresso fantasma" e sumir a comanda.
  if (sent === 0) {
    throw new Error('render[] presente mas nada imprimivel (bytes vazios/invalidos)')
  }
  log.info(`Pre-rendered comandas printed (${sent} impressao(oes))`)
}

/**
 * Prints a simple test page to verify the printer is working.
 *
 * @param printerName - Windows printer name
 */
export async function testPrint(printerName: string): Promise<void> {
  log.info(`Test print on "${printerName}"`)
  const printer = createPrinter()

  printer.alignCenter()
  printer.bold(true)
  printer.setTextSize(1, 1)
  printer.println('ZUPPY IMPRESSORA')
  printer.setTextNormal()
  printer.bold(false)
  printer.drawLine()
  printer.println('Impressão de teste')
  printer.println(new Date().toLocaleString('pt-BR'))
  printer.drawLine()
  printer.println('Se você vê esta mensagem,')
  printer.println('a impressora está funcionando!')
  printer.drawLine()
  printer.alignLeft()
  printer.println(`Impressora: ${printerName}`)
  printer.println(`Papel: ${paperWidthMm()}mm`)
  printer.drawLine()
  printer.alignCenter()
  printer.println('Powered by Zuppy Food')
  printer.cut()

  await sendRawToWindowsPrinter(printerName, printer.getBuffer())
  log.info('Test print completed')
}
