# Relatório de Hardening — Agente Local Margin Engine

**Data:** 2026-06-18  
**Versão alvo:** 5.3.0+  
**Escopo:** Emissão NFC-e assíncrona, resiliência operacional, observabilidade e anti-tempestade SEFAZ

---

## 1. Resumo executivo

O agente fiscal foi reestruturado para **desacoplar checkout da emissão SEFAZ**. O operador recebe confirmação de venda e impressão do cupom em **1–2 segundos** (limitado apenas pelo registro da venda no backend). A NFC-e é processada em **background** via fila persistente SQLite.

**Modo legado preservado:** `POST /fiscal/emitir?sync=1` ou `FISCAL_EMITIR_SYNC=true` mantém o comportamento síncrono anterior.

---

## 2. Antes vs depois (arquitetura)

### Antes

```
PDV confirmarPagamento()
  → await emitirFiscal()          [8–25s bloqueando UI]
    → enfileirarEmissao()
      → aguardarConclusao()       [poll até SEFAZ responder]
        → emitirNfce + gerarPdf   [PDF no caminho quente]
          → callback backend
  → imprimir cupom
  → limpar carrinho
```

### Depois

```
PDV confirmarPagamento()
  → registrar venda
  → imprimir cupom
  → limpar carrinho                    [< 2s]
  → emitirFiscal() [background]
      → POST /fiscal/emitir            [retorno imediato ENFILEIRADO]
      → poll GET /fiscal/emissao/:id

Worker fila fiscal (1s)
  → EMISSAO: ACBr/SEFAZ
  → callback backend (sem PDF)
  → enfileira GERAR_PDF
  → GERAR_PDF: DANFC-e em background
```

---

## 3. Tarefas implementadas

| # | Tarefa | Status | Arquivos |
|---|--------|--------|----------|
| 1 | Emissão assíncrona | ✅ | `fiscalService.js`, `index.js`, `useFrenteCaixa.ts`, `agenteLocal.ts` |
| 2 | PDF fora do caminho crítico | ✅ | `fiscalService.js` (job `GERAR_PDF`) |
| 3 | Anti-tempestade | ✅ | `fiscalRateLimit.js` |
| 4 | Deduplicação | ✅ | `filaFiscal.js`, `fiscalService.js` |
| 5 | Recovery de boot | ✅ | `filaFiscal.recuperarBoot()`, `index.js` |
| 6 | Recovery de timeout | ✅ | `tentarRecuperarEmissao()` em `fiscalService.js` |
| 7 | Purge automático | ✅ | `fiscalPurge.js`, `filaFiscal.purgeAntigos()`, `fila.purgeAntigos()` |
| 8 | Observabilidade | ✅ | `fiscalMetrics.js`, `GET /diagnostico/metricas` |
| 9 | Watchdog real | ✅ | `watchdog.js` + `reiniciarAcbrMonitor()` em `index.js` |
| 10 | Escalabilidade | ✅ | Worker 1s, rate limit, purge, fila WAL |
| 11 | Segurança | ✅ | Dedup, recovery, rate limit, token inalterado |
| 12 | Testes | ✅ | `test/fiscal-hardening.test.js` (`npm run test:fiscal`) |

---

## 4. Correções por regra obrigatória

| Regra | Implementação |
|-------|---------------|
| R1 — Nunca perder venda | Venda registrada antes da emissão; fiscal em fila persistente |
| R2 — Nunca perder NFC-e autorizada | Recovery por `consultarChave` em timeout/incerto |
| R3 — Nunca emitir duas vezes | Dedup por `correlationId` + `numeroVenda` + resultado CONCLUIDO |
| R4 — Nunca numeração duplicada | Numeração local existente + dedup de job |
| R5/R6 — Nunca travar operador | Front libera caixa antes da SEFAZ |
| R7/R8 — Recuperável após reinício | `recuperarBoot()` + SQLite WAL |

---

## 5. Novos endpoints e contratos

### `POST /fiscal/emitir` (padrão assíncrono)

Resposta imediata:

```json
{
  "fiscal": "pending",
  "status": "ENFILEIRADO",
  "correlationId": "uuid",
  "numeroVenda": "V123",
  "async": true
}
```

Modo síncrono (compat): `?sync=1` ou header `X-Fiscal-Sync: 1`

### `GET /fiscal/emissao/:correlationId`

Consulta status: `ENFILEIRADO`, `PROCESSANDO`, `CONCLUIDO`, `FALHA_PERMANENTE`

### `GET /diagnostico/metricas`

Métricas p50/p95/p99, contadores, rate limit, watchdog

---

## 6. Variáveis de ambiente novas

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `FISCAL_EMITIR_SYNC` | `false` | Modo síncrono legado |
| `FISCAL_WORKER_MS` | `1000` | Intervalo worker fiscal |
| `FISCAL_RATE_LIMIT_MIN` | `12` | Máx emissões/minuto/CNPJ |
| `FISCAL_RATE_LIMIT_HORA` | `200` | Máx emissões/hora/CNPJ |
| `FISCAL_RATE_BACKOFF_MS` | `60000` | Backoff base (1–30 min escalonado) |
| `FISCAL_BOOT_CANCEL` | `false` | `true` = cancela pendentes no boot (antigo) |
| `FISCAL_PURGE_*` | 30/180 dias | Retenção SQLite |
| `ACBR_AUTO_RESTART` | `false` | Reinicia ACBr após 3 falhas watchdog |
| `ACBR_MONITOR_EXE` | — | Caminho do executável ACBr |

---

## 7. Ganhos estimados

| Métrica | Antes | Depois |
|---------|-------|--------|
| Tempo checkout (UI) | 8–25s | **1–2s** |
| Bloqueio operador | Sim | **Não** |
| PDF no caminho quente | Sim | **Não** |
| Recovery boot | Cancelava jobs | **Reprocessa** |
| Tempestade SEFAZ | Possível | **Rate limit** |
| Métricas operacionais | Ausentes | **Endpoint dedicado** |

---

## 8. Riscos eliminados / mitigados

- **cStat 999 por tempestade:** rate limit + backoff 1/2/5/15/30 min
- **Emissão fantasma pós-timeout:** consulta chave antes de falhar
- **Jobs órfãos no boot:** `recuperarBoot()` + `emissao_resultados` consistente
- **Crescimento SQLite:** purge automático a cada 6h
- **ACBr travado:** watchdog pausa fila + restart opcional

---

## 9. Riscos residuais

| Risco | Mitigação recomendada |
|-------|----------------------|
| Backend offline no callback | Job `CALLBACK_BACKEND` na fila (já existente) |
| PDF não gerado | Job `GERAR_PDF` retentável; reimprimir via `/acbr/nfce/reimprimir` |
| Homologação MG instável | Rate limit + mensagem operacional no front |
| Deploy manual desatualizado | Copiar todos os `.js` novos + reiniciar serviço |

---

## 10. Checklist de produção

- [ ] Copiar arquivos para `C:\Program Files\PDV Margin Engine\app\`
- [ ] Atualizar front (`margin-engine-front` build)
- [ ] Confirmar `.env`: `FISCAL_EMITIR_SYNC=false`, `FISCAL_BOOT_CANCEL=false`
- [ ] Reiniciar serviço Windows do agente
- [ ] Testar venda: carrinho limpa em < 2s, toast "NFC-e em processamento"
- [ ] Verificar `GET /diagnostico/metricas` com token
- [ ] Executar `npm run test:fiscal` no repo
- [ ] Monitorar fila: `GET /fila/fiscal`

---

## 11. Arquivos alterados

**Novos:** `fiscalMetrics.js`, `fiscalRateLimit.js`, `fiscalPurge.js`, `test/fiscal-hardening.test.js`

**Modificados:** `filaFiscal.js`, `fiscalService.js`, `index.js`, `fila.js`, `watchdog.js` (uso), `.env.example`, `package.json`

**Front:** `agenteLocal.ts`, `useFrenteCaixa.ts`

---

## 12. Como testar manualmente

1. Venda com fiscal ativo → carrinho limpa imediatamente
2. `GET /fiscal/emissao/{correlationId}` → evolui ENFILEIRADO → CONCLUIDO
3. Reiniciar agente durante emissão → job volta PENDENTE
4. `POST /fiscal/emitir?sync=1` → comportamento antigo (bloqueante)
5. 15 emissões rápidas → rate limit bloqueia temporariamente

---

*Documento gerado no hardening de produção do Agente Local Margin Engine.*
