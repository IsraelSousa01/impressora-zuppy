/**
 * electron/instance.test.ts
 *
 * Cobre a decisão de QUEM é esta instância — porta, profile, pasta de dados e
 * auto-start — porque é dela que depende a regra número um desta mudança:
 * quem já tem o app instalado e abre sem nenhum argumento tem que continuar
 * exatamente como estava (porta 7847, pasta de dados de hoje, login item com
 * o mesmo nome e sem args). Um app que "repareia sozinho" depois de atualizar
 * é comanda perdida em restaurante aberto.
 *
 * `instance.ts` é puro (nem electron nem electron-store), então roda direto.
 */
import { describe, it, expect } from 'vitest'

import {
  resolveInstanceIdentity,
  resolvePortCandidates,
  resolveUserDataPath,
  resolveLoginItemSettings,
  sanitizeProfileName,
  DEFAULT_LOCAL_PORT,
  PORT_SEARCH_SPAN,
} from './instance'

/** argv de um app empacotado: o exe e mais nada. */
const ARGV_SEM_ARGUMENTOS = ['C:\\Program Files\\Zuppy Impressora\\ZuppyImpressora.exe']

describe('instância default (a de hoje)', () => {
  it('sem argv e sem env: porta 7847, sem profile, sem avisos', () => {
    expect(resolveInstanceIdentity(ARGV_SEM_ARGUMENTOS, {})).toEqual({
      requestedPort: DEFAULT_LOCAL_PORT,
      profile: null,
      warnings: [],
    })
    expect(DEFAULT_LOCAL_PORT).toBe(7847)
  })

  it('profile null NÃO muda a pasta de dados', () => {
    const padrao = 'C:\\Users\\dono\\AppData\\Roaming\\Zuppy Impressora'
    expect(resolveUserDataPath(padrao, null)).toBe(padrao)
  })

  it('auto-start é exatamente o registro de hoje: mesmo nome, sem args', () => {
    expect(resolveLoginItemSettings({ profile: null, requestedPort: DEFAULT_LOCAL_PORT })).toEqual({
      openAtLogin: true,
      openAsHidden: true,
      name: 'Zuppy Impressora',
    })
  })

  it('--port=7847 explícito continua sendo a instância default', () => {
    // Um atalho antigo que já passasse a porta padrão não pode ganhar pasta
    // nova (seria repareamento silencioso).
    const identity = resolveInstanceIdentity([...ARGV_SEM_ARGUMENTOS, '--port=7847'], {})
    expect(identity).toEqual({ requestedPort: 7847, profile: null, warnings: [] })
  })
})

describe('resolveInstanceIdentity — porta', () => {
  it('aceita --port=N e --port N', () => {
    expect(resolveInstanceIdentity(['app.exe', '--port=7848'], {}).requestedPort).toBe(7848)
    expect(resolveInstanceIdentity(['app.exe', '--port', '7849'], {}).requestedPort).toBe(7849)
  })

  it('aceita ZUPPY_LOCAL_PORT, e o argv tem precedência sobre o env', () => {
    expect(resolveInstanceIdentity(['app.exe'], { ZUPPY_LOCAL_PORT: '7850' }).requestedPort).toBe(7850)
    expect(
      resolveInstanceIdentity(['app.exe', '--port=7848'], { ZUPPY_LOCAL_PORT: '7850' }).requestedPort
    ).toBe(7848)
  })

  it('porta sem sentido cai no default COM aviso — nunca em silêncio', () => {
    for (const raw of ['abc', '0', '80', '70000', '7848.5', '']) {
      const identity = resolveInstanceIdentity(['app.exe', `--port=${raw}`], {})
      expect(identity.requestedPort).toBe(DEFAULT_LOCAL_PORT)
      expect(identity.warnings).toHaveLength(1)
      expect(identity.warnings[0]).toMatch(/ignorada/)
    }
  })

  it('porta inválida também não inventa profile (segue a instância default)', () => {
    expect(resolveInstanceIdentity(['app.exe', '--port=abc'], {}).profile).toBeNull()
  })
})

describe('resolveInstanceIdentity — profile', () => {
  it('--profile nomeia a instância', () => {
    expect(resolveInstanceIdentity(['app.exe', '--profile=cozinha'], {}).profile).toBe('cozinha')
    expect(resolveInstanceIdentity(['app.exe'], { ZUPPY_PROFILE: 'bar' }).profile).toBe('bar')
  })

  it('só --port (≠ default) já dá pasta própria, derivada da porta pedida', () => {
    // O dono cria um atalho com uma flag só; duas impressoras não podem
    // dividir device_token por falta de um segundo argumento.
    expect(resolveInstanceIdentity(['app.exe', '--port=7848'], {}).profile).toBe('porta-7848')
  })

  it('--profile vence a derivação pela porta', () => {
    expect(
      resolveInstanceIdentity(['app.exe', '--port=7848', '--profile=cozinha'], {}).profile
    ).toBe('cozinha')
  })

  it('profile sem nenhum caractere utilizável: avisa e volta à regra da porta', () => {
    const identity = resolveInstanceIdentity(['app.exe', '--profile=   '], {})
    expect(identity.profile).toBeNull()
    expect(identity.warnings[0]).toMatch(/não tem nenhum caractere utilizável/)
  })
})

describe('sanitizeProfileName — o profile vira PASTA', () => {
  it('normaliza acento, espaço e maiúscula', () => {
    expect(sanitizeProfileName('  Cozinha Quente ')).toBe('cozinha-quente')
    expect(sanitizeProfileName('Balcão')).toBe('balc-o')
  })

  it('não deixa nada que escape da pasta de dados', () => {
    for (const malicioso of ['../../evil', '..\\..\\evil', 'C:/Windows', './x', '..']) {
      const slug = sanitizeProfileName(malicioso)
      expect(slug).not.toMatch(/[./\\:]/)
    }
    expect(sanitizeProfileName('..')).toBe('')
  })

  it('limita o tamanho e não termina em hífen', () => {
    const slug = sanitizeProfileName('a'.repeat(80))
    expect(slug.length).toBeLessThanOrEqual(24)
    expect(sanitizeProfileName('cozinha!!!')).toBe('cozinha')
  })
})

describe('resolvePortCandidates', () => {
  it('a pedida primeiro, depois a faixa curta', () => {
    expect(resolvePortCandidates(DEFAULT_LOCAL_PORT)).toEqual([7847, 7848, 7849, 7850])
    expect(resolvePortCandidates(7848)).toHaveLength(PORT_SEARCH_SPAN)
    expect(resolvePortCandidates(7848)[0]).toBe(7848)
  })

  it('não passa do teto de portas válidas', () => {
    expect(resolvePortCandidates(65534)).toEqual([65534, 65535])
  })
})

describe('resolveUserDataPath', () => {
  const padrao = 'C:\\Users\\dono\\AppData\\Roaming\\Zuppy Impressora'

  it('profile vira sufixo da pasta — nunca a mesma pasta de outro profile', () => {
    expect(resolveUserDataPath(padrao, 'cozinha')).toBe(`${padrao}-cozinha`)
    expect(resolveUserDataPath(padrao, 'bar')).not.toBe(resolveUserDataPath(padrao, 'cozinha'))
    expect(resolveUserDataPath(padrao, 'cozinha')).not.toBe(padrao)
  })
})

describe('resolveLoginItemSettings — a instância tem que voltar do reboot', () => {
  it('instância com profile carrega os próprios argumentos', () => {
    expect(resolveLoginItemSettings({ profile: 'cozinha', requestedPort: 7848 })).toEqual({
      openAtLogin: true,
      openAsHidden: true,
      name: 'Zuppy Impressora (cozinha)',
      args: ['--profile=cozinha', '--port=7848'],
    })
  })

  it('nome do registro difere por profile — senão uma sobrescreve a outra', () => {
    const cozinha = resolveLoginItemSettings({ profile: 'cozinha', requestedPort: 7848 })
    const bar = resolveLoginItemSettings({ profile: 'bar', requestedPort: 7849 })
    const padrao = resolveLoginItemSettings({ profile: null, requestedPort: 7847 })
    expect(new Set([cozinha.name, bar.name, padrao.name]).size).toBe(3)
  })
})
