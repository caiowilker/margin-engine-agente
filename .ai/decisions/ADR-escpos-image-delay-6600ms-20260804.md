# ADR: Gargalo restante ~6,6s no renderCupomConteudo — escpos.Printer.image

**Data:** 2026-08-04  
**Status:** IMPLEMENTADO  
**Afeta:** `print/escpos/impressoraCore.js`, logo ESC/POS no cupom  

## Evidência (não hipótese)

Logs de campo:

| Cenário | renderCupomConteudo | buffer ESC/POS | RAW |
|---------|---------------------|----------------|-----|
| Rápido  | 42 ms               | 45 ms          | ~900 ms |
| Lento   | **6638 ms**         | **6640 ms**    | ~850 ms |

RAW constante → gargalo **dentro** de `gerarBuffer()` → `renderCupomConteudo()` → `imprimirLogoCupomEscpos()`.

### Reprodução no código da lib

Arquivo: `node_modules/escpos/index.js` (`escpos@3.0.0-alpha.6`):

```js
Printer.prototype.image = async function (image, density) {
  // ...
  bitmap.data.forEach(async (line) => {
    // escreve linha
    await new Promise((resolve) => { setTimeout(() => resolve(true), 200); });
  });
  return this.lineSpace();
};
```

1. **200 ms × N linhas** do bitmap (`density` d24 → N = ceil(altura/24)).  
   Altura ≈ 720 px → 30 × 200 ms = **6000 ms** (± o pico observado de 6,6 s).

2. **Callback nunca chamado:** assinatura real é `(image, density)`. O agente fazia:
   ```js
   await new Promise((resolve, reject) => {
     printer.image(image, "d24", (err) => { ... resolve() });
   });
   ```
   Prova unitária: Promise externa fica pendente >3 s; callback não dispara.

3. `forEach`+`async` não serializa awaits na Promise retornada — comportamento inconsistente entre hang e atraso.

## Correção

1. Monkey-patch de `Printer.prototype.image` no load de `impressoraCore.js`:
   - escrita **síncrona** das linhas (adequado a `MemoryDevice`);
   - **sem** `setTimeout(200)`;
   - suporte a Promise **e** callback.

2. `imprimirLogoCupomEscpos` passa a `await printer.image(image, density)` (sem wrapper de callback).

3. Telemetria por fase: `loadMs`, `paintMs`, `cacheHit` em `print.imprimirlogo_total`.

## Resultado medido no teste

`test/escpos-image-patch.test.js` (altura 720 px, 30 linhas):

- callback: **~2 ms** (antes: hang)
- await Promise: **~1 ms** (antes: teórico 6000 ms)
- ganho: **~5999 ms**

## Alvo operacional

- `renderCupomConteudo` < 100 ms (logo em cache após warm)
- buffer ESC/POS < 150 ms
- RAW < 800 ms  
Total consistente < 1 s.
