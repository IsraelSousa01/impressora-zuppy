# Zuppy Impressora

App de impressão automática para o Zuppy Food. Roda em segundo plano no Windows, escuta pedidos do Supabase Realtime e imprime via ESC/POS.

## Stack

- **Electron 36** + **electron-vite 2**
- **React 19** + **TypeScript 5** (strict)
- **Supabase Realtime** para receber pedidos em tempo real
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
│   ├── realtime.ts      # Supabase Realtime listener
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
| POST   | `/configure`   | Salva configuração (tenant, Supabase)  |
| GET    | `/printers`    | Lista impressoras instaladas           |
| POST   | `/test-print`  | Imprime página de teste                |

### POST /configure — Payload

```json
{
  "tenant_id": "uuid",
  "supabase_url": "https://xxxx.supabase.co",
  "anon_key": "eyJ...",
  "tenant_name": "Restaurante Exemplo",
  "auto_print": true,
  "device_token": "tok_xxx"
}
```

## Configuração de Ícone

O ícone da bandeja é gerado programaticamente (círculo SVG colorido):
- 🟢 Verde = conectado ao Supabase
- 🟠 Laranja = desconectado (reconectando)
- 🔴 Vermelho = não configurado

Para o instalador, coloque `resources/icon.ico` (mínimo 256×256).
Use https://www.icoconverter.com/ para converter PNG → ICO.

## Auto-atualização

Configure `electron-builder.yml` com seu repositório GitHub e crie releases normalmente. O app verifica atualizações a cada 4 horas.

## Segurança

- Servidor HTTP vincula apenas a `127.0.0.1` (nunca `0.0.0.0`)
- CORS liberado apenas para `https://zuppyfood.app` e `localhost:*`
- Chaves sensíveis nunca são enviadas ao renderer
