# Checklist Windows — Impressão Térmica (ACBr PosPrinter)

Homologação física no Windows. CI/Linux cobre contratos, benchmark e layout offline.

## Pré-requisitos

- [ ] Windows 10/11 x64
- [ ] Impressora térmica ESC/POS instalada (driver Windows ou rede TCP)
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
- [ ] INI: `ControlePorta=0` (RAW), `BytesCount=512`, `BytesInterval=10`, `LogNivel=0`
- [ ] Modelo POS80/Elgin = **1** (Epson), não `0`
- [ ] Log de boot: `[ACBrPosPrinter] Modo nativo — biblioteca PosPrinter carregada`
- [ ] `GET /config/impressora` → `mode: native`, `nativeReady: true`
- [ ] Windows: propriedades da térmica → Avançado → **Imprimir diretamente na impressora**
- [ ] Windows: desmarcar suporte bidirecional se status hanguear
- [ ] Instalador: `node scripts/installer-apply-print-config.js <appDir> print-config.json`

## Erro -10 / hang ~120s

- [ ] Porta salva válida (`RAW:nome` ou `TCP:192.168.x.x:9100`) — sem host de teste
- [ ] Nenhum ACBr Monitor / utilitário do fabricante segurando a fila
- [ ] Circuito: após -10, cupom comercial vai native (&lt; 5s); Detectar force retenta ACBr
- [ ] Alternativa: COM virtual do fabricante ou TCP:9100 se USB/spooler continuar lento

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
