# Changelog

Todas as mudanças relevantes do Agente Local Margin Engine são documentadas neste arquivo.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

## [1.0.0] - 2026-06-19

Primeira versão apta para produção comercial, consolidando cinco fases de hardening fiscal e operacional.

### Adicionado

**Fila fiscal e emissão assíncrona (Fases 1–2)**
- Fila fiscal v2 com estados, deduplicação por `correlationId` e `numeroVenda`, metadados `_fiscalMeta`
- Emissão NFC-e assíncrona (`POST /fiscal/emitir`) com checkout desacoplado da SEFAZ
- Job `GERAR_PDF` fora do caminho crítico de emissão
- Recovery de boot e consulta de chave antes de reemitir (`fiscalRecuperacao.js`)
- Rate limit anti-tempestade SEFAZ por CNPJ (`fiscalRateLimit.js`)
- Métricas persistentes (`fiscalMetrics.js`, `GET /diagnostico/metricas`)
- Purge automático de SQLite e arquivos fiscais (`fiscalPurge.js`, `fiscalStorage.js`)
- Watchdog ACBr com pausa de fila e restart opcional
- Testes automatizados: `fiscal-hardening`, `fiscal-production`, `fiscal-chaos` (21 casos)

**Segurança e integridade (Fase 3)**
- `POST /acbr/nfce/emitir` retorna 410 sem `numeroVenda`; com venda enfileira na fila fiscal
- `manifest.json` com SHA-256 obrigatório; auto-update bloqueado se hash vazio
- Graceful shutdown: `server.close()` + `aguardarJobsAtivos(30s)`
- Verificação de espaço em disco antes de gravar XML/PDF/backup
- Endpoints `GET /diagnostico/alertas` e `GET /diagnostico/saude`

**Resiliência e operação (Fase 4)**
- Backoff de recovery com `tentativas_consulta`, `proximo_retry_at`, `MAX_TENTATIVAS_CONSULTA`
- Checkout front-end fire-and-forget com badge "Emitindo NF..."
- Documento `docs/LIMITACOES_ARQUITETURA.md`
- Scripts `npm run predeploy` e `npm run smoke`

**Observabilidade e multi-caixa (Fase 5)**
- Dashboard HTML inline (`GET /diagnostico/dashboard`, refresh 10s)
- Recovery manual (`POST /diagnostico/recovery`)
- Multi-caixa no front via `VITE_AGENTE_URLS` / `getAgenteUrl(caixaId)`
- Webhooks de alerta (`fiscalAlertas.js`) e relatório diário (`fiscalRelatorio.js`, `GET /diagnostico/relatorio`)
- Alias `GET /fiscal/status/:correlationId`
- Manifest com 27+ arquivos SHA-256

**Release (Fase 6)**
- Headers de segurança globais (`X-Content-Type-Options`, `X-Frame-Options`)
- Rate limit separado para diagnóstico (10 req/min em recovery e relatório)
- Purge de `audit.db` configurável (`AUDIT_RETENCAO_DIAS`, padrão 90 dias)
- `CHANGELOG.md`, `docs/OPERACAO.md`, `docs/NOTA_TECNICA_V1.md`
- Deploy alternativo via Docker (`Dockerfile`, `docker-compose.yml`)

**Integração front (Fase 7)**
- `docs/CONTRATOS_API.md`, `docs/COMPATIBILIDADE_V1.md`, `docs/GUIA_COMPLETO.md`
- `test/contract.test.js`, `scripts/smoke-integration.js`
- Alias `CORS_ORIGINS`; tipos alinhados no margin-engine-front

### Corrigido

- Bug `purgeAntigos`: variável `diasDocumentos` não declarada em `filaFiscal.js`
- Front: polling fiscal passa a usar `correlationId` retornado pela API
- Front: `enviarImpressaoCupom` restaurado após desacoplamento fiscal
- `generate-manifest.js`: união de `ARQUIVOS_PADRAO` com manifest existente (27 arquivos)
- Função `contarIncertosComBackoff` restaurada após refactor acidental

### Segurança

- Remoção de `backendToken` de payloads SQLite; sanitização de registros legados
- Logs estruturados sem payload completo de venda (CPF, valor omitidos ou mascarados)
- Token do agente exigido em rotas sensíveis quando PDV ativado
- Credenciais sensíveis no cofre (`credenciais.js`), não em `config.json`

### Limitações conhecidas

- **1 agente = 1 ACBr = 1 caixa** — throughput ~60–120 NFC-e/hora por instância; escalar = uma instância por caixa
- **SHA-256 do manifest** sensível a LF/CRLF — gerar manifest no ambiente de deploy final
- **Supermercado 500+ vendas/dia ou multi-caixa centralizado** exige arquitetura evoluída (ver `docs/NOTA_TECNICA_V1.md`)
- Operação 24×7 contínua em volume alto requer monitoramento ativo e purge configurado
