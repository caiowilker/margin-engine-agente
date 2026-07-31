# ADR — Fail-fast worker + TCP válido + Get-Printer gated

**Data:** 2026-07-31  
**Status:** Aceito  
**Contexto:** Logs de campo 1.0.4 (Caixa 1) — timeout worker, `physical_lock.slow` 70–90s, `TCP:192168150:9100`, `list_printers_taskkill` até 143s, HTTP 502.

## Problema

1. Timeout do worker ACBr só rejeitava a Promise **depois** de `Worker.terminate()`. Com FFI travado, `terminate()` podia demorar minutos e o `physicalLock` (`pos-print`) segurava a fila (~73–90s nos logs).
2. `normalizarPortaAcbr` aceitava qualquer `TCP:…`, propagando host sem pontos (`192168150`).
3. `Get-Printer` em background competia com RAW/USB e disparava `taskkill` lento sob carga.
4. `taskkill` via `execFile` às vezes não retornava no timeout do Node (até 143s de wall-clock no log).

## Decisão

1. Timeout do worker: `reject` imediato + `void killAndRespawn`; `terminate()` com teto `ACBR_POS_WORKER_TERMINATE_MS` (default 2s).
2. Validar IPv4/host em `parsePortaTcp` / `portaAcbrValida` / `normalizarPortaAcbr`; salvar config rejeita porta inválida; `buildRuntimeValues` normaliza e infere modelo POS80→1.
3. `listarImpressorasWindowsAsync` / `listar()` usam só cache quando impressão em andamento, physicalLock ou late abandon.
4. `killProcessTree` com hard deadline `PRINTER_TASKKILL_HARD_MS` (default 6s).

## Consequências

- Próximo job libera o lock em ~timeout+cooldown, não minutos.
- Porta TCP inválida não chega à impressora; operador corrige IP com pontos.
- Menos corrida Get-Printer × RAW no USB problemático.
