/**
 * electron/http-server.ts
 * Express HTTP server on localhost:7847.
 *
 * Endpoints:
 *   GET  /ping            → { ok: true }
 *   GET  /status          → connection/queue status
 *   POST /configure       → save config and (re)connect realtime
 *   GET  /printers        → list Windows printers
 *   POST /test-print      → print a test page
 *   POST /print-raw       → print a ready-made ESC/POS document (base64)
 *   POST /install-update  → install a downloaded update on demand (panel button)
 *
 * Security:
 *   - Binds to 127.0.0.1 only (never 0.0.0.0)
 *   - CORS restricted to *.zuppyfood.com.br and http://localhost:*
 *   - Host header restricted to loopback (anti DNS rebinding)
 */

import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { Server } from 'http'
import { app as electronApp } from 'electron'
import { getConfig, setConfig, isConfigured, getLogs, type AppConfig } from './store'
import { isAllowedZuppyOrigin, canonicalizeZuppyApiOrigin } from './config'
import { getConnectionStatus, connect, disconnect } from './realtime'
import { getQueueStatus } from './print-queue'
import { getUpdateState, installNow } from './updater'
import { listPrinters, testPrint, printRawDocument } from './printer'
import { createLogger } from './logger'

const log = createLogger('HTTP')

export const HTTP_PORT = 7847
export const HTTP_HOST = '127.0.0.1'

// ─── CORS ─────────────────────────────────────────────────────────────────────

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. same-process fetch, Postman during dev)
    if (!origin) return callback(null, true)

    // Mesma allowlist que valida o `api_url` do /configure (electron/config.ts):
    // quem pode falar com este app é quem este app pode chamar.
    if (isAllowedZuppyOrigin(origin)) {
      callback(null, true)
    } else {
      log.warn(`CORS blocked origin: ${origin}`)
      callback(new Error(`Origin ${origin} not allowed`))
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}

// ─── Host header ──────────────────────────────────────────────────────────────

/**
 * `Host` aceito por este servidor: só o loopback, com a porta em que ele
 * escuta.
 *
 * Ligar em 127.0.0.1 impede que a máquina da loja seja alcançada pela rede,
 * mas NÃO impede DNS rebinding: um domínio do atacante que resolve para
 * 127.0.0.1 faz o navegador da vítima bater neste servidor tratando tudo como
 * same-origin — sem `Origin`, o CORS nem entra na conversa. O que denuncia
 * esse request é o `Host`, que carrega o nome pelo qual o navegador chegou.
 */
export function isAllowedLocalHostHeader(host: string | undefined, port: number): boolean {
  if (!host) return false
  const normalized = host.trim().toLowerCase()
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`
}

// ─── /print-raw validation ────────────────────────────────────────────────────

/**
 * Teto do documento DECODIFICADO aceito pelo /print-raw: 64 KB.
 *
 * Por quê 64 KB: a folha de calibração do painel e uma comanda renderizada
 * pelo servidor têm poucos KB (texto ESC/POS a 48 colunas ≈ 50 bytes/linha);
 * 64 KB dá folga de sobra para QR/conteúdo raster moderado, mas é um teto
 * duro contra documento gigante — 64 KB de texto seriam ~1300 linhas
 * (~5 m de papel), o suficiente pra travar a impressora e esvaziar a bobina.
 * O limite de 1 MB do body JSON protege o processo, não o papel; este aqui
 * protege a impressora.
 */
export const PRINT_RAW_MAX_DECODED_BYTES = 64 * 1024

/** ESC @ — init ESC/POS. Todo documento legítimo do Zuppy começa assim. */
const ESC_POS_INIT = [0x1b, 0x40] as const

/**
 * Alfabeto base64 estrito (com padding `=` só no fim). Validado ANTES do
 * decode porque `Buffer.from(s, 'base64')` é leniente: ignora caracteres
 * inválidos em silêncio, e lixo viraria bytes imprevisíveis na impressora.
 */
const BASE64_STRICT = /^[A-Za-z0-9+/]+={0,2}$/

export type PrintRawValidation =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: string }

/**
 * Valida o `bytes_base64` do POST /print-raw como entrada NÃO confiável:
 * string base64 estrita → teto de tamanho decodificado → precisa começar
 * com ESC @ (0x1B 0x40). Só devolve bytes prontos pra impressora se as
 * três barreiras passarem.
 */
export function validatePrintRawDocument(bytesBase64: unknown): PrintRawValidation {
  if (typeof bytesBase64 !== 'string' || bytesBase64.length === 0) {
    return { ok: false, error: 'Missing required field: bytes_base64 (base64 string)' }
  }

  if (bytesBase64.length % 4 !== 0 || !BASE64_STRICT.test(bytesBase64)) {
    return { ok: false, error: 'bytes_base64 is not valid base64' }
  }

  const bytes = Buffer.from(bytesBase64, 'base64')

  if (bytes.length > PRINT_RAW_MAX_DECODED_BYTES) {
    return {
      ok: false,
      error: `Document too large: ${bytes.length} bytes (max ${PRINT_RAW_MAX_DECODED_BYTES})`,
    }
  }

  if (bytes.length < ESC_POS_INIT.length || bytes[0] !== ESC_POS_INIT[0] || bytes[1] !== ESC_POS_INIT[1]) {
    return {
      ok: false,
      error: 'Document must start with ESC/POS init (0x1B 0x40)',
    }
  }

  return { ok: true, bytes }
}

// ─── /configure ───────────────────────────────────────────────────────────────

/** Corpo do POST /configure. `api_url` é `unknown`: chega do navegador. */
export interface ConfigureRequestBody {
  tenant_id?: string
  tenant_name?: string
  auto_print?: boolean
  device_token?: string
  printer_name?: string
  paper_size?: '80mm' | '58mm'
  api_url?: unknown
}

export type ConfigurePlan =
  | {
      ok: true
      /** `device_token` é garantido: sem ele o plano nem chega a ser ok. */
      patch: Partial<AppConfig> & { device_token: string }
      identityChanged: boolean
    }
  | { ok: false; status: 400; error: string }

/**
 * Normaliza uma origem para comparação: sem espaços, sem barra final e em
 * minúsculas. Origem não tem componente sensível a caixa (esquema, host e
 * porta), então baixar a string inteira é seguro e deixa `api_url` e o header
 * `Origin` comparáveis byte a byte.
 */
function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Destino local (`http://localhost[:porta]`, `http://127.0.0.1[:porta]`). A
 * allowlist aceita esses hosts porque o Gestor rodando em `npm run dev` precisa
 * falar com o app — mas mandar o device_token PARA localhost é outra história:
 * num app instalado na loja, quem escuta em localhost é qualquer programa da
 * máquina, não o Zuppy. Por isso o pareamento só aceita destino local fora de
 * build empacotado (ver `allowLocalApiOrigin`).
 */
function isLocalApiOrigin(origin: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

/**
 * Decide o que o POST /configure vai gravar — validação, detecção de troca de
 * identidade e patch — sem tocar em store, rede ou express. O handler só
 * aplica o resultado.
 *
 * Regras que valem a pena ler antes de mexer:
 *
 *  - `api_url` diz para QUAL Zuppy este app manda o device_token, então passa
 *    pela mesma allowlist do CORS (isAllowedZuppyOrigin) e precisa ser igual ao
 *    header `Origin` do request: assim uma aba do Gestor de produção não
 *    consegue apontar a impressora da loja para outro host. Os dois lados são
 *    canonizados antes da comparação (canonicalizeZuppyApiOrigin), então uma
 *    aba no apex pareando com `api_url` do www é o MESMO host, não divergência.
 *  - `api_url` sem `Origin` é rejeitado: sem o header não há como amarrar o
 *    destino a quem pediu, e a allowlist sozinha aceitaria qualquer host do
 *    Zuppy. Body SEM `api_url` e sem `Origin` continua valendo — é o Gestor
 *    antigo e o pareamento por Postman/same-process, que não mudam destino.
 *  - `opts.allowLocalApiOrigin` (false em build empacotado) barra destino
 *    local: ver isLocalApiOrigin.
 *  - `api_url` inválido rejeita o request INTEIRO: não grava nem os outros
 *    campos, pra não deixar o app meio pareado.
 *  - `api_url` ausente (Gestor antigo, que ainda não manda o campo) LIMPA o
 *    valor salvo (`null` explícito, porque setConfig faz merge raso): o app
 *    segue quem o pareou por último e volta ao default de produção.
 *  - Trocar device_token ou tenant_id é troca de identidade e zera a sessão:
 *    ela pertencia ao tenant anterior. Sem isso, connect() vê session_token
 *    presente e pula a re-autenticação, reusando a sessão da loja anterior — o
 *    app fica preso em "conectando". (Bug real: app da PIZZA PIZZA reusando a
 *    session_token da Praça Zuppy.)
 *  - Mudar SÓ o `api_url` NÃO é troca de identidade: a sessão é emitida pelo
 *    backend, não pelo host. `gestordepedidos.` e `www.` são o mesmo banco, e
 *    zerar a sessão ao alternar entre eles recriaria o ping-pong de
 *    re-autenticação que este endpoint existe pra evitar. Quando o host muda de
 *    verdade (dev ↔ prod), o device_token muda junto e já zera; e se um host
 *    não reconhecer a sessão, o 401 do poll re-autentica sozinho
 *    (electron/realtime.ts). O handler reconecta em todo /configure de
 *    qualquer forma, então a base nova entra em vigor no tick seguinte.
 */
export function planConfigureUpdate(
  current: Partial<AppConfig>,
  body: ConfigureRequestBody,
  originHeader: string | undefined,
  opts: { allowLocalApiOrigin: boolean }
): ConfigurePlan {
  const {
    tenant_id,
    tenant_name,
    auto_print,
    device_token,
    printer_name,
    paper_size,
    api_url,
  } = body

  // Entrada do navegador: `device_token` só serve se for string preenchida —
  // um número viraria `12345.slice` mais adiante.
  if (typeof device_token !== 'string' || device_token === '') {
    return { ok: false, status: 400, error: 'Missing required field: device_token' }
  }

  let nextApiUrl: string | null = null
  if (api_url !== undefined && api_url !== null) {
    if (typeof api_url !== 'string') {
      return { ok: false, status: 400, error: 'api_url not allowed' }
    }

    const candidate = canonicalizeZuppyApiOrigin(normalizeOrigin(api_url))
    if (!isAllowedZuppyOrigin(candidate)) {
      return { ok: false, status: 400, error: 'api_url not allowed' }
    }

    if (!opts.allowLocalApiOrigin && isLocalApiOrigin(candidate)) {
      return { ok: false, status: 400, error: 'api_url not allowed' }
    }

    const origin = originHeader ? canonicalizeZuppyApiOrigin(normalizeOrigin(originHeader)) : ''
    if (origin === '') {
      return { ok: false, status: 400, error: 'api_url requires Origin' }
    }

    if (candidate !== origin) {
      return { ok: false, status: 400, error: 'api_url must match request origin' }
    }

    nextApiUrl = candidate
  }

  const identityChanged =
    current.device_token !== device_token ||
    (tenant_id !== undefined && current.tenant_id !== tenant_id)

  const patch: Partial<AppConfig> & { device_token: string } = {
    device_token,
    api_url: nextApiUrl,
    ...(tenant_id !== undefined && { tenant_id }),
    ...(tenant_name !== undefined && { tenant_name }),
    ...(auto_print !== undefined && { auto_print }),
    ...(printer_name !== undefined && { printer_name }),
    ...(paper_size !== undefined && { paper_size }),
    ...(identityChanged && {
      session_token: undefined,
      session_expires_at: undefined,
    }),
  }

  return { ok: true, patch, identityChanged }
}

// ─── Router ───────────────────────────────────────────────────────────────────

function buildRouter() {
  const router = express.Router()

  /** GET /ping */
  router.get('/ping', (_req: Request, res: Response) => {
    res.json({ ok: true })
  })

  /** GET /status */
  router.get('/status', (_req: Request, res: Response) => {
    const cfg = getConfig()
    const queueStatus = getQueueStatus()
    const logs = getLogs()

    res.json({
      status: isConfigured()
        ? getConnectionStatus()
          ? 'connected'
          : 'disconnected'
        : 'not_configured',
      version: electronApp.getVersion(),
      printer: cfg.printer_name ?? null,
      paper_size: cfg.paper_size ?? '80mm',
      queue: queueStatus.length,
      lastPrint: logs[0] ?? null,
      tenant_name: cfg.tenant_name ?? null,
      tenant_id: cfg.tenant_id ?? null,
      // Origem da API gravada no pareamento; `null` = default de produção.
      // O Gestor usa isto pra saber se o app está apontado pro ambiente dele.
      api_url: cfg.api_url ?? null,
      connected: getConnectionStatus(),
      // Update baixado aguardando janela segura (loja fechada + fila vazia).
      // `downloadedAt` deixa o painel detectar "esperando há muito tempo" e
      // oferecer o botão de instalar agora (POST /install-update).
      update: getUpdateState(),
    })
  })

  /** POST /configure */
  router.post('/configure', async (req: Request, res: Response) => {
    // Valida ANTES de qualquer escrita: request rejeitado não deixa rastro
    // no store (ver planConfigureUpdate).
    const plan = planConfigureUpdate(
      getConfig(),
      req.body as ConfigureRequestBody,
      req.get('origin'),
      // Em `npm run dev` o Gestor roda em localhost e precisa poder apontar o
      // app pra si; no app instalado na loja, destino local é sempre suspeito.
      { allowLocalApiOrigin: !electronApp.isPackaged }
    )

    if (!plan.ok) {
      res.status(plan.status).json({ error: plan.error })
      return
    }

    const device_token = plan.patch.device_token
    // Token curto não mostra NADA: os 4 últimos caracteres de um token de 6
    // seriam quase o token inteiro no log.
    const maskedToken = device_token.length > 8 ? `…${device_token.slice(-4)}` : '****'

    try {
      setConfig(plan.patch)

      log.info(
        `Configuration updated (device_token ${maskedToken}, ` +
          `api_url: ${plan.patch.api_url ?? 'default'})` +
          (plan.identityChanged ? ' (identidade mudou — sessão zerada)' : '')
      )

      // Reconnect polling with new config
      await disconnect()
      await connect()

      res.json({ ok: true, device_token })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('Configure endpoint error', err)
      res.status(500).json({ error: message })
    }
  })

  /** GET /printers */
  router.get('/printers', async (_req: Request, res: Response) => {
    try {
      const printers = await listPrinters()
      res.json({ printers })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('Failed to list printers', err)
      res.status(500).json({ error: message })
    }
  })

  /** POST /test-print */
  router.post('/test-print', async (req: Request, res: Response) => {
    const { printer_name } = req.body as { printer_name?: string }
    const cfg = getConfig()
    const target = printer_name ?? cfg.printer_name

    if (!target) {
      res.status(400).json({ error: 'No printer specified or configured' })
      return
    }

    try {
      await testPrint(target)
      res.json({ ok: true, printer: target })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('Test print failed', err)
      res.status(500).json({ error: message })
    }
  })

  /**
   * POST /print-raw
   * Imprime um documento ESC/POS já pronto (ex.: folha de calibração de
   * largura do painel do Zuppy — não é comanda de pedido, então não passa
   * pela fila de print_jobs). Body: { bytes_base64, printer_name? }.
   */
  router.post('/print-raw', async (req: Request, res: Response) => {
    const { bytes_base64, printer_name } = req.body as {
      bytes_base64?: unknown
      printer_name?: unknown
    }

    // printer_name vai direto como argumento de processo (spooler via
    // PowerShell) — só aceita string.
    if (printer_name !== undefined && typeof printer_name !== 'string') {
      res.status(400).json({ error: 'printer_name must be a string' })
      return
    }

    const cfg = getConfig()
    const target = printer_name ?? cfg.printer_name

    if (!target) {
      res.status(400).json({ error: 'No printer specified or configured' })
      return
    }

    const validation = validatePrintRawDocument(bytes_base64)
    if (!validation.ok) {
      res.status(400).json({ error: validation.error })
      return
    }

    try {
      await printRawDocument(target, validation.bytes)
      res.json({ ok: true, printer: target })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('Raw print failed', err)
      res.status(500).json({ error: message })
    }
  })

  /**
   * POST /install-update
   * Instala AGORA um update já baixado — o botão "atualizar" do painel.
   * É a única exceção à regra de "nunca instalar com a loja aberta": aqui é
   * ato explícito do lojista, não decisão automática. Body: { confirm: true }
   * obrigatório — o restart derruba a impressão por alguns segundos, então
   * nenhum GET perdido ou POST vazio pode disparar isso por acidente.
   */
  router.post('/install-update', (req: Request, res: Response) => {
    const { confirm } = req.body as { confirm?: unknown }

    if (confirm !== true) {
      res.status(400).json({ error: 'Missing required field: confirm (must be true)' })
      return
    }

    const update = getUpdateState()
    if (!update.updateReady) {
      res.status(409).json({ error: 'No update downloaded yet' })
      return
    }

    // Responde ANTES de instalar: quitAndInstall encerra o processo e a
    // resposta se perderia. O painel confirma pelo /status pós-restart.
    res.json({ ok: true, version: update.version })

    setImmediate(() => {
      installNow()
        .then((result) => {
          if (!result.ok) log.error(`On-demand install failed: ${result.error}`)
        })
        .catch((err) => log.error('On-demand install threw', err))
    })
  })

  return router
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let server: Server | null = null

/**
 * Starts the Express HTTP server on 127.0.0.1:7847.
 * Resolves when the server is listening.
 */
export function startHttpServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const expressApp = express()

    // Antes de tudo (inclusive do parse do body): `Host` estranho é DNS
    // rebinding, não cliente legítimo — ver isAllowedLocalHostHeader.
    expressApp.use((req: Request, res: Response, next: NextFunction) => {
      if (!isAllowedLocalHostHeader(req.headers.host, HTTP_PORT)) {
        log.warn(`Blocked request with Host header: ${req.headers.host ?? '(ausente)'}`)
        res.status(403).json({ error: 'bad host' })
        return
      }
      next()
    })

    expressApp.use(cors(corsOptions))
    expressApp.use(express.json({ limit: '1mb' }))

    // Log all requests
    expressApp.use((req: Request, _res: Response, next: NextFunction) => {
      log.debug(`${req.method} ${req.path}`)
      next()
    })

    expressApp.use('/', buildRouter())

    // Generic error handler
    expressApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      log.error('Unhandled HTTP error', err)
      res.status(500).json({ error: err.message })
    })

    server = expressApp.listen(HTTP_PORT, HTTP_HOST, () => {
      log.info(`HTTP server listening on http://${HTTP_HOST}:${HTTP_PORT}`)
      resolve()
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`Port ${HTTP_PORT} already in use`)
      }
      reject(err)
    })
  })
}

/**
 * Gracefully shuts down the HTTP server.
 */
export function stopHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve()
      return
    }
    server.close(() => {
      log.info('HTTP server stopped')
      resolve()
    })
    server = null
  })
}
