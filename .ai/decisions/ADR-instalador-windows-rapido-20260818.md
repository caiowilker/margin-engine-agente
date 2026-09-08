# ADR — Instalador Windows rápido no caixa

**Data:** 2026-08-18  
**Status:** Aceito

## Problema

O `Margin-Engine-Setup-*.exe` levava vários minutos no ponto de venda. O payload (~64 MB compactado, ~8000 arquivos extraídos) era extraído com LZMA no nível máximo; o bootstrap recalculava SHA-256 de ~1500 arquivos, rodava predeploy de novo, aplicava `icacls /T` na árvore e esperava até 165 s o health do agente. Schemas XSD e frontend `.br`/`.gz` (inúteis no `express.static`) inflavam a extração.

## Decisão

1. Compressão Inno: `lzma2/fast` **sem solid** (`SolidCompression=no`) — extract/update
   mais rápido com muitos arquivos; Node/DLLs com `nocompression`.
2. Schemas XSD e `node_modules` entram como **`vendor/*.zip`** (1 arquivo cada,
   `nocompression`). Bootstrap extrai com `tar.exe` se stamp divergir.
3. Frontend do instalador sem `*.br` e `*.gz` (política do manifest alinhada).
4. Bootstrap empacotado (`BUILD_STAMP.json` + natives no ZIP): não roda `npm ci`,
   não regenera manifest, não roda predeploy.
5. ACL na raiz de `%ProgramData%\MarginEngine` com herança `(OI)(CI)` — `/T` só no modo **reparar**.
6. Espera do serviço/health: **45 s + retry 20 s** (sucesso retorna antes). Teto **75 s**.
   Wait-online exige `ui.ok`. `install-service --no-open` poll SCM ~200 ms.
   Update/repair: **skip reinstall** do serviço se já no SCM + natives OK (só `sc start`).
   **NM ZIP** no caminho crítico; **schemas** (local + ProgramData) **após** `:9100` online
   (menos I/O no cold start; ainda fail-hard antes do Done).
   Update: skip ProgramData schemas se já suficientes; firewall skip se regra existe.
   Diagnóstico HTTP full só se health falhou (light se `ui.ok`).
   Timing: `install-bootstrap-timing.json` (fases + totalMs).
   Wizard: `DisableReadyPage=yes`; caixa pode usar `/VERYSILENT /MODE=update`
   (WizardSilent → sem `--open`).
   Pós-extract ZIP: fail-hard se natives/schemas inválidos; prepare-build faz
   round-trip probe antes do ISCC.
   Se SCM já RUNNING e `/health` OK → skip start longo (`wait_online_already`).
   Timing: `install-bootstrap-timing.json` (fases + totalMs).
   Parada pré-update: 20 s + 25 s (skip se já parado). Preinstall Inno ≤10 s.
   `validatePostUpdate` falha o bootstrap se manifest/UI inválidos.
   **Sleep SCM:** `Atomics.wait` no **global** `Atomics` (nunca `require("worker_threads")`).
   Falha de wait-online grava `install-bootstrap-error.txt` com serviceResult/startResult.
7. Skip de SHA-256 só se o `manifest.json` listar arquivos **existentes** e sem `.br`/`.gz`.
8. `prepare-build.ps1` regenera manifest, remove `.br`/`.gz`, assert-payload, **pack ZIPs**, ISCC.

## Consequências

- Instalação no caixa deixa de ser CPU-bound no LZMA máximo e deixa de repetir trabalho já feito no `prepare-build.ps1`.
- Pacote um pouco maior (binários sem recompressão); extração bem mais rápida.
- Reparo com `node_modules` quebrado ainda executa `npm ci`.
- Manifest incoerente (update parcial / pacote velho) não deixa `manifestOk: false` no boot: regenera no caixa.
