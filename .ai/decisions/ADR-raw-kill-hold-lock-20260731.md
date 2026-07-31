# ADR — Kill confirmado no RAW Windows + hold do physicalLock

**Data:** 2026-07-31  
**Status:** Aceito  
**Contexto:** P2a produção (agente 1.0.4+)

## Problema

Em PCs com spooler/USB lento, `WritePrinter` via PowerShell pode demorar ~2 min. O soft timeout rejeitava a Promise na hora e liberava o `physicalLock` enquanto o wrapper (ou o spooler) ainda usava a porta — o próximo cupom competia no mesmo USB e o HTTP/PDV sofria efeito cascata.

Além disso, `taskkill` era fire-and-forget (sem saber se o PID morreu) e o timer hard era cancelado pelo `finish` do soft.

## Decisão

1. Soft timeout **só inicia kill** (`taskkill /F /T` + confirmação de PID).
2. A Promise (e portanto o `physicalLock`) só libera quando:
   - kill confirma wrapper morto, ou
   - processo filho sai, ou
   - teto `PRINTER_RAW_KILL_HOLD_MS` (default 12s).
3. Erro tipado: `code=RAW_PRINT_TIMEOUT`, `printTimedOut=true` — executor **não** faz fallback físico no mesmo job.
4. Métricas: `print.taskkill_attempt`, `print.taskkill_still_alive`, `print.raw_kill_confirmed_release`, `print.raw_kill_hold_expired`, `print.child_exit`, `print.late_abandoned` (+ `lateMs`).

## Não-objetivos

- Não cancela job já no spooler/kernel Windows (papel tardio ainda possível).
- Não introduz `nativeEscposWorker` — o isolamento já é `execFile(powershell)`.

## Consequências

- HTTP do agente permanece responsivo (executor abandona no hard drain; fila não bloqueia o event loop).
- Próximo job RAW espera o lock até o kill/hold — reduz corrida USB nesta máquina problemática.
- Diagnóstico de campo fica explícito nos logs; checklist USB/driver continua sendo a correção de raiz.
