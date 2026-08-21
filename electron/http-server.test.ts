/**
 * electron/http-server.test.ts
 *
 * Cobre as barreiras de entrada do servidor local, todas alimentadas direto
 * pelo navegador (tudo é entrada não confiável):
 *
 *   - validatePrintRawDocument (POST /print-raw): base64 estrito, teto de
 *     tamanho decodificado e exigência do init ESC/POS (0x1B 0x40) antes de
 *     qualquer byte chegar à impressora.
 *   - planConfigureUpdate (POST /configure): `api_url` dentro da allowlist,
 *     canonizado (apex ⇒ www) e igual ao `Origin` do pareamento; request
 *     inválido não grava nada; troca de identidade (device_token ou
 *     tenant_id — não o api_url) zera a sessão.
 *   - isAllowedLocalHostHeader: só o loopback pode ser o `Host` da requisição,
 *     que é o que denuncia um DNS rebinding.
 *
 * `http-server.ts` importa `electron` (app.getVersion no /status) e, via
 * `./store`, o `electron-store` — ambos exigem rodar dentro do Electron.
 * Mocka-se os dois só pra permitir o import fora do Electron (mesmo padrão
 * de print-queue.test.ts); a função testada é pura e não toca nenhum deles.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
  },
}))

vi.mock('electron-store', () => {
  class MockElectronStore<T extends Record<string, unknown>> {
    private data: T
    constructor(opts: { defaults: T }) {
      this.data = { ...opts.defaults }
    }
    get<K extends keyof T>(key: K): T[K] {
      return this.data[key]
    }
    set<K extends keyof T>(key: K, value: T[K]): void {
      this.data[key] = value
    }
  }
  return { default: MockElectronStore }
})

const {
  validatePrintRawDocument,
  PRINT_RAW_MAX_DECODED_BYTES,
  planConfigureUpdate,
  isAllowedLocalHostHeader,
} = await import('./http-server')

const ESC_POS_INIT = Buffer.from([0x1b, 0x40])

/** Documento ESC/POS mínimo e legítimo: init + texto. */
function validDocumentBase64(payload = 'CALIBRACAO 48 COLS\n'): string {
  return Buffer.concat([ESC_POS_INIT, Buffer.from(payload, 'ascii')]).toString('base64')
}

describe('validatePrintRawDocument', () => {
  it('ausente / não-string / vazio: rejeita pedindo o campo', () => {
    for (const input of [undefined, null, 123, {}, [], '']) {
      const result = validatePrintRawDocument(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/bytes_base64/)
    }
  })

  it('base64 com caracteres fora do alfabeto: rejeita antes de decodificar', () => {
    // Buffer.from é leniente e ignoraria o lixo em silêncio — a validação
    // estrita existe exatamente pra barrar isso.
    const result = validatePrintRawDocument('não é@base64!')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not valid base64/)
  })

  it('base64 com comprimento não múltiplo de 4: rejeita', () => {
    const result = validatePrintRawDocument('abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not valid base64/)
  })

  it('base64 válido mas sem o init ESC/POS: rejeita sem imprimir', () => {
    const semInit = Buffer.from('lixo arbitrario', 'ascii').toString('base64')
    const result = validatePrintRawDocument(semInit)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/0x1B 0x40/)
  })

  it('documento de 1 byte (só ESC, sem @): rejeita', () => {
    const result = validatePrintRawDocument(Buffer.from([0x1b]).toString('base64'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/0x1B 0x40/)
  })

  it('acima do teto de tamanho: rejeita citando o limite', () => {
    const gigante = Buffer.alloc(PRINT_RAW_MAX_DECODED_BYTES + 1, 0x20)
    ESC_POS_INIT.copy(gigante)
    const result = validatePrintRawDocument(gigante.toString('base64'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/too large/)
  })

  it('exatamente no teto: aceita (limite é inclusivo)', () => {
    const noLimite = Buffer.alloc(PRINT_RAW_MAX_DECODED_BYTES, 0x20)
    ESC_POS_INIT.copy(noLimite)
    const result = validatePrintRawDocument(noLimite.toString('base64'))
    expect(result.ok).toBe(true)
  })

  it('documento legítimo: aceita e devolve os bytes idênticos ao original', () => {
    const original = Buffer.concat([
      ESC_POS_INIT,
      Buffer.from('REGUA |----+----1----+----2|\n', 'ascii'),
    ])
    const result = validatePrintRawDocument(original.toString('base64'))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytes.equals(original)).toBe(true)
  })

  it('documento mínimo (só o init, 2 bytes): aceita', () => {
    const result = validatePrintRawDocument(ESC_POS_INIT.toString('base64'))
    expect(result.ok).toBe(true)
  })
})

describe('planConfigureUpdate', () => {
  /** App já pareado com a produção pelo Gestor (estado mais comum). */
  const pareadoNaProducao = {
    device_token: 'tok_loja_1',
    tenant_id: 'tenant-1',
    api_url: null,
    session_token: 'sess_antiga',
    session_expires_at: '2099-01-01T00:00:00Z',
  }

  /**
   * Store real da frota 1.2.0: a chave `api_url` nunca existiu lá. Não é o
   * mesmo que `api_url: null` — é o estado de TODO app instalado hoje.
   */
  const frotaSemApiUrl = {
    device_token: 'tok_loja_1',
    tenant_id: 'tenant-1',
    session_token: 'sess_antiga',
    session_expires_at: '2099-01-01T00:00:00Z',
  }

  /** App rodando fora de build empacotado: o Gestor em localhost pode parear. */
  const EM_DEV = { allowLocalApiOrigin: true }
  /** App instalado na loja: destino local é sempre suspeito. */
  const EMPACOTADO = { allowLocalApiOrigin: false }

  /** Origem real do Gestor em produção — é ela que pareia as lojas. */
  const ORIGIN_GESTOR = 'https://gestordepedidos.zuppyfood.com.br'

  it('device_token ausente: rejeita antes de qualquer escrita', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { tenant_id: 'tenant-1' },
      ORIGIN_GESTOR,
      EMPACOTADO
    )
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.status).toBe(400)
      expect(plan.error).toMatch(/device_token/)
    }
  })

  it('device_token não-string ou vazio: 400 (entrada do navegador)', () => {
    for (const lixo of [12345, '', {}, true, []]) {
      const plan = planConfigureUpdate(
        pareadoNaProducao,
        { device_token: lixo as unknown as string },
        ORIGIN_GESTOR,
        EMPACOTADO
      )
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.error).toMatch(/device_token/)
    }
  })

  it('api_url permitido e igual ao Origin: grava e PRESERVA a sessão', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { device_token: 'tok_loja_1', tenant_id: 'tenant-1', api_url: 'https://dev.zuppyfood.com.br' },
      'https://dev.zuppyfood.com.br',
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.patch.api_url).toBe('https://dev.zuppyfood.com.br')
    // A sessão é emitida pelo backend, não pelo host: mudar só a base da API
    // não a invalida. Se o host novo não reconhecer a sessão, o 401 do poll
    // re-autentica sozinho — zerar aqui recriaria o ping-pong de re-auth.
    expect(plan.identityChanged).toBe(false)
    expect('session_token' in plan.patch).toBe(false)
    expect('session_expires_at' in plan.patch).toBe(false)
  })

  it('api_url no apex: grava o www (o 308 cross-host descartaria o Authorization)', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { device_token: 'tok_loja_1', api_url: 'https://zuppyfood.com.br' },
      'https://zuppyfood.com.br',
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.patch.api_url).toBe('https://www.zuppyfood.com.br')
  })

  it('Origin no apex e api_url no www: aceita (apex e www são o mesmo host)', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { device_token: 'tok_loja_1', api_url: 'https://www.zuppyfood.com.br' },
      'https://zuppyfood.com.br',
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.patch.api_url).toBe('https://www.zuppyfood.com.br')
  })

  it('api_url fora da allowlist: 400 e nenhum patch (nem os outros campos)', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      {
        device_token: 'tok_novo',
        printer_name: 'EPSON',
        api_url: 'https://zuppyfood.com.br.evil.com',
      },
      'https://zuppyfood.com.br.evil.com',
      EMPACOTADO
    )
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.status).toBe(400)
      expect(plan.error).toBe('api_url not allowed')
    }
    expect(plan).not.toHaveProperty('patch')
  })

  it('api_url que não é string: 400 (entrada do navegador não é confiável)', () => {
    for (const lixo of [123, {}, [], true]) {
      const plan = planConfigureUpdate(
        pareadoNaProducao,
        { device_token: 'tok_loja_1', api_url: lixo },
        ORIGIN_GESTOR,
        EMPACOTADO
      )
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.error).toBe('api_url not allowed')
    }
  })

  it('api_url permitido mas diferente do Origin: 400', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { device_token: 'tok_loja_1', api_url: 'https://dev.zuppyfood.com.br' },
      ORIGIN_GESTOR,
      EMPACOTADO
    )
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.status).toBe(400)
      expect(plan.error).toBe('api_url must match request origin')
    }
  })

  it('api_url e Origin diferindo só em barra final/caixa: aceita (normaliza os dois)', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { device_token: 'tok_loja_1', api_url: 'https://DEV.zuppyfood.com.br/' },
      'https://dev.zuppyfood.com.br',
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.patch.api_url).toBe('https://dev.zuppyfood.com.br')
  })

  it('api_url sem header Origin: 400 — nada amarra o destino a quem pediu', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { device_token: 'tok_loja_1', api_url: 'https://dev.zuppyfood.com.br' },
      undefined,
      EMPACOTADO
    )
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.status).toBe(400)
      expect(plan.error).toBe('api_url requires Origin')
    }
  })

  it('body sem api_url e sem Origin: segue aceito (Gestor antigo / same-process)', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { device_token: 'tok_loja_1', printer_name: 'EPSON TM-T20' },
      undefined,
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.patch.api_url).toBeNull()
  })

  it('destino local: aceito fora de build empacotado, recusado no app instalado', () => {
    for (const local of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      const emDev = planConfigureUpdate(
        pareadoNaProducao,
        { device_token: 'tok_loja_1', api_url: local },
        local,
        EM_DEV
      )
      expect(emDev.ok).toBe(true)
      if (emDev.ok) expect(emDev.patch.api_url).toBe(local)

      // Na loja, quem escuta em localhost é qualquer programa da máquina.
      const empacotado = planConfigureUpdate(
        pareadoNaProducao,
        { device_token: 'tok_loja_1', api_url: local },
        local,
        EMPACOTADO
      )
      expect(empacotado.ok).toBe(false)
      if (!empacotado.ok) expect(empacotado.error).toBe('api_url not allowed')
    }
  })

  it('api_url ausente: limpa o valor salvo e PRESERVA a sessão', () => {
    // Gestor antigo (não manda o campo) devolve o app ao default de produção —
    // o app segue quem o pareou por último. `null` explícito porque setConfig
    // faz merge raso: campo omitido ficaria com o valor antigo. Voltar ao
    // default não é trocar de identidade: mesmo device_token, mesmo tenant.
    const plan = planConfigureUpdate(
      { ...pareadoNaProducao, api_url: 'https://dev.zuppyfood.com.br' },
      { device_token: 'tok_loja_1', tenant_id: 'tenant-1' },
      'https://www.zuppyfood.com.br',
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.patch.api_url).toBeNull()
    expect(plan.identityChanged).toBe(false)
    expect('session_token' in plan.patch).toBe(false)
    expect('session_expires_at' in plan.patch).toBe(false)
  })

  it('api_url ausente e já era default: patch com null e sessão preservada', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      {
        device_token: 'tok_loja_1',
        tenant_id: 'tenant-1',
        printer_name: 'EPSON TM-T20',
      },
      ORIGIN_GESTOR,
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.patch.api_url).toBeNull()
    expect(plan.identityChanged).toBe(false)
    // Trocar de impressora não pode derrubar a sessão ativa.
    expect('session_token' in plan.patch).toBe(false)
    expect('session_expires_at' in plan.patch).toBe(false)
    expect(plan.patch.printer_name).toBe('EPSON TM-T20')
  })

  it('store da frota 1.2.0 (sem a chave api_url) + Gestor antigo: identidade intacta', () => {
    const plan = planConfigureUpdate(
      frotaSemApiUrl,
      { device_token: 'tok_loja_1', tenant_id: 'tenant-1' },
      ORIGIN_GESTOR,
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.identityChanged).toBe(false)
    expect(plan.patch.api_url).toBeNull()
    expect('session_token' in plan.patch).toBe(false)
    expect('session_expires_at' in plan.patch).toBe(false)
  })

  it('re-pareamento idêntico (mesmo token, tenant e api_url): sessão intacta', () => {
    const plan = planConfigureUpdate(
      { ...pareadoNaProducao, api_url: 'https://dev.zuppyfood.com.br' },
      {
        device_token: 'tok_loja_1',
        tenant_id: 'tenant-1',
        api_url: 'https://dev.zuppyfood.com.br',
      },
      'https://dev.zuppyfood.com.br',
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.identityChanged).toBe(false)
    expect('session_token' in plan.patch).toBe(false)
    expect('session_expires_at' in plan.patch).toBe(false)
  })

  it('device_token novo: troca de identidade e sessão zerada explicitamente', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { device_token: 'tok_outra_loja' },
      ORIGIN_GESTOR,
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.identityChanged).toBe(true)
    // `undefined` NO patch, não ausência dele: setConfig faz merge raso, e a
    // chave precisa chegar lá pra apagar a sessão da loja anterior.
    expect('session_token' in plan.patch).toBe(true)
    expect('session_expires_at' in plan.patch).toBe(true)
    expect(plan.patch.session_token).toBeUndefined()
    expect(plan.patch.session_expires_at).toBeUndefined()
  })

  it('tenant_id novo: troca de identidade e sessão zerada explicitamente', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { device_token: 'tok_loja_1', tenant_id: 'tenant-2' },
      ORIGIN_GESTOR,
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.identityChanged).toBe(true)
    expect('session_token' in plan.patch).toBe(true)
    expect('session_expires_at' in plan.patch).toBe(true)
    expect(plan.patch.session_token).toBeUndefined()
  })

  it('campos opcionais ausentes ficam fora do patch (setConfig é merge raso)', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      { device_token: 'tok_loja_1' },
      ORIGIN_GESTOR,
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    for (const campo of ['tenant_id', 'tenant_name', 'auto_print', 'printer_name', 'paper_size']) {
      expect(campo in plan.patch).toBe(false)
    }
  })

  it('campo desconhecido no body: ignorado, sem quebrar o pareamento', () => {
    const plan = planConfigureUpdate(
      pareadoNaProducao,
      {
        device_token: 'tok_loja_1',
        ...({ campo_do_futuro: 'valor' } as Record<string, unknown>),
      },
      ORIGIN_GESTOR,
      EMPACOTADO
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.patch).not.toHaveProperty('campo_do_futuro')
  })
})

describe('isAllowedLocalHostHeader', () => {
  const PORTA = 7847

  it('aceita o loopback pelo IP e pelo nome, na porta do servidor', () => {
    expect(isAllowedLocalHostHeader('127.0.0.1:7847', PORTA)).toBe(true)
    expect(isAllowedLocalHostHeader('localhost:7847', PORTA)).toBe(true)
    expect(isAllowedLocalHostHeader('LOCALHOST:7847', PORTA)).toBe(true)
  })

  it('rejeita domínio de terceiro (DNS rebinding resolve o domínio pro loopback)', () => {
    expect(isAllowedLocalHostHeader('evil.com', PORTA)).toBe(false)
    expect(isAllowedLocalHostHeader('evil.com:7847', PORTA)).toBe(false)
    expect(isAllowedLocalHostHeader('localhost.evil.com:7847', PORTA)).toBe(false)
  })

  it('rejeita outra porta e Host ausente', () => {
    expect(isAllowedLocalHostHeader('127.0.0.1:9999', PORTA)).toBe(false)
    expect(isAllowedLocalHostHeader('localhost', PORTA)).toBe(false)
    expect(isAllowedLocalHostHeader(undefined, PORTA)).toBe(false)
    expect(isAllowedLocalHostHeader('', PORTA)).toBe(false)
  })
})
