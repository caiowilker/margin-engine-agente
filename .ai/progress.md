# PROGRESS — Agente Local

**Última atualização:** 2026-07-31  
**Versão:** `1.0.5` — fail-fast worker + TCP válido + config UI sólida

## Changelog (2026-07-31) — Solidez impressão (audit hang)

- **Kill latch:** após timeout do worker, próximo job espera `terminate`+cooldown — sem 2ª DLL no mesmo RAW.
- **Guard térmico** antes de `POS_Ativar` no caminho worker (jato/laser).
- **Estação:** sem `invalidate`×2 por pedido (sessão quente; re-Ativa só se Porta mudar).
- **Salvar config** reseta circuito ACBr + limpa fallback in-process.
- Sem fallback no mesmo job após timeout/Imprimir; Detectar não força Get-Printer sob lock.
- Timeouts RAW/list dinâmicos; Device `TimeOut` alinhado ao soft call; `PodeLerDaPorta` opt-in.
- **Sem FFI no main:** worker morto → native (não koffi no processo HTTP). Opt-in: `ACBR_POS_ALLOW_INPROCESS` ou `ACBR_POS_WORKER=false`.
- **Circuito TTL default 0:** só Salvar/Detectar reabre ACBr (sem half-open surpresa).

## Changelog (2026-07-31) — PosPrinter -10 / INI RAW produção

- INI: `LogNivel=0`, `ArqLog=`, `BytesCount=512`, `BytesInterval=10`, `TimeOut=5`, `ControlePorta=0` (RAW).
- Boot regrava INI canônico + `npm run check:posprinter-deps` (DLL + side + koffi).
- Dica operador -10 atualizada (spooler “imprimir direto”).
- ADR: [ADR-posprinter-raw-ini-20260731.md](./decisions/ADR-posprinter-raw-ini-20260731.md).

## Changelog (2026-07-31) — Porta escolhida = única usada (anti host de teste)

- Env de impressão lido **dinamicamente** (não mais congelado no boot do módulo).
- Boot **sanitiza** `TCP:192168150` e host fantasma; INI válido é SSOT.
- Native imprime **só** a porta salva (RAW/TCP) — sem scan de rede/host antigo.
- `PRINT_RAW_STRICT` default **true**.

## Changelog (2026-07-31) — Config impressão UI + persistência sólida

- Persistência atômica (INI/.env/stations); reset só se mudou; `unchanged` na API.
- TCP inválido rejeitado no save (422); modelo POS80 `0`→`1`; `paperMm` no `ler()`.
- UI: dirty state, select de modelo, TCP só com IP válido + “Aplicar IP”, confirmar Detectar.
- Front: `obterConfigImpressora(fresh)`, resposta com `config`/`unchanged`.

## Changelog (2026-07-31) — 1.0.5 Fail-fast (logs Caixa 1)

- **Causa:** timeout do worker só rejeitava após `terminate()` → `physicalLock` 70–90s; TCP `192168150` sem pontos; Get-Printer + taskkill até 143s.
- Worker: `reject` imediato + `terminate` com teto 2s.
- TCP: validação IPv4; save rejeita porta inválida; POS80 → modelo `1` se `0`.
- Get-Printer: só cache sob impressão / lock / late abandon.
- `killProcessTree`: hard deadline 6s.
- ADR: [ADR-print-failfast-tcp-list-20260731.md](./decisions/ADR-print-failfast-tcp-list-20260731.md).

## Changelog (2026-07-31) — Diagnóstico Win32 + half-open circuito

- **`print.raw_win32_timing`:** OpenPrinter → WritePrinter → EndDocPrinter com `slowest=` no log.
- Script de campo `scripts/diagnose-raw-print.ps1` (sem agente).
- **`ACBR_POS_CIRCUIT_TTL_MS` (default 15 min):** circuito não fica forever em native — retenta ACBr/Epson (QR tags). `0` = nunca expira.
- Contexto: update 1.0.3 (RAW 8s→4s + circuito) fez PCs com USB lento parecerem “parados”; Epson/QR GS(k) segue correto no código.

## Changelog (2026-07-31) — P2a/P2c harden kill RAW + fallback in-process

- **P2a:** `print/winProcessKill.js` — `taskkill /F /T` com confirmação de PID morto; métricas `print.taskkill_attempt`, `print.taskkill_still_alive`, `print.child_exit`.
- Soft timeout **mata** o wrapper, mas **só libera physicalLock** quando kill confirma morte, filho sai, ou teto `PRINTER_RAW_KILL_HOLD_MS` (default 12s) — evita 2º cupom no USB ainda ocupado.
- Erro RAW marca `code=RAW_PRINT_TIMEOUT` + `printTimedOut` (sem fallback ACBr no mesmo job).
- Hard kill (+1,5s) permanece ativo após soft (antes era cancelado pelo `finish`).
- Cleanup de temp no settle; leak-guard de segurança.
- **Nota de campo:** wrapper PowerShell morto ≠ spooler parou — `late_abandoned` com `lateMs` documenta drenagem do driver USB.
- **P2b:** guard/teste — `execFileSync(` proibido em `impressoraCore`.
- **P2c:** fallback in-process do worker sobe para `error` + abre circuito ACBr (comerciais → native).
- ADR: [ADR-raw-kill-hold-lock-20260731.md](./decisions/ADR-raw-kill-hold-lock-20260731.md).

## Changelog (2026-07-30) — 1.0.4 Worker FFI + physical lock + env SSOT

- **Worker PosPrinter** com `terminate()` real, sessão quente, cooldown pós-kill, fallback in-process.
- **Main não toca PosPrinter** com worker ON (`ACBR_POS_WORKER_OWNS_SESSION`); status soft-fail; fila interna no pool (sem BUSY).
- **`physicalResourceLock`** + `PHYSICAL_USB_TOPOLOGY` (default `separate`); native RAW e NFC-e/NFS-e sob o mesmo modelo de keys.
- **`printEnvSchema`**: defaults canônicos; `.env.example` gerado; typo → clamp (sem restart loop).
- Flag: `ACBR_POS_WORKER=true` (default); rollback `=false`.
- ADR: [ADR-worker-pos-physical-lock-env-20260730.md](./decisions/ADR-worker-pos-physical-lock-env-20260730.md).

## Changelog (2026-07-30) — Solidity produção (poll + circuito + front)

### 1.0.3 (produção — passada PDV real)

- Factory honra circuito → **native** efetivo (sem timeout ACBr no 2º cupom).
- Hard drain: **sem fallback** no mesmo job (anti-dupla física).
- Timeouts comerciais: soft **4s**, drain **≤2s**, RAW **4s**, ACBr call **5s**, wait fiscal **2s**.
- Front: imprime mesmo com status “off” stale; POST timeout **6s**.
- Checklist campo: USB suspend, bidirecional, driver fabricante.

- Versão instalador/agente/front alinhada para deploy em campo (substitui 1.0.1).
- `postImpressaoTermica` preserva `motivoImpressao` no Error (timeout ≠ offline).
- Reclaim não roda com `impressaoEmAndamento()`; job `ERRO` não promove a `IMPRESSO` se status mudou no meio do envio.
- Bootstrap não chama `resetPrintProvider` quando sync foi idempotente (`unchanged: true`).
- Testes: busy probe, solidity production, circuit, idempotência.

- Hang ~150 s em `RAW:POSPrinter POS80`, `AbortError` (“signal is aborted without reason”), falso **Agente off**.
- Loop `[PrinterLocalConfig] Configuração salva` + `resetPrintProvider` a cada poll de status.
- PWA 1.0.0 **não** era a causa.

### Fix (Fases 1–5)

1. **`salvar` / `sincronizarDeDeteccao` idempotentes** — skip se porta/modelo/env iguais.
2. **`testar` read-only** (ACBr provider + impressoraCore) — sem sync/reset no poll.
3. **`GET /impressora/status` + `printerService.testar`** respeitam `impressaoEmAndamento` (igual probe leve).
4. **Circuito ACBr persistente** (`acbr-pos-circuit.json`); `-10`/timeout/hard-drain abrem circuito; comerciais → native; reset só Detectar force.
5. **Hard drain:** `late_abandoned_ok` só log; job já `ERRO` não vira `IMPRESSO`.
6. **Front:** `timeout_impressao` ≠ `agente_offline` ([`impressaoGarantida.ts`](../margin-engine-front/src/lib/impressaoGarantida.ts)).
7. Docs: [ADR-print-poll-readonly-circuit-20260730.md](./decisions/ADR-print-poll-readonly-circuit-20260730.md), [CHECKLIST-IMPRESSORA-CAMPO.md](./CHECKLIST-IMPRESSORA-CAMPO.md).

### ACBr PosPrinter como caminho oficial (fim do cupom ~120s)

- **Causa raiz real em produção:** a DLL `ACBrPosPrinter64.dll` estava instalada, mas **bindings FFI ausentes** → `canLoadNativeLib()=false` → factory caía sempre em ESC/POS nativo (`provider_nao_operacional`).
- **Hang ~120s:** `enviarRawWindows` matava o PowerShell com `SIGTERM` (ineficaz no Windows) e **não rejeitava a Promise** no timeout → job só terminava quando o spooler soltava (~2 min); agente “off”, `signal is aborted without reason` no front.
- **Fix:**
  1. FFI via **`koffi`** (prebuild Windows — sem VS Build Tools; `ffi-napi` exigia compile no reparo e falhava).
  2. `PRINT_FAST_NATIVE=false` padrão → impressão via **ACBr tags**; native só retaguarda.
  3. Timeout RAW: `taskkill /F /T` + reject imediato (máx. ~8s no fallback).
  4. Export `detectarImpressora` (corrige `core.detectarImpressora is not a function` no bootstrap).
- **Nota:** HTTP **402** em PIX/capability era gate `DELIVERY_PLUS` indevido — corrigido no backend.

### Impressão térmica instantânea — fim da demora de minutos

- **Causa raiz (sessão RAW):** a cada cupom o pipeline fazia `invalidatePosPrinterSession` + `POS_Ativar` de novo na porta `RAW:` (spooler Windows). O Ativar travava minutos → UI dizia "enviado", papel só depois, agente sumia (threadpool FFI preso) e voltava.
- **Fix (mantido):**
  1. Sessão PosPrinter **quente**; sem re-Ativar por job; invalidação só após fiscal.
  2. Timeout duro em `callPos` (8s) + hard-drain no executor.
  3. `PRINT_FAST_NATIVE=true` permanece como escape hatch (não é mais o padrão).
- **Hardening (mesma data):**
  - Porta `RAW:` não varre rede/USB em fallback.
  - Timeout dedicado `PRINT_JOB_TIMEOUT_FAST_MS=4000` para tipos comerciais.
  - Probe de status pula enquanto `impressaoEmAndamento`.
  - RAW timeout padrão 8s; retries ACBr PosPrinter 2.
  - Follow-up auditoria: Desativar/Finalizar com timeout 2s; hard-drain sem retry de fila; station route sem invalidate no native; `resetPrintProvider` não dispara Desativar; aviso de flags perigosas no boot; gate de reclaim com envio abandonado vivo.
  - **Cache `printerLocalConfig.ler()` (5s):** render ia de ~1.7s → ~0.3ms por cupom (INI lido dezenas de vezes). Crítico p/ produção.
  - Benchmark CI sem logo + iterações reduzidas; auditoria T00 usa versão do `package.json`.

### Agente sempre rápido — probes e event loop

- `Get-Printer` virou **async** (`execFile` + single-flight + cache 30s) — nunca mais congela o Node.
- `/status` e `/status-basico` usam probe leve: impressão recente / memória fiscal; live só no cold start ou `?probe=1`.
- `/impressora/status` não chama Get-Printer/POS se houve impressão recente.
- Heartbeat com timeout 5s; `mesaFila` alinhado a 5s.

### 1ª via impressa como "*** SEGUNDA VIA ***"

- Causa: `imprimirCupomFiscalPreferido` defaultava `segundaVia: true`; `reimprimirDanfce` sempre usava `montarPayloadSegundaVia`.
- Fix: 1ª via sem banner; banner só com `reimpressao`/`motivo`; endpoint `/acbr/nfce/reimprimir` respeita `segundaVia`/`reimpressao`.

### Impressão térmica — regressão de latência (~140s) e AbortError

- **Causa:** `enviarRawWindows` usava `execFileSync` (PowerShell + `WritePrinter`). Quando o spooler demorava, o event loop do agente congelava ~2 min — timeouts da fila não disparavam; o front abortava aos 25s (`signal is aborted without reason`) e retentava, enfileirando duplicatas.
- **Fix (rodada 1):**
  - RAW Windows **async** (`execFile` + soft/hard kill).
  - Caminho rápido `windows-raw-config` quando `PRINTER_PORTA=RAW:…`.
  - HTTP **202/fila** imediato em todas as rotas `/impressora/*`.
  - Idempotência de cupom; espera fiscal curta; `VerificarImpressora=0`.
- **Fix (rodada 2 — solidez):**
  - Timeout **cooperativo**: no deadline, drena o invoke (não abandona) — se concluir tarde, aceita; evita dupla impressão e lock preso.
  - Libera sessão ACBr só **depois** do invoke terminar (nunca no meio do `POS_Imprimir`).
  - Front: `montarPayloadCupomNaoFiscal` **não** marca `segundaVia` na 1ª via; 2ª via usa `reimpressao`/`motivo`.
  - TTL cupom 180s (anti-retry); pedido/comanda mantém 24h.
  - Reclaim periódico de jobs `ENVIANDO` presos; RAW soft-kill → hard-kill; timeout HTTP front 8s.

## Changelog (2026-07-28)

### Logo térmica maior e estruturada

- Política única `printerLogoSize.js`: fator padrão **2×** (legado 1 promove automaticamente).
- ACBr: `logo_fatorx/y` + `<bmp Largura>` conforme papel 58/80mm.
- ESC/POS: resize via sharp antes de `image()`; INI PosPrinter_Logo alinhado.
- Preview HTML da 2ª via com logo maior; copy no painel de impressora.

### Impressão PDV — COLS TDZ (cupom/fechamento)

- Causa: `renderCupomConteudo` / `renderFechamentoConteudo` usavam `COLS` antes de `const COLS = getThermalCols()` → `Cannot access 'COLS' before initialization`.
- Sintoma: teste de impressora OK; cupom do frente de caixa e fechamento falhavam (fallback native ESC/POS).
- Fix: declarar `COLS` no início das funções; teste `impressora-core-cols.test.js`.
- Extra: `canLoadNativeLib` exige `ffi-napi`/`ref-napi` (não só DLL) — evita falso "ready" e fallback ruidoso a cada cupom; `classifyPrintError` cobre ffi/COLS.

## Changelog (2026-07-26)

### Hardening sessão QR Garçom (review)

- LoginPage aplica `entrarComQrGarcom` (setUser antes de navegar) — evita bounce /login↔/mesas.
- `isUsableOperatorMe` + normalize FOOD_SERVICE; single-flight no exchange.
- Floor sem perfil: não deixa sessão zumbi; pede regenerar QR.
- Agente sanitiza operatorMe no mint (sem secrets).

- Causa: `api-backend.json` e fallback do proxy apontavam para `app.marginengine.com.br` (SPA) → login/getMe falhavam → "Servidor indisponível" e mesas não abriam.
- Fix: `normalizeBackendUrl` no `apiProxy` (app/www → `api.marginengine.com.br`); build grava API correta.
- Floor mint inclui `operatorMe`; exchange devolve perfil → celular entra no mapa sem depender de getMe/nuvem nem credenciais offline.
- LoginPage: retry do QR + copy orientando garçom (não senha no celular).

- Causa: `.env` com `AGENT_BIND_HOST=127.0.0.1` (legado do `.env.example`) vencía o LAN — QR com IP certo, celular `ERR_CONNECTION_REFUSED`.
- Fix: `resolveBindHost` ignora loopback quando `lanStaffAccess` está on → força `0.0.0.0`.
- Firewall: regra `PDV Agente 9100` com **-Profile Any** (instalador + boot); migra `.env` no bootstrap.
- `GET /lan/info.diagnostics` + UI no QR Garçom (bind / reachability / firewall).
- Testes: `lan-network`, `lan-diagnostics`.

### QR Garçom na LAN (IP + token sem senha) — hardening

- Mint via IP LAN do PC (não só loopback); JWT obrigatório no body; rate limit floor.
- CORS/`PNA` com `Authorization`; `lanStaffAccess` no catálogo JS↔Java; `/status-basico.lan`.
- Front: stash do floor até exchange OK; retry pós-login; QR só com `operatorBound`.
- Docs/ADR alinhados (sem senha no celular).

### Anti-duplicata térmica (pré-conta / comanda)

- Agente: `idempotency_key` em `print_jobs` — retry/timeout/duplo POST não reimprimem.
- Pré-conta: chave `preconta:{orderId}:{hash}`; comanda nuvem: `cloud:{jobId}`.
- Estação WS só no **localhost** do caixa (celular no IP LAN não imprime cozinha).
- `MesaToolbar` trava síncrona; `usePrintStation` dedup in-memory por `jobId`.
- Testes: `test/print-idempotency.test.js`.

### QR Garçom na LAN (IP + token sem senha)

- Problema: QR usava `localhost`; agente escutava só `127.0.0.1`; `/api-proxy` bloqueava celular.
- Solução: `lanNetwork.js` + bind `0.0.0.0` com `lanStaffAccess`; `garcomFloor.js` (mint/exchange); QR `http://IP:9100/pdv/mesas?floor=…`.
- Front: `StaffHubQrSection` mint com JWT do caixa; `AuthContext` exchange no boot; pré-conta térmica inalterada (`/impressora/pedido` + agentToken).
- Testes: `test/lan-network.test.js`, `test/garcom-floor.test.js`; front `mesaStaffQr.test.ts`.

## Changelog (2026-07-18)

### QR Code NFC-e no cupom térmico (impressão do sistema)

- Causa: `printer.qrcode()` da lib `escpos` envia `GS Z`/`ESC Z` (proprietário). Impressoras Epson-compatíveis ignoram e imprimem a URL da NFC-e como texto.
- Correção: sequência padrão `GS ( k` (Fn 165/167/169/180/181) via `bytesQrGsK` + `printer.raw()`, com fallback raster.
- Config: `PRINTER_QR_ESCPOS_MODE=gs_k|raster` (padrão `gs_k`).
- Teste: `test/qr-cupom.test.js` no pipeline `test:print`.

### Update remoto — hardening pós-auditoria

- Agente: `atualizando` até o exit; ACK cloud só pós-restart; manifest obrigatório; versão lida do disco; rollback limpa pending.
- Backend: ACK sem body = falha; erro sempre gravado em `ok=false`; `@Version` + `@DynamicUpdate` anti lost-update; revogar limpa pedido.
- Front: force via `codigo`/`podeForcar`; feedback no cancelar.

### Update remoto — fase 5 (fechamento / hardening)

- **ACK pós-restart:** `updaterCloudPending.js` persiste pedido de ACK após apply cloud; flush no poll de config (idempotente).
- **Rollback HTTP:** `/updater/rollback` restaura backup e **agenda reinício** (evita processo com código velho em memória).
- Testes: `updater-cloud-pending.test.js`.

### Update remoto — fase 4 (observabilidade no ERP)

- Listagem `GET /pdv/ativacao/terminais` inclui `agentVersion`, heartbeat, flags de update (`updatePendente`, erro, `versionOutdated`) e `latestAgentVersion`.
- Front Terminais PDV: chips de status, alerta de frota desatualizada, cancelar pedido pendente.
- Testes em `PdvAtivacaoControllerTest` (toTerminalListItem).

### Update remoto — fase 3 (comando por dispositivo no cloud)

- Backend: colunas `update_requested_*` / `update_applied_at` / `update_last_error`; `POST /pdv/dispositivos/{id}/update/request|cancel`; `POST /pdv/agente/update/ack`.
- Agente: após poll de config, se `aplicarUpdateQuandoOcioso`, tenta apply ocioso (`force: false`) e envia ACK; ocupado não ACK (reintenta).
- Front: Terminais PDV → “Atualizar agente” por terminal ATIVO.
- Teste: `updater-cloud-request.test.js`.

### Update remoto — fase 2 (publicação + apply seguro)

- **`npm run release:update`**: gera `dist/update.zip` + `update-release.json` + `update-release.env` (variáveis `PDV_AGENTE_*` para o Render).
- **`updaterIdleGuard`**: `UPDATE_REQUIRE_IDLE=true` (padrão) — não aplica com fiscal/fila ativos; Diagnóstico oferece força com confirmação; AUTO_UPDATE nunca força.
- Front Diagnóstico: confirm “Aplicar mesmo assim” quando 409 ocupado.

### Update remoto — fase 1 (manifest completo + anti-downgrade)

- **Política** `scripts/manifestPolicy.js`: update.zip inclui JS da raiz, `package.json`, `print/`, `fiscal/`, `runtime/`, `storage/` e `frontend-dist/`; exclui nativos, DLLs, `node_modules`, testes e scripts de build.
- **Geração** `generate-manifest.js` / `package:update` validam cobertura obrigatória (ex.: `print/qrCodeAcbrBmp.js`) antes de publicar.
- **Anti-downgrade** `updaterVersion.js` (paridade Inno) em `updaterRemoteCheck` e `manifestUpdater.aplicarPacote`.
- **Apply sólido:** grava o novo `manifest.json` após copiar arquivos (corrige boot `manifestOk: false`); backup formato 2 com `_backup-index.json` sem sobrescrever o manifest real; exige `package.json` no pacote.
- Testes: `manifest-policy.test.js`, anti-downgrade em `updater-remote-check` e `manifest-updater-front`.

### QR Code NFC-e no cupom térmico — BMP sem sharp

- **Bug:** `gerarBmpQrAcbr` usava `sharp.toFormat("bmp")`, formato de saída **não suportado** pelo sharp. Toda URL de QR NFC-e (contém `|`) falhava na geração do BMP → `printExecutor` caía no fallback ESC/POS nativo → impressoras sem comando QR nativo imprimiam a **URL em texto** no lugar do QR.
- **Correção:** `print/qrCodeAcbrBmp.js` agora codifica BMP monocromático 1-bpp diretamente da matriz do QR (`qr-image.matrix`), com quiet zone de 4 módulos e escala via `PRINTER_QR_BMP_WIDTH` (padrão 280 px). Sem dependência de sharp no fluxo de impressão.
- **Teste:** harness de `test/print-extended.test.js` corrigido para aguardar testes assíncronos (a falha era engolida); teste do QR BMP agora valida header `BM`, 1 bpp e tamanho do arquivo gerado.

## Changelog (2026-07-17)

### Impressão — contrato HTTP e status honest

- Helper `responderResultadoImpressao`: contrato único **200** impresso / **202** fila em cupom, abertura, fechamento, movimento, pedido, gaveta, teste, segunda-via.
- `GET /status`: durante fiscal ocupado, **não** chama `impressora.testar()` (paridade com `/status-basico`); evita falso `impressoraConectada=false` / timeout → offline no PDV.

> **Certificação:** [`../../margin-engine/.ai/certification/CERTIFICACAO_1.0.md`](../../margin-engine/.ai/certification/CERTIFICACAO_1.0.md)  
> **Estado oficial:** [`../../margin-engine/.ai/PROJECT_STATUS.md`](../../margin-engine/.ai/PROJECT_STATUS.md)

---

## Maturidade

| Dimensão | Indicador |
|----------|-----------|
| ACBrLib (padrão 1.0) | 🟢 `ACBR_DRIVER=lib` default |
| ACBr Monitor (fallback) | 🟢 `ACBR_DRIVER=monitor` |
| Fila fiscal + callback | 🟢 Produção |
| Impressão (PrintJobService + hardening F13) | 🟢 Pipeline único certificado |
| Contingência EPEC | 🟢 Automática F14/F16 |
| Instalador Windows | 🟢 Stop/start + anti-downgrade + `check:release-alignment` |
| Build Windows | 🟢 Pipeline documentado em `build/windows/LEIA-ME.md` |
| Recovery SQLite degradado | 🟢 F15 |
| Testes automatizados | 🟢 `npm test` + `test:integration` verdes |
| Order Engine / Print Station | 🟢 `POST /impressora/pedido` + `frontend-dist` alinhado |
| NFS-e (modelo 99) | 🟢 Rotas + callback; Lib nativa `ACBrNFSe64.dll` (`nfseLib.js`) com fallback Monitor |

---

## Entregas F13–F17

| Frente | Entrega |
|--------|---------|
| F13 | `print/printJobService.js`, worker, retry, catálogo config |
| F14 | Watchdog → contingência; instalador stop/restart; docs antivírus |
| F15 | Limites fila offline/fiscal; `recoverCorruptedBootDbs`; métricas diagnóstico |
| F16 | EPEC UUID; restore SEFAZ; bootstrap abort; paths docs |
| F17 | Certificação plataforma 1.0.0 |

---

## Driver fiscal

```
fiscal/factory.js
  ├── lib      ← padrão 1.0 (ACBrLib Pro)
  └── monitor  ← fallback (ACBr Monitor TCP)
```

Contrato unificado: `fiscal/contract.js` + testes paridade.

---

## Operação

- Docs: `docs/OPERACAO.md`, `docs/CONTRATOS_API.md`
- Checklist Windows: `../../margin-engine/.ai/homologacao/checklist-homologacao-windows-1.0.md`
- Deploy: `.ai/DEPLOY_PRODUCTION.md`

---

## Pendente (não bloqueante 1.0)

- Homologação SEFAZ em hardware Windows por loja piloto
- Remoção componentes legados exportados sem uso (coordenação com front)
