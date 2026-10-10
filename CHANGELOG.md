# Changelog

## 1.6.0 (em desenvolvimento) — o app se explica e se protege

Melhorias que não dependem do servidor. Nenhum contrato existente mudou (`/ping`, `/status`, `/configure`, `/printers`, `/test-print`, `/print-raw`, `/install-update`): só campos e rotas novos, todos opcionais para quem chama.

- **Janelinha "Zuppy Impressora está aberto e imprimindo"** ao abrir o atalho com o app já aberto. Só diz "imprimindo" quando é verdade (pareado, com impressora e conectado); sem conexão ou sem pareamento, diz isso.
- **Atalho `zuppy-impressora://abrir`** (Windows) que o navegador chama. A URL só abre a janelinha: parâmetros, caminho e fragmento são ignorados; qualquer outro destino não faz nada. Registrado só no app instalado e na instância padrão.
- **"Sair" na bandeja pede confirmação** dizendo que os pedidos deixam de imprimir (e quantas comandas estão na fila). O botão padrão é "Continuar imprimindo". A atualização automática e o desligamento do Windows não pedem confirmação.
- **Reabre sozinho depois de um erro inesperado** do processo principal (no máximo 3 vezes em 10 min; acima disso o app segue rodando). O log registra quando a execução anterior não terminou normalmente. Queda dura (encerrar pelo Gerenciador de Tarefas, falta de energia) continua dependendo do auto-start do Windows no próximo login: nenhum código do processo cobre isso.
- **Computador acordado com a loja aberta** (`powerSaveBlocker`, `prevent-app-suspension`). Só com loja aberta e sessão ativa; solta ao fechar, ao perder a sessão, ao parar o polling e sozinho depois de 5 min sem consulta. A tela continua apagando. Consumo: o de um computador ligado e ocioso; em notebook na bateria a carga dura menos com a loja aberta.
- **Registro em arquivo** em `<logs do app>/zuppy-impressora[-profile].log`, rotativo (total ≤ 5 MB, ~24 h). Passa por um filtro que remove token, Bearer, nome, telefone, endereço, e-mail e documento. `debug` fica só no console. Teto de vazão (5 linhas iguais e 300 por minuto, com um resumo do que foi omitido): um site que fique chamando o servidor local não empurra o diagnóstico para fora do arquivo.
- **`GET /logs`** devolve o trecho recente (até 500 linhas) **só** a uma página do Zuppy (header `Origin` na allowlist; sem `Origin` é 403, ao contrário do `/status`). Sem upload automático.
- **`printer_state` no `/status`**: estado da impressora lido do Windows (`ok`, `offline`, `paper_out`, `paper_jam`, `door_open`, `stopped`, `error`, `not_found`, `unknown`) com a fila do spooler. Em cache de 30 s; o `/status` nunca espera o Windows.

## 1.5.1 — papel escolhido no painel

- **O papel da impressora (58mm ou 80mm) pode ser trocado pelo painel do Zuppy**, inclusive em sessão de suporte, sem ninguém no computador da loja. O servidor manda a escolha no poll (`printer_paper_size: { value, set_at }`), e o app troca o papel, descarta a calibração da impressora anterior e refaz o handshake uma vez para o servidor montar a comanda na largura nova.
- **Cada escolha do painel é aplicada uma vez**: uma troca feita depois no computador da loja continua valendo até a próxima escolha no painel. Só horários do servidor são comparados entre si (relógio errado na loja não muda nada).
- Sem o campo (servidor antigo, loja sem escolha no painel, impressora nomeada), nada muda em relação à 1.5.0.

## 1.5.0 — sinal de acordar

O app passa a ouvir um "sinal de acordar" do Zuppy pelo Supabase Realtime. Com o sinal ligado, a comanda sai assim que o pedido é aceito e o app consulta o servidor a cada 30 s em vez de 3 s (cerca de 10 vezes menos requisições por loja). O sinal só liga para as lojas que o Zuppy colocar na flag `PRINTER_WAKE_SIGNAL_*`; nas demais, a 1.5.0 se comporta exatamente como a 1.4.0.

- **Sinal de acordar** (`electron/wake.ts`): assina o canal `printer-wake:<tópico>` de cada loja que a estação imprime; qualquer mensagem dispara um poll imediato (um por vez, no mínimo 2 s entre eles, sem furar backoff nem `Retry-After`). Poll do sinal vazio ganha um repoll em 2 s.
- **Nenhuma loja depende do sinal**: canal caído, heartbeat parado, resposta sem `wake` (duas seguidas) ou sinal perdido detectado põem o app de volta no ritmo de hoje, com jitter de 0 a 5 s no primeiro poll depois da queda.
- **Watchdog do socket**: se o sinal ficar mais de ~2 min fora do ar, o app recria a conexão do Realtime (a biblioteca pode parar de reconectar sozinha depois de uma queda no meio do handshake, achado no teste em produção).
- **Detector de sinal perdido** por `wake_expected`: reporta ao servidor em `X-Printer-Wake: missed=<n>` e volta ao ritmo de hoje por 10 min.
- **Janela segura de atualização** usa o `store_closed` do servidor junto com o `next_poll_ms` (nunca o ritmo que o app escolheu): com o poll a 30 s e a loja aberta, a atualização não instala.
- **Headers novos em todo poll**: `X-Printer-App-Version` e `X-Printer-Wake` (a versão instalada chega ao painel sem depender do pareamento).
- **Repoll curto depois de reportar falha de impressão** (a nova tentativa do servidor não emite sinal).
- **Segurança**: a URL do Realtime só é aceita como `https://<ref>.supabase.co`; tópico, anon key e URL do socket nunca vão a log nem ao `/status`; o app não usa Presence e não envia nada pelo canal.
