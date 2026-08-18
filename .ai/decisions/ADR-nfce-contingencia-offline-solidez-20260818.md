# ADR — Solidez da NFC-e em contingência off-line (2026-08-18)

## Contexto

A NFC-e (modelo 65) em contingência segue o MOC / NT 2016.002: `tpEmis=9`, `dhCont`, `xJust` (≥15), chave com dígito 35 = 9, DANFE com “EMITIDA EM CONTINGÊNCIA”, transmissão posterior do **mesmo** XML assinado (mesmo cNF), prazo de até 24 horas ou o primeiro dia útil subsequente.

A emissão **normal** (`tpEmis=1`, `NFE_Enviar`) já está estável e não deve ser alterada.

## Decisão

1. Off-line continua isolado: `FormaEmissao=8` (Lib) → XML `tpEmis=9`. Sem `NFE_Enviar` na venda.
2. Após Assinar, validar XML + dígito 35 da chave + cDV módulo 11 + `idDest=1`. Sem isso, a nota não entra na fila.
3. Transmissão posterior: carregar o XML gravado, conferir assinatura e chave, **não** re-assinar, só `NFE_Enviar`. A chave devolvida pela SEFAZ tem de ser a mesma da impressa. `cStat` 100 e 150 contam como autorizada.
4. Probe automático (flag off por padrão): só `cStat=107` é SEFAZ operacional. 108/109 = paralisada → off-line.
5. Antes do CarregarINI da emissão normal, a sessão volta a `FormaEmissao=0` para não vazar teOffLine.
6. O botão Sincronizar do operador também transmite a fila NFC-e off-line (não só EPEC).
7. DANFE pode acrescentar QR (`infNFeSupl`); o arquivo da fila só é atualizado se chave, assinatura e tpEmis=9 permanecerem.
8. Contingência com Monitor TCP (paridade) é recusada — off-line só na ACBrLib nativa.

## Consequências

- Cupom e venda no caixa não passam a depender de SEFAZ quando a contingência está ativa.
- XML inválido sai da fila de retry (intervenção), timeout/SEFAZ down permanece pendente.
- Alerta operacional em 2h e alerta de prazo legal em 24h.
