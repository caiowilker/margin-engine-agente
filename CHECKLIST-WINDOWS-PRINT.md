# Checklist Windows — Impressão Térmica (ACBr PosPrinter)

Homologação física no Windows. CI/Linux cobre contratos, benchmark e layout offline.

Referência oficial (ACBr Online / Infocotidiano): PosPrinter = tags ESC/POS + abstração por
**protocolo** (não marca). Elgin i9 → modelo Epson ESC/POS. Fonte: palestra “tesouro escondido”.

## Hierarquia de porta (recomendação ACBr → nosso agente)

Ordem preferida para frota estável:

1. **`TCP:IP:9100`** — impressora de rede; status/gaveta/papel OK; ACBr sem spooler Windows
2. **`COMn`** (USB→virtual COM do fabricante) — status bidirecional; ACBr direto
3. **`USB` / `USB:Marca Modelo`** — ACBr nativo VID/PID (sem driver de relatório)
4. **`RAW:NomeWindows`** — túnel pelo spooler (útil, mas Ativar em loop pode hangear)

No agente: comercial em **RAW** → ESC/POS nativo Win32 (rápido). Fiscal/DANFE e TCP/COM → ACBr.
Não force `PRINT_FAST_NATIVE=false` em RAW:POS80 de parque com AV/spooler lento.

## Pré-requisitos

- [ ] Windows 10/11 x64
- [ ] Impressora térmica ESC/POS (preferir TCP:9100 ou COM; RAW só se necessário)
- [ ] `ACBrPosPrinter64.dll` em `agente-local/posprinter/lib/` ou `ACBR_POSPRINTER_LIB_PATH`
- [ ] **`koffi` instalado** no `node_modules` do instalador (`prepare-build.ps1` / `npm ci` — prebuild Windows, sem VS Build Tools)
- [ ] Agente ativado (`http://localhost:9100`)

## Configuração

- [ ] `PRINTER_PROVIDER=acbr-posprinter`
- [ ] `PRINTER_FALLBACK=native`
- [ ] `PRINT_FAST_NATIVE` **ausente ou `raw`** (padrão = comercial RAW via ESC/POS nativo; fiscal no ACBr)
- [ ] `PRINT_FAST_NATIVE=false` só se quiser forçar ACBr também no comercial RAW (lento/hang neste parque)
- [ ] Remover `PRINTER_ALLOW_PARITY` em produção
- [ ] `npm run check:posprinter-deps` → OK (`ACBrPosPrinter64.dll` + side DLLs + koffi)
- [ ] INI: `ControlePorta=0` em **RAW** (spooler); `ControlePorta=1` em **TCP/COM/USB** (ACBr Online recomenda ligar)
- [ ] `BytesCount=512`, `BytesInterval=10`, `LogNivel=0` (log alto em produção enche HD)
- [ ] Modelo = **protocolo**: POS80/Elgin Epson-compat = **1**, não `0`
- [ ] Colunas: 48 (80mm padrão), 42/40 (estreitas/BT), 32 (58mm) — `PRINTER_PAPER_MM` / `ColunasFonteNormal`
- [ ] Corte: **parcial** default (`PRINTER_CUT=partial`) — total só se quiser folha cair
- [ ] Logo: BMP 1-bpp (ACBr) + raster ESC/POS aquecido (native); ou NV na impressora (`/logo`)
- [ ] Log de boot: `[ACBrPosPrinter] Modo nativo — biblioteca PosPrinter carregada`
- [ ] `GET /config/impressora` → `mode: native`, `nativeReady: true`
- [ ] Windows (se RAW): propriedades → Avançado → **Imprimir diretamente na impressora**
- [ ] Windows: desmarcar suporte bidirecional se status hanguear (USB costuma não retornar status)
- [ ] Instalador: `node scripts/installer-apply-print-config.js <appDir> print-config.json`

## Erro -10 / hang ~120s

- [ ] Porta salva válida (`RAW:nome` ou `TCP:192.168.x.x:9100`) — sem host de teste
- [ ] Nenhum ACBr Monitor / utilitário do fabricante segurando a fila
- [ ] Circuito: após -10, cupom comercial vai native (&lt; 5s); Detectar force retenta ACBr
- [ ] Alternativa preferida: **TCP:9100** ou COM virtual (caminho “sem spooler” da palestra ACBr)

## Testes funcionais

- [ ] `POST /impressora/teste` — QR, barras EAN13/EAN8/CODE128, corte, gaveta (**&lt; 5s**)
- [ ] Cupom não fiscal no PDV — imprime em **&lt; 5s** (não ~120s)
- [ ] `POST /impressora/segunda-via` — `{ "numeroVenda": "..." }` ou payload completo
- [ ] `PUT /impressora/logo` — upload BMP monocromático (Base64)
- [ ] Cupom NFC-e homolog — QR escaneável
- [ ] NF-e 55 — DANFE térmico simplificado via segunda via
- [ ] Pagamento misto + PIX copia e cola
- [ ] Fallback: sem bindings ffi → agente usa `native` com timeout ~8s (sem hang de 2 min)

## Benchmark (Windows opcional)

- [ ] `npm run benchmark:print` — comparar tempos com `data/benchmark-print.json` baseline CI
- [ ] 10 cupons seguidos — lock serial OK; agente permanece online

## Critério de aceite

- [ ] ≥ 1 impressora real homologada (marca/modelo documentados)
- [ ] `npm run test:agent-print` verde
- [ ] Evidência em `RESULTADO-HOMOLOG-PRODUCAO.md` (após homolog)
- [ ] Instalação em `Program Files` contém `node_modules\koffi`
