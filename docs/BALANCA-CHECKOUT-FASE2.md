# Balança de checkout — Fase 2 (operador + homologação)

Complementa [BALANCA-CHECKOUT-PRIX3.md](./BALANCA-CHECKOUT-PRIX3.md).

## Três faixas (não misturar)

| Faixa | Quando | COM serial |
|-------|--------|------------|
| **A — Etiqueta** | Bip com peso/preço embutido (PLU) | Não abre |
| **B — Balança viva** | Produto `porPeso` sem peso na etiqueta | Sim (open-once) |
| **C — Teclado** | Digitação no modal | Pode existir; auto-add desliga nesta abertura |

## Agilidade de caixa

Com balança ligada no PDV (`checkoutScaleEnabled`):

1. Modal abre → sessão COM uma vez  
2. Poll ~200 ms → 2 leituras estáveis iguais (±1 g)  
3. **Auto-add** da linha (sem click)  
4. Teclado sempre disponível (override)

Kill-switch em **Operação**: “Pedir confirmação manual do peso”.

## Protocolos (aba Impressão)

| Preset | Serial típica | Notas |
|--------|---------------|--------|
| Toledo Prix 3 | 9600 8N1 | Prt3 / P05A |
| Filizola BP | 2400–9600 8N1 | ENQ → STX+5 |
| Urano 12 | **9600 8N2** | Stop bits = 2 |

Protocolo é **escolha explícita** — não adivinhar marca no cabo.

## Certificação (lab)

1. Fixtures unit (agente + front)  
2. Mock transport / rotas com token  
3. Engine autoConfirm (N=2)  
4. Regressão etiqueta (0 sessão COM)  
5. Físico Toledo — 20 ciclos E2E p95 ≤ 1,2 s  
6. Filizola/Urano quando houver hardware  

Matriz detalhada: [BALANCA-CHECKOUT-MATRIZ-ACEITE.md](./BALANCA-CHECKOUT-MATRIZ-ACEITE.md) (seção Fase 2).

Fase 3 (ops / health / SOP): [BALANCA-CHECKOUT-SOP.md](./BALANCA-CHECKOUT-SOP.md).  
**GA produção Toledo:** [BALANCA-CHECKOUT-GA.md](./BALANCA-CHECKOUT-GA.md).
