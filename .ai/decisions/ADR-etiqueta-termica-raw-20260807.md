# ADR — Impressão real de etiquetas térmicas ZPL/PPLA (2026-08-07)

**Status:** Aceito  
**Contexto:** `/pdv/etiquetas` gerava ZPL/PPLA com preview, mas só copiar/baixar. Faltava enviar raw ao agente.

## Decisão

1. **Agente:** `POST /impressora/etiqueta` (alias `/impressora/raw`) enfileira job `etiqueta_termica` → bytes via `enviarBuffer` (Win32 RAW / TCP :9100). **Nunca** ACBr PosPrinter / ESC/POS tags.
2. **Encoding:** ZPL `utf8`; PPLA `latin1` (preserva STX `\u0002`).
3. **Porta:** body `porta` (`RAW:Nome` | `TCP:ip:9100`) via `withPortaOverride` — impressora de etiquetas separada do cupom POS80.
4. **Cópias:** 1–99 envios do mesmo buffer (agnóstico ao formato).
5. **Front:** após gerar — seletor **obrigatório** de impressora de etiquetas (LS `pdv.etiqueta.porta`), cópias, **Imprimir ZPL/PPLA**. Recusa porta vazia e porta que parece cupom POS80.
6. **Cópias ZPL:** `^PQ{n}` em um único envio (não N WritePrinter). PPLA: loop com timeout escalado.

## Consequências

- Operador deve selecionar L42/Zebra, não a térmica de cupom.
- Heurística `TERMICA_RX` inclui zebra/argox/godex/l42.
