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
  "uptime": 123.4,
  "manifestOk": true,
  "fiscal": { "pendentes": 0, "falhas": 0, ... },
  "timestamp": "ISO8601"
}
```

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

### POST /venda

**Consumidor:** `agenteService.registrarVenda()` (fallback offline)

**Status:** ✓

---

### GET /updater/status · POST /updater/verificar

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
