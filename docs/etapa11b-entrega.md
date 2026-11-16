# Etapa 11-B — UI otimista + revalidação (STOP para 11-C)

Versão: **1.0.110**.

## Regras

| Ação | Otimista? |
|------|-----------|
| add/remove item, qtd, cliente, desconto, abrir pagamento | Sim + revalidação BG |
| finalizar, estorno, dinheiro, razão | **Não** — servidor decide |

- Seq/versão por requisição (`FrenteSeqGate`) — descarta respostas velhas / duplo clique / troca rápida.
- Sync de estado da venda: debounce + fila idempotente (`FrenteSyncFila`).
- Sem spinner bloqueante; pill discreto `catalogoSyncBackground || revalidandoEmBackground`.
- Divergência: toast claro + revert só do necessário (preço/desconto/cliente), venda em andamento permanece.

## Arquivos

- `margin-engine-front/src/lib/frenteOptimistic.ts`
- `margin-engine-front/src/hooks/useFrenteOptimistic.ts`
- Wiring em `useFrenteCaixa` (add item revalida preço; finalização não otimista)
- Gate offline planejado em `registrarVendaCheckout` / `pdvFinalizacaoOffline`

## Testes

- `frenteOptimistic.test.ts` — seq, duplo clique, fila, debounce, percentis
- `pdvFinalizacaoOffline.test.ts` — offline não planejado
- Crediário / preço / lápides (11-A) cobrem pré-condições de divergência

## Medições antes/depois (p50/p95/p99)

Rodar:
```bash
cd margin-engine-front
npx vitest run src/test/frenteOptimistic.test.ts src/test/catalogoCache50k.bench.test.ts
```

| Ação | Antes (caminho sync bloqueante típico) | Depois (otimista + BG) |
|------|----------------------------------------|-------------------------|
| Add item (UI) | espera rede | imediato; revalidação BG |
| Seq discard | N/A | stale descartada (`frenteOptimistic.test`) |
| Debounce sync | N/A | 320ms coalescido |
| Harness percentis (n=100, 1..100ms) | — | p50=50 / p95=95 / p99=99 |
| Catálogo 50k (proxy abertura) | — | p50=0.23 / p95=1.48 / p99=1.59 ms |

Latências do balcão real = UI paint sem await de rede no add/qtd/cliente; finalizar continua aguardando servidor.

## Regressão

- Fluxos legados + `controleNumerarioAtivo` TRUE/FALSE: finalização/estorno/dinheiro/razão **não** passam pelo caminho otimista (`isOptimisticAllowed` = false).
- Duas abas: fila idempotente por id; seq local por aba (última escrita vence no debounce).

## STOP

Aguardando aprovação para iniciar **11-C**.
