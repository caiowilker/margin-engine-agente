# ADR — Delay intermitente de impressão (path feliz sagrado)

**Data:** 2026-09-17  
**Status:** Aceito  
**Afeta:** `rawWinspoolNative`, `impressoraCore`, keepalive spooler, sessão PosPrinter idle

## Contexto

No Caixa 1 (native / `RAW:POSPrinter POS80`) a maioria dos jobs fica em 40–180 ms. Em episódios raros após ociosidade:

1. Spike visível no log (0,5–1,1 s) — `OpenPrinter` / `StartDoc` frios.
2. Ou log ~100 ms com **papel atrasado** — o operador sente delay, mas `IMPRESSO` já foi marcado.

`durationMs` e `print.job_e2e` medem **aceitação no spooler** (`EndDocPrinter`), **não** o instante em que o papel sai da térmica. Keepalive só com `OpenPrinter` mantinha o HANDLE vivo sem impedir USB selective suspend / firmware dormindo.

## Decisão

1. **Não reescrever o hot path feliz** (fila, prioridades, `PRINT_FAST_NATIVE`, Ativar por job, ClosePrinter no ping).
2. **Keepalive de dispositivo** (`PRINT_SPOOLER_KEEPALIVE_MODE=status`): após ociosidade (`PRINT_SPOOLER_DEEP_IDLE_MS=20000`), `GetPrinter` toca o driver. Em uso recente o ping força `handle` — **idêntico ao comportamento anterior** (sem GetPrinter no meio do salão). Modo `dle` opt-in. Recover fail-soft + re-ping após worker reset.
3. **Observabilidade pós-EndDoc** (`PRINT_SPOOLER_JOB_WATCH_MS`, default 0): poll `GetJob` em background; **não** atrasa `IMPRESSO`. Métrica `print.spooler_job_drain_ms`.
4. **Métricas de episódio raro:** `print.openprinter_cold`, warn em `raw_win32_timing` se ≥500 ms, `print.spooler_keepalive_recover` / `_slow`, `print.pos_session_cold_init`.
5. **Rewarm periódico** (`PRINT_HOTPATH_REWARM_MS`, default **0**): off por padrão (zero carga extra). Logo já retenta no cache miss. Opt-in se quiser aquecer a cada N ms.
6. **`ACBR_POS_SESSION_IDLE_MS=0`**: sem teardown por idle (espelha lib fiscal). Guarda `<=0` evita `setTimeout(0)` destrutivo. Sites podem setar `300000` explicitamente.

## Consequências

- Path feliz permanece igual.
- Episódios raros ficam mensuráveis e menos frequentes quando o keepalive de dispositivo + USB sem selective suspend estão ok.
- Checklist de campo: desligar suspensão seletiva de USB continua obrigatório — software não substitui 100%.
- `IMPRESSO ≠ papel na bandeja` fica documentado para suporte não caçar bug de fila quando o log está limpo.
