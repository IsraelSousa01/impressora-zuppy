/**
 * electron/config.ts
 * Constantes compartilhadas do processo main.
 */

import type { AppConfig } from './store'

/**
 * ZUPPY_APP_URL: base da API do Zuppy que o app consome
 * (/api/printer/auth, /jobs, /orders/[id], /jobs/[id]/confirm).
 *
 * USA `www.` DE PROPÓSITO: o apex `zuppyfood.com.br` faz 307-redirect pra
 * `www.zuppyfood.com.br`, e numa redireção ENTRE HOSTS o fetch descarta o
 * header `Authorization` (regra do padrão). Isso quebrava `/jobs` e
 * `/jobs/[id]/confirm` com 401 (só o stream sobrevivia, porque autentica por
 * `?token=` na URL) — e o confirm falhando fazia o app REIMPRIMIR em loop.
 * Apontar direto pro host que serve (www) preserva o header.
 * Override por env em build/dev sem editar código.
 *
 * É o DEFAULT, não a palavra final: o Gestor que pareia o app manda a própria
 * origem em `api_url` no POST /configure (ver resolveApiBaseUrl), pra o mesmo
 * binário conseguir falar com dev.zuppyfood.com.br sem virar outro build.
 */
export const ZUPPY_APP_URL =
  process.env.ZUPPY_APP_URL ?? 'https://www.zuppyfood.com.br'

/**
 * Origens do Zuppy que este app aceita — LISTA ÚNICA, usada tanto no CORS do
 * servidor local (quem pode falar com localhost:7847) quanto na validação do
 * `api_url` do POST /configure (para onde este app pode mandar o
 * device_token). São a mesma pergunta: "isto é o Zuppy?". Duas listas
 * divergentes deixariam o app aceitar um pareamento que aponta a API pra um
 * host que o CORS jamais deixaria conversar com ele.
 *
 * Aceita: o apex de produção, qualquer subdomínio *.zuppyfood.com.br
 * (gestordepedidos., pedido., dev., www.) e localhost/127.0.0.1 pro dev.
 * Compara a origem INTEIRA e ancorada: nada de path, query, credenciais
 * (`user:pass@`) ou sufixo colado (`zuppyfood.com.br.evil.com`).
 */
export function isAllowedZuppyOrigin(origin: string): boolean {
  return (
    origin === 'https://zuppyfood.com.br' ||
    /^https:\/\/([a-z0-9-]+\.)+zuppyfood\.com\.br$/.test(origin) ||
    /^http:\/\/localhost(:\d+)?$/.test(origin) ||
    /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
  )
}

/**
 * Canoniza a origem que vai virar base da API: `https://zuppyfood.com.br`
 * (apex) vira `https://www.zuppyfood.com.br`; qualquer outra origem passa
 * inalterada.
 *
 * Por quê: o apex responde 308 pro `www.` em TODOS os paths, e numa redireção
 * ENTRE HOSTS o fetch descarta o header `Authorization` — o mesmo motivo de
 * ZUPPY_APP_URL (leia o docblock dele) apontar direto pro www. Um `api_url`
 * apex gravado no pareamento reproduziria aquele bug: `/jobs` e
 * `/jobs/[id]/confirm` em 401 eterno, confirm falhando e app reimprimindo em
 * loop. O CORS NÃO usa isto: lá a pergunta é "quem está falando comigo?" e a
 * comparação com o header `Origin` do navegador é byte a byte.
 *
 * Espera uma origem já normalizada (minúsculas, sem barra final).
 */
export function canonicalizeZuppyApiOrigin(origin: string): string {
  return origin === 'https://zuppyfood.com.br' ? 'https://www.zuppyfood.com.br' : origin
}

/**
 * Base efetiva da API para ESTE app: a origem gravada no pareamento
 * (`api_url`, validada pela allowlist no POST /configure) ou o default de
 * produção. Todo call-site que monta URL da API do Zuppy passa por aqui —
 * ninguém concatena ZUPPY_APP_URL direto, senão um app pareado pelo Gestor de
 * dev continuaria batendo na prod com token de dev e ficaria em 401 pra
 * sempre.
 *
 * Revalida na LEITURA: o store é um JSON no disco do lojista, e o que a
 * gravação de hoje aceita não diz nada sobre o que já está gravado lá (versão
 * anterior do app, edição manual). Valor fora da allowlist cai no default de
 * produção em vez de virar destino do device_token.
 */
export function resolveApiBaseUrl(cfg: Pick<AppConfig, 'api_url'>): string {
  const producao = ZUPPY_APP_URL.replace(/\/+$/, '')
  if (!cfg.api_url) return producao

  const gravado = cfg.api_url.trim().replace(/\/+$/, '')
  return isAllowedZuppyOrigin(gravado) ? gravado : producao
}
