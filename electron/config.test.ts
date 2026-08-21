/**
 * electron/config.test.ts
 *
 * Cobre as regras puras que decidem COM QUEM este app fala:
 *
 *   - isAllowedZuppyOrigin: a allowlist única (CORS do servidor local +
 *     validação do `api_url` do POST /configure). Um furo aqui deixa uma
 *     página qualquer apontar a impressora da loja pro host dela — e o
 *     device_token vai junto.
 *   - canonicalizeZuppyApiOrigin: o apex nunca pode virar base da API (308
 *     cross-host descarta o `Authorization`).
 *   - resolveApiBaseUrl: a base efetiva da API (origem do pareamento ou o
 *     default de produção), sempre sem barra final e sempre revalidada.
 *
 * `config.ts` não importa nada em runtime (o `AppConfig` é `import type`),
 * então este arquivo roda sem mock de electron/electron-store.
 */
import { describe, it, expect } from 'vitest'

import {
  isAllowedZuppyOrigin,
  canonicalizeZuppyApiOrigin,
  resolveApiBaseUrl,
  ZUPPY_APP_URL,
} from './config'

/** O default sempre sai sem barra final — é o que resolveApiBaseUrl devolve. */
const PRODUCAO = ZUPPY_APP_URL.replace(/\/+$/, '')

describe('isAllowedZuppyOrigin', () => {
  const casos: Array<[origin: string, permitido: boolean, porque: string]> = [
    ['https://zuppyfood.com.br', true, 'apex de produção'],
    ['https://www.zuppyfood.com.br', true, 'host que realmente serve a API'],
    ['https://dev.zuppyfood.com.br', true, 'ambiente de dev'],
    ['https://gestordepedidos.zuppyfood.com.br', true, 'Gestor'],
    ['http://localhost:3000', true, 'dev local'],
    ['http://127.0.0.1:3000', true, 'dev local por IP'],
    ['http://localhost', true, 'dev local sem porta'],
    ['https://x.vercel.app', false, 'preview fora do domínio'],
    ['https://zuppyfood.com.br.evil.com', false, 'sufixo colado no domínio'],
    ['http://zuppyfood.com.br', false, 'produção sem TLS'],
    ['https://www.zuppyfood.com.br/gestor', false, 'origem com path não é origem'],
    ['', false, 'string vazia'],
  ]

  for (const [origin, permitido, porque] of casos) {
    it(`${permitido ? 'aceita' : 'rejeita'} ${origin || '(vazio)'} — ${porque}`, () => {
      expect(isAllowedZuppyOrigin(origin)).toBe(permitido)
    })
  }

  it('rejeita origem com credenciais embutidas', () => {
    expect(isAllowedZuppyOrigin('https://user:senha@www.zuppyfood.com.br')).toBe(false)
  })

  it('rejeita origem com query', () => {
    expect(isAllowedZuppyOrigin('https://www.zuppyfood.com.br?a=1')).toBe(false)
  })
})

describe('canonicalizeZuppyApiOrigin', () => {
  it('apex vira www — o 308 cross-host descartaria o Authorization', () => {
    expect(canonicalizeZuppyApiOrigin('https://zuppyfood.com.br')).toBe(
      'https://www.zuppyfood.com.br'
    )
  })

  it('qualquer outra origem passa inalterada', () => {
    for (const origin of [
      'https://www.zuppyfood.com.br',
      'https://gestordepedidos.zuppyfood.com.br',
      'https://dev.zuppyfood.com.br',
      'http://localhost:3000',
    ]) {
      expect(canonicalizeZuppyApiOrigin(origin)).toBe(origin)
    }
  })

  it('é idempotente (aplicar duas vezes não muda nada)', () => {
    const uma = canonicalizeZuppyApiOrigin('https://zuppyfood.com.br')
    expect(canonicalizeZuppyApiOrigin(uma)).toBe(uma)
  })
})

describe('resolveApiBaseUrl', () => {
  it('sem api_url: cai no default de produção', () => {
    expect(resolveApiBaseUrl({})).toBe(PRODUCAO)
    expect(resolveApiBaseUrl({ api_url: null })).toBe(PRODUCAO)
  })

  it('com api_url: usa a origem do pareamento', () => {
    expect(resolveApiBaseUrl({ api_url: 'https://dev.zuppyfood.com.br' })).toBe(
      'https://dev.zuppyfood.com.br'
    )
  })

  it('remove barra(s) final(is) — a URL é montada com `${base}/api/...`', () => {
    expect(resolveApiBaseUrl({ api_url: 'https://dev.zuppyfood.com.br/' })).toBe(
      'https://dev.zuppyfood.com.br'
    )
    expect(resolveApiBaseUrl({ api_url: 'http://localhost:3000//' })).toBe(
      'http://localhost:3000'
    )
  })

  it('o default também sai sem barra final', () => {
    expect(resolveApiBaseUrl({})).not.toMatch(/\/$/)
  })

  it('api_url gravado fora da allowlist: ignora e usa o default de produção', () => {
    // O store é um JSON no disco do lojista: o que já está gravado não passou
    // necessariamente pela validação de hoje.
    for (const gravado of [
      'https://evil.com',
      'https://zuppyfood.com.br.evil.com',
      'http://www.zuppyfood.com.br',
      'https://www.zuppyfood.com.br/gestor',
      'lixo',
    ]) {
      expect(resolveApiBaseUrl({ api_url: gravado })).toBe(PRODUCAO)
    }
  })

  it('api_url gravado com espaços em volta: aceita o valor limpo', () => {
    expect(resolveApiBaseUrl({ api_url: '  https://dev.zuppyfood.com.br  ' })).toBe(
      'https://dev.zuppyfood.com.br'
    )
  })
})
