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
5. Front: flag no cupom + `abrirGaveta()` se impressão recusada / DANFC-e + botão manual no painel.

## Consequências

- Uma ida ao spooler no cupom com dinheiro (rápido e sem corrida USB).
- Operador testa gaveta em Configuração → Impressão → Abrir gaveta.
