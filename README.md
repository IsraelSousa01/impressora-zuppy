# Zuppy Impressora

App de impressão automática para o Zuppy Food. Roda em segundo plano no Windows, busca os pedidos por polling na API do Zuppy e imprime via ESC/POS.

## Stack

- **Electron 36** + **electron-vite 2**
- **React 19** + **TypeScript 5** (strict)
- **Polling HTTP na API do Zuppy** (`/api/printer/auth`, `/jobs`, `/orders/[id]`, `/jobs/[id]/confirm`) para receber os pedidos — desde a 1.0.8 não há mais Supabase Realtime aqui
- **node-thermal-printer** para impressão ESC/POS
- **Express** para o servidor HTTP local (porta 7847 na instância padrão; ver *Várias impressoras na mesma máquina*)
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

Para simular uma segunda impressora na mesma máquina:

```bash
npm run dev -- --profile=cozinha --port=7848
```

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
│   ├── windows-printer-list.ts # Lista as impressoras do Windows (PowerShell, sem wmic)
│   ├── tray.ts          # Ícone na bandeja do sistema
│   ├── store.ts         # electron-store (config + logs)
│   ├── instance.ts      # Porta e profile desta instância (puro)
│   ├── destination.ts   # Impressora nomeada do device_token (puro)
│   ├── pairing.ts       # Pareamento pelo código copiado
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

## Várias impressoras na mesma máquina

Cada impressora nomeada no Zuppy (Cozinha, Bar, Balcão) tem o **próprio
`device_token`** e precisa da própria instância do app. Duas instâncias só
convivem se tiverem porta e pasta de dados separadas — senão dividem
`device_token`/`session_token` e uma derruba a outra.

| Argumento           | Variável de ambiente | Default |
|---------------------|----------------------|---------|
| `--port=7848`       | `ZUPPY_LOCAL_PORT`   | `7847`  |
| `--profile=cozinha` | `ZUPPY_PROFILE`      | (nenhum) |

- **Sem argumento nenhum, nada muda**: porta 7847 e a mesma pasta de dados de
  sempre. Quem já tem o app instalado não repareia nada.
- `--profile` ausente e porta diferente da padrão ⇒ profile derivado da porta
  **pedida** (`porta-7848`). Uma flag só já basta para a segunda instância ter
  pasta própria.
- A pasta de dados vira `…\Zuppy Impressora-<profile>`. É ela que separa a
  config **e** que faz o single-instance lock do Electron valer por instância:
  abrir o mesmo atalho duas vezes continua abrindo só uma cópia.
- **Porta ocupada não derruba o app**: ele tenta as três seguintes
  (7847→7850), registra no log qual ficou e devolve a porta efetiva em
  `GET /status`. Faixa inteira ocupada ⇒ o servidor local não sobe (o app
  continua imprimindo; o que falta é o pareamento pela tela do Zuppy — use o
  código copiado, abaixo).
- Instância com profile registra o auto-start com **nome próprio** e com os
  próprios argumentos, então volta certa depois do reboot.

## Pareamento pelo código copiado

O caminho normal continua sendo o zero-config: a tela de Impressão do Zuppy
acha o app na porta local e chama `POST /configure`. O caminho manual existe
para quando a porta não é achável (todas ocupadas, firewall, instância que
subiu fora da faixa):

1. na tela de Impressão do Zuppy, copie o **código da impressora**;
2. clique com o botão direito no ícone da Zuppy ao lado do relógio;
3. **Parear com o código copiado**.

O app valida o código **no servidor** (o mesmo `POST /api/printer/auth`) antes
de gravar qualquer coisa: código errado não derruba a impressora que já estava
funcionando. O resultado vem em caixa de diálogo, com o nome da impressora
("Cozinha — Podrão"). Não toca no `api_url`: um código colado não carrega
origem, então o destino continua o do último pareamento.

## Endpoints HTTP (localhost:7847 na instância padrão)

| Método | Rota           | Descrição                              |
|--------|----------------|----------------------------------------|
| GET    | `/ping`        | Health check → `{ ok: true, zuppy_printer_app: 1 }` |
| GET    | `/status`      | Status atual da conexão e fila         |
| POST   | `/configure`   | Pareia o app (tenant, device_token, api_url) |
| GET    | `/printers`    | Lista impressoras instaladas → `{ printers, error }` |
| POST   | `/test-print`  | Imprime página de teste                |

### Como o Zuppy reconhece este app

O Zuppy **sonda** as portas 7847→7850 para achar as instâncias desta máquina.
"Respondeu 200 com JSON" não prova nada: qualquer programa sem privilégio pode
escutar numa porta livre da faixa e responder parecido — e o auto-pareamento
mandaria o `device_token` da loja para ele. Por isso toda resposta servida por
este app se identifica, em dois lugares:

| Onde   | Nome                        | Valor |
|--------|-----------------------------|-------|
| Header | `X-Zuppy-Printer-App`       | `1`   |
| Corpo  | `zuppy_printer_app` (`/status` e `/ping`) | `1`   |

- O valor é a **versão do contrato de identificação**, não um booleano.
- O header vai em **todas** as respostas do servidor local (menos o `403` de
  `Host` inválido) e está no `Access-Control-Expose-Headers`, senão o JS da
  página do Zuppy não conseguiria lê-lo.
- **Não é segredo**: está aqui e no código. Ele elimina o impostor acidental —
  o processo qualquer que só devolve JSON na porta —, não um atacante que
  estudou o app.
- **Aditivo**: nenhum campo do `/status` mudou de nome ou de sentido. O app
  antigo, que não tem o marcador, continua sendo aceito na **7847** (a porta
  histórica, onde o Zuppy mantém a confiança herdada); o marcador é exigido nas
  portas novas, onde app antigo nunca sobe — ele não aceita `--port`.

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

### GET /status — Resposta

```json
{
  "zuppy_printer_app": 1,
  "status": "connected",
  "version": "1.3.1",
  "printer": "EPSON TM-T20",
  "printer_list_error": null,
  "paper_size": "80mm",
  "queue": 0,
  "lastPrint": null,
  "tenant_name": "Podrão",
  "tenant_id": "uuid",
  "port": 7848,
  "destination": { "id": "uuid", "name": "Cozinha", "purpose": "kitchen" },
  "display_name": "Cozinha — Podrão",
  "api_url": null,
  "connected": true,
  "update": { "updateReady": false, "version": null, "downloadedAt": null }
}
```

- `zuppy_printer_app` — marcador de identidade (acima); o mesmo valor do header
  `X-Zuppy-Printer-App`.
- `version` — a versão do `package.json` deste app (`app.getVersion()`).
- `printer_list_error` — motivo da última falha ao listar as impressoras do
  Windows; `null` quando a listagem funcionou (ou ainda não foi tentada). Lista
  vazia **com** motivo é falha de enumeração, não máquina sem impressora.
- `paper_size` — **sempre** `"80mm"` ou `"58mm"`: é a largura que este app de
  fato usa para imprimir, então qualquer outro valor que tenha sido gravado na
  config é ecoado como `"80mm"` (o mesmo default do renderizador).
- `api_url` — origem salva no pareamento; `null` quando é o default de produção.
- `port` — a porta **efetiva** desta instância (a máquina pode ter mais de uma).
- `destination` — a impressora nomeada deste `device_token`; `null` no token
  legado da loja.
- `display_name` — "Cozinha — Podrão". `tenant_name` continua significando a
  **loja**.

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
- Header `Host` aceito só como `127.0.0.1:<porta efetiva>` ou `localhost:<porta efetiva>`; qualquer outro → `403 { "error": "bad host" }` (barra DNS rebinding, que chega como same-origin e passa longe do CORS). A porta comparada é a porta em que **esta** instância escuta, não a 7847 fixa
- Toda resposta servida carrega o header `X-Zuppy-Printer-App: 1`, e o `/status` e o `/ping` repetem o marcador no corpo (`zuppy_printer_app: 1`): é o que impede que um processo qualquer escutando numa porta da faixa 7847→7850 seja promovido a impressora da loja e receba o `device_token` no auto-pareamento (ver *Como o Zuppy reconhece este app*)
- O `device_token` nunca vai inteiro para o log — só os 4 últimos caracteres (`maskDeviceToken`); `session_token` não é logado nem mascarado
- CORS liberado apenas para `https://zuppyfood.com.br`, qualquer subdomínio de `zuppyfood.com.br` (em qualquer profundidade: `gestordepedidos.`, `dev.`, `www.`…), `http://localhost[:porta]` e `http://127.0.0.1[:porta]` — `isAllowedZuppyOrigin` em `electron/config.ts`, a mesma lista que valida o `api_url` do `/configure`
- Os destinos `localhost`/`127.0.0.1` valem como `api_url` só em build de desenvolvimento; no app empacotado, nunca
- Chaves sensíveis nunca são enviadas ao renderer
