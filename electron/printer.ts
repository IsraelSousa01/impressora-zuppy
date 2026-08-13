/**
 * electron/printer.ts
 * ESC/POS printing via node-thermal-printer.
 *
 * Exposes:
 *  - listPrinters()        → available Windows printer names
 *  - testPrint()           → prints a simple test page
 *  - printOrder()          → prints kitchen + operational tickets for an order
 *  - printRawDocument()    → sends a ready-made ESC/POS document (raw bytes)
 *  - buildKitchenTicketBytes()    → ESC/POS bytes for kitchen (no prices)
 *  - buildOperationalTicketBytes() → ESC/POS bytes for full ticket with prices
 */

import {
  ThermalPrinter,
  PrinterTypes,
  CharacterSet,
  BreakLine,
} from 'node-thermal-printer'
import { exec, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import { createLogger } from './logger'
import { getConfig } from './store'
import { ZUPPY_APP_URL } from './config'
import { layoutTwoColumns, wrapText, doubleWidthColumns } from './text-layout'

const execAsync = promisify(exec)
const log = createLogger('PRINTER')

/**
 * Impressão RAW no Windows SEM módulo nativo — via worker PowerShell PERSISTENTE.
 *
 * O node-thermal-printer, pra falar com a impressora do Windows, exige o módulo
 * nativo `@thiagoelg/node-printer`, que precisa compilar com Visual Studio Build
 * Tools — a máquina da loja não tem. Então montamos a comanda com o
 * node-thermal-printer (getBuffer) e mandamos os bytes ESC/POS pro spooler do
 * Windows via winspool.drv, chamado por P/Invoke C# dentro de um PowerShell.
 *
 * Até a 1.1.0 cada impressão iniciava um powershell.exe NOVO (+2 arquivos
 * temporários) e recompilava o C# com Add-Type — medido na máquina da loja:
 * ~840ms de start do powershell + ~660ms de Add-Type = ~1,5s de overhead POR
 * comanda, parte relevante do piso de 2,4s da latência fim-a-fim. Agora um
 * único worker fica vivo: compila o C# UMA vez no boot, responde 'READY' e
 * entra num loop lendo uma requisição por linha no stdin e respondendo uma
 * linha no stdout. Sem arquivo temporário: impressora e bytes viajam em
 * base64 na própria linha (linhas 100% ASCII — imune a codepage do console).
 *
 * Protocolo (1 linha por mensagem, campos separados por TAB):
 *   requisição → `<id>\t<printerName utf8→b64>\t<bytes b64>`
 *   resposta   → `<id>\tOK\t<qtde bytes>`  |  `<id>\tERR\t<mensagem utf8→b64>`
 *
 * Garantias:
 *  - NUNCA responde OK sem o spooler ter aceitado o documento: o OK só sai
 *    depois de ZuppyRawPrinter.Send() retornar; qualquer falha de
 *    OpenPrinter/StartDoc/WritePrinter lança e vira ERR (caller falha alto).
 *  - Recuperação: worker morto (crash, kill, reciclagem do Windows) é
 *    detectado pelo evento 'exit'; o próximo envio faz respawn sob demanda.
 *  - Timeout por requisição: impressão pendurada derruba o worker e rejeita
 *    (a fila faz o retry) — nada fica pendurado pra sempre.
 *  - Sem vazamento: `process.on('exit')` mata o worker; e se o app morrer
 *    sem evento (crash duro), o stdin do worker fecha (EOF) e o loop de
 *    ReadLine termina sozinho.
 *
 * ATENÇÃO ao editar o script: é um template literal SEM interpolação — não
 * use crase (escape do PowerShell) nem `${` (interpolação JS) dentro dele.
 * O teste de invariantes em printer-worker.test.ts vigia isso.
 */
export const PRINT_WORKER_PS_SOURCE = `
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ZuppyRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter falhou (err=" + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "Zuppy Comanda"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter falhou err=" + Marshal.GetLastWin32Error());
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written)) throw new Exception("WritePrinter falhou err=" + Marshal.GetLastWin32Error());
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@

[Console]::Out.WriteLine('READY')

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Length -eq 0) { continue }
  $parts = $line.Split([char]9)
  $id = $parts[0]
  try {
    if ($parts.Count -ne 3) { throw 'requisicao malformada (esperado id TAB printer TAB bytes)' }
    $printer = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    $bytes = [Convert]::FromBase64String($parts[2])
    [ZuppyRawPrinter]::Send($printer, $bytes)
    [Console]::Out.WriteLine($id + [char]9 + 'OK' + [char]9 + $bytes.Length)
  } catch {
    $msg = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_.Exception.Message))
    [Console]::Out.WriteLine($id + [char]9 + 'ERR' + [char]9 + $msg)
  }
}
`

/** Teto de UMA impressão — o mesmo dos 20s do execFile da era one-shot. */
const PRINT_WORKER_REQUEST_TIMEOUT_MS = 20000
/** Teto pro worker compilar o C# e responder READY (máquina de loja lenta). */
const PRINT_WORKER_STARTUP_TIMEOUT_MS = 30000

/** Monta a linha de requisição do protocolo do worker (campos em base64 → ASCII puro). */
export function buildPrintWorkerRequestLine(
  id: string,
  printerName: string,
  data: Buffer,
): string {
  return [
    id,
    Buffer.from(printerName, 'utf8').toString('base64'),
    data.toString('base64'),
  ].join('\t')
}

export type PrintWorkerResponse =
  | { id: string; status: 'ok' }
  | { id: string; status: 'error'; message: string }

/**
 * Interpreta uma linha de resposta do worker. Linhas que não são resposta
 * (READY, eco de lixo) retornam null — o caller decide logar.
 */
export function parsePrintWorkerResponseLine(line: string): PrintWorkerResponse | null {
  const parts = line.split('\t')
  if (parts.length < 2) return null
  const [id, status] = parts
  if (status === 'OK') return { id, status: 'ok' }
  if (status === 'ERR') {
    const message = parts[2]
      ? Buffer.from(parts[2], 'base64').toString('utf8')
      : 'erro desconhecido do worker de impressao'
    return { id, status: 'error', message }
  }
  return null
}

interface PendingPrintRequest {
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface PrintWorkerHandle {
  child: ChildProcessWithoutNullStreams
  /** Resolve quando o worker respondeu READY (C# compilado, loop ativo). */
  ready: Promise<void>
  /** Derruba o worker e rejeita tudo que estava pendente. Idempotente. */
  fail: (err: Error) => void
}

let printWorkerHandle: PrintWorkerHandle | null = null
const pendingPrintRequests = new Map<string, PendingPrintRequest>()
let nextPrintRequestId = 1
/**
 * Serializa os envios ao worker: a impressora física é serial e o protocolo
 * atende uma requisição por vez. A fila (print-queue.ts) já é serial, mas
 * test-print/print-raw do http-server chegam por fora dela.
 */
let printSendChain: Promise<void> = Promise.resolve()

function rejectAllPendingPrintRequests(err: Error): void {
  for (const pending of pendingPrintRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(err)
  }
  pendingPrintRequests.clear()
}

/** Retorna o worker vivo ou faz o spawn de um novo (respawn sob demanda). */
function ensurePrintWorker(): PrintWorkerHandle {
  if (printWorkerHandle) return printWorkerHandle

  log.info('Iniciando worker PowerShell de impressão…')
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      // -EncodedCommand (base64 de UTF-16LE): sem arquivo .ps1 temporário e
      // sem qualquer escaping de shell.
      '-EncodedCommand',
      Buffer.from(PRINT_WORKER_PS_SOURCE, 'utf16le').toString('base64'),
    ],
    { windowsHide: true },
  )

  let readySettled = false
  let resolveReady!: () => void
  let rejectReady!: (err: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // Uma falha pode chegar sem ninguém aguardando `ready` naquele instante
  // (worker morre ocioso entre comandas) — sem isto seria unhandled rejection.
  ready.catch(() => {})

  const startupTimer = setTimeout(() => {
    handle.fail(
      new Error(`worker de impressão não ficou pronto em ${PRINT_WORKER_STARTUP_TIMEOUT_MS}ms`),
    )
  }, PRINT_WORKER_STARTUP_TIMEOUT_MS)

  const handle: PrintWorkerHandle = {
    child,
    ready,
    fail: (err: Error) => {
      if (printWorkerHandle === handle) printWorkerHandle = null
      clearTimeout(startupTimer)
      if (!readySettled) {
        readySettled = true
        rejectReady(err)
      }
      rejectAllPendingPrintRequests(err)
      if (!child.killed) child.kill()
    },
  }

  let stdoutBuffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let newlineIndex: number
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '')
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      if (line.length === 0) continue

      if (line === 'READY') {
        if (!readySettled) {
          readySettled = true
          clearTimeout(startupTimer)
          log.info('Worker de impressão pronto (C# compilado)')
          resolveReady()
        }
        continue
      }

      const response = parsePrintWorkerResponseLine(line)
      if (!response) {
        log.warn(`Linha inesperada do worker de impressão: ${line}`)
        continue
      }
      const pending = pendingPrintRequests.get(response.id)
      if (!pending) {
        log.warn(`Resposta do worker sem requisição pendente (id=${response.id})`)
        continue
      }
      pendingPrintRequests.delete(response.id)
      clearTimeout(pending.timer)
      if (response.status === 'ok') pending.resolve()
      else pending.reject(new Error(response.message))
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    const text = chunk.trim()
    // '#< CLIXML' é o preâmbulo que o powershell SEMPRE emite no stderr
    // quando os streams são redirecionados — ruído de boot, não erro.
    if (text && text !== '#< CLIXML') log.warn(`Worker de impressão stderr: ${text}`)
  })

  // Sem handler, um EPIPE no stdin (worker morreu entre o check e o write)
  // derrubaria o processo inteiro do app.
  child.stdin.on('error', (err) => {
    handle.fail(new Error(`stdin do worker de impressão falhou: ${err.message}`))
  })
  child.on('error', (err) => {
    handle.fail(new Error(`falha ao iniciar powershell.exe: ${err.message}`))
  })
  child.on('exit', (code, signal) => {
    handle.fail(
      new Error(`worker de impressão encerrou (code=${code ?? 'null'}, signal=${signal ?? 'null'})`),
    )
  })

  printWorkerHandle = handle
  return handle
}

/** Uma requisição de impressão ao worker já pronto, com timeout próprio. */
function requestPrintFromWorker(
  handle: PrintWorkerHandle,
  printerName: string,
  data: Buffer,
): Promise<void> {
  const id = String(nextPrintRequestId++)
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // fail() rejeita esta pendência (ainda está no Map) e derruba o worker:
      // um PowerShell pendurado não pode atender a próxima comanda.
      handle.fail(
        new Error(
          `impressão não respondeu em ${PRINT_WORKER_REQUEST_TIMEOUT_MS}ms — worker será reiniciado no próximo envio`,
        ),
      )
    }, PRINT_WORKER_REQUEST_TIMEOUT_MS)
    pendingPrintRequests.set(id, { resolve, reject, timer })
    handle.child.stdin.write(`${buildPrintWorkerRequestLine(id, printerName, data)}\n`, (err) => {
      if (err) {
        handle.fail(new Error(`falha ao enviar requisição ao worker: ${err.message}`))
      }
    })
  })
}

/**
 * Manda o buffer ESC/POS pra impressora do Windows via spooler RAW, pelo
 * worker persistente. Envios são serializados (printSendChain); a falha de um
 * envio é repassada ao chamador mas nunca contamina o próximo da corrente.
 */
async function sendRawToWindowsPrinter(
  printerName: string,
  data: Buffer,
): Promise<void> {
  const task = printSendChain.then(async () => {
    let handle = ensurePrintWorker()
    try {
      await handle.ready
    } catch (err) {
      // O worker morreu antes de ficar pronto (boot falhou, ou crash entre
      // comandas com o handle já limpo). NENHUMA requisição foi entregue,
      // então um único respawn + nova tentativa é seguro — zero risco de
      // imprimir duas vezes.
      log.warn(
        `Worker de impressão indisponível (${err instanceof Error ? err.message : String(err)}) — respawn e nova tentativa`,
      )
      handle = ensurePrintWorker()
      await handle.ready
    }
    const startedAt = Date.now()
    await requestPrintFromWorker(handle, printerName, data)
    log.info(`RAW ${data.length} bytes → "${printerName}" em ${Date.now() - startedAt}ms`)
  })
  printSendChain = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

// Sem vazamento no shutdown: mata o worker quando o app encerra. (Cinto
// extra: se o app morrer sem 'exit', o EOF do stdin encerra o loop do worker.)
process.on('exit', () => {
  printWorkerHandle?.child.kill()
})

// ─── Test-only ────────────────────────────────────────────────────────────────

/** PID do worker vivo (null se não há worker). Só para testes de recuperação. */
export function getPrintWorkerPidForTests(): number | null {
  return printWorkerHandle?.child.pid ?? null
}

/** Derruba o worker como se tivesse crashado. Só para testes/teardown. */
export function killPrintWorkerForTests(): void {
  printWorkerHandle?.fail(new Error('worker derrubado pelo teste'))
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
 * Largura em colunas da ESTAÇÃO local: usa a calibração explícita do usuário
 * (`cfg.columns`, ver AppConfig em store.ts) quando existir; senão deriva da
 * largura física do papel com a MESMA matemática de `createPrinter`
 * (58mm→32, 80mm→48). É a fonte única de verdade sobre "quantas colunas esta
 * impressora imprime de verdade" — usada pelo cutover de print-queue.ts para
 * decidir entre os bytes já renderizados pelo servidor e o build local.
 */
export function stationColumns(): number {
  const cfg = getConfig()
  if (typeof cfg.columns === 'number' && Number.isFinite(cfg.columns) && cfg.columns > 0) {
    return Math.floor(cfg.columns)
  }
  return paperWidthMm() === 58 ? 32 : 48
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

/**
 * Imprime um par esquerda/direita (item + preço, TOTAL + valor etc.) sem
 * nunca exceder a largura do papel nem cortar o valor da direita no meio.
 * Substitui `printer.tableCustom()`: ver electron/text-layout.ts para o
 * porquê (a lib nativa arredonda a largura da coluna PRA CIMA e trunca
 * texto que não cabe via `.substring()`).
 */
function printTwoColumns(
  printer: ThermalPrinter,
  left: string,
  right: string,
): void {
  for (const line of layoutTwoColumns(left, right, printer.getWidth())) {
    printer.println(line)
  }
}

/**
 * Imprime um cabeçalho em tamanho dobrado (`setTextSize(1, 1)`) descontando
 * a largura dupla por caractere. Sem isso, nomes de loja/textos maiores que
 * `floor(columns/2)` saem partidos ao meio pela própria impressora — foto
 * real: "Pastel dos Amigos" (17 chars, 58mm/16 colunas dobradas) virou
 * "Pastel dos Amig" + "os". Assume que `printer.setTextSize(1, 1)` já foi
 * chamado pelo chamador (e será desfeito por ele depois).
 */
function printDoubleWidthLine(printer: ThermalPrinter, text: string): void {
  const columns = doubleWidthColumns(printer.getWidth())
  for (const line of wrapText(text, columns)) {
    printer.println(line)
  }
}

/**
 * Reset explícito de estado no início de CADA documento (fonte normal, sem
 * negrito, sem tamanho dobrado, alinhado à esquerda).
 *
 * `printOrder` cria uma instância nova de ThermalPrinter por ticket, mas
 * isso só zera o BUFFER em memória — o `cut()` do ticket anterior é quem
 * reseta o HARDWARE físico (chama initHardware() depois de cortar). Se o
 * ticket anterior falhar antes do cut(), ou se outro processo tiver deixado
 * a impressora em outro estado, o próximo documento herdaria negrito/tamanho
 * dobrado/alinhamento residual. Este reset no início torna o início de cada
 * documento determinístico, para que a via da cozinha nunca contamine a da
 * entrega nem vice-versa.
 */
function resetDocumentState(printer: ThermalPrinter): void {
  printer.setTextNormal()
  printer.bold(false)
  printer.alignLeft()
}

// ─── ESC/POS Ticket Builders ──────────────────────────────────────────────────

/**
 * Builds ESC/POS bytes for the **kitchen ticket** (no prices, for the kitchen).
 */
export async function buildKitchenTicketBytes(
  printer: ThermalPrinter,
  order: OrderData,
): Promise<void> {
  resetDocumentState(printer)

  printer.alignCenter()
  printer.bold(true)
  printer.setTextSize(1, 1)
  printDoubleWidthLine(printer, '*** COZINHA ***')
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
    printDoubleWidthLine(printer, `RETIRADA: ${order.pickup_code}`)
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

  resetDocumentState(printer)

  printer.alignCenter()
  printer.bold(true)
  printer.setTextSize(1, 1)
  printDoubleWidthLine(printer, cfg.tenant_name ?? 'Zuppy Food')
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

    printTwoColumns(printer, `${item.quantity}x ${name}`, brl(item.subtotal))

    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        printTwoColumns(printer, `  + ${addon.name}`, brl(addon.price))
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
  printTwoColumns(printer, 'Subtotal:', brl(order.subtotal))

  if (order.delivery_fee > 0) {
    printTwoColumns(printer, 'Taxa de entrega:', brl(order.delivery_fee))
  }

  if (order.discount > 0) {
    printTwoColumns(printer, 'Desconto:', `-${brl(order.discount)}`)
  }

  printer.bold(true)
  printTwoColumns(printer, 'TOTAL:', brl(order.total))
  printer.bold(false)
  printer.drawLine()

  // Payment
  printer.println(`Pagamento: ${paymentLabel(order.payment_method)}`)
  if (order.payment_method === 'cash' && order.change_for) {
    // printTwoColumns (não println cru): o print() da lib refaz o fold
    // quebrando no último espaço, o que já separou "R$" do valor numa linha
    // e o resto na seguinte. printTwoColumns mantém o par rótulo/valor numa
    // única linha (ou desce o valor inteiro, nunca cortado).
    printTwoColumns(printer, 'Troco para:', brl(order.change_for))
    const change = order.change_for - order.total
    printTwoColumns(printer, 'Troco:', brl(change > 0 ? change : 0))
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
 * Imprime um documento ESC/POS JÁ PRONTO (bytes crus) — caminho do
 * POST /print-raw (ex.: folha de calibração de largura gerada pelo painel
 * do Zuppy). Usa o MESMO transporte RAW das comandas renderizadas pelo
 * servidor; a validação do documento (base64, tamanho, init ESC/POS) é
 * responsabilidade do chamador (http-server.ts).
 *
 * @param printerName - Windows printer name
 * @param bytes       - Documento ESC/POS completo, já decodificado
 */
export async function printRawDocument(
  printerName: string,
  bytes: Buffer,
): Promise<void> {
  log.info(`Printing raw document (${bytes.length} bytes) on "${printerName}"`)
  await sendRawToWindowsPrinter(printerName, bytes)
  log.info('Raw document printed')
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
