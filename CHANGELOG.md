# Changelog

Todas as mudanças relevantes do Agente Local Margin Engine são documentadas neste arquivo.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

## [Unreleased]

### Fixed — sync Windows build: Schemas via cópia case-aware (DrvFS)

- `sync-windows-build.sh`: exclui `acbrlib/data/Schemas` do rsync principal e copia arquivo a arquivo
  com merge case-insensitive (rsync mkstemp falhava no 9p; `copytree` quebrava em `IssDSF`/`ISSDSF`).
- No NTFS, as duas pastas viram um destino único — XSDs de raiz + versões 1.00/1.01/2.03 no payload.

### Fixed — instalador Windows: schemas XSD sempre no payload e no ProgramData

- Sync (`sync-windows-build.sh`/`.ps1`) copia `acbrlib/data/Schemas` do repo (NFe+NFSe); não depende mais de instalação prévia.
- Bootstrap/`installer-apply-fiscal-config`: `ensureInstallerSchemas` roda sempre (mesmo com `emissaoFiscal=false` ou `.env` existente).
- Inno: Source explícito de Schemas; `assert-installer-payload` valida contagem mínima de XSD.

- **Cupom fiscal em contingência:** XML assinado (tpEmis=9) imprime sem consulta SEFAZ; QR opcional; banner `EMITIDA EM CONTINGENCIA`.
- **Cupom não fiscal intermitente 2–5s:** HANDLE WinSpool permanece aberto entre cupons (USB não dorme); keepalive 5s; path native não espera NFC-e/SEFAZ. Retry de HANDLE velho só em StartDoc/StartPage (nunca após WritePrinter).
- **Relatório térmico de vendas do histórico:** seleção múltipla no `/pdv/historico` envia um job `relatorio` ao agente (`POST /impressora/relatorio`) com produtos agregados — mesma fila da térmica, sem reimprimir N cupons.
- Keepalive USB não enfileira ping enquanto o worker WinSpool ainda está em WritePrinter (mesmo após timeout do job HTTP).
- **Impressão RAW rápida (Win serviço):** tmp/script/DLL em `ProgramData\MarginEngine\impressao\raw`; escrita async; script memoizado (sem I/O sync por cupom); waits `PRINT_CORE_LOCK_WAIT_MS` / `PRINT_PHYSICAL_LOCK_WAIT_MS`; métricas `print.raw_phase` / `print.event_loop_lag` / `physical_lock.wait_timeout`.

## [1.0.17] - 2026-08-28

### Fixed — instalador Windows enterprise (1ª instalação sólida)

- Bootstrap: stop do serviço também no **install**; auto-reparo inline se health falhar; exit code explícito para o Inno Setup.
- Espera do agente: 120s + retry 60s (teto 180s); health in-process com backoff adaptativo.
- SCM: polling com `Atomics.wait` (sem spawn Node a cada poll); fail-fast se pacote empacotado sem `node_modules`.
- `install-service.js`: timeouts maiores no fluxo `--from-installer`; sucesso só com serviço **RUNNING**.

### Fixed — agente sobrevive a restart do serviço Windows

- HTTP sobe antes de SQLite/integrity; boot degradado; recuperação JWT via `/pdv/ativar/renovar`; shutdown limpo SIGTERM/SIGINT.

## [1.0.14] - 2026-08-27

### Fixed — dashboard 7d/30d em PDVs instalados (Essencial/Mercado)

- `frontend-dist` rebuild com `resumoPeriodo` + DRE operacional sem gate `ABC_DRE` no front.
- Datas civis locais (sem deslocamento UTC após 21h BRT).
- `Cache-Control: no-store` em `index.html`, `sw.js`, `registerSW.js`, `version.json` e `manifest.webmanifest` (força UI nova após update remoto).

### Alterado

- Versão **1.0.14** — publicar `dist/update.zip` no CDN e atualizar `PDV_AGENTE_*` no Render.

## [1.0.10] - 2026-08-10

### Fixed — agente “off” no meio da comanda

- `unhandledRejection` **não encerra** mais o processo (só loga) — evita PDV ver agente offline por alguns segundos até o serviço Windows subir.
- Estação: retry curto se agente offline/timeout; **não** manda ack `ok:false` (não queima tentativas → 410); libera claim e refila.

### Fixed — texto "?" no cabeçalho do vasilhame

- Travessão Unicode (`—`) não cabe no codepage ESC/POS → trocado por hífen ASCII: `ETIQUETA - COLE NO VASILHAME`.

### Fixed — vasilhame com um só código de barras

- Removidos dual CODE39 e QR do comprovante; fica só **CODE128** + texto legível.
### Fixed — rota parcial Bar sem Entrega

- Com alguma rota preenchida, `requirePortaForPrintType("entrega")` falha explícito se Entrega estiver vazia (não cai mais na impressora padrão em silêncio).

### Alterado

- Versão **1.0.10** (alinhada ao backend/front do hotfix 410 Gone / soft-redispatch).

## [1.0.9] - 2026-08-10

### Fixed — latência RAW 0.8–3.7s (spawn PowerShell + AddType)

- **Causa:** cada job fazia `execFile(powershell)` + `Add-Type` (300–831ms) mesmo com DLL pré-compilada.
- **Fix:** `PRINT_RAW_BACKEND=auto` → **koffi WinSpool** in-process → host PowerShell **persistente** (AddType 1x) → spawn legado só como fallback.
- Warm real: `warmPrintHotPath` aquece koffi + host persistente.
- Métricas: `print.job_e2e` (enqueue→impresso), `backend` em `print.raw_phase`, warn se etapa >200ms / E2E >1s.
- Bench: `scripts/print-raw-latency-bench.js` (~350ms economizados vs AddType simulado).
- ADR: `.ai/decisions/ADR-raw-winspool-koffi-fast-20260810.md`.

### Alterado

- Versão **1.0.9**.

## [1.0.8] - 2026-08-10

### Corrigido — Elgin i9 barcode "?" (CODE128)

- **Causa raiz:** `escpos.utils.codeLength` omitia o byte `n` do `GS k m=73` para códigos curtos (`{BVAS01`). A Elgin lia `{` (0x7B) como comprimento → imprimia `"?"`.
- **Fix:** `print/barcodeDialect.js` monta Function B corretamente (`1D 6B 49 07 7B 42…`) via `printer.raw`, sem a lib quebrada.
- **Dialetos:** Genérica/Epson, Elgin (dual CODE128+CODE39, largura≤2), Bematech, Daruma, só CODE39.
- **UI:** seletor de dialeto + “Testar código de barras” + confirmação visual Sim/Não (avança dialeto e reimprime).
- **API:** `POST /impressora/teste-barcode` (hex dump) e `POST /impressora/barcode-visual`.
- Testes: `test/barcode-dialect.test.js` (hex Elgin vs bug escpos).

### Alterado

- Versão **1.0.8**.

## [1.0.7] - 2026-08-10

### Corrigido — blindagem impressão (6 frentes)

1. **Claim/fila (com order-engine):** TTL claim 30s no backend; agente serializa RAW (`physicalResourceLock` + `withPrintLock`) — Bar+Entrega no mesmo PC sem corromper buffer.
2. **Anti-dupla / anti-409:** alinhado ao front (leader tab); jobs do incidente prod documentados em `docs/PRINT-HARDENING-SCENARIOS-20260810.md`.
3. **Multi-categoria:** mutex local um job por vez na mesma impressora física.
4. **Observabilidade:** evento `REIMPRESSAO_AUDIT` + log estruturado em 2ª via.
5. **Vasilhame:** CODE128 Epson `{B`; fallback CODE39 com falha forçada testada; QR module 58mm; banner `*** SEGUNDA VIA ***` expandido; texto código em tamanho grande.
6. **Testes A–F:** `test/print-hardening-scenarios.test.js`.

### Alterado

- Versão instalador/manifest **1.0.7**.
- `VERSION` alinhado a `package.json` (1.0.7).

## [1.0.6] - 2026-08-01

### Corrigido

- **Diagnóstico Motor OFFLINE falso:** StatusServico no worker atualizava memória só no filho; o HTTP lia offline. Agora o pai espelha `statusServico`/`testar` (`syncStatusMemoriaFromWorkerResult`). ADR `ADR-diagnostico-motor-memoria-worker-20260801.md`.
- **IE no INI (Monitor):** emitente com apenas dígitos (máscara SIARE `004388631.00-00` → `0043886310000`).
- **CarregarINI XmlNode nulo:** staging preferia `acbrlib/lib/libxml2.dll` legado; agora prioriza `LibXml2/x64` (emissão NFC-e).
- **StatusServico JSON oco:** ACBrLib (`TipoResposta=2`) pode devolver `{Status:{CStat:0}}` vazio enquanto o XML WS (`*-sta.xml`) tem `cStat=107` — fallback lê o XML e evita Diagnóstico OFFLINE / contingência falsa. ADR `ADR-statusservico-json-oco-xml-20260801.md`.
- **Certificado mTLS:** `applyNativeCertConfig` restaura `Certificado.Arquivo/Senha` + `DFe.*`; prova de identidade do PFX; senha `[Certificado]` plaintext no runtime.ini (paridade campo).
- **EMISSAO_FISCAL vivo:** drivers Lib/Monitor não congelam mais o flag no boot (`wrapAcbrExports`); salvar no painel passa a valer na fila e no Diagnóstico sem reinício.
- **Sessão ACBrLib / koffi:** wrapper oficial `@projetoacbr`; soft-abandon **sem** `Symbol.dispose`/`Finalizar` (dispose do pacote envenena koffi); idle Finalizar off por padrão; processo envenenado → `ACBR_LIB_AUTO_RECYCLE` (restart do serviço); lock reentrante; staging NFe≠NFSe; StatusServico cache positivo.
- Self-heal `garantirEmissaoFiscalAtiva` na fila e nas rotas `/fiscal/emitir*` antes de recusar emissão.
- NF-e painel com `forcarEmissao` não depende mais só de `isNfeModelo55Habilitado()` (que exigia toggle on).
- Boot reaplica autoridade local → runtime antes do HTTP/worker.
- `VERSION` alinhado a `package.json` (1.0.6).
- **Win10 impressora/status:** `posprinter.ini` SSOT em ProgramData (migra install-dir legado); status/poll trata porta RAW/TCP salva como conectada mesmo se Get-Printer falhar/timeout; janela `impressaoRecenteOk` 15 min; cache lista Windows 90s; PosPrinter sem overwrite DLL com sessão ativa.

### Alterado

- Versão instalador/manifest **1.0.6**.
- Bootstrap do instalador grava `ACBR_POSPRINTER_INI` em `%ProgramData%\MarginEngine\Config`.
## [1.0.5] - 2026-07-31

### Corrigido

- Timeout do worker ACBr rejeita **antes** de `terminate()` (não segura `physicalLock` por minutos).
- `terminate()` com teto 2s; `taskkill` com hard deadline 6s.
- TCP inválido (`TCP:192168150:9100`) rejeitado na normalização/save; POS80 com modelo `0` → `1`.
- Get-Printer não dispara sob impressão/physicalLock (evita corrida USB + HTTP 502).

### Alterado

- Versão instalador/manifest **1.0.5**.

## [1.0.4] - 2026-07-30

### Adicionado

- **Worker PosPrinter** (`acbrPosWorker` + pool): `terminate()` real no hang, sessão quente, cooldown, fallback in-process.
- **`physicalResourceLock`** + `PHYSICAL_USB_TOPOLOGY=shared|separate` — serializa térmica/NFC-e no mesmo hub USB.
- **`config/printEnvSchema.js`** — SSOT de timeouts; `.env.example` gerado (`npm run generate:print-env` / `check:print-env`).
- ADR: worker + lock físico + schema env.

### Alterado

- Timeouts canônicos alinhados (4s/2s/4s/5s); typo de env → clamp (sem restart do serviço Windows).
- Native RAW e emissão NFC-e sob o mesmo modelo de locks físicos.
- Main bloqueado de carregar PosPrinter com worker ativo; Detectar/force limpa fallback in-process.
- Versão instalador/manifest **1.0.4**.

## [1.0.1] - 2026-07-12

### Adicionado

- **AUTO_UPDATE cobre `frontend-dist/`** — manifest com SHA-256, backup, rollback e validação para agente + PWA.
- `scripts/package-update-zip.js` (`npm run package:update`) — empacota `dist/update.zip` para `PDV_AGENTE_URL_DOWNLOAD`.
- Contrato HTTP front↔agente (`apiContract.js`, `apiContractVersion`) e telemetria de versão no heartbeat.
- Testes: `manifest-updater-front`, `updater-remote-check`, `api-contract`, `heartbeat-version`.

### Alterado

- `manifestUpdater.js` — suporte a subpastas `frontend-dist/` no apply/rollback.
- `scripts/sync-windows-build.sh` — manifest gerado após sync do front.

### Corrigido

- Impressão automática no checkout (via `frontend-dist` neste release) — fluxo fiscal/não fiscal sólido com `cupomModo: SEMPRE`.

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
