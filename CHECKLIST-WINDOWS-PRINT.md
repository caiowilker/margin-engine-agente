# Checklist Windows — Impressão Térmica (ACBr PosPrinter)

Homologação física no Windows. CI/Linux cobre contratos, benchmark e layout offline.

## Pré-requisitos

- [ ] Windows 10/11 x64
- [ ] Impressora térmica ESC/POS instalada (driver Windows ou rede TCP)
- [ ] `ACBrPosPrinter64.dll` em `agente-local/posprinter/lib/` ou `ACBR_POSPRINTER_LIB_PATH`
- [ ] Agente ativado (`http://localhost:9100`)

## Configuração

- [ ] `PRINTER_PROVIDER=acbr-posprinter`
- [ ] `PRINTER_FALLBACK=native`
- [ ] Remover `PRINTER_ALLOW_PARITY` em produção
- [ ] `GET /config/impressora` → `mode: native`, `nativeReady: true`
- [ ] Instalador: `node scripts/installer-apply-print-config.js <appDir> print-config.json`

## Testes funcionais

- [ ] `POST /impressora/teste` — QR, barras EAN13/EAN8/CODE128, corte, gaveta
- [ ] `POST /impressora/segunda-via` — `{ "numeroVenda": "..." }` ou payload completo
- [ ] `PUT /impressora/logo` — upload BMP monocromático (Base64)
- [ ] Cupom NFC-e homolog — QR escaneável
- [ ] NF-e 55 — DANFE térmico simplificado via segunda via
- [ ] Pagamento misto + PIX copia e cola
- [ ] Fallback: renomear DLL → agente usa `native` sem crash

## Benchmark (Windows opcional)

- [ ] `npm run benchmark:print` — comparar tempos com `data/benchmark-print.json` baseline CI
- [ ] 10 cupons seguidos — lock serial OK

## Critério de aceite

- [ ] ≥ 1 impressora real homologada (marca/modelo documentados)
- [ ] `npm run test:agent-print` verde
- [ ] Evidência em `RESULTADO-HOMOLOG-PRODUCAO.md` (após homolog)
