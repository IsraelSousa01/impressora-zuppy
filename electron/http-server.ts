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
 */

import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { Server } from 'http'
import { app as electronApp } from 'electron'
import { getConfig, setConfig, isConfigured, getLogs } from './store'
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

    // Domínio canônico de produção é zuppyfood.com.br — o Gestor roda no apex
    // e em subdomínios (gestordepedidos., pedido.). Aceita o apex e qualquer
    // subdomínio *.zuppyfood.com.br, mais localhost pro dev.
    const allowed =
      origin === 'https://zuppyfood.com.br' ||
      /^https:\/\/([a-z0-9-]+\.)+zuppyfood\.com\.br$/.test(origin) ||
      /^http:\/\/localhost(:\d+)?$/.test(origin) ||
      /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)

    if (allowed) {
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
      connected: getConnectionStatus(),
      // Update baixado aguardando janela segura (loja fechada + fila vazia).
      // `downloadedAt` deixa o painel detectar "esperando há muito tempo" e
      // oferecer o botão de instalar agora (POST /install-update).
      update: getUpdateState(),
    })
  })

  /** POST /configure */
  router.post('/configure', async (req: Request, res: Response) => {
    const {
      tenant_id,
      tenant_name,
      auto_print,
      device_token,
      printer_name,
      paper_size,
    } = req.body as {
      tenant_id?: string
      tenant_name?: string
      auto_print?: boolean
      device_token?: string
      printer_name?: string
      paper_size?: '80mm' | '58mm'
    }

    if (!device_token) {
      res.status(400).json({
        error: 'Missing required field: device_token',
      })
      return
    }

    try {
      // Trocar de dispositivo/loja invalida a sessão anterior: ela pertence ao
      // tenant antigo. Se não zerar, connectSSEStream() vê session_token
      // presente e PULA a re-autenticação (realtime.ts), reusando a sessão da
      // loja anterior — o app nunca reconecta e fica preso em "conectando".
      // (Bug real: app da PIZZA PIZZA reusando a session_token da Praça Zuppy.)
      const current = getConfig()
      const identityChanged =
        current.device_token !== device_token ||
        (tenant_id !== undefined && current.tenant_id !== tenant_id)

      // Persist configuration
      setConfig({
        device_token,
        ...(tenant_id !== undefined && { tenant_id }),
        ...(tenant_name !== undefined && { tenant_name }),
        ...(auto_print !== undefined && { auto_print }),
        ...(printer_name !== undefined && { printer_name }),
        ...(paper_size !== undefined && { paper_size }),
        // Zera a sessão só quando a identidade muda — força re-login com o
        // device_token novo. Trocas de impressora/papel preservam a sessão.
        ...(identityChanged && {
          session_token: undefined,
          session_expires_at: undefined,
        }),
      })

      log.info(
        `Configuration updated with device_token: ${device_token}` +
          (identityChanged ? ' (identidade mudou — sessão zerada)' : '')
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
