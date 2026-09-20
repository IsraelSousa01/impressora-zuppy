/**
 * electron/http-server.ts
 * Express HTTP server on localhost — porta 7847 na instância default, a
 * primeira livre da faixa quando a máquina atende mais de uma impressora
 * (ver startHttpServer e electron/instance.ts).
 *
 * Endpoints:
 *   GET  /ping            → { ok: true, zuppy_printer_app: 1 }
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
 *   - Host header restricted to loopback NA PORTA EFETIVA (anti DNS rebinding)
 *   - Toda resposta servida se identifica como este app (header
 *     `X-Zuppy-Printer-App` + campo `zuppy_printer_app`) — ver
 *     PRINTER_APP_IDENTITY_HEADER
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
import {
  enumeratePrinters,
  getPrinterEnumerationError,
  testPrint,
  printRawDocument,
} from './printer'
import { createLogger, maskDeviceToken } from './logger'
import { formatDeviceLabel } from './destination'
import { DEFAULT_LOCAL_PORT } from './instance'

const log = createLogger('HTTP')

/**
 * Porta histórica. Continua sendo a da instância default — quem abre o app sem
 * argumento nenhum escuta aqui, como sempre. A porta EFETIVA desta instância
 * vem de `startHttpServer` (ver `electron/instance.ts`).
 */
export const HTTP_PORT = DEFAULT_LOCAL_PORT
export const HTTP_HOST = '127.0.0.1'

// ─── Identidade do app ────────────────────────────────────────────────────────

/**
 * Marcador que diz "quem respondeu aqui é o app de impressão da Zuppy".
 *
 * Por que existe: desde que o Zuppy passou a SONDAR a faixa 7847..7850 para
 * achar as instâncias desta máquina, "respondeu 200 num GET /status com JSON"
 * deixou de provar qualquer coisa — qualquer processo sem privilégio da
 * máquina do dono pode escutar numa porta livre da faixa e devolver um
 * `{"status":"not_configured"}` convincente. Se a 7847 estiver muda, esse
 * impostor vira a instância principal e o auto-pareamento manda o
 * `device_token` da loja PARA ELE — a credencial que registra qualquer
 * computador como impressora daquele restaurante e dá acesso ao stream de
 * pedidos com nome, telefone e endereço dos clientes.
 *
 * O marcador não é segredo nenhum (está neste repositório e no README): ele
 * não impede um atacante que ESTUDOU o app de imitá-lo. Ele elimina o caso
 * real — o processo qualquer que só devolve JSON na porta e seria promovido a
 * impressora por acidente.
 *
 * Vai em DOIS lugares, header e corpo, porque o consumidor checa os dois: o
 * header não aparece num JSON copiado/cacheado por engano, e o corpo
 * sobrevive a proxy que reescreve header.
 *
 * O valor é a VERSÃO do contrato de identificação, não um booleano: se um dia
 * o formato do `/status` mudar de forma incompatível, o outro lado distingue
 * pelo número em vez de adivinhar pelo `version` do app.
 */
export const PRINTER_APP_IDENTITY_HEADER = 'X-Zuppy-Printer-App'
export const PRINTER_APP_IDENTITY_VERSION = 1

/** Campo do corpo que carrega o mesmo marcador do header. */
export const PRINTER_APP_IDENTITY_FIELD = 'zuppy_printer_app'

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
  // Sem isto o header de identidade existe na resposta mas o JS da página do
  // Zuppy não consegue LER: header de resposta cross-origin fora da safelist
  // só chega ao `fetch` se estiver no Access-Control-Expose-Headers.
  exposedHeaders: [PRINTER_APP_IDENTITY_HEADER],
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

function buildRouter(port: number) {
  const router = express.Router()

  /** GET /ping */
  router.get('/ping', (_req: Request, res: Response) => {
    // `ok` continua sendo o campo do health check de sempre; o marcador entra
    // ao lado (ver PRINTER_APP_IDENTITY_HEADER).
    res.json({ ok: true, [PRINTER_APP_IDENTITY_FIELD]: PRINTER_APP_IDENTITY_VERSION })
  })

  /** GET /status */
  router.get('/status', (_req: Request, res: Response) => {
    const cfg = getConfig()
    const queueStatus = getQueueStatus()
    const logs = getLogs()

    res.json({
      // Marcador de identidade (ver PRINTER_APP_IDENTITY_HEADER). Primeiro
      // campo do corpo de propósito: é o que o Zuppy checa antes de tratar
      // esta porta como uma impressora da loja.
      [PRINTER_APP_IDENTITY_FIELD]: PRINTER_APP_IDENTITY_VERSION,
      status: isConfigured()
        ? getConnectionStatus()
          ? 'connected'
          : 'disconnected'
        : 'not_configured',
      version: electronApp.getVersion(),
      printer: cfg.printer_name ?? null,
      // Motivo da última falha ao listar impressoras; `null` = listagem ok/ainda não tentada.
      printer_list_error: getPrinterEnumerationError(),
      // Só os dois valores que a impressora entende. O que decide a largura
      // real já é `cfg.paper_size === '58mm' ? 58 : 80` (electron/printer.ts);
      // ecoar aqui um terceiro valor que algum /configure antigo tenha gravado
      // diria ao Zuppy uma largura que este app não usa — e reprovaria o app
      // na validação de forma do outro lado.
      paper_size: cfg.paper_size === '58mm' ? '58mm' : '80mm',
      queue: queueStatus.length,
      lastPrint: logs[0] ?? null,
      tenant_name: cfg.tenant_name ?? null,
      tenant_id: cfg.tenant_id ?? null,
      // Campos ADITIVOS (o Gestor antigo simplesmente ignora):
      //  - `port`: em que porta ESTA instância respondeu. Uma máquina com duas
      //    impressoras tem duas instâncias em portas diferentes, e é por aqui
      //    que a tela de Impressão sabe com qual delas está falando.
      //  - `destination`: a impressora nomeada deste device_token ("Cozinha"),
      //    `null` no token legado da loja.
      //  - `display_name`: como esta instância se chama para um humano
      //    ("Cozinha — Podrão"). `tenant_name` fica como sempre foi: quem já
      //    lê aquele campo não pode ver o texto mudar de significado.
      port,
      destination: cfg.destination ?? null,
      display_name: formatDeviceLabel(cfg),
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
    const maskedToken = maskDeviceToken(device_token)

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
      // `error` != null com `printers: []` = falha ao listar, não ausência de impressoras.
      const { printers, error } = await enumeratePrinters()
      res.json({ printers, error })
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
let boundPort: number | null = null

/**
 * Monta o app Express para uma porta específica. A porta entra por parâmetro
 * (e não por constante) porque a validação de `Host` compara com a porta em
 * que ESTE servidor escuta — com a porta errada aqui, todo request legítimo
 * viraria 403.
 */
function buildExpressApp(port: number): express.Express {
  const expressApp = express()

  // Antes de tudo (inclusive do parse do body): `Host` estranho é DNS
  // rebinding, não cliente legítimo — ver isAllowedLocalHostHeader.
  expressApp.use((req: Request, res: Response, next: NextFunction) => {
    if (!isAllowedLocalHostHeader(req.headers.host, port)) {
      log.warn(`Blocked request with Host header: ${req.headers.host ?? '(ausente)'}`)
      res.status(403).json({ error: 'bad host' })
      return
    }
    next()
  })

  // Identidade em TODA resposta que este servidor chega a servir (o 403 de
  // `Host` acima fica de fora de propósito: request de DNS rebinding não
  // merece nem o eco). Um único lugar, para que nenhum endpoint novo nasça
  // anônimo — ver PRINTER_APP_IDENTITY_HEADER.
  expressApp.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(PRINTER_APP_IDENTITY_HEADER, String(PRINTER_APP_IDENTITY_VERSION))
    next()
  })

  expressApp.use(cors(corsOptions))
  expressApp.use(express.json({ limit: '1mb' }))

  // Log all requests
  expressApp.use((req: Request, _res: Response, next: NextFunction) => {
    log.debug(`${req.method} ${req.path}`)
    next()
  })

  expressApp.use('/', buildRouter(port))

  // Generic error handler
  expressApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('Unhandled HTTP error', err)
    res.status(500).json({ error: err.message })
  })

  return expressApp
}

/** Sobe o servidor em UMA porta. `null` = a porta está ocupada (EADDRINUSE). */
function listenOnPort(port: number): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const onStartupError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        resolve(null)
        return
      }
      reject(err)
    }

    const candidate = buildExpressApp(port).listen(port, HTTP_HOST, () => {
      // Já escutando: a partir daqui um 'error' não é mais falha de startup, e
      // sem NENHUM listener o EventEmitter derrubaria o processo — que está
      // imprimindo pedidos. Fica registrado no log.
      candidate.off('error', onStartupError)
      candidate.on('error', (err) => log.error('HTTP server error', err))
      resolve(candidate)
    })

    candidate.on('error', onStartupError)
  })
}

/**
 * Sobe o servidor HTTP local em 127.0.0.1, na primeira porta livre da lista.
 * Resolve com a porta efetiva.
 *
 * A lista vem de `resolvePortCandidates` (electron/instance.ts): a porta
 * pedida primeiro, as vizinhas depois. Porta ocupada não é erro fatal — quase
 * sempre é a outra impressora desta mesma máquina — mas a porta escolhida
 * SEMPRE vai para o log e para o GET /status; nada aqui acontece em silêncio.
 *
 * Todas ocupadas: rejeita com uma mensagem que diz o que fazer. O app segue
 * imprimindo (o polling não depende deste servidor); o que fica indisponível é
 * o pareamento pela tela do Zuppy — e para isso existe o "colar código" da
 * bandeja (electron/pairing.ts), que não passa por porta nenhuma.
 */
export async function startHttpServer(
  candidatePorts: readonly number[] = [HTTP_PORT]
): Promise<number> {
  const ports = candidatePorts.length > 0 ? candidatePorts : [HTTP_PORT]

  for (const port of ports) {
    const candidate = await listenOnPort(port)
    if (candidate === null) {
      log.warn(`Porta ${port} ocupada (outra instância da Zuppy?) — tentando a próxima`)
      continue
    }

    server = candidate
    boundPort = port
    log.info(`HTTP server listening on http://${HTTP_HOST}:${port}`)
    if (port !== ports[0]) {
      log.warn(
        `A porta pedida (${ports[0]}) estava ocupada: esta instância ficou na ${port}. ` +
          'Pareie esta impressora pela tela de Impressão do Zuppy ou pelo código na bandeja.'
      )
    }
    return port
  }

  throw new Error(
    `Nenhuma porta livre entre ${ports[0]} e ${ports[ports.length - 1]}. ` +
      'Feche instâncias extras da Zuppy Impressora ou inicie esta com --port=<outra porta>.'
  )
}

/** Porta em que o servidor está escutando; `null` se não subiu. */
export function getBoundPort(): number | null {
  return boundPort
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
    boundPort = null
  })
}
