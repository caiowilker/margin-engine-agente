# ADR — RAW:Windows comercial via ESC/POS nativo rápido

**Data:** 2026-07-31  
**Status:** Superseded por [ADR-posprinter-acbr-primary-20260801.md](./ADR-posprinter-acbr-primary-20260801.md)

## Problema

Em POS80 via `RAW:NomeWindows`, o caminho ACBr (`POS_ConfigGravarValor` / `POS_Ativar`) frequentemente falha com **-10** ou estoura soft timeout (4s). O job ou falhava sem fallback (anti-dupla) ou só imprimia no drain (~6–11s), embora o WritePrinter Win32 real fosse ~0,4–0,8s.

## Decisão

1. Porta **`RAW:`** + payload comercial → native direto no executor (`withProvider`).
2. Circuito aberto → native só para **não fiscal** (DANFE/chave permanece no ACBr).
3. Timeout **pré-impressão** (`acbrPhase` config/ativar/init ou ConfigGravar -10) → fallback native no mesmo job.
4. `RAW_PRINT_TIMEOUT` **nunca** faz fallback (WritePrinter já iniciado).
5. **RawPrinterHelper.dll** + logo PNG/`escpos.Image` aquecidos no boot.

## Não-objetivos

- Não remove isolamento PowerShell.
- Não muda provider cache global para RAW (resolução é por job no executor).
