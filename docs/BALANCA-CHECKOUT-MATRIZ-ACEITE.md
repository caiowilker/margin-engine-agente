# Matriz de aceite — balança de checkout (Fase 1)

Ambiente: Windows + agente :9100 + Prix 3 (Prt3) + PDV com `checkoutScaleEnabled`.

## Happy path

| ID | Cenário | Esperado | OK |
|----|---------|----------|----|
| H1 | Modal `porPeso` + scale on | Sessão abre; kg atualiza ~250 ms quando estável | ☐ |
| H2 | Stable → Confirmar | Linha com kg 3 casas; modal fecha; sessão fecha | ☐ |
| H3 | Editar peso no carrinho | `pesoInicial`; atualiza só a linha | ☐ |
| H4 | Teclado com scale ok | Manual funciona | ☐ |
| H5 | POST `/scale/teste` | &lt; 3 s, `{ ok, kg }` | ☐ |
| H6 | Cupom com scale idle | Print ok; status scale pode usar cache | ☐ |
| H7 | Scale + print USB separado | Ambos ok | ☐ |

## Failure

| ID | Cenário | Esperado | OK |
|----|---------|----------|----|
| F1 | Agente offline | Toast agente necessário; teclado fica | ☐ |
| F2 | 401 | Um resync token; sem loop | ☐ |
| F3 | COM errada / unplug | OPEN_FAILED / USB_GONE | ☐ |
| F4 | ENQ timeout | TIMEOUT ≤ 2500 ms agente / ≤ 4000 ms UI | ☐ |
| F5 | Confirm instável | Bloqueado | ☐ |
| F6 | Fecha modal mid-poll | Abort; sem item; sem unhandled rejection | ☐ |
| F7 | Double Confirm | Uma linha | ☐ |
| F8 | Scan outro barcode com modal | Bloqueado / toast | ☐ |
| F9 | USB shared + print lock | Fail ≤ 1500 ms LOCK_WAIT_TIMEOUT | ☐ |
| F10 | Frame inválido / baud errado | INVALID_FRAME; ≤ 2 reopen | ☐ |
| F11 | Native missing | NATIVE_MISSING; agente sobe | ☐ |
| F12 | kg &gt; 999 | Guard existente | ☐ |
| F13 | Duas leituras HTTP | BUSY ou serializado no lock | ☐ |
| F14 | Idle 120 s | Agente fecha porta; próximo open limpo | ☐ |

## CI (automatizado)

- Parser fixtures (agente + front Vitest)
- Lock wait timeout → `SCALE_LOCK_WAIT_TIMEOUT`
- Rotas exigem token + shape `codigo`

---

## Fase 2 — Happy / perf

| ID | Cenário | Esperado | OK |
|----|---------|----------|----|
| H2.1 | Scale on, auto default | Sale-ready → linha sem click | ☐ |
| H2.2 | N=2 iguais | 1 linha; sessão fecha async | ☐ |
| H2.3 | Kg muda no streak | Zera; 0 add | ☐ |
| H2.4 | Teclado mid-poll | Override; Enter manual | ☐ |
| H2.5 | Kill-switch auto off | Click V1; live continua | ☐ |
| H2.6 | Editar linha kg | Sem auto | ☐ |
| H2.7–8 | Filizola / Urano Testar | `{ ok, kg }` | ☐ |
| H2.9–10 | Etiqueta PESO/PRECO + scale on | 0 COM | ☐ |
| H2.11 | Item scale → item etiqueta | Sequência ok | ☐ |
| H2.12 | Zero no prato | Sem fire | ☐ |
| H2.perf | 20 ciclos estáveis | p50≤600 / p95≤1200 ms | ☐ |

## Fase 2 — Failure

| ID | Esperado | OK |
|----|----------|----|
| F2.1 Protocol inválido | 400 UNSUPPORTED | ☐ |
| F2.2 Urano 8N1 errado | TIMEOUT/INVALID; PT limpo | ☐ |
| F2.3 Double fire | 1 linha | ☐ |
| F2.4 Abort mid-streak | 0 item | ☐ |
| F2.5 Modal + bip | Toast; 0 segunda linha | ☐ |
| F2.6 Unstable longo | 0 add; teclado ok | ☐ |
| F2.7 Poll overlap | skip; sem fila | ☐ |
| F2.8 Reopen mid-streak | streak zera | ☐ |
| F2.9 Overload / negative | códigos V1; 0 cupom | ☐ |

## Fase 2 — CI

- Parsers Toledo / Filizola BP / Urano12
- `autoConfirmStable` unit (N=2)
- `scaleLaneGuard` etiqueta sem COM
- `/scale/protocols` + stopBits open

### Lab H2.perf (evidência)

```bash
npm run test:scale                 # unit + bench --mock → data/benchmark-scale.json
npm run benchmark:scale:live       # Toledo físico; SCALE_BENCH_TOKEN=...
```

Budgets agente hot: p50 ≤ 120 ms, p95 ≤ 400 ms. Marque H2.perf só com JSON live anexado/gerado.

---

## Fase 3 — Ops / launch

| ID | Cenário | Esperado | OK |
|----|---------|----------|----|
| H3.1 | Bench `--mock` | JSON + exit 0 em CI (`npm run test:scale`) | ☐ |
| H3.2 | Bench `--live` Toledo 20× | budgets F2; H2.perf ✓ | ☐ |
| H3.3 | Diagnóstico no painel | nativeOk, lastError, p50/p95 | ☐ |
| H3.4 | USB unplug idle | Chip vermelho + toast 1× | ☐ |
| H3.5 | N=3 no terminal | 3 samples; 2 não dispara | ☐ |
| H3.6 | PLU etiqueta | `origemPeso=etiqueta`; 0 `/scale/sessao` | ☐ |
| H3.7 | Piloto SOP | Runbook sem engenharia | ☐ |

| ID | Falha | Esperado | OK |
|----|-------|----------|----|
| F3.1 | Idle probe | Não abre COM / não enfileira peso | ☐ |
| F3.2 | Modal aberto | Chip não compete | ☐ |
| F3.3 | native missing | Chip vermelho; agente sobe; PDV ok | ☐ |

SOP: [BALANCA-CHECKOUT-SOP.md](./BALANCA-CHECKOUT-SOP.md).

---

## GA Toledo — produção

Gate completo: [BALANCA-CHECKOUT-GA.md](./BALANCA-CHECKOUT-GA.md).

| ID | Cenário | Esperado | OK |
|----|---------|----------|----|
| G0.1 | Residual 1 kg no prato → novo SKU | 0 auto-add até zerar/trocar | ☐ |
| G0.2 | Zera → coloca → N estáveis | 1 linha correta | ☐ |
| G0.3 | Bench live Toledo 20× | p50/p95 budgets; JSON | ☐ |
| G0.4 | `test:scale` no CI | verde obrigatório | ☐ |
| G1.1 | USB unplug (sessão) | chip critical + toast 1×/episodio | ☐ |
| G1.2 | Cancel durante open | COM fecha; sem orphan | ☐ |
| G1.3 | native missing pós-install | chip/PDV claro; agente sobe | ☐ |
| G1.4 | PDV on / agente off | aviso único | ☐ |
| G1.5 | Double fire | 1 linha | ☐ |
| G1.6 | Modal + bip | toast; 0 segunda linha | ☐ |
| G2.1 | Filizola/Urano na UI | label Experimental | ☐ |
| G2.2 | Piloto 1 dia | checklist SOP ✓ | ☐ |
