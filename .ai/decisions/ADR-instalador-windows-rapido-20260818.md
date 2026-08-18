# ADR — Instalador Windows rápido no caixa

**Data:** 2026-08-18  
**Status:** Aceito

## Problema

O `Margin-Engine-Setup-*.exe` levava vários minutos no ponto de venda. O payload (~64 MB compactado, ~8000 arquivos extraídos) era extraído com LZMA no nível máximo; o bootstrap recalculava SHA-256 de ~1500 arquivos, rodava predeploy de novo, aplicava `icacls /T` na árvore e esperava até 165 s o health do agente. Schemas XSD e frontend `.br`/`.gz` (inúteis no `express.static`) inflavam a extração.

## Decisão

1. Compressão Inno: `lzma2/fast` + solid; Node portátil e DLLs ACBr/PosPrinter com `nocompression`.
2. Schemas XSD entram uma única vez via `dist\app\*`.
3. Frontend do instalador sem `*.br` e `*.gz` (política do manifest alinhada).
4. Bootstrap empacotado (`BUILD_STAMP.json` + `node_modules` nativo): não roda `npm ci`, não regenera manifest, não roda predeploy.
5. ACL na raiz de `%ProgramData%\MarginEngine` com herança `(OI)(CI)` — `/T` só no modo **reparar**.
6. Espera do serviço/health: 60 s + retry 30 s (sucesso retorna antes; folga para Defender no 1º boot).
7. Skip de SHA-256 só se o `manifest.json` listar arquivos **existentes** e sem `.br`/`.gz`. Caso contrário o bootstrap regenera.
8. `prepare-build.ps1` sempre regenera o manifest, remove `.br`/`.gz` e roda `assert-installer-payload.js` antes do ISCC.

## Consequências

- Instalação no caixa deixa de ser CPU-bound no LZMA máximo e deixa de repetir trabalho já feito no `prepare-build.ps1`.
- Pacote um pouco maior (binários sem recompressão); extração bem mais rápida.
- Reparo com `node_modules` quebrado ainda executa `npm ci`.
- Manifest incoerente (update parcial / pacote velho) não deixa `manifestOk: false` no boot: regenera no caixa.
