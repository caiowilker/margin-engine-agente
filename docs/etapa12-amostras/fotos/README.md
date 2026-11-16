# Baseline físico ANTES (Etapa 12-3 Passo 0)

Pasta para foto/scan da bobina impressa na POS80 (e 58 mm quando houver hardware).

## Protocolo

1. Recolher cada cupom impresso (jobs em `ANTES-print-jobs.json`).
2. Medir com régua: topo da 1ª linha → linha do corte parcial → anotar `mmReal` em `ANTES-baseline-fisico.json` (e blocos se possível).
3. Fotografar o papel esticado (sem perspectiva forte) e salvar aqui como:
   - `ANTES-fiscal-1item-80mm.jpg`
   - `ANTES-fiscal-5itens-80mm.jpg`
   - `ANTES-fiscal-20itens-80mm.jpg`
   - `ANTES-naofiscal-1item-80mm.jpg`
   - `ANTES-naofiscal-5itens-80mm.jpg`
   - `ANTES-naofiscal-20itens-80mm.jpg`
4. Decodificar QR no celular → colar URL em `ANTES-qr-decode.json` → `decodeCelular.resultado` (ideal: 2 celulares).

## Status

| Item | Estado |
|------|--------|
| Jobs WritePrinter POS80 | enviados (ok) |
| Fotos nesta pasta | **vazia — PENDENTE** |
| mmReal | **PENDENTE** |
| QR celular | **PENDENTE** |
| 58 mm | sem hardware → Compacto/Ultra **DESATIVADOS** |

Checklist: `docs/etapa12-3-passo0-checklist.md`
