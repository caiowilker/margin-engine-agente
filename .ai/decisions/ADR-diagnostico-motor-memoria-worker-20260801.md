# ADR — Diagnóstico Motor: memória fiscal no processo HTTP (worker)

**Data:** 2026-08-01  
**Status:** Aceito

## Contexto

Com `ACBR_LIB_WORKER=true`, `StatusServico` / `testar` rodam no filho fiscal. `atualizarStatusMemoria` era chamado só no worker. O Diagnóstico (`/diagnostico` → `obterStatusMemoria`) lê o processo HTTP → Motor ✗ Verificar e `statusGeral=OFFLINE` mesmo com SEFAZ `cStat=107` / `operacional=true`.

Hotfix de JS sem regenerar SHA no `manifest.json` também forçava `manifestOk=false` → OFFLINE.

## Decisão

1. Após `acbrLibWorkerPool.call` no pai, espelhar resultado de `statusServico` / `testar` / `testarLibDetalhe` via `syncStatusMemoriaFromWorkerResult`.
2. Em `statusServicoLib` (worker ou sem worker), continuar atualizando memória no processo que executa a op (cache incluso).
3. IE do emitente no INI: apenas dígitos (`replace(/\D/g,"")`), alinhado ao backend `AcbrIniFormat.onlyDigits`.
4. Após hotpatch em produção, regenerar/atualizar SHA no `manifest.json` (ou `npm run manifest` + sync build).

## Consequências

- Diagnóstico Motor OK / ONLINE acompanha StatusServico real.
- Rejeições SEFAZ (230, 781) em homologação continuam sendo resposta de negócio; não confundir com Motor offline.
- Instalador/build deve regenerar manifest para não marcar OFFLINE por divergência de SHA.
