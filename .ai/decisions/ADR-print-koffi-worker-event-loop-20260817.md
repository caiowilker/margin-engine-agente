# ADR — WritePrinter isolado (event loop do PDV)

**Data:** 2026-08-17  
**Status:** aceito

## Contexto

No caixa (Elgin i9 USB) a gaveta e o cupom são em geral rápidos (100–900 ms), mas em picos o job ficava 14–50 s em `PENDENTE` antes de `IMPRESSO`. O `durationMs` do envio em si continuava baixo. O operador via: finalizar venda lento, celular lento, botão de teste da gaveta rápido e depois “não abre”.

Diagnósticos anteriores atribuíram “falha de cabo USB” porque o logger marcava qualquer linha com `print`/`impressora` com essa causa — inclusive o WARN de E2E > 1s.

## Causa raiz

`WritePrinter` / `OpenPrinter` via koffi rodava **no event loop do agente**. USB selective suspend ou spooler ocupado bloqueia a FFI 14–50 s. Timers de timeout não disparam. HTTP do agente (API-proxy, celular, checkout) congela junto.

Efeitos em cadeia:

1. Fila `processando=true` enquanto a FFI não volta — próximo job fica `PENDENTE`.
2. `comLockImpressao` / `physicalResourceLock` só checavam timeout **depois** de adquirir o lock.
3. Clique rápido no teste (`force=true`) enfileirava N pulsos e enchia o spooler.
4. Primeiro `OpenPrinter` após idle era o mais lento (impressora “dormindo”).

## Decisão

1. `writeRaw` despacha para `worker_threads` (`rawWinspoolWorker.js`). A sequência Open→Write→Close fica no **mesmo** thread do worker (HANDLE não cruza threads koffi.async).
2. Timeout no processo principal: job falha sem matar o worker no meio do WritePrinter (anti-dupla). Event loop permanece livre.
3. Espera de lock é fail-fast (`Promise.race`) e o waiter **não** dispara segundo envio.
4. Jobs de gaveta ativos (`PENDENTE`/`ENVIANDO`/`REPROCESSANDO`) coalescem. `force` tem throttle (`PRINTER_DRAWER_FORCE_MIN_MS=400`).
5. Keepalive `OpenPrinter`+`ClosePrinter` a cada 40 s (`PRINT_SPOOLER_KEEPALIVE_MS`) para o USB não dormir. Não enfileira ping se o worker ainda está em WritePrinter (`workerBusy`, inclusive após timeout do job).
6. Sugestão de log de “cabo USB” só em erros reais de WinSpool/porta — não em métrica de latência.
7. Hardware da térmica (gaveta/porta/modelo) é SSOT local (`PUT /config/impressora`). `isAvailable()` no processo HTTP **não** carrega koffi.

## Consequências

- Travada USB ainda atrasa **aquele** cupom/gaveta, mas **não** o caixa nem o celular.
- Cupom que estourar timeout pode sair no papel mesmo com job `ERRO` (envio abandonado no worker) — sem retry (já era a regra de `RAW_PRINT_TIMEOUT`).
- Keepalive não compete com WritePrinter em andamento (`workerBusy` inclui o id após timeout).
- Painel operacional do PDV não edita gaveta/porta/modelo — só o painel Impressora.
- Keepalive pode falhar em loja sem porta RAW configurada (no-op).
