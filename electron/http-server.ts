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
 *
 * Security:
 *   - Binds to 127.0.0.1 only (never 0.0.0.0)
 *   - CORS restricted to https://zuppyfood.app and http://localhost:*
 */

import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { Server } from 'http'
import { app as electronApp } from 'electron'
import { getConfig, setConfig, isConfigured, getLogs } from './store'
import { getConnectionStatus, connect, disconnect } from './realtime'
import { getQueueStatus } from './print-queue'
import { listPrinters, testPrint } from './printer'
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
      // Persist configuration
      setConfig({
        device_token,
        ...(tenant_id !== undefined && { tenant_id }),
        ...(tenant_name !== undefined && { tenant_name }),
        ...(auto_print !== undefined && { auto_print }),
        ...(printer_name !== undefined && { printer_name }),
        ...(paper_size !== undefined && { paper_size }),
      })

      log.info(`Configuration updated with device_token: ${device_token}`)

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
