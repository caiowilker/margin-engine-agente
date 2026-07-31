# ADR — Gaveta de dinheiro sólida (ESC/POS nativo)

**Data:** 2026-07-31  
**Status:** Aceito

## Problema

A API `/impressora/gaveta` existia, mas o PDV quase não a usava; o teste nativo não abria a gaveta; em caminho ACBr a gaveta podia pagar `POS_Ativar -10` em RAW.

## Decisão

1. `abrirGaveta` **sempre** via ESC/POS nativo (nunca sessão ACBr).
2. Pulso configurável (`PRINTER_DRAWER_ON_MS` / `OFF_MS` / `PIN` / `INVERTED`).
3. Mesmo job do cupom: anexa pulso quando dinheiro (ou `abrirGaveta: true`).
4. Abertura/sangria/suprimento e teste: pulso quando `PRINTER_DRAWER` ativo.
5. Front: flag no cupom + `abrirGaveta()` se impressão recusada / DANFE com chave + botão manual.
6. Caminho ACBr tags: após tags, `talvezAbrirGavetaAposAcbr` (dinheiro / sempre em abertura-movimento).
7. Faturar pedido: recusa de impressão e DANFE com chave também abrem gaveta em dinheiro.
8. Coalesce ~800ms (`PRINTER_DRAWER_COALESCE_MS`) — cupom+job `/gaveta` não dão pulso duplo.
9. Job gaveta: timeout curto (~2,5s) e `withProvider` sempre native (`op=abrirGaveta`).
10. Front PDV: em dinheiro+chave, dispara gaveta **antes** do DANFE e envia o job com `abrirGaveta: false` (sem 2ª batida após DANFE lento).

## Consequências

- Uma ida ao spooler no cupom com dinheiro (rápido e sem corrida USB).
- Operador testa gaveta em Configuração → Impressão → Abrir gaveta.
- Troco sai antes/durante a impressão fiscal; segundo job não “bate” a gaveta de novo.
