/**
 * electron/config.ts
 * Constantes compartilhadas do processo main.
 *
 * ZUPPY_APP_URL: base da API do Zuppy que o app consome
 * (/api/printer/auth, /jobs, /jobs/stream, /orders/[id], /jobs/[id]/confirm).
 * Domínio canônico de produção é zuppyfood.com.br (ver lib/subdomain.ts no
 * repo web). Override por env em build/dev sem editar código.
 */
export const ZUPPY_APP_URL = process.env.ZUPPY_APP_URL ?? 'https://zuppyfood.com.br'
