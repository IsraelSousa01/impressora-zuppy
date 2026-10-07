# Changelog

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
