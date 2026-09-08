# ADR — Emissão fiscal extrema (solidez + velocidade PDV)

**Status:** Aceito  
**Data:** 2026-09-08  
**Repo:** agente-local

## Problema

No caixa, NFC-e precisa ser **rápida** (liberar venda / próxima nota) e **sólida**
(nunca reemitir nota já autorizada; nunca tela “travada” no PDF/SEFAZ).

Auditoria do hot path encontrou:

1. `imprimirPDF` após todo `NFE_Enviar` **dentro do lock** — segundos a minutos.
2. Timeout Lib/worker classificado como **transient → reemitir** (duplicidade 539).
3. Preflight aceitava cStat **108** (paralisado) como online.
4. Probe StatusServico **duplicava** preflight sob o lock de emissão.
5. Dedup por `correlationId` omitia `RECUPERANDO`.
6. Até 10 bumps 539 seriais; backoff inicial 60s.

## Decisões

1. **PDF fora do caminho crítico NFC-e** — `persistNativeEmissaoOutputs` só gera PDF
   se `FISCAL_GERAR_PDF_ON_EMIT=true` (ou NF-e 55 + `FISCAL_GERAR_PDF=true`).
   Default: XML autorizado + QR; DANFE via fila `GERAR_PDF` se desejado.
2. **Timeout pós-Enviar = INCERTO** — `err.incerto=true`; `isTransient` **não**
   inclui esses timeouts; recovery consulta SEFAZ, **nunca reemite** o mesmo nNF.
3. **Online = cStat 107 apenas** — preflight e `statusServicoLib.operacional`.
4. **Skip probe** se cache StatusServico tem 107 quente (&lt; min(30s, TTL)).
5. Dedup EMISSAO inclui `RECUPERANDO`; `FISCAL_MAX_BUMP_539` default **3**;
   backoff transient `[8s, 20s, 60s, 180s, 600s]`.
6. **CALLBACK worker** roda mesmo com fila pausada; contingência não puxa CALLBACK
   no mutex SEFAZ; stale CALLBACK/PDF → PENDENTE (não INCERTO); jobs em voo
   protegidos de `liberarJobsTravados`.
7. Timeout Enviar agenda `scheduleRecycle` para matar sessão órfã.

## Consequências

- Tempo até `CONCLUIDO` ≈ SEFAZ + XML (sem PDF).
- Timeout não gasta numeração nem gera nota dupla.
- 108/109 → fail-fast ou contingência offline (se habilitada), não Enviar cego.
- Contingência SEFAZ: callbacks e NFC-e off-line seguem; emissão online para.
- MOC 15s pós-104 mantido em `FISCAL_CONSULTA_POS_104_MS` (indSinc=1 evita 104).
