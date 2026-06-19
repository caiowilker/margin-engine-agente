# Auditoria Técnica de Produção — Agente Local Margin Engine v5.3.0

**Data:** 2026-06-19  
**Escopo:** `agente-local` + integração com `margin-engine-front` e `margin-engine` (fluxo de venda/NFC-e)  
**Modo:** Somente leitura — nenhuma alteração de código nesta etapa  
**Versão auditada:** `package.json` → 5.3.0  

---

## Resumo executivo

O agente local possui **base arquitetural sólida** para PDV de varejo (Express, SQLite, fila offline, mutex ACBr, cofre de credenciais, watchdog). Porém, evidências de operação real (logs de produção da sessão 2026-06-18/19) e análise estática indicam **fragilidades críticas no pipeline fiscal síncrono**, **risco de tempestade na fila fiscal**, **gargalos de performance acima do mercado** e **lacunas de recuperação** que impedem classificação como “pronto para supermercado 24×7” sem ressalvas.

### Veredito final

## **APTO COM RESSALVAS**

| Cenário | Aptidão |
|---------|---------|
| Mercearia / padaria, 100–300 vendas/dia, 1 caixa, fiscal opcional | **Apto com ressalvas** |
| Conveniência / farmácia com NFC-e obrigatória | **Apto com ressalvas** (após deploy consistente + limpeza de fila) |
| Supermercado 500+ vendas/dia ou multi-caixa | **Não apto** (performance + fila fiscal) |
| Operação 24×7 contínua | **Não apto** (timers sem shutdown, risco de crescimento SQLite) |
| Rede instável + fiscal obrigatório | **Apto com ressalvas** (offline de venda OK; fiscal fica inconsistente) |

---

## PARTE 1 — Arquitetura geral

### Mapa de módulos

| Módulo | Responsabilidade | Persistência |
|--------|------------------|--------------|
| `index.js` | HTTP :9100, boot, rotas, EPEC, auto-update | `config.json`, `fila.db` (EPEC), `contingencia.json` |
| `acbr.js` | TCP ACBr :9200, emissão INI, mutex global | INI/XML/PDF em `marginPaths` |
| `impressora.js` | ESC/POS USB/rede/spooler Windows | Cache 30s em memória |
| `fila.js` | Vendas offline → backend | `data/fila.db` |
| `filaFiscal.js` | Jobs EMISSAO/CALLBACK/CANCEL/INUTIL | `data/fila_fiscal.db` |
| `fiscalService.js` | Orquestra emissão + callback backend | Via fila + filesystem |
| `fiscalRetry.js` | Classificação cStat / retry | — |
| `documentosFiscais.js` | XML/PDF sync | Filesystem |
| `reconciliacaoFiscal.js` | Divergência backend | Poll 5min |
| `credenciais.js` | Keyring Windows + vault AES | Credential Manager |
| `logger.js` | Pino estruturado | Arquivo rotativo (prod) |
| `watchdog.js` | Saúde ACBr, pausa fila fiscal | — |
| `marginPaths.js` | Árvore fiscal ProgramData | mkdir sync |
| `fiscalNumeracao.js` | Sequência nNF local | `fiscal_numeracao.db` |

### Perguntas arquiteturais

| Pergunta | Resposta | Evidência |
|----------|----------|-----------|
| Acoplamento excessivo? | **Sim, moderado** | `index.js` concentra boot, SQLite EPEC, timers, updater, rotas (~1580 linhas). `fiscalService` depende de `acbr`, `filaFiscal`, `docs`, preflight. |
| Código duplicado? | **Sim** | Duas conexões SQLite em `fila.db` (`fila.js` + `index.js` EPEC). HTTP client duplicado (`fiscalService.httpRequest`, `fila.js` fetch, `index.js` fetch). |
| Dependência circular? | **Não detectada** | Grafo unidirecional: index → serviços → acbr/fila. |
| Risco de crescimento? | **Alto** | `index.js` monolítico; cada feature fiscal adiciona handler + rota + timer. |
| Risco de manutenção? | **Moderado-alto** | Lógica fiscal espalhada em 8+ arquivos; constantes mortas (`MAX_TENTATIVAS` em `filaFiscal.js:23`). |
| Risco de travamento? | **Alto** | Mutex ACBr + HTTP síncrono bloqueante + `aguardarConclusao` até 120s + worker fiscal 5s. |

### Nota Parte 1: **6,5 / 10**

---

## PARTE 2 — Fluxo de venda

### Sequência real (evidência front + agente)

```
Operador Finalizar
  → Backend POST /pdv/vendas (margin-engine)
  → Agente POST /fiscal/emitir (se fiscalEnabled)
       → enfileirarEmissao → aguardarConclusao (bloqueante)
  → impressora.imprimirCupom (após fiscal)
  → Limpa carrinho
```

**Arquivo:** `margin-engine-front/src/hooks/useFrenteCaixa.ts` (~1427–1574)

### Pontos positivos

- Venda registrada no **backend antes** da NFC-e → venda comercial raramente perdida.
- Fila offline SQLite com `numero_venda UNIQUE` → anti-duplicata local (`fila.js:141-155`, `167-171`).
- `INSERT OR IGNORE` evita duplicata na fila offline (`fila.js:167-171`).
- Cupom impresso mesmo se NFC-e falhar (toast informativo, venda concluída).

### Cenários de risco

| Cenário | Perda? | Duplicidade? | Órfã? | Evidência |
|---------|--------|--------------|-------|-----------|
| Backend OK, fiscal falha | Não (venda no ERP) | Não | **Sim — venda sem NFC-e** | Front continua após catch fiscal (`useFrenteCaixa.ts:1523-1530`) |
| Backend offline | Não (fila SQLite) | Baixo | Possível se `INSERT OR IGNORE` silenciar retry com payload diferente | `fila.js:167-171` |
| Agente reinicia mid-emission | Não venda | Possível nNF duplicado/inutilizado | **Job cancelado no boot sem `emissao_resultados`** | `index.js:189-191`, `filaFiscal.js:407-415` |
| Timeout fiscal 120s+ | Não venda | **Risco dupla emissão** se operador repete venda | HTTP pendente | `filaFiscal.js:331-375`, `agenteLocal.ts:27` timeout 180s |
| Emergência localStorage | Venda só no browser | Duplicata se sync posterior | **Órfã no backend** | `useFrenteCaixa.ts:1416-1424` |
| Fiscal autorizada, callback falha | Não | Não | **ERP desatualizado** | `fiscalService.js:108-121` enfileira CALLBACK_BACKEND |

### Nota Parte 2: **6,0 / 10**

---

## PARTE 3 — Fila offline e fila fiscal

### fila.js (vendas)

| Aspecto | Avaliação |
|---------|-----------|
| Crash recovery | WAL + `busy_timeout=5000` (`fila.js:133-137`) |
| Retry | `MAX_TENTATIVAS` env, default 10 (`fila.js:30`, `354`) |
| Sync batch | Até 50 vendas, timeout 15s (`fila.js:285`) |
| Limpeza automática | **Não** — registros CONCLUIDO permanecem |
| Crescimento infinito | **Risco** — sem purge/TTL |

**Bug:** `carregarConfigPersistida` lê token de `config.json` (`fila.js:91-93`) enquanto token migrado para cofre (`credenciais.js`) → sync offline pode falhar silenciosamente.

**Race:** `syncEmAndamento` boolean não atômico (`fila.js:36`, `242-257`).

### filaFiscal.js (NFC-e)

| Aspecto | Avaliação |
|---------|-----------|
| Dedup correlationId | Sim (`filaFiscal.js:89-96`) |
| Boot recovery | PROCESSANDO→PENDENTE (`filaFiscal.js:79-82`) |
| Boot cancel | **Cancela jobs sem atualizar `emissao_resultados`** | Evidência logs usuário: centenas de 999 com `tentativas:1` |
| Retry 999 | Limitado a 2 (`fiscalRetry.js:21`, `81-85`) — **correção recente** |
| Dead code | `MAX_TENTATIVAS=10` linha 23 **não usado** |
| Deadlock | Improvável (single process) |
| Corrupção SQLite | Baixo (WAL); risco `SQLITE_BUSY` com 2 writers em `fila.db` |

**Evidência operacional (logs 2026-06-19):** centenas de falhas `cStat 999` em ~12 minutos, intervalo ~3s, sempre `tentativas:1` → **tempestade de jobs distintos**, não retry do mesmo — compatível com fila acumulada + retentativas de venda + SEFAZ MG bloqueio regra 656.

### Nota Parte 3: **5,5 / 10**

---

## PARTE 4 — NFC-e

### Fluxo de emissão

```
fiscalPreflight → acbr.emitirNfce → criarEnviarIni (TCP)
  → assertAutorizada → persistirDocumentosFiscais
       → salvarXml (sync)
       → gerarPdfDanfce (até 2 comandos ACBr, timeout 120s cada)
       → callbackBackend ou fila CALLBACK
```

### Matriz de cenários

| Cenário | Comportamento | Gap |
|---------|---------------|-----|
| Emissão normal | OK se INI correto | — |
| Rejeição SEFAZ (685, 869, 391) | Erro permanente, fila para | Deploy inconsistente causou rejeições em produção |
| cStat 999 | Retry limitado (2) | Pode saturar SEFAZ se fila grande |
| Timeout ACBr | `err.incerto`, consulta chave se parcial | `aguardarConclusao` não trata INCERTO |
| SEFAZ lenta | Bloqueia até 120s | Operador espera |
| ACBr travado | Watchdog pausa fila após 3 falhas | Auto-restart **não wired** (`watchdog.iniciar()` sem fn, `index.js:199`) |
| XML não retornado | Erro em persistência | XML extraído da resposta ACBr |
| Certificado/CSC | Preflight parcial | Config no ACBr GUI — OK arquiteturalmente |
| Contingência EPEC | Scheduler 5min | Complexidade adicional |
| Numeração local | `fiscalNumeracao.db` reserva nNF | **Risco gap** se ACBr/SEFAZ divergir sem sync |
| Emissão duplicada | Mitigado por correlationId cache | **Risco** se operador nova venda com novo ID |
| Perda XML | Backup best-effort `documentosFiscais.js:64-71` | Disco cheio não tratado |

### Riscos fiscais específicos (evidência código + operação)

1. **vTotTrib item vs total (cStat 685)** — corrigido no repo; deploy manual falhou (`acbr.js` montarIniNfce).
2. **Troco (cStat 869)** — corrigido no repo; mesma fragilidade de deploy.
3. **GTIN SEM GTIN com EAN no codigo** — corrigido recentemente (`resolverGtin`).
4. **Tempestade 999** — bloqueio SEFAZ MG; fila sem rate limit global.
5. **Venda fiscalmente inconsistente** — ERP tem venda, NFC-e falhou → cupom não fiscal impresso (comportamento correto PDV) mas ERP `precisaEmitirFiscal` pode ficar pendente.

### Nota Parte 4: **5,0 / 10** (operacional recente) / **7,0 / 10** (código pós-commit 97b94a5 se deployado)

---

## PARTE 5 — Performance (por que a emissão é lenta)

### Pipeline estimado (ms) — evidência arquitetural

| Etapa | Estimativa | Bloqueante? | Evidência |
|-------|------------|-------------|-----------|
| Backend registrar venda | 300–1500 | Sim (front await) | `useFrenteCaixa.ts:1427` |
| Fila fiscal worker wait | **0–5000** | Sim | `filaFiscal.iniciarWorker(5000)` `index.js:198` |
| `aguardarConclusao` poll | 200ms granular | Sim | `FISCAL_POLL_MS` default 200 |
| fiscalPreflight | 500–3000 | Sim | TCP ACBr |
| ACBr CriarEnviarNFe | **2000–15000** (SEFAZ) | Sim, mutex | `ACBR_TIMEOUT_EMISSAO_MS=120000` |
| Salvar XML sync | 10–100 | Sim (event loop) | `documentosFiscais.js` writeFileSync |
| **gerarPdfDanfce** | **3000–30000** | **Sim, desnecessário p/ cupom térmico** | `fiscalService.js:64-65`, `acbr.js:1036-1076` |
| Callback backend + base64 PDF | 500–3000 | Sim | `fiscalService.js:73-109` |
| Impressão cupom | 1000–15000 | Sim (após fiscal) | `execFileSync` PowerShell `impressora.js:181` |
| **Total típico** | **8–25 s** | | |
| **PDV moderno ref.** | **1–4 s** | | |

### Ranking de gargalos (impacto)

| # | Gargalo | Impacto | Tipo |
|---|---------|---------|------|
| 1 | HTTP `/fiscal/emitir` **síncrono** aguarda fila+ACBr+PDF+callback | **Crítico** | Arquitetura |
| 2 | `gerarPdfDanfce` no caminho quente (`persistirDocumentosFiscais`) | **Alto** | Processamento desnecessário |
| 3 | Mutex `withAcbrLock` serializa emissão + PDF + watchdog + EPEC | **Alto** | Concorrência |
| 4 | Worker fiscal interval **5s** antes de pegar job | **Médio** | Polling |
| 5 | `aguardarConclusao` até **120s** | **Médio** | Timeout longo |
| 6 | I/O sync (INI, XML, PDF, readdir) | **Médio** | Disco |
| 7 | Impressão via PowerShell sync | **Médio** | Spooler |
| 8 | Preflight TCP extra | **Baixo-médio** | Rede |
| 9 | ViaCEP enriquecimento empresa | **Baixo** | Rede |
| 10 | Logs Pino sync em prod | **Baixo** | I/O |

### Comparação mercado

| Solução | Comportamento típico | Margin Engine |
|---------|---------------------|---------------|
| Linx / TOTVS / SysPDV | Emissão assíncrona; cupom liberado rápido; DANFE em background | Emissão **bloqueia** finalização |
| Bematech / Elgin | Driver spooler otimizado | PowerShell RAW 15s timeout |
| Omie / Bling PDV | Cloud fiscal, latência variável | Local ACBr (OK) mas pipeline síncrono |
| NCR / Nex | Hardware dedicado, fila impressão separada | Mutex única impressão+serialização |

### Nota Parte 5: **4,0 / 10**

---

## PARTE 6 — Impressão

| Cenário | Comportamento | Evidência |
|---------|---------------|-----------|
| Impressora desligada | Erro propagado; **venda não trava** (fiscal já passou) | `impressora.js` throw; front `enviarImpressaoCupom` |
| Sem papel | Depende driver; erro genérico | — |
| USB removido | Fallback cadeia auto-detect | `PRINTER_TYPE=auto` |
| Fila spool grande | PowerShell sync aguarda | timeout 15s |
| Impressão simultânea | `printLock` serializa | `impressora.js:115-118` |
| Timeout | Rede 8s; teste 2s; PS 15s | `impressora.js:273,294,181` |
| Retry | Fallback modos; **sem retry automático estruturado** | — |
| Trava caixa? | **Não** — impressão após liberar carrinho... **mas carrinho só libera após fiscal** | `useFrenteCaixa.ts:1500-1564` |

**Risco:** Operador percebe lentidão antes de impressão porque NFC-e bloqueia tudo.

### Nota Parte 6: **7,0 / 10**

---

## PARTE 7 — Memória e recursos

### Timers ativos (sem cleanup no shutdown)

| Timer | Intervalo | Arquivo |
|-------|-----------|---------|
| Fila sync vendas | 30s | `index.js:1370` |
| EPEC sync | 5min | `index.js:1378` |
| Auto-update | 1h | `index.js:1388` |
| Fila fiscal worker | 5s | `filaFiscal.js:224` |
| Watchdog ACBr | 30s | `watchdog.js:52` |
| Reconciliação | 5min | `reconciliacaoFiscal.js:123` |

**Gap:** `uncaughtException`/`unhandledRejection` apenas logam (`index.js:1392-1397`); sem graceful shutdown; timers vazam em restart parcial.

### Projeção operação contínua

| Horizonte | Risco |
|-----------|-------|
| 8h | Baixo |
| 24h | Moderado (crescimento SQLite filas) |
| 72h | Moderado-alto (logs, fila fiscal falhas acumuladas) |
| 7–30 dias | **Alto** sem purge — `fila_vendas`, `fila_fiscal`, `emissao_resultados` |

### Nota Parte 7: **6,0 / 10**

---

## PARTE 8 — Segurança

| Aspecto | Status | Evidência |
|---------|--------|-----------|
| Token agente | Header `X-Agent-Token`; opcional se não ativado | `exigirAgentToken` `index.js:329-337` |
| Token em localStorage (front) | Risco XSS roubar token | `agenteLocal.ts` |
| Credenciais backend | Keyring + AES vault | `credenciais.js` |
| CORS | Restrito a frontend origin | `index.js` middleware |
| Auto-update | SHA-256 obrigatório | `index.js:404-414` |
| Diagnóstico | Exige token se ativado | Patch v5.0 |
| SQLite manipulação local | Admin Windows pode alterar filas | Risco operacional físico |
| Replay fiscal | correlationId dedup parcial | `filaFiscal.js:89-96` |
| Clonagem agente | Mesmo token se copiar config+cofre | Risco médio |

### Nota Parte 8: **7,5 / 10**

---

## PARTE 9 — Robustez operacional

| Evento | Recuperação | Tempo estimado |
|--------|-------------|----------------|
| Kill node.exe | Windows Service reinicia | 10–30s |
| Queda energia | SQLite WAL recovery | Automático |
| Internet off | Vendas enfileiradas | Sync 30s quando volta |
| ACBr parado | Watchdog pausa fila fiscal | 90s (3×30s) |
| Reinício agente | **Cancela emissões pendentes** | Imediato — **perde fila fiscal** |
| Trocar certificado/CSC | Manual ACBr GUI | Operador |
| Backend mudou URL | Reativar terminal | Manual |

**Operador consegue vender?** Sim — venda offline ou online sem NFC-e.  
**Com NFC-e obrigatória?** Parcial — vende mas fiscal fica pendente/inconsistente.

### Nota Parte 9: **6,5 / 10**

---

## PARTE 10 — Qualidade vs mercado / capacidade

| Volume | Aptidão atual | Limitante |
|--------|---------------|-----------|
| 100 vendas/dia | **OK** | — |
| 500 vendas/dia | **Limite** | Pipeline fiscal síncrono |
| 2.000 vendas/dia | **Não** | Mutex ACBr + fila |
| 10.000 vendas/dia | **Não** | Arquitetura single-thread fiscal |
| Multi-caixa | **OK** (1 agente/caixa) | Sem coordenação central nNF |
| Rede instável | **OK vendas** / **Frágil fiscal** | — |
| 24×7 | **Não recomendado** | Timers, SQLite growth |

### Nota Parte 10: **5,5 / 10**

---

## Notas por módulo (0–10)

| Módulo | Nota |
|--------|------|
| `index.js` | 6,0 |
| `acbr.js` | 6,5 |
| `impressora.js` | 7,0 |
| `fila.js` | 6,5 |
| `filaFiscal.js` | 5,0 |
| `fiscalService.js` | 5,5 |
| `fiscalRetry.js` | 7,0 |
| `documentosFiscais.js` | 7,0 |
| `reconciliacaoFiscal.js` | 4,5 |
| `credenciais.js` | 8,0 |
| `logger.js` | 8,0 |
| `watchdog.js` | 6,0 |
| `marginPaths.js` | 8,0 |
| `fiscalNumeracao.js` | 7,0 |
| Integração front | 6,0 |
| Integração backend | 7,0 |

**Média ponderada:** **6,2 / 10**

---

## Top 20 problemas mais graves

| # | Severidade | Problema | Arquivo | Função | Impacto |
|---|------------|----------|---------|--------|---------|
| 1 | **Crítica** | Emissão fiscal **bloqueia** finalização da venda | `useFrenteCaixa.ts` | `confirmarPagamento` | Lentidão 8–25s; fila no caixa |
| 2 | **Crítica** | Tempestade fila fiscal / SEFAZ 656 | `filaFiscal.js` | `processarUm` | Bloqueio CNPJ 1h |
| 3 | **Crítica** | Boot cancela jobs sem `emissao_resultados` | `index.js:189-191` | `boot` | HTTP timeout 120s |
| 4 | **Alta** | `gerarPdfDanfce` no caminho quente | `fiscalService.js:64-65` | `persistirDocumentosFiscais` | +3–30s por venda |
| 5 | **Alta** | Deploy manual desincronizado (869/685) | Operacional | — | Rejeições em produção |
| 6 | **Alta** | Venda OK / NFC-e falha → inconsistência ERP | `useFrenteCaixa.ts:1523-1530` | catch fiscal | Risco fiscal |
| 7 | **Alta** | `aguardarConclusao` ignora INCERTO | `filaFiscal.js:331-375` | poll | Espera até timeout |
| 8 | **Alta** | Mutex ACBr global | `acbr.js:55-58` | `withAcbrLock` | Serialização total |
| 9 | **Alta** | Duas conexões `fila.db` | `index.js` + `fila.js` | SQLite | SQLITE_BUSY |
| 10 | **Média** | Token fila vs cofre | `fila.js:91-93` | `carregarConfigPersistida` | Sync offline falha |
| 11 | **Média** | Worker fiscal 5s | `index.js:198` | boot | Latência inicial |
| 12 | **Média** | Sem purge SQLite | `fila.js`, `filaFiscal.js` | — | Crescimento 30d |
| 13 | **Média** | Reconciliação ineffective on FALHA_PERMANENTE | `reconciliacaoFiscal.js:109-112` | — | Divergência persiste |
| 14 | **Média** | Watchdog auto-restart não wired | `index.js:199` | `watchdog.iniciar` | ACBr manual |
| 15 | **Média** | `processando` / `syncEmAndamento` TOCTOU | `filaFiscal.js:152` | `processarUm` | Race raro |
| 16 | **Média** | Numeração nNF só local | `fiscalNumeracao.js` | `reservarProximoNumero` | cStat 539 |
| 17 | **Média** | Emergência localStorage órfã | `useFrenteCaixa.ts:1416-1424` | — | Perda backend |
| 18 | **Baixa** | MAX_TENTATIVAS morto fiscal | `filaFiscal.js:23` | — | Confusão ops |
| 19 | **Baixa** | `isTransient` não usado | `fiscalRetry.js` | — | Código morto |
| 20 | **Baixa** | Timers sem shutdown | `index.js` | boot | Leak menor |

---

## Top 20 melhorias (maior impacto — somente recomendação, sem implementação)

| # | Melhoria | Impacto esperado |
|---|----------|------------------|
| 1 | Emissão fiscal **assíncrona** — HTTP 202 + polling/WebSocket | −5 a −15s percebidos |
| 2 | Remover PDF do caminho quente (background job) | −3 a −10s |
| 3 | Impressão cupom **antes** ou **paralela** à NFC-e | UX mercado |
| 4 | Rate limit global emissões + limpa fila automática | Evita 656 |
| 5 | Boot: atualizar `emissao_resultados` ao cancelar | Elimina timeout fantasma |
| 6 | Deploy versionado (installer, não copy manual) | Elimina 869/685 em prod |
| 7 | Unificar conexão `fila.db` | Estabilidade |
| 8 | Worker fiscal event-driven (0ms vs 5s) | −0 a −5s |
| 9 | Purge SQLite 90 dias | Operação 30d |
| 10 | Fila fiscal: dedup por `numeroVenda` pendente | Anti-tempestade |
| 11 | Retry fiscal só via fila (remover retry duplo acbr) | Menos carga SEFAZ |
| 12 | Consulta automática chave pós-timeout | Recupera incerto |
| 13 | Dashboard fila fiscal no PDV | Ops mercado |
| 14 | Wire watchdog restart ACBr | Menos intervenção |
| 15 | Corrigir reconciliação FALHA_PERMANENTE | ERP consistente |
| 16 | Token fila sempre via `credenciais.ler` | Sync confiável |
| 17 | Métricas timing (Prometheus/log estruturado) | Diagnóstico perf |
| 18 | Contingência EPEC testada em homologação | Farmácia/super |
| 19 | Testes integração ACBr mock | CI |
| 20 | Separar `index.js` em routers | Manutenção |

---

## O que impede produção plena

1. Pipeline fiscal **síncrono** acima de 8s (inaceitável para supermercado pico).
2. Histórico de **tempestade 999** — SEFAZ bloqueou operação real.
3. **Deploy manual** de `acbr.js` — divergência repo vs `Program Files`.
4. Boot **cancela** emissões sem feedback ao front.
5. Sem **purge** filas — risco 30 dias uptime.

---

## O que gera / explica lentidão na emissão

1. `await emitirFiscal()` no front (**bloqueio total**).
2. `enfileirarEmissao` → `aguardarConclusao` (**poll + worker 5s**).
3. ACBr TCP `CriarEnviarNFe` (**SEFAZ + mutex**).
4. `gerarPdfDanfce` (**2 comandos ACBr extras**).
5. Callback backend com PDF base64.
6. Só então impressão térmica.

---

## Comparação mercado (síntese)

O agente está **nivelado** em: cofre credenciais, fila offline vendas, impressora multi-modo, protocolo ACBr TCP correto, classificação cStat, watchdog básico.

Está **abaixo** de Linx/TOTVS/SysPDV/NCR em: **tempo de finalização**, **emissão assíncrona**, **resiliência fila fiscal**, **operacionalização deploy**, **anti-tempestade SEFAZ**.

Está **comparável** a Omie/Bling PDV local para lojas pequenas **com ressalvas fiscais**.

---

## Capacidade operacional estimada

| Perfil | Veredicto |
|--------|-----------|
| 1 caixa, mergado, 150 vendas/dia, rede estável | **Operável** |
| 1 caixa, NFC-e obrigatória, homologação MG | **Operável após deploy + limpar fila + pausa SEFAZ** |
| 2+ caixas mesmo CNPJ | **Operável** (agente por máquina) |
| Supermercado pico sábado 800 vendas/dia | **Não recomendado** sem async fiscal |
| 24×7 | **Não recomendado** sem purge/monitoramento |

---

## Checklist operação real (antes de abrir loja)

- [ ] `Select-String acbr.js ibptCupom` na instalação Windows
- [ ] `POST /fila/fiscal/limpar` — pendentes = 0
- [ ] ACBr Monitor TCP 9200, sessão Demo < 1h
- [ ] `GET /acbr/sefaz/status` → cStat 107
- [ ] Certificado A1 + CSC homologação/produção alinhados
- [ ] `EMISSAO_FISCAL=true` + `AMBIENTE_SEFAZ` = ACBr GUI
- [ ] Impressora detectada (`POST /impressora/detectar`)
- [ ] Uma venda teste `/acbr/nfce/emitir` antes do PDV
- [ ] Confirmar ERP recebe callback fiscal
- [ ] Plano se NFC-e falhar (reemissão manual / suporte)

---

## Roadmap de correção (prioridade — sem implementar agora)

### Fase 0 — Estabilização (1–2 dias)
- Limpar fila fiscal; pausa SEFAZ se 999
- Deploy versionado 97b94a5+ em todas as estações
- Documentar procedimento operador

### Fase 1 — Confiabilidade fiscal (1 semana)
- Boot + `emissao_resultados` consistente
- Dedup `numeroVenda` na fila EMISSAO
- PDF fora do caminho quente

### Fase 2 — Performance (2 semanas)
- Emissão async (202 + status)
- Impressão paralela
- Worker event-driven

### Fase 3 — Escala (1 mês)
- Purge SQLite; métricas; reconciliação corrigida
- Testes carga 500 vendas/dia

---

## Lista consolidada de bugs (evidência código)

| ID | Bug | Arquivo:linha | Severidade |
|----|-----|---------------|------------|
| B01 | Boot cancela fila sem `emissao_resultados` | `index.js:189-191` | Alta |
| B02 | `aguardarConclusao` não trata INCERTO | `filaFiscal.js:331-375` | Alta |
| B03 | `MAX_TENTATIVAS` fiscal morto | `filaFiscal.js:23` | Baixa |
| B04 | Reconciliação chama `reprocessarIncertos` errado | `reconciliacaoFiscal.js:109-112` | Média |
| B05 | Token fila lê config.json não cofre | `fila.js:91-93` | Média |
| B06 | Dual SQLite `fila.db` | `index.js:246` + `fila.js:132` | Média |
| B07 | Watchdog restart não conectado | `index.js:199` | Média |
| B08 | `syncEmAndamento` TOCTOU | `fila.js:242-257` | Baixa |
| B09 | `processando` TOCTOU | `filaFiscal.js:152-155` | Baixa |

---

## Fragilidades (não necessariamente bugs)

- Pipeline fiscal monolítico síncrono
- Dependência ACBr Demo (1h) em homologação
- Numeração nNF descentralizada por agente
- Cupom fiscal depende de ordem: backend → fiscal → print
- Auto-update reinicia serviço (risco mid-venda)

---

## Riscos fiscais

| Risco | Probabilidade | Impacto |
|-------|---------------|---------|
| Venda sem NFC-e autorizada | Alta (já ocorreu) | Médio |
| Tempestade rejeição SEFAZ | Média (ocorreu) | Alto |
| Gap numeração nNF | Baixa | Alto |
| XML salvo / ERP não | Baixa | Médio |
| Contingência EPEC não testada | Média | Alto |

---

## Riscos operacionais

- Operador repete venda durante timeout → duplicidade comercial
- Fila fiscal centenas de jobs → log spam, CPU, SEFAZ
- Reinício Windows mid-sync → vendas offline OK, fiscal perdida
- emergência localStorage → venda fantasma

---

## Riscos performance

- p95 emissão > 12s (**péssimo** vs mercado)
- Mutex ACBr em horário pico
- PDF sync desnecessário

---

## Riscos segurança

- Token agente em localStorage (XSS)
- Acesso físico à máquina → manipular SQLite
- Auto-update mitigado por SHA-256 (positivo)

---

## Conclusão

O **agente-local Margin Engine v5.3.0** é **utilizável em produção real para varejo pequeno** com NFC-e, desde que: deploy seja **controlado**, fila fiscal **monitorada**, e expectativa de tempo de emissão seja **6–15 segundos** (não 1–4s de PDV maduro).

Para **supermercado, multi-caixa pesado e 24×7**, o veredicto permanece **NÃO APTO** até Fase 2 do roadmap (emissão assíncrona + PDF background + anti-tempestade).

---

*Auditoria baseada exclusivamente em código-fonte commitado (`97b94a5` agente, `85393bf` front, `d74494e` backend) e logs operacionais fornecidos pelo operador (2026-06-18/19). Nenhuma suposição além das evidências.*
