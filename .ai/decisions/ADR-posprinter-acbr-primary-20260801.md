# ADR — ACBr PosPrinter como caminho primário (também em RAW:)

**Data:** 2026-08-01  
**Status:** Aceito  
**Supersede:** [ADR-print-raw-native-fast-20260731.md](./ADR-print-raw-native-fast-20260731.md) (bypass RAW→native incondicional)

## Problema

O executor e `preferNativeEscPos` forçavam ESC/POS nativo em **toda** porta `RAW:`, então a ACBrLib PosPrinter quase nunca era chamada em produção (só DANFE/fiscal sob condições especiais). Emissão fiscal (NFe) ok ≠ PosPrinter ok. Sintoma: “posprinter não funciona” apesar da DLL e do demo oficial.

## Decisão

1. **Caminho primário:** ACBr tags via worker (`POS_Inicializar` → config → `POS_Ativar` 1× → `POS_InicializarPos` + `POS_Imprimir` por cupom).
2. **Native ESC/POS** só como retaguarda: circuito aberto (comerciais), `PRINT_FAST_NATIVE=true|always`, falha pré-impressão (-10/timeout init), ou **gaveta**.
3. **FFI:** flags Boolean de `POS_Imprimir` / similares como **`int` 0/1** (demo oficial Windows `ffi-napi`), não `bool` koffi de 1 byte.
4. Mantém: worker + soft timeout + circuito persistente + `ControlePorta=0` + Device Bytes* (ADR INI RAW).
5. **Factory** não troca provider por circuito (sem payload) — fiscal/DANFE permanece no ACBr; routing comercial é por job.
6. **Timeout mid-print** (`cmd=imprimirTags`): sem fallback native (anti-dupla) e sem abrir circuito.
7. **INI:** `PaginaDeCodigo` enum ACBr (`5`=UTF8); `CortaPapel`/`TipoCorte` coerentes; circuito TTL half-open **15 min**.

## Não-objetivos

- Não remove anti-dupla pós-`WritePrinter` / hard drain.
- Não obriga Ativar a cada cupom (sessão quente permanece).
