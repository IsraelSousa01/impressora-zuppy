/**
 * electron/config.ts
 * Constantes compartilhadas do processo main.
 *
 * ZUPPY_APP_URL: base da API do Zuppy que o app consome
 * (/api/printer/auth, /jobs, /jobs/stream, /orders/[id], /jobs/[id]/confirm).
 *
 * USA `www.` DE PROPÓSITO: o apex `zuppyfood.com.br` faz 307-redirect pra
 * `www.zuppyfood.com.br`, e numa redireção ENTRE HOSTS o fetch descarta o
 * header `Authorization` (regra do padrão). Isso quebrava `/jobs` e
 * `/jobs/[id]/confirm` com 401 (só o stream sobrevivia, porque autentica por
 * `?token=` na URL) — e o confirm falhando fazia o app REIMPRIMIR em loop.
 * Apontar direto pro host que serve (www) preserva o header.
 * Override por env em build/dev sem editar código.
 */
export const ZUPPY_APP_URL =
  process.env.ZUPPY_APP_URL ?? 'https://www.zuppyfood.com.br'
