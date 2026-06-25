# PROJECT BRAIN

## Project Name

Margin Engine Agente Local — Terminal PDV Windows/WSL

---

## Business Objective

Serviço Node.js local que conecta o PDV ao hardware (impressora térmica, balança, gaveta) e à camada fiscal via ACBrMonitorPLUS. Garante fila offline comercial, fila fiscal persistente, armazenamento XML/PDF e callback ao backend.

---

## Main Features

* API Express em `:9100` — impressão, vendas offline, fiscal, diagnóstico
* Integração ACBr TCP `127.0.0.1:9200` — NFC-e 65, NF-e 55, cancelamento, inutilização
* Fila SQLite — `fila.js` (vendas), `filaFiscal.js` (emissão, callback, PDF)
* Impressão térmica ESC/POS — `impressora.js` (cupom, fechamento, abertura, movimento)
* Documentos fiscais — `documentosFiscais.js` (XML, PDF, QR, paths ACBr)
* Auto-update, config sync com backend, vault de credenciais (Credential Manager)

---

## Backend

Technology: Node.js 20+, Express, better-sqlite3, escpos, Pino

Architecture: monólito modular; `index.js` roteador; serviços por domínio

Patterns: mutex global ACBr (`acbr.js`), fila persistente com idempotência, callback assíncrono ao Spring Boot

Responsabilidade fiscal: executar ACBr, persistir XML/PDF local, enviar `qrcode` + Base64 ao backend

---

## Frontend

Technology: build estático opcional em `frontend-dist/` (repo separado `margin-engine-front`)

Architecture: agente serve SPA em produção ou apenas API

---

## Impressão térmica e QR NFC-e (2026-06)

| Recurso | Implementação |
|---------|----------------|
| QR conteúdo | URL `infNFeSupl/qrCode` — `resolverQrCodeNfce` |
| ESC/POS | `printer.qrcode(..., "M", size)` + fallback `qrimage` PNG |
| Obrigatoriedade | NFC-e modelo 65 sem QR → **erro** (não imprime fiscal incompleto) |
| Portal consulta | Host extraído da URL do QR (`portalConsultaDocumento`) |
| Chave | Grupos de 4 dígitos |
| Endereço | `formatarLinhaEnderecoEmpresa` — sem duplicar bairro |
| NF-e 55 | Título e portal distintos; QR não exigido |
| Env | `IMPRIMIR_QR_NFCE=true`, `IMPRIMIR_QR_NFCE_SIZE=3..8` |

Teste: `test/qr-cupom.test.js`

---

## Database

Technology: SQLite em `data/agente.db`

Tabelas principais: fila vendas, fila fiscal, documentos, configuração

Rules: nunca apagar XML autorizado; PDF validado com `%PDF`

---

## Security

Authentication: `X-Agent-Token` após ativação PDV; rotas públicas mínimas (`/status-basico`)

Authorization: token por dispositivo/caixa; CORS + `privateNetworkHeaders` nas rotas de impressão

Rules: certificado A1 e CSC ficam no ACBr, não no agente; credenciais backend no Credential Manager

---

## Integration

External APIs: ACBrMonitorPLUS (TCP), Spring Boot (callback fiscal, sync config)

Queues: `filaFiscal` — EMISSAO, CALLBACK_BACKEND, GERAR_PDF, CANCELAMENTO, INUTILIZACAO

Messaging: HTTP REST; sem message broker

Paths ACBr: `C:\ProgramData\MarginEngine\acbr\` (XML, PDF, logs)

---

## Development Standards

* Código em inglês; docs `.ai/*` e `docs/*` em português brasileiro
* Testes em `test/*.test.js` — rodar antes de release
* Logs estruturados Pino na fila fiscal
* Não bloquear event loop em impressão (async qrimage)

---

## Project Constraints

* Windows como alvo principal de produção (raw print PowerShell)
* ACBrMonitorPLUS obrigatório — não substituir
* Porta 9100 padrão (configurável via `PORT`)

---

## Important Decisions

* ADR-001: agente como único ponto ACBr + hardware
* ADR-010 (backend): orquestração emissão no agente com callback
* TCP ACBr preservado (não migrar para ent/sai como protocolo principal)
* Impressão cupom fiscal só com QR válido para NFC-e 65

---

## Non Functional Requirements

* Emissão NFC-e < 15s condições normais
* Impressão com lock (`printLock`) — sem concorrência na térmica
* Reconciliação fiscal periódica (`FISCAL_RECONCILIACAO_MS`)
* Timeout emissão configurável (`ACBR_TIMEOUT_EMISSAO_MS`)

---

## What Must Never Change

* Fluxo: Front → Agente → ACBr → SEFAZ
* Callback backend com `chaveNfe`, `qrcode`, XML/PDF após autorização
* Fila fiscal persistente antes de produção
* Idempotência sync vendas offline

---

## Referências

* Progresso: `.ai/progress.md`
* Deploy: `.ai/DEPLOY_PRODUCTION.md`
* Docs operação: `docs/OPERACAO.md`, `docs/GUIA_COMPLETO.md`
* Contratos API: `docs/CONTRATOS_API.md`
