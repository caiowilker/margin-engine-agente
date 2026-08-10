# ADR — RAW WinSpool sem spawn PowerShell por cupom

**Data:** 2026-08-10  
**Status:** Aceito  
**Contexto:** Produção 1.0.8 — logs com 0.8–3.7s por job; `AddType` 300–831ms a cada spawn.

## Problema

Cada cupom fazia `execFile(powershell)` + `Add-Type -Path RawPrinterHelper.dll`. O warm pré-compilava a DLL no disco, mas **não** evitava o custo de carregar o tipo em um processo novo. Resultado: latência comercial inaceitável.

## Decisão

Ordem `PRINT_RAW_BACKEND=auto` (default):

1. **koffi + winspool.drv** in-process (`print/rawWinspoolNative.js`) — preferido; zero PowerShell.
2. **Host PowerShell persistente** (`print/rawWin32Persistent.js`) — AddType 1x; jobs via stdin JSON+base64.
3. **Spawn legado** — só fallback; log em `warn` com `backend: spawn`.

Warm (`warmPrintHotPath`) passa a aquecer koffi + host persistente, não só a DLL.

## Métricas

- `print.raw_phase` inclui `backend` (`koffi`|`persistent`|`spawn`)
- `print.raw_win32_timing` mantido (AddType=0 no fast path)
- `print.job_e2e` — enqueue→impresso consolidado; warn se >1s
- `print.raw_stage_slow` — etapa >200ms

## Não-objetivos

- Não remove o script legado (fallback AV/koffi fail).
- Não move WritePrinter para o processo HTTP sem physicalLock (mantém serialização USB).

## Consequências

- Meta: enqueue→papel <500ms local; picos 2–3.7s eliminados no caminho feliz.
- Isolamento: koffi WinSpool é bem mais simples que ACBr PosPrinter; se falhar, host PS persiste o isolamento parcial.
