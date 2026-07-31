# ADR — INI PosPrinter RAW de produção (erro -10 / hang 120s)

**Data:** 2026-07-31  
**Status:** Aceito  
**Contexto:** ACBrLibPosPrinter `-10` (Ativar) + timeout ~120s em `RAW:` no Windows.

## Decisão

1. **`ControlePorta=0` em RAW** (já em `resolveControlePorta`) — spooler Windows gerencia a porta; evita ativação exclusiva que gera -10.
2. **`[PosPrinter_Device]` sempre presente:** `BytesCount=512`, `BytesInterval=10`, `TimeOut=5` (env: `PRINTER_BYTES_*`).
3. **Produção:** `LogNivel=0`, `ArqLog=` vazio (debug: `PRINTER_ACBR_LOG_NIVEL=4`).
4. **Modelo:** POS80/Elgin → `1` (Epson), nunca `0` genérico em operação.
5. Boot/`sanitizarConfigPersistida` regrava INI canônico se divergir.
6. Script `npm run check:posprinter-deps` valida DLL + side DLLs + koffi.

## Campo (Windows)

- Propriedades da impressora → Avançado → **Imprimir diretamente na impressora**.
- Desmarcar suporte bidirecional se houver hang de status.
- Alternativa sólida: `TCP:IP:9100` ou COM virtual do fabricante.

## Não-objetivos

- Não forçar COM virtual automaticamente (depende do fabricante/driver).
- Native ESC/POS continua como fallback/circuito quando Ativar falha.
