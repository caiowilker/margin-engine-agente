# ADR — RAW Windows em ProgramData (anti-lag ~112s)

**Data:** 2026-08-01  
**Status:** Aceito

## Problema

No caixa Win10 (serviço LocalSystem, v1.0.6), cupom comercial via native RAW mostrava:

- Win32 `totalMs` ~170–300ms (WritePrinter OK)
- `PrintExecutor.durationMs` ~111–115s com soft deadline 4s disparando só no fim
- Padrão “Envio concluiu no drain” após lag extremo

O WritePrinter não era lento: o event loop congelava **antes** do `execFile` (PowerShell). Causa mais provável: `writeFileSync` em `C:\Windows\TEMP` sob Windows Defender / serviço LocalSystem (~90–120s).

## Decisão

1. Workdir RAW = `%ProgramData%\MarginEngine\impressao\raw` (DirectoryManager).
2. Hot path usa `fs.promises.writeFile` (não bloqueia o loop).
3. Script `.ps1` memoizado no processo (`rawScriptCache`) — sem `readFileSync` a cada cupom.
4. Orçamento de espera: `PRINT_CORE_LOCK_WAIT_MS` + `PRINT_PHYSICAL_LOCK_WAIT_MS` (default 4s) — falha sem segundo envio.
5. Métricas: `print.raw_phase`, `print.raw_tmp_write_slow`, `print.event_loop_lag`, `print.core_lock_wait*`, `physical_lock.wait_timeout`.

## Consequências

- Cupom deve voltar a < ~2–4s wall-clock quando a POS80 responde.
- Script/DLL RawPrinterHelper migram para o mesmo diretório.
- Se o USB/spooler estiver preso por job anterior, o próximo falha em ~4s em vez de ~112s.
