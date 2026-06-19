# Guia Completo — Agente Local Margin Engine v1.0.0

Documento mestre: arquitetura, implementação, configuração, operação e integração com o front PDV.

**Versão:** 1.0.0  
**Porta padrão:** 9100  
**Node.js:** 18+  
**Stack:** Express, SQLite (better-sqlite3), ACBr Monitor (TCP), ESC/POS

---

## Índice

1. [O que é o agente](#1-o-que-é-o-agente)
2. [Arquitetura e fluxo de dados](#2-arquitetura-e-fluxo-de-dados)
3. [Estrutura do projeto](#3-estrutura-do-projeto)
4. [Instalação e primeiro boot](#4-instalação-e-primeiro-boot)
5. [Configuração (.env)](#5-configuração-env)
6. [Ativação e credenciais](#6-ativação-e-credenciais)
7. [Módulos principais](#7-módulos-principais)
8. [API HTTP — referência completa](#8-api-http--referência-completa)
9. [Emissão fiscal NFC-e](#9-emissão-fiscal-nfce)
10. [Fila offline de vendas](#10-fila-offline-de-vendas)
11. [Impressora térmica](#11-impressora-térmica)
12. [Contingência EPEC](#12-contingência-epec)
13. [Observabilidade e diagnóstico](#13-observabilidade-e-diagnóstico)
14. [Integração com margin-engine-front](#14-integração-com-margin-engine-front)
15. [Segurança](#15-segurança)
16. [Deploy, manifest e auto-update](#16-deploy-manifest-e-auto-update)
17. [Testes automatizados](#17-testes-automatizados)
18. [Docker (alternativa Linux)](#18-docker-alternativa-linux)
19. [Limitações e capacidade](#19-limitações-e-capacidade)
20. [Troubleshooting rápido](#20-troubleshooting-rápido)
21. [Documentos relacionados](#21-documentos-relacionados)

---

## 1. O que é o agente

O **agente local** é um servidor Node.js que roda na máquina do caixa (Windows ou Linux). Ele conecta:

| Componente | Função |
|------------|--------|
| **Navegador (front PDV)** | Chamadas HTTP para localhost:9100 |
| **Backend Margin Engine** | Sincronização de vendas, callbacks fiscais, contingência |
| **ACBr Monitor** | Emissão NFC-e via TCP (porta 9200) |
| **Impressora térmica** | Cupom ESC/POS (USB, rede ou spooler Windows) |

Sem o agente, o front web **não** imprime cupom nem emite NFC-e localmente — o navegador não acessa impressora nem ACBr diretamente.

---

## 2. Arquitetura e fluxo de dados

```
┌─────────────────┐     HTTPS      ┌──────────────────┐
│  Front PDV      │ ─────────────► │ Backend Spring   │
│  (Vite/React)   │                │ margin-engine    │
└────────┬────────┘                └──────────────────┘
         │ HTTP localhost:9100
         ▼
┌─────────────────────────────────────────────────────┐
│              AGENTE LOCAL (index.js)                 │
│  ┌─────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ fila.js │  │ filaFiscal.js│  │ fiscalService.js│ │
│  │ vendas  │  │ NFC-e jobs   │  │ orquestração    │ │
│  └────┬────┘  └──────┬───────┘  └────────┬────────┘ │
│       │              │                    │          │
│       ▼              ▼                    ▼          │
│   fila.db      fila_fiscal.db         acbr.js ───────┼──► ACBr :9200
│                                                      │
│  impressora.js ──────────────────────────────────────┼──► Térmica
└─────────────────────────────────────────────────────┘
```

### Fluxo de venda com NFC-e (pós v1.0 — checkout desacoplado)

1. Operador finaliza pagamento no front.
2. Front registra venda no **backend** (obrigatório).
3. Front imprime cupom via agente (`POST /impressora/cupom`) — **1–2 s**.
4. Front enfileira NFC-e em background (`POST /fiscal/emitir`) — retorno imediato `{ fiscal: "pending", correlationId }`.
5. Worker fiscal processa job `EMISSAO` → ACBr/SEFAZ.
6. Front faz polling (`GET /fiscal/emissao/:correlationId`) e exibe badge "Emitindo NF..." até `CONCLUIDO`.
7. Agente persiste XML/PDF, callback no backend, job `GERAR_PDF` se configurado.

O operador **não fica bloqueado** aguardando a SEFAZ.

---

## 3. Estrutura do projeto

```
agente-local/
├── index.js                 # Servidor HTTP, rotas, boot, EPEC, updater
├── acbr.js                  # Cliente TCP ACBr, montagem INI NFC-e
├── fila.js                  # Fila offline de vendas → backend
├── filaFiscal.js            # Fila persistente EMISSAO/CALLBACK/PDF/...
├── fiscalService.js         # Orquestração emissão, cancelamento, callback
├── fiscalRecuperacao.js     # Recovery INCERTO, consulta chave SEFAZ
├── fiscalRateLimit.js       # Anti-tempestade SEFAZ por CNPJ
├── fiscalMetrics.js         # Métricas p50/p95 em SQLite
├── fiscalPurge.js           # Purge automático DB + arquivos
├── fiscalStorage.js         # Espaço em disco, purge XML/PDF
├── fiscalAlertas.js         # Webhooks operacionais
├── fiscalRelatorio.js       # Relatório diário
├── diagnosticoDashboard.js  # Dashboard HTML inline
├── diagnosticoRateLimit.js  # Rate limit recovery/relatório
├── auditLog.js              # Auditoria imutável
├── manifestUpdater.js       # Integridade SHA-256 + auto-update
├── credenciais.js           # Cofre (Windows Credential Manager / AES)
├── impressora.js            # ESC/POS
├── watchdog.js              # Saúde ACBr
├── marginPaths.js           # ProgramData/MarginEngine
├── data/                    # SQLite, config, logs (runtime)
├── scripts/                 # manifest, predeploy, smoke
├── test/                    # Testes automatizados
└── docs/                    # Documentação
```

### Bancos SQLite (`data/`)

| Arquivo | Conteúdo |
|---------|----------|
| `fila.db` | Vendas offline + EPEC pendentes |
| `fila_fiscal.db` | Jobs fiscais, resultados, documentos indexados |
| `fiscal_metrics.db` | Amostras de latência emissão/PDF |
| `audit.db` | Log de ações sensíveis (recovery, rollback, etc.) |
| `config.json` | Config pública (sem token em texto puro) |

### Arquivos fiscais (`C:\ProgramData\MarginEngine\` ou `MARGIN_ENGINE_ROOT`)

| Pasta | Conteúdo |
|-------|----------|
| `acbr/xml/` | XMLs autorizados |
| `acbr/pdf/` | DANFC-e PDF |
| `acbr/backup/` | Backups fiscais |

---

## 4. Instalação e primeiro boot

### Windows (recomendado)

```text
Clique direito em setup.bat → Executar como administrador
```

O instalador: Node 18+, `npm install`, `.env`, serviço Windows, abre http://localhost:9100.

### Manual

```bash
cd agente-local
npm install
cp .env.example .env
npm run manifest
npm run predeploy
npm test
npm start
```

### Sequência de produção

```bash
npm run manifest    # SHA-256 dos .js — obrigatório no destino
npm run predeploy   # checks de ambiente
npm test            # 21 testes fiscais
npm run smoke       # com agente + ACBr rodando
```

---

## 5. Configuração (.env)

Principais variáveis (ver `.env.example` completo):

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | 9100 | Porta HTTP do agente |
| `EMISSAO_FISCAL` | false | Habilita pipeline NFC-e |
| `ACBR_HOST` / `ACBR_PORT` | 127.0.0.1 / 9200 | ACBr Monitor |
| `FISCAL_EMITIR_SYNC` | false | true = emissão bloqueante (legado) |
| `FISCAL_RATE_LIMIT_MIN` | 12 | Máx emissões/min/CNPJ |
| `AGENT_TOKEN_REQUIRED` | true | Exige X-Agent-Token após ativação |
| `CORS_ORIGINS` | http://localhost:5173 | Origens extras além de localhost |
| `AUTO_UPDATE` | false | Auto-update via backend |
| `AUDIT_RETENCAO_DIAS` | 90 | Purge audit.db |
| `WEBHOOK_ALERTAS_URL` | — | Webhook Slack/Teams para alertas |
| `FISCAL_PURGE_*` | 30–180 dias | Retenção SQLite e arquivos |

**Prioridade de config:** `data/config.json` + cofre de credenciais > `.env`.

---

## 6. Ativação e credenciais

1. Acesse http://localhost:9100
2. Insira código gerado no painel administrativo (`POST /ativar`)
3. Agente grava:
   - Dados públicos em `data/config.json`
   - `backendToken` no **cofre** (`credenciais.js`) — nunca em texto puro no JSON
   - `agentToken` para header `X-Agent-Token`

### Token no front

O front salva `agentToken` em `localStorage` e envia em todas as rotas sensíveis. Se 401 após reinstalação: `GET /auth/local-token` ou reativar pelo painel.

---

## 7. Módulos principais

### filaFiscal.js — coração fiscal

- Tipos de job: `EMISSAO`, `CALLBACK_BACKEND`, `GERAR_PDF`, `CANCELAMENTO`, etc.
- Estados: `PENDENTE` → `PROCESSANDO` → `CONCLUIDO` | `FALHA_PERMANENTE` | `INCERTO`
- Dedup por `correlationId` + coluna `numero_venda`
- Recovery no boot: jobs `INCERTO`/`PROCESSANDO` reprocessados
- Worker interval: `FISCAL_WORKER_MS` (padrão 500–1000 ms)

### fiscalService.js

- `enfileirarEmissao()` — modo async (padrão) ou sync (`?sync=1`)
- `consultarStatusEmissao()` — polling do front
- `persistirDocumentosFiscais()` — XML, PDF, callback backend
- Rate limit antes de cada emissão

### fiscalRecuperacao.js

- Consulta chave na SEFAZ antes de reemitir (evita duplicata pós-timeout)
- Backoff: `tentativas_consulta`, `proximo_retry_at`, `MAX_TENTATIVAS_CONSULTA`
- `forcarRecoveryManual()` — endpoint `/diagnostico/recovery`

### fiscalRateLimit.js

- Janela 12/min e 200/h por CNPJ (configurável)
- Backoff escalonado em cStat 999 e erros 5xx

### fiscalPurge.js

- A cada 6 h: purge fila fiscal, fila vendas, XML/PDF/backup antigos, **audit.db**

### watchdog.js

- Monitora falhas ACBr consecutivas
- Pausa fila fiscal; restart opcional (`ACBR_AUTO_RESTART`)

---

## 8. API HTTP — referência completa

Legenda de proteção:

- **Público** — sem token
- **Token** — exige `X-Agent-Token` quando ativado
- **PN** — inclui headers Private Network Access (CORS localhost/HTTPS)

### Saúde e status

| Método | Rota | Proteção | Descrição |
|--------|------|----------|-----------|
| GET | `/health` | PN | Ping mínimo `{ ok, versao, uptime }` |
| GET | `/status-basico` | PN | Status reduzido sem dados sensíveis |
| GET | `/status` | PN + Token | Status completo para frente de caixa |
| GET | `/config` | PN | Config pública |
| GET | `/auth/local-token` | PN | Recupera agentToken |

### Ativação

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/ativar` | Ativa com código do painel |

### Fiscal (principal)

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/fiscal/emitir` | Enfileira NFC-e (async padrão) |
| GET | `/fiscal/emissao/:correlationId` | Status da emissão (polling front) |
| GET | `/fiscal/status/:correlationId` | Alias idêntico ao anterior |
| POST | `/fiscal/cancelar` | Cancelamento SEFAZ + backend |
| GET | `/acbr/fiscal/preflight` | Valida ACBr antes de emitir |
| GET | `/acbr/sefaz/status` | Status serviço SEFAZ |
| GET | `/acbr/nfce/consultar/:chave` | Consulta NFC-e |
| POST | `/acbr/nfce/cancelar` | Cancelamento direto ACBr |
| POST | `/acbr/nfce/inutilizar` | Inutilização numeração |
| POST | `/acbr/nfce/reimprimir` | Reimpressão DANFC-e |
| POST | `/acbr/nfce/emitir` | **Legado** — 410 sem numeroVenda; com venda → fila |

### Fila fiscal

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/fila/fiscal` | Status fila fiscal |
| POST | `/fila/fiscal/reprocessar` | Reprocessa incertos |
| POST | `/fila/fiscal/limpar` | Limpeza administrativa |

### Diagnóstico

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/diagnostico` | JSON completo (painel PDV) |
| GET | `/diagnostico/saude` | Health check operacional |
| GET | `/diagnostico/alertas` | Alertas JSON (ACBr, disco, incertos) |
| GET | `/diagnostico/dashboard` | HTML inline (refresh 10s) |
| GET | `/diagnostico/metricas` | p50/p95, rate limit, watchdog |
| GET | `/diagnostico/fiscal` | Diagnóstico fiscal detalhado |
| GET | `/diagnostico/relatorio?data=YYYY-MM-DD` | Relatório diário |
| POST | `/diagnostico/recovery` | Recovery manual (10 req/min) |

### Vendas offline

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/venda` | Registra venda local |
| GET | `/fila` | Lista fila offline |
| POST | `/fila/sincronizar` | Sync manual com backend |
| POST | `/fila/reprocessar` | Reset FALHA → PENDENTE |

### Impressora

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/impressora/cupom` | Imprime cupom (alias de /imprimir) |
| POST | `/impressora/imprimir` | Imprime cupom |
| POST | `/impressora/abertura` | Comprovante abertura caixa |
| POST | `/impressora/fechamento` | Relatório fechamento |
| POST | `/impressora/movimento-caixa` | Suprimento/sangria |
| POST | `/impressora/gaveta` | Abre gaveta |
| GET | `/impressora/status` | Teste conexão |
| GET | `/impressora/listar` | Lista impressoras Windows |
| POST | `/impressora/detectar` | Redetecta impressora |

### Contingência EPEC

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/contingencia/status` | Estado contingência |
| POST | `/contingencia/encerrar` | Encerra manualmente |
| POST | `/contingencia/epec/salvar` | Salva XML EPEC |
| GET | `/contingencia/epec/pendentes` | Lista pendentes |

### Auto-update

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/updater/status` | Estado do updater |
| POST | `/updater/verificar` | Verifica nova versão |
| POST | `/updater/rollback` | Rollback último backup |

Contratos detalhados front ↔ back: `docs/CONTRATOS_API.md`.

---

## 9. Emissão fiscal NFC-e

### Pré-requisitos

1. ACBr Monitor Pro instalado e configurado (certificado A1, CSC, ambiente)
2. `EMISSAO_FISCAL=true` no `.env`
3. Dados da empresa completos no front/backend

### POST /fiscal/emitir — resposta async

```json
{
  "fiscal": "pending",
  "status": "PENDENTE",
  "correlationId": "uuid",
  "numeroVenda": "V123",
  "async": true
}
```

### Polling — GET /fiscal/emissao/:correlationId

Statuses possíveis:

| Status | Significado |
|--------|-------------|
| `PENDENTE` | Na fila |
| `PROCESSANDO` | ACBr/SEFAZ em andamento |
| `CONCLUIDO` | Autorizada |
| `CONCLUIDO_RECUPERADO` | Recuperada por consulta chave |
| `INCERTO` | Timeout — recovery tentará resolver |
| `FALHA_PERMANENTE` | Erro definitivo |
| `NAO_ENCONTRADO` | correlationId inválido |

### Modo síncrono (legado)

`POST /fiscal/emitir?sync=1` ou `FISCAL_EMITIR_SYNC=true` — bloqueia até SEFAZ responder (não usar em produção com operador).

### Regras de negócio (hardening)

- **R1** Venda nunca perdida — registrada no backend antes da NFC-e
- **R2** NFC-e autorizada nunca perdida — recovery por consulta chave
- **R3** Nunca emitir duas vezes — dedup correlationId + numeroVenda
- **R4** Checkout não trava operador — emissão em background

---

## 10. Fila offline de vendas

Quando o backend está inacessível:

1. `POST /venda` salva em `fila.db` com `numero_venda UNIQUE`
2. Front recebe `{ origem: "offline" }`
3. Sync automático a cada `SYNC_INTERVAL_MS` (30 s padrão)
4. Idempotência via `numeroVendaCliente` no backend

---

## 11. Impressora térmica

Modo `PRINTER_TYPE=auto` (recomendado):

1. Spooler Windows (RAW)
2. Rede TCP (9100/9101)
3. USB direto

Variáveis: `PRINTER_NAME`, `PRINTER_HOST`, `PRINTER_PORT`.

Timeout impressão: 20 s no front; retry automático em 5xx/timeout.

---

## 12. Contingência EPEC

Quando SEFAZ falha na emissão:

1. Agente ativa modo EPEC
2. XMLs armazenados em SQLite
3. Retransmissão a cada 5 minutos
4. Encerramento automático quando todos transmitidos

---

## 13. Observabilidade e diagnóstico

### Dashboard local

http://localhost:9100/diagnostico/dashboard

- Status geral: OPERACIONAL | DEGRADADO | CRÍTICO
- Fila fiscal, incertos, ACBr, disco, últimas emissões
- Botão recovery manual
- Auto-refresh 10 s

### Métricas

`GET /diagnostico/metricas` — latência p50/p95/p99, contadores, rate limit.

### Webhooks

`WEBHOOK_ALERTAS_URL` — alertas de incertos acumulados e disco crítico.

`RELATORIO_WEBHOOK_URL` — relatório diário no horário `RELATORIO_HORARIO`.

### Logs

Produção: JSON rotativo em `data/logs/agente.log` (pino).  
Desenvolvimento: pino-pretty no terminal.

---

## 14. Integração com margin-engine-front

Arquivo principal: `margin-engine-front/src/services/agenteLocal.ts`

### Fluxo checkout (useFrenteCaixa.ts)

```typescript
// 1. Venda no backend
// 2. Impressão cupom
// 3. Background fiscal:
agenteService.emitirFiscal(cupom, { numeroVenda, correlationId }, caixaId);
agenteService.acompanharEmissaoFiscal(correlationId, callbacks, timeout, pollMs, routingKey);
```

### Multi-caixa

`.env` do front:

```env
VITE_AGENTE_URLS=["http://localhost:9100","http://localhost:9101"]
```

`getAgenteUrl(caixaId)` roteia por hash estável do caixaId.

### Status do agente

`agenteService.statusDetalhado()`:

1. Ping `/health`
2. `/status` com token
3. Fallback `/status-basico`

Compatibilidade validada: `docs/COMPATIBILIDADE_V1.md`.

---

## 15. Segurança

| Medida | Implementação |
|--------|---------------|
| Token local | `X-Agent-Token` após ativação |
| Cofre credenciais | Token backend fora de config.json |
| CORS | localhost + `CORS_ORIGINS` + frontendOrigin |
| Headers | `nosniff`, `X-Frame-Options: DENY` |
| Manifest SHA-256 | Bloqueia auto-update adulterado |
| Audit log | Ações sensíveis em audit.db |
| Logs | Sem CPF/valor completo em console |
| Rate limit | Fiscal + diagnóstico (recovery) |

---

## 16. Deploy, manifest e auto-update

### Manifest de integridade

```bash
npm run manifest
```

Gera `manifest.json` com SHA-256 de 28+ arquivos `.js`.  
**Gerar no mesmo ambiente de deploy** (LF vs CRLF).

### Auto-update

`AUTO_UPDATE=true` — verifica backend a cada hora.  
Recusado se manifest incompleto.

### Graceful shutdown

SIGTERM/SIGINT → fecha HTTP → aguarda jobs fiscais 30 s → fecha DBs.

---

## 17. Testes automatizados

| Comando | O que valida |
|---------|--------------|
| `npm test` | 21 testes fiscais (dedup, recovery, rate limit, purge) |
| `npm run test:contract` | 11 contratos front ↔ back |
| `npm run predeploy` | manifest, SQLite, disco, ACBr, porta |
| `npm run smoke` | Fluxo HTTP com ACBr |
| `npm run smoke:integration` | Payload idêntico ao front |

---

## 18. Docker (alternativa Linux)

```bash
docker build -t pdv-agente:1.0.0 .
docker compose up -d
```

**Nota:** ACBr não roda dentro do container — use para ambientes sem fiscal ou ACBr no host via rede.

Volumes: `./data`, `./.env` (read-only).

---

## 19. Limitações e capacidade

| Cenário | Aptidão |
|---------|---------|
| 1 caixa, 100–350 vendas/dia | ✅ Confortável |
| Farmácia/conveniência com NFC-e | ✅ Com monitoramento |
| Supermercado 500+ vendas/dia | ❌ 1 instância insuficiente |
| Multi-caixa | ✅ 1 agente por caixa |

Throughput: ~60–120 NFC-e/hora por instância.

Detalhes: `docs/NOTA_TECNICA_V1.md`, `docs/LIMITACOES_ARQUITETURA.md`.

---

## 20. Troubleshooting rápido

| Sintoma | Ação |
|---------|------|
| Front "agente offline" | Verificar serviço :9100, Private Network, CORS |
| NFC-e não sai | ACBr online? `EMISSAO_FISCAL=true`? |
| Jobs INCERTO | Aguardar recovery ou `POST /diagnostico/recovery` |
| manifestOk: false | `npm run manifest` + reiniciar |
| Token 401 | Reativar terminal ou `/auth/local-token` |
| Disco cheio | Purge ou mover XML/PDF antigos |

Guia campo: `docs/OPERACAO.md`.

---

## 21. Documentos relacionados

| Documento | Público | Conteúdo |
|-----------|---------|----------|
| **Este guia** | Dev + arquiteto | Visão completa |
| `docs/OPERACAO.md` | Técnico de campo | Instalação, backup, rede |
| `docs/CONTRATOS_API.md` | Dev front/back | Contratos HTTP |
| `docs/COMPATIBILIDADE_V1.md` | QA / integração | Matriz compatibilidade |
| `docs/NOTA_TECNICA_V1.md` | Gestor / arquiteto | Capacidade e notas |
| `docs/LIMITACOES_ARQUITETURA.md` | Todos | Restrições de design |
| `CHANGELOG.md` | Release | Histórico versões |
| `README.md` | Início rápido | Instalação resumida |

---

*Margin Engine — Agente Local v1.0.0 · Documento gerado para entrega de produção.*
