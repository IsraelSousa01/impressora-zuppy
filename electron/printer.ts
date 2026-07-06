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
import { exec } from 'child_process'
import { promisify } from 'util'
import { createLogger } from './logger'
import { getConfig } from './store'

const execAsync = promisify(exec)
const log = createLogger('PRINTER')

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the configured paper width in mm as a number */
function paperWidthMm(): 80 | 58 {
  const cfg = getConfig()
  return cfg.paper_size === '58mm' ? 58 : 80
}

/** Creates a configured ThermalPrinter instance for a given printer name */
function createPrinter(printerName: string): ThermalPrinter {
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `printer:${printerName}`,
    characterSet: CharacterSet.PC858_EURO,
    breakLine: BreakLine.WORD,
    lineCharacter: '-',
    width: paperWidthMm() === 58 ? 32 : 48,
    removeSpecialCharacters: false,
    options: {
      timeout: 10000,
    },
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
      printer.italic(true)
      printer.println(`  Obs: ${item.notes}`)
      printer.italic(false)
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
      printer.italic(true)
      printer.println(`  Obs: ${item.notes}`)
      printer.italic(false)
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
  const kitchenPrinter = createPrinter(printerName)
  await buildKitchenTicketBytes(kitchenPrinter, order)
  const kitchenOk = await kitchenPrinter.isPrinterConnected()
  if (!kitchenOk) {
    throw new Error(`Printer "${printerName}" is not connected`)
  }
  await kitchenPrinter.execute()

  // Small gap between tickets
  await new Promise<void>((r) => setTimeout(r, 300))

  // ── Operational ticket ──
  const opPrinter = createPrinter(printerName)
  await buildOperationalTicketBytes(opPrinter, order)
  await opPrinter.execute()

  log.info(`Order #${order.order_number} printed successfully`)
}

/**
 * Prints a simple test page to verify the printer is working.
 *
 * @param printerName - Windows printer name
 */
export async function testPrint(printerName: string): Promise<void> {
  log.info(`Test print on "${printerName}"`)
  const printer = createPrinter(printerName)

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

  const connected = await printer.isPrinterConnected()
  if (!connected) {
    throw new Error(`Printer "${printerName}" is not connected`)
  }
  await printer.execute()
  log.info('Test print completed')
}
