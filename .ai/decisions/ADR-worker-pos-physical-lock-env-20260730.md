# ADR — Worker PosPrinter + lock físico USB + schema de env

**Data:** 2026-07-30  
**Status:** Aceito  
**Versão:** 1.0.4

## Contexto

Em PDV Windows, `POS_Ativar`/`POS_Imprimir` via koffi no processo principal pode prender o threadpool (hang ~150 s). `Promise.race` não cancela FFI. NFC-e e térmica no mesmo hub USB competem. Defaults de timeout no `.env.example` divergiam do código.

## Decisões

1. **Worker só PosPrinter** (`print/workers/acbrPosWorker.js` + `acbrPosWorkerPool.js`): sessão quente (Ativar 1×); timeout → `worker.terminate()` + cooldown + circuito; late messages ignoradas via `generation`; fila interna por `printerKey` (sem BUSY throw).
2. **Main não carrega PosPrinter** enquanto `ACBR_POS_WORKER` ativo (`ACBR_POS_WORKER_OWNS_SESSION`) — status/versão soft-fail; logo invalida worker e usa in-process uma vez.
3. **Fallback in-process** se spawn/init falhar (`print.worker_fallback_inprocess`) — serviço não fica morto. `ACBR_POS_WORKER=false` restaura caminho legado.
4. **`physicalResourceLock` reentrante** + `PHYSICAL_USB_TOPOLOGY=shared|separate` (default `separate`). Print (ACBr + native RAW) e emissão NFC-e/NF-e/NFS-e usam keys; em `shared` a mesma key `usb-shared`. Ordem: physical → emissionLock.
5. **`config/printEnvSchema.js`**: SSOT de defaults; typo → clamp + log (`env.clamped`); **não** `process.exit` por timeout inválido.
6. NFe em worker fica para fase 2.

## Consequências

- Main com worker ON não mantém sessão quente PosPrinter.
- Hard drain / anti-dupla / circuito 1.0.3 permanecem.
- Campo: se térmica e cert no mesmo hub → `PHYSICAL_USB_TOPOLOGY=shared`.
