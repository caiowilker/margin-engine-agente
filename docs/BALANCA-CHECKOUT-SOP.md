# SOP — Balança de checkout (loja + suporte)

Complementa [BALANCA-CHECKOUT-FASE2.md](./BALANCA-CHECKOUT-FASE2.md), [BALANCA-CHECKOUT-PRIX3.md](./BALANCA-CHECKOUT-PRIX3.md) e **[BALANCA-CHECKOUT-GA.md](./BALANCA-CHECKOUT-GA.md)** (gate de loja).

## Loja — ligar em 5 passos

1. Agente local rodando (`:9100`) com `serialport` OK (instalador chama `ensureScaleNative` / rebuild). Se falhar → **Reparar instalador** antes de ligar a flag no PDV.
2. Em **PDV → Configurações → Impressão / Balança**: protocolo **Toledo Prix 3** (GA). Filizola/Urano = Experimental (lab). Porta COM → **Salvar** → **Testar**.
3. Em **Operação**: ligar **Balança de checkout no PDV**. Se o agente estiver desligado, aparece aviso para habilitar na Impressão.
4. Auto-add ON por padrão, mas só após **prato limpo** (near-zero ou **aumento** ≥ 50 g). Queda de peso residual não dispara. Com kill-switch, o operador confirma o estável.
5. Se o piso vibrar: **Estabilidade = 3**. Default = 2.

Urano 12 (lab): balança e agente em **9600 8N2**.

## Três faixas (não misturar)

| Faixa | O que fazer |
|-------|-------------|
| **Etiqueta** (PESO/PRECO no bip) | Vai direto ao cupom — **não** abre COM |
| **Balança viva** (`porPeso` sem embutido) | Modal + auto-add quando estável |
| **Teclado** | Digitar no modal = override; poll continua até confirmar |

Chip **Balança** no cabeçalho do caixa: verde OK · âmbar instável · vermelho USB/COM/native. Clique abre configurações. Com modal de peso aberto o chip **não** compete com o poll.

## Quando usar kill-switch / N=3

- Falso auto-add ou vibração → primeiro tente **N=3**; se persistir, kill-switch (confirmação manual).
- Não desligue a balança no agente só por vibração — o teclado continua disponível.

## Falhas comuns (suporte)

| Sintoma | Causa típica | Ação |
|---------|--------------|------|
| “Módulo serial indisponível” | `serialport` nativo ausente | Reparar instalador / rebuild serialport |
| Timeout / frame inválido | COM/baud/protocolo errado | Testar; Urano = 8N2 |
| USB vermelho no chip | Cabo saiu (sessão aberta / disconnect) | Replug + **Atualizar** portas + Testar (Windows pode renumerar COM) |
| Etiqueta “não pesa na balança” | Esperado — faixa etiqueta | OK |
| “Retire o produto anterior” | Residual no prato (anti cobrança errada) | Zerar prato / trocar item |
| Diagnóstico no painel | native, stopBits, p50/p95, erros | Botão **Diagnóstico** |

Sem hex/stack na tela do operador. Logs estruturados no agente (`metric: scale.*`).

## Homologação lab (gate GA Toledo)

```bash
npm run test:scale                  # unit + bench mock
npm run benchmark:scale:live        # Windows + Prix 3; SCALE_BENCH_TOKEN=...
```

Evidência: `data/benchmark-scale.json`. Budgets hot: p50 ≤ 120 ms, p95 ≤ 400 ms (agente). E2E sale-ready→linha: ver matriz H2.perf.

## Checklist piloto (1–2 caixas, 1 dia)

- [ ] Testar OK na abertura do turno
- [ ] 20 itens por peso com auto — sem click
- [ ] Contar falsos auto-add (meta: 0); se >0 → N=3 ou kill-switch
- [ ] 1 bip etiqueta PESO + 1 item scale na mesma venda
- [ ] Unplug USB → chip vermelho + toast 1×; teclado ainda funciona
- [ ] Anotar protocolo/COM do terminal

## Fora deste SOP

Tara/zero remoto · Web Serial · novos protocolos · dashboard multi-loja.
