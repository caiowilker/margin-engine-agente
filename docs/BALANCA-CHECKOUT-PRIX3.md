# Balança de checkout — Toledo Prix 3 (ENQ_STX5)

Módulo isolado do agente (`src/scale/`). **Não** misturar com carga MGV (`src/balanca/`).

Fase 2 (multi-marca, auto-add, convivência etiqueta): ver [BALANCA-CHECKOUT-FASE2.md](./BALANCA-CHECKOUT-FASE2.md).  
SOP loja/suporte + health chip (Fase 3): [BALANCA-CHECKOUT-SOP.md](./BALANCA-CHECKOUT-SOP.md).  
Gate GA: [BALANCA-CHECKOUT-GA.md](./BALANCA-CHECKOUT-GA.md).

## Configuração na balança

| Item | Valor |
|------|--------|
| Protocolo de comunicação | **Prt3** (ou P05A / leitura Prt5 — ENQ → STX+5+ETX) |
| Baud | **9600** (8N1) — também aceito 2400/4800 se a Prix 3 estiver assim |
| Cabo | USB serial (FTDI/Prolific) ou RS-232 → COM no Windows |
| Display de preço | Opcional: ao abrir a sessão o agente envia preço/kg 1× (STX+6+ETX) |

No menu da Prix 3, confira que o protocolo de **saída contínua/consulta** está em modo **ENQ** (não contínuo sem pedido).

## Configuração no Margin Engine

1. Abra **PDV → Configurações do terminal → Impressão**.
2. Em **Balança de checkout**: selecione a COM listada (nunca invente), baud 9600, marque **Habilitar**, **Salvar**, depois **Testar**.
3. Em **Operação**, ligue **Balança de checkout no PDV** (`operacional.checkoutScaleEnabled`).
4. No PDV, venda um produto **por kg** — o modal abre a sessão COM uma vez e atualiza o peso ~250 ms.

Teclado numérico permanece como fallback. Confirmar pela balança só com peso **estável** e amostra com menos de 1,5 s.

## Protocolo (resumo)

```
Host → balança:  ENQ (0x05)
Balança → host:  STX + PPPPP (5 ASCII) + ETX
  PPPPP = kg × 1000   |  IIIII = instável  |  NNNNN = negativo  |  SSSSS = sobrecarga
```

## Falhas comuns

| Sintoma | Ação |
|---------|------|
| “Módulo serial indisponível” | Reinstale/Repare o Margin Engine (rebuild `serialport`) |
| “Porta não configurada” | Selecione a COM e salve |
| “Não respondeu a tempo” | Prix 3 ligada, Prt3, baud 9600, cabo firme |
| “Resposta inválida” | Baud/protocolo errados |
| “Equipamento ocupado” | Aguarde o cupom (USB compartilhado) e tente de novo |

## Homologação

Ver [BALANCA-CHECKOUT-MATRIZ-ACEITE.md](./BALANCA-CHECKOUT-MATRIZ-ACEITE.md).
