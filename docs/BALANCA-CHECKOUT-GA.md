# Balança de checkout — GA Toledo (produção)

Gate de liberação de loja. Complementa [SOP](./BALANCA-CHECKOUT-SOP.md), [Fase 2](./BALANCA-CHECKOUT-FASE2.md) e [matriz](./BALANCA-CHECKOUT-MATRIZ-ACEITE.md).

## O que é GA

| Item | Produção |
|------|----------|
| Marca | **Toledo Prix 3** apenas |
| Filizola BP / Urano 12 | **Experimental (lab)** — UI bloqueia `enabled` em loja |
| Auto-add | ON + gate prato (near-zero **ou rise positivo ≥ 50 g**; queda não arma) |
| Enter / Confirmar | Com auto ON: exige prato armado. Kill-switch: operador pode confirmar estável |
| Kill-switch / N=3 | Operação do terminal |
| Tare remoto | Fora |

## Checklist obrigatório antes de liberar loja

1. [ ] `npm run test:scale` verde (CI agente)
2. [ ] `npm run test:scale` verde no front (`src/lib/scale/`)
3. [ ] Lab: `SCALE_BENCH_TOKEN=… npm run benchmark:scale:live` → `data/benchmark-scale.json` com budgets
4. [ ] Lab: residual no prato → **não** auto-add até zerar/trocar (G0.1)
5. [ ] Lab: unplug USB com sessão → chip critical / erro claro; replug + Testar; COM pode ter renumerado
6. [ ] Lab: cancelar modal durante open → COM fecha (sem orphan 120 s)
7. [ ] Instalador: serialport rebuild OK (`ensureScaleNative`); se falhar, não ligar flag PDV
8. [ ] Dual enable: agente `enabled` + PDV `checkoutScaleEnabled` + Testar OK
9. [ ] Piloto 1–2 caixas, 1 dia: 0 cobrança errada; kill-switch só se vibração extrema

## Suporte — pacote mínimo

No painel Impressão → **Diagnóstico** (native, stopBits, p50/p95, lastError).  
Logs agente com `metric: scale.*`.  
Não pedir hex/stack ao operador.

## Anti-regressão

- Auto-add sem gate de prato = **bloqueio de GA**
- Liberar Filizola/Urano como “suportado” sem HW = **bloqueio**
- Auto-detect de marca / COM = proibido
