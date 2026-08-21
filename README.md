# Zuppy Impressora

App de impressão automática para o Zuppy Food. Roda em segundo plano no Windows, busca os pedidos por polling na API do Zuppy e imprime via ESC/POS.

## Stack

- **Electron 36** + **electron-vite 2**
- **React 19** + **TypeScript 5** (strict)
- **Polling HTTP na API do Zuppy** (`/api/printer/auth`, `/jobs`, `/orders/[id]`, `/jobs/[id]/confirm`) para receber os pedidos — desde a 1.0.8 não há mais Supabase Realtime aqui
- **node-thermal-printer** para impressão ESC/POS
- **Express** para o servidor HTTP local (porta 7847)
- **electron-store** para persistência local
- **electron-updater** para auto-atualização via GitHub Releases

## Pré-requisitos

- Node.js 20+
- npm 10+
- Windows 10/11 x64

## Instalação

```bash
npm install
```

> ⚠️ O `node-thermal-printer` pode precisar de build nativo. Se houver erros, rode:
> ```bash
> npm install --global windows-build-tools
> ```

## Desenvolvimento

```bash
npm run dev
```

Abre o app Electron com hot-reload. O servidor HTTP sobe na porta 7847.

## Build

```bash
npm run build:win
```

Gera o instalador em `release/ZuppyImpressora-{version}-Setup.exe`.

## Estrutura do Projeto

```
impressora-zuppy/
├── electron/
│   ├── main.ts          # Main process (ponto de entrada)
│   ├── preload.ts       # Bridge renderer ↔ main (contextBridge)
│   ├── http-server.ts   # Express em localhost:7847
│   ├── realtime.ts      # Polling de print jobs na API do Zuppy
│   ├── print-queue.ts   # Fila de impressão com retry
│   ├── printer.ts       # ESC/POS via node-thermal-printer
│   ├── tray.ts          # Ícone na bandeja do sistema
│   ├── store.ts         # electron-store (config + logs)
│   └── logger.ts        # Logger estruturado
├── src/
│   ├── App.tsx          # Interface React (janela de configurações)
│   ├── main.tsx         # Entrypoint React
│   ├── index.html       # HTML base
│   └── index.css        # Estilos globais
├── resources/
│   └── icon.ico         # Ícone do instalador (substitua pelo real)
├── electron.vite.config.ts
├── electron-builder.yml
├── package.json
└── tsconfig.json
```

## Endpoints HTTP (localhost:7847)

| Método | Rota           | Descrição                              |
|--------|----------------|----------------------------------------|
| GET    | `/ping`        | Health check → `{ ok: true }`         |
| GET    | `/status`      | Status atual da conexão e fila         |
| POST   | `/configure`   | Pareia o app (tenant, device_token, api_url) |
| GET    | `/printers`    | Lista impressoras instaladas           |
| POST   | `/test-print`  | Imprime página de teste                |

### POST /configure — Payload

```json
{
  "device_token": "tok_xxx",
  "tenant_id": "uuid",
  "tenant_name": "Restaurante Exemplo",
  "auto_print": true,
  "printer_name": "EPSON TM-T20",
  "paper_size": "80mm",
  "api_url": "https://gestordepedidos.zuppyfood.com.br"
}
```

Só `device_token` é obrigatório (string não vazia; sem ele, `400`). Os demais campos são opcionais e o que vier é mesclado na config salva.

**`api_url`** — origem da API do Zuppy que este app vai chamar. Serve para o mesmo instalador atender produção e dev: sem ele, um app pareado pelo Gestor de dev bate na produção com token de dev e fica em `401` para sempre. O motivo completo está no docblock de `resolveApiBaseUrl` (`electron/config.ts`).

- Origem absoluta, sem path/query, e dentro da allowlist (abaixo); qualquer outra coisa → `400 { "error": "api_url not allowed" }` **sem gravar nada** (nem os outros campos).
- Precisa ser igual ao `Origin` do request — apex e `www.` contam como iguais, porque os dois lados são canonizados antes da comparação. Diferente → `400 { "error": "api_url must match request origin" }`.
- Mandar `api_url` **exige** o header `Origin`; sem ele → `400 { "error": "api_url requires Origin" }`. Body sem `api_url` continua aceito sem `Origin` (Gestor antigo, chamada same-process).
- `https://zuppyfood.com.br` é **gravado como** `https://www.zuppyfood.com.br`: o apex responde `308` para o `www.` em todos os paths, e numa redireção entre hosts o `fetch` descarta o header `Authorization`.
- Destino local (`http://localhost[:porta]`, `http://127.0.0.1[:porta]`) só é aceito **fora de build empacotado** (`npm run dev`). No app instalado na loja → `400 { "error": "api_url not allowed" }`.
- **Ausente = limpa o valor salvo** e o app volta ao default de produção (`https://www.zuppyfood.com.br`). O app segue quem o pareou por último.
- Mudar `device_token` ou `tenant_id` invalida a sessão atual e força re-autenticação. Mudar só o `api_url` **não** zera a sessão: ela é emitida pelo backend, não pelo host, e um host que não a reconheça devolve `401` no poll seguinte, que já re-autentica.

`GET /status` ecoa o valor salvo em `api_url` (`null` quando é o default).

## Configuração de Ícone

O ícone da bandeja é gerado programaticamente (círculo SVG colorido):
- 🟢 Verde = conectado à API do Zuppy
- 🟠 Laranja = desconectado (reconectando)
- 🔴 Vermelho = não configurado

Para o instalador, coloque `resources/icon.ico` (mínimo 256×256).
Use https://www.icoconverter.com/ para converter PNG → ICO.

## Auto-atualização

Configure `electron-builder.yml` com seu repositório GitHub e crie releases normalmente. O app verifica atualizações a cada 4 horas.

## Segurança

- Servidor HTTP vincula apenas a `127.0.0.1` (nunca `0.0.0.0`)
- Header `Host` aceito só como `127.0.0.1:7847` ou `localhost:7847`; qualquer outro → `403 { "error": "bad host" }` (barra DNS rebinding, que chega como same-origin e passa longe do CORS)
- CORS liberado apenas para `https://zuppyfood.com.br`, qualquer subdomínio de `zuppyfood.com.br` (em qualquer profundidade: `gestordepedidos.`, `dev.`, `www.`…), `http://localhost[:porta]` e `http://127.0.0.1[:porta]` — `isAllowedZuppyOrigin` em `electron/config.ts`, a mesma lista que valida o `api_url` do `/configure`
- Os destinos `localhost`/`127.0.0.1` valem como `api_url` só em build de desenvolvimento; no app empacotado, nunca
- Chaves sensíveis nunca são enviadas ao renderer
