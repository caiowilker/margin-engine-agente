# Contratos de API — Agente Local ↔ Front

Documento gerado na **Fase 7** (integration check).  
Versão do agente: **1.0.0**  
Consumidores: `margin-engine-front/src/services/agenteLocal.ts`, `src/hooks/useFrenteCaixa.ts`, `src/pages/PDV/DiagnosticoPage.tsx`

Legenda de compatibilidade:

| Símbolo | Significado |
|---------|-------------|
| ✓ | Campos e tipos alinhados |
| ⚠ | Campo opcional no back ou nome alternativo aceito pelo front |
| ✗ | Divergência (corrigida na Fase 7 ou documentada como won't fix) |

---

## Fiscal — checkout desacoplado (Fases 2–5)

### POST /fiscal/emitir

**Consumidor:** `useFrenteCaixa.ts` → `dispararEmissaoFiscalEmBackground()` → `agenteService.emitirFiscal()`

**Request:**

```
Headers: Content-Type: application/json, X-Agent-Token (se ativado), X-Correlation-Id
Body: CupomFiscal + { numeroVenda, correlationId }
  — itens[], empresa (DadosEmpresa), pagamentos via formaPagamento/total, cpfCliente?, nomeCliente?, operador
  — caixaId não vai no body; roteamento multi-caixa usa getAgenteUrl(caixaId) na URL base
```

**Response 200 (assíncrono — padrão):**

```json
{
  "fiscal": "pending",
  "status": "PENDENTE" | "ENFILEIRADO" | "PROCESSANDO",
  "correlationId": "uuid",
  "numeroVenda": "V123",
  "async": true,
  "deduplicado": false
}
```

**Response 200 (fiscal desligado):** `{ "fiscal": false }`

**Response 500:** `{ "erro": "...", "cStat"?: "...", "sefazIntermitente"?: true }`

**Status de compatibilidade:** ✓ (tipo `ResultadoEmissaoPendente` corrigido para incluir `PENDENTE`)

---

### POST /fiscal/nfse/emitir

**Consumidor:** `agenteService.emitirNfse()` (painel NFS-e no front)

**Request:**

```
Headers: Content-Type: application/json, X-Agent-Token (se ativado), X-Correlation-Id
Body: PayloadEmissaoNfse + { numeroRps, correlationId, modeloDocumento: "99" }
  — documentIni (INI ABRASF montado no backend), tomador, servico, empresa
  — numeroVenda espelha numeroRps para compatibilidade com fila fiscal
```

**Response 200 (assíncrono — padrão):**

```json
{
  "fiscal": "pending",
  "status": "PENDENTE",
  "correlationId": "uuid",
  "numeroVenda": "42",
  "async": true,
  "modeloDocumento": "99"
}
```

**Response 503:** `{ "erro": "NFS-e desabilitada (NFSE_ENABLED ou EMISSAO_FISCAL)" }`

**Response 400:** `{ "erro": "...", "camposFaltando": ["..."], "permanente": true }`

**Callback backend:** `POST {backendUrl}/pdv/nfse/rps/{numeroRps}/fiscal/resultado`

**Payload callback:** inclui `chaveNfe` e `numeroNfe` (contrato unificado com NFC-e) além de `chaveNfse`/`numeroNfse`; `statusFiscal`, `xmlContent`, `correlationId`, `modeloDocumento: "99"`.

```json
{
  "correlationId": "uuid",
  "chaveNfe": "...",
  "numeroNfe": "...",
  "chaveNfse": "...",
  "numeroNfse": "...",
  "serieRps": "1",
  "protocolo": "...",
  "cStat": "100",
  "statusFiscal": "AUTORIZADA",
  "xmlContent": "...",
  "modeloDocumento": "99"
}
```

**Status de compatibilidade:** ✓ (módulo paralelo — não altera NFC-e/NF-e)

---

### POST /fiscal/lib/emitir-nfse

**Consumidor:** provider ACBrLib (quando `ACBR_DRIVER=lib`)

**Request/Response:** idênticos a `POST /fiscal/nfse/emitir`, com `acbrDriver: "lib"` implícito.

**Status de compatibilidade:** ✓

---

### GET /fiscal/emissao/:correlationId

**Consumidor:** `agenteService.consultarEmissaoFiscal()` / `acompanharEmissaoFiscal()`

**Request:** Headers `X-Agent-Token` (se ativado)

**Response 200:**

```json
{
  "correlationId": "uuid",
  "numeroVenda": "V123",
  "status": "PENDENTE" | "PROCESSANDO" | "CONCLUIDO" | "CONCLUIDO_RECUPERADO" | "FALHA_PERMANENTE" | "INCERTO" | "NAO_ENCONTRADO",
  "resultado": { "fiscal": true, "chave": "...", ... } | { "fiscal": false } | null,
  "erro": null | "mensagem",
  "atualizadoEm": "ISO8601"
}
```

**Status de compatibilidade:** ✓ — tipo `StatusEmissaoFiscalAgente` adicionado no front

---

### GET /fiscal/status/:correlationId

**Consumidor:** alias documentado; `agenteService.consultarStatusFiscal()` (opcional). Polling principal usa `/fiscal/emissao/:id`.

**Request/Response:** idênticos a `GET /fiscal/emissao/:correlationId`

**Status de compatibilidade:** ✓

---

## Diagnóstico operacional

### GET /diagnostico/saude

**Consumidor:** smoke tests, monitoramento externo (não chamado diretamente pelo front React hoje)

**Request:** sem token obrigatório

**Response 200:**

```json
{
  "ok": true,
  "versao": "1.0.0",
  "frontVersion": "build-id ou null",
  "apiContractVersion": 3,
  "uptime": 123.4,
  "manifestOk": true,
  "fiscal": { "pendentes": 0, "falhas": 0, ... },
  "timestamp": "ISO8601"
}
```

`apiContractVersion` — inteiro do contrato HTTP front↔agente (ver `docs/API_CONTRACT_VERSION.md`). **Não** é `versao` do pacote.

**Status de compatibilidade:** ✓

---

### GET /diagnostico/alertas

**Consumidor:** smoke / dashboard externo; campos espelhados no HTML do dashboard

**Response 200 (campos principais):**

```json
{
  "acbr": "online" | "offline" | "degradado",
  "versao": "1.0.0",
  "manifestOk": true,
  "statusGeral": "OPERACIONAL" | "DEGRADADO" | "CRÍTICO",
  "ultimaEmissaoSucesso": { "correlation_id"?: "...", "correlationId"?: "...", ... },
  "metricas": { "emissoesHoje": 0, "taxaSucessoPercent": 100 },
  "filaFiscal": { ... },
  "incertos": 0,
  "timestamp": "ISO8601"
}
```

**Status de compatibilidade:** ⚠ — `ultimaEmissaoSucesso` pode usar `correlation_id` (snake_case do SQLite); front/smoke aceita ambos

---

### GET /diagnostico/dashboard

**Consumidor:** navegador (técnico de campo); embed no painel futuro

**Response 200:** `Content-Type: text/html; charset=utf-8` — HTML inline com status e versão

**Status de compatibilidade:** ✓

---

### POST /diagnostico/recovery

**Consumidor:** dashboard HTML (botão recovery), scripts de operação

**Request:** Headers `X-Agent-Token`, body `{}`

**Response 200:**

```json
{
  "ok": true,
  "jobsReprocessados": 0,
  "resetados": 0,
  "timestamp": "ISO8601"
}
```

**Status de compatibilidade:** ✓

---

### GET /diagnostico/relatorio

**Consumidor:** smoke / webhooks de relatório diário

**Response 200:** `{ "emissoes": { "total": number, ... }, "data": "YYYY-MM-DD", ... }`

**Status de compatibilidade:** ✓

---

## Status e conectividade (caixa)

### GET /health

**Consumidor:** `agenteService.statusDetalhado()` (ping), `resolveAgenteBaseUrl()` (multi-caixa)

**Response 200:** `{ "ok": true, "versao": "1.0.0", "uptime": number }`

**Status de compatibilidade:** ✓

---

### GET /status

**Consumidor:** `agenteService.status()` / `statusDetalhado()`

**Response 200:**

```json
{
  "online": true,
  "impressoraConectada": boolean,
  "acbrConectado": boolean,
  "versao": "1.0.0",
  "ativado": boolean,
  "pdvNome": "string",
  "filaOffline": { "pendentes": 0, "falhas": 0 },
  "contingencia": { "ativa": false, "epecPendentes": 0 }
}
```

**Status de compatibilidade:** ✓ — mapeado para `StatusAgente`

---

### GET /status-basico

**Consumidor:** fallback de `statusDetalhado()` quando token inválido

**Response 200:** `{ "ok", "ativado", "pdvNome", "versao", "fila", "impressora?", "fiscal?" }`

**Status de compatibilidade:** ✓

---

### GET /auth/local-token

**Consumidor:** `sincronizarTokenAgente()`

**Response 200:** `{ "agentToken": "..." }`

**Status de compatibilidade:** ✓

---

### GET /diagnostico

**Consumidor:** `DiagnosticoPage` → `agenteService.diagnostico()`

**Response 200:** objeto `DiagnosticoAgente` (versao, agente, impressora, acbr, banco, fila, contingencia, updater, sistema)

**Status de compatibilidade:** ✓

---

## Outras rotas consumidas pelo front

### GET /acbr/fiscal/preflight

**Consumidor:** `agenteService.preflightEmissao()`

**Response:** `{ "ok": boolean, "fiscal"?: boolean, "erro"?: string }`

Falhas de validação (certificado, ACBr, SEFAZ) respondem **HTTP 200** com `ok: false` (não 400), para o PDV não tratar preflight como erro de rede.

**Status:** ✓

---

### POST /fiscal/cancelar

**Consumidor:** `agenteService.cancelarFiscal()`

**Request:** `{ chave, motivo, numeroVenda, correlationId? }` + header `X-Correlation-Id`

**Status:** ✓

---

### GET /fila/fiscal

**Consumidor:** `agenteService.filaFiscalStatus()`

**Response:** `{ pendentes, falhas, incertos?, itens? }`

**Status:** ✓

---

### POST /fila/fiscal/reprocessar

**Consumidor:** `agenteService.reprocessarFilaFiscal()`

**Status:** ✓

---

### GET /diagnostico/fiscal

**Consumidor:** `agenteService.diagnosticoFiscal()`

**Status:** ✓ (tipo genérico `Record<string, unknown>` no front)

---

### POST /impressora/cupom

**Consumidor:** `agenteService.imprimirCupom()`

**Request:** `CupomFiscal`

**Response:** `{ "ok": true }`

**Status:** ✓

---

### POST /impressora/pedido

**Consumidor:** `agenteService.imprimirPedido()` via `usePrintStation` (Order Engine / Print Station)

**Request:** `PrintJobPayload` (camelCase ou snake_case)

```json
{
  "jobId": "uuid",
  "printType": "cozinha",
  "eventType": "ORDER_CREATED",
  "orderNumber": "ORD-1",
  "orderId": "uuid",
  "tableCode": "M12",
  "customerName": "Maria",
  "total": 42.5,
  "notes": null,
  "priority": "normal",
  "elapsedSeconds": 0,
  "createdAt": "ISO8601",
  "copies": 1,
  "items": [{ "code": "1", "name": "Cafe", "quantity": 2, "unit": "un" }]
}
```

**Response 200:** `{ "ok": true, "jobId": "…", "job": { "id": "…" } }`

**Response 202 (fila):** `{ "ok": false, "fila": true, "jobId": "…", "job": { "id": "…" } }`

**Status de compatibilidade:** ✓ (Sprint Order Engine — estação de impressão)

Se existirem rotas em `GET/PUT /config/impressora/station-routes`, o job é impresso na porta
mapeada para `printType` (mesmo PC com cozinha + bar). Sem rota → porta padrão do PosPrinter.

---

### GET /config/impressora/station-routes

**Response:** `{ "byPrintType": { "cozinha": "", "bar": "TCP:…", "producao": "", "cliente": "", "entrega": "" } }`

Porta vazia = usa a impressora padrão. Formatos: `RAW:Nome Windows`, `TCP:ip:9100`, `COMn`.

### PUT /config/impressora/station-routes

**Request:** mesmo formato de `byPrintType`. Persiste em `data/printer-stations.json`.

---

### POST /venda

**Consumidor:** `agenteService.registrarVenda()` / `registrarVendaCheckout` (front)

**Comportamento (padrão — local-first):**

1. Enfileira venda no SQLite (`fila_vendas`) com `INSERT OR IGNORE` (idempotente por `numero_venda`).
2. Responde **imediatamente** com `origem: "local"` e `syncPendente: true`.
3. Dispara sync com `POST {BACKEND_URL}/pdv/vendas` em background (sem bloquear o checkout).
4. Em sucesso do backend, marca fila como `SINCRONIZADO`.

**Query `?modo=cloud-first`:** tenta nuvem primeiro; se falhar, enfileira e responde como local-first (legado).

**Response (local-first):**

```json
{
  "numeroVenda": "PDV-…",
  "emitidoEm": "…",
  "total": 0,
  "lucro": 0,
  "margem": 0,
  "precisaEmitirFiscal": true,
  "statusFiscal": "PENDENTE",
  "origem": "local",
  "syncPendente": true
}
```

**Status:** ✓

---

### GET /fiscal/documento/xml

**Query:** `numeroVenda` (obrigatório se sem `chave`), `chave` (opcional)

**Consumidor:** `agenteService.baixarXmlDocumento()` → `baixarXmlFiscalVenda` (front)

**Response 200:**

```json
{
  "xmlContent": "<nfeProc>…</nfeProc>",
  "chave": "…",
  "qrcode": "…",
  "modeloDocumento": "65"
}
```

**Status:** ✓

---

### GET /updater/status · POST /updater/verificar · POST /updater/aplicar

**Consumidor:** `DiagnosticoPage` / `agenteService.updater`

**Status:** ✓

---

### POST /acbr/nfce/emitir (legado)

**Consumidor:** `agenteService.emitirNfce()` — fluxo antigo; checkout atual usa `/fiscal/emitir`

**Response 410** sem `numeroVenda`; com venda redireciona para fila

**Status:** ⚠ — mantido por compatibilidade; não usado no checkout desacoplado

---

## CORS e headers

| Aspecto | Back | Front | Status |
|---------|------|-------|--------|
| CORS localhost | Qualquer `localhost:*` permitido | Vite `:5173` | ✓ |
| CORS produção | `CORS_ORIGINS` no `.env` | `frontendOrigin` na ativação | ✓ |
| Private Network | `Access-Control-Allow-Private-Network: true` | fetch HTTPS→localhost | ✓ |
| Headers permitidos | Content-Type, X-Agent-Token, X-Correlation-Id | idem | ✓ |
| Security headers | nosniff, X-Frame-Options DENY | não afeta fetch API | ✓ |
| JSON Content-Type | `res.json()` define `application/json` | espera JSON | ✓ |

---

## Referências de código

| Artefato | Caminho |
|----------|---------|
| Cliente HTTP front | `margin-engine-front/src/services/agenteLocal.ts` |
| Checkout background | `margin-engine-front/src/hooks/useFrenteCaixa.ts` |
| Tipos PDV | `margin-engine-front/src/types/pdv.types.ts` |
| Rotas back | `agente-local/index.js` |
| Emissão fiscal | `agente-local/fiscalService.js` |
| Testes contrato | `agente-local/test/contract.test.js` |
| Smoke integrado | `agente-local/scripts/smoke-integration.js` |
