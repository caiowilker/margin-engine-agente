# ADR: Fila de impressão com prioridade + sessão ACBr quente (5 min)

**Data:** 2026-08-06  
**Status:** Aceito  
**Afeta:** `printJobStore`, `printJobService`, `acbrPosPrinterRuntime`, front térmica

## Decisão

1. Coluna `prioridade` nos jobs: gaveta=0, pedido/comanda=1, cupom fiscal/comercial/DANFE/2ª via=2, demais=5.  
   `proximoJobPronto` ordena por `prioridade ASC, criado_em ASC`.
2. Default `ACBR_POS_SESSION_IDLE_MS=300000` (5 min). Enqueue de job rápido chama `extendPosPrinterSessionIdle` + `warmPrintHotPath`.
3. `PRINTER_RAW_KILL_HOLD_MS=4000`; `PRINT_JOB_BACKOFF_MS=500` (teto retry 5s).
4. Front: enqueue timeout 12s; gaveta sem retry; checkout espera QR ≤2s.

## Consequência

Caixa, fiscal, pré-conta e comanda compartilham fila rápida e sessão quente — sensação de sistema grande no salão e no balcão.
