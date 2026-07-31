# ADR — RAW:Windows comercial via ESC/POS nativo rápido

**Data:** 2026-07-31  
**Status:** Aceito

## Problema

Em POS80 via `RAW:NomeWindows`, o caminho ACBr (`POS_ConfigGravarValor` / `POS_Ativar`) frequentemente falha com **-10** ou estoura soft timeout (4s). O job ou falhava sem fallback (anti-dupla) ou só imprimia no drain (~6–11s), embora o WritePrinter Win32 real fosse ~0,4–0,8s. AddType C# a cada PowerShell novo somava 250–600ms; logo frio (sharp + Image.load) somava segundos no primeiro cupom.

## Decisão

1. Porta **`RAW:`** + payload comercial → **preferNativeEscPos** (sem pagar tentativa ACBr).
2. **isFastNativePath** respeita circuito aberto e preferNative (não exige `PRINT_FAST_NATIVE=true`).
3. Timeout **pré-impressão** (`ConfigGravar` / `Ativar` -10) permite **fallback native no mesmo job** (nenhum byte enviado).
4. **RawPrinterHelper.dll** pré-compilada (cache em `%TEMP%/pdv-margin-raw`) + warm no boot.
5. Logo: cache de PNG + **escpos.Image em memória**; warm no boot.

## Não-objetivos

- Não remove isolamento PowerShell (WritePrinter no processo principal ainda é risco de hang).
- Fiscal/DANFE com chave permanece no ACBr quando aplicável.

## Consequências

- Cupom não fiscal em RAW deve imprimir perto do tempo do spooler (~1s após warm).
- Primeiro job após -10 ACBr não fica sem cupom quando a falha é pré-envio.
