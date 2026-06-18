# PROGRESS — Agente Local (Fiscal NFC-e)

**Última atualização:** 2026-06-17  
**Status:** Fases 01–08 + Bloqueadores B01–B05 implementados

---

## Concluído

* Mutex global ACBr (`acbr.js`)
* Consulta SEFAZ e por chave
* Fila fiscal SQLite (EMISSAO, CALLBACK_BACKEND, CANCELAMENTO, INUTILIZACAO, EPEC)
* Persistência XML/PDF real em `MarginEngine/acbr/*` (validação `%PDF`)
* `fiscalService.js` — emissão via fila, cancelamento, inutilização, callback backend com `pdfContentBase64`
* `fiscalPreflight.js` — validação A1/CSC/ambiente antes de emitir (`GET /acbr/fiscal/preflight`)
* `reconciliacaoFiscal.js` — ciclo automático de reconciliação (5 min padrão)
* `fiscalRetry.js` — classificação cStat/erros transientes vs permanentes
* `watchdog.js` — pausa fila quando ACBr offline
* Rotas: `/fiscal/emitir` (fila), `/fiscal/cancelar`, `/diagnostico/fiscal`, `/fila/fiscal`, `/acbr/nfce/reimprimir`
* Logger Pino integrado na fila fiscal

---

## Bloqueadores corrigidos (2026-06-17)

| ID | Arquivo principal | Resumo |
|----|-------------------|--------|
| B01 | `acbr.js`, `documentosFiscais.js`, `fiscalService.js` | PDF real ACBr + Base64 no callback |
| B03 | `filaFiscal.js`, `fiscalService.js` | Emissão enfileirada com idempotência |
| B04 | `fiscalPreflight.js` | Preflight certificado/CSC/ambiente |
| B05 | `reconciliacaoFiscal.js` | Reconciliação automática periódica |

---

## Deploy

* Executar `npm install` se novas deps
* Configurar `EMISSAO_FISCAL=true`, ACBr em `127.0.0.1:9200`
* Certificado A1 + CSC no ACBrMonitorPLUS (CSC não armazenado no agente)
* Variáveis opcionais: `ACBR_TIMEOUT_EMISSAO_MS`, `FISCAL_EMISSAO_TIMEOUT_MS`, `FISCAL_RECONCILIACAO_MS`
