# Prova de conformidade — Compacto/Ultra fiscal × MET DANFE NFC-e (12-2)

**Data:** 2026-10-13T22:45:36.022Z
**Status:** Compacto/Ultra fiscal **BLOQUEADO** em produção até aceite desta prova.
**Liberação (após aceite):** `PRINT_CUPOM_FISCAL_COMPACTO=true` ou sidecar `cupomFiscalCompactoLiberado`.

## Correção aplicada

- **REVERTIDO** `omitVolumes` no cupom **fiscal** (MET Divisão III — qtde total de itens).
- Labels sistema do QR removíveis mantidos (MET: textos extras = sistema).
- Portal `Consulte em <URL>`, chave, protocolo, TOTAL, pagamentos, troco, consumidor: **mesmo texto**.
- `dataAutorizacao` no payload **não é impressa no Padrão nem no Compacto** (gap pré-existente 12-2; não introduzido pelo Compacto).

## Mapa MET 12-2 × cortes Compacto (fiscal liberado)

| Bloco MET | Obrigatório | Compacto remove/altera? | Mesmo texto? |
|-----------|-------------|-------------------------|--------------|
| III Volumes/qtde itens | Sim | **NÃO** (revertido) | Sim |
| III TOTAL | Sim | Não (só seps `====`→`----`) | Sim |
| III Pagamento(s) | Sim | Não | Sim |
| III Recebido/Troco | Se houver | Não | Sim |
| VI Consumidor | Sim | Não | Sim |
| IV/VII Chave | Sim | Não (quebra igual) | Sim |
| IV/VII Protocolo | Sim | Pode juntar na linha nNF se couber | Mesmo texto |
| IV Consulta + URL | Sim | Mantém `Consulte em <URL>` | Sim |
| V QR | Sim ≥25mm | Labels sistema removidos; QR intacto | URL QR igual |
| rodapé sistema | Não | merge Obrigado+Volte | N/A |

## Diff linha a linha — fiscal-5itens

### REMOVIDAS (Padrão → Compacto)

```
================================================
================================================
NFC-e: 123  Serie: 1
Protocolo: 135260000012345
</linha_simples>
</linha_simples>
</linha_simples>
</linha_simples>
<ce><n>Consulta via QR Code</n></ce>
<ce><n>Consulte pela chave ou QR Code</n></ce>
<ce><n>Obrigado pela preferencia!</n></ce>
<ce><n>Volte sempre!</n></ce>
```

### ADICIONADAS / ALTERADAS (só no Compacto)

```
NFC-e: 123  Serie: 1  Protocolo: 135260000012345
<ce><n>Obrigado pela preferencia! Volte sempre!</n></ce>
```

### Ultra extras vs Compacto

```
<ce><n>PDV Margin Engine</n></ce>
```

### Campos obrigatórios extraídos (devem ser iguais)

```json
{
  "padrao": {
    "chaveDigits": "35261012345678000199650010000001231000001234",
    "protocolo": "135260000012345",
    "numeroNfe": "123",
    "serieNfe": "1",
    "consultaLine": "Consulte em www.nfce.fazenda.sp.gov.br",
    "portal": "www.nfce.fazenda.sp.gov.br",
    "qrPlaceholder": true,
    "qrTag": "",
    "temTitulosFiscais": true,
    "total": "69,00",
    "volumes": "6",
    "troco": "",
    "recebido": "",
    "pagamentos": [
      "DINHEIRO R$ 69,00"
    ],
    "cliente": "CLIENTE TESTE",
    "cpf": "52998224725"
  },
  "compacto": {
    "chaveDigits": "35261012345678000199650010000001231000001234",
    "protocolo": "135260000012345",
    "numeroNfe": "123",
    "serieNfe": "1",
    "consultaLine": "Consulte em www.nfce.fazenda.sp.gov.br",
    "portal": "www.nfce.fazenda.sp.gov.br",
    "qrPlaceholder": true,
    "qrTag": "",
    "temTitulosFiscais": true,
    "total": "69,00",
    "volumes": "6",
    "troco": "",
    "recebido": "",
    "pagamentos": [
      "DINHEIRO R$ 69,00"
    ],
    "cliente": "CLIENTE TESTE",
    "cpf": "52998224725"
  },
  "iguais": true
}
```

## Diff linha a linha — fiscal-5-multipag

### REMOVIDAS (Padrão → Compacto)

```
================================================
================================================
NFC-e: 123  Serie: 1
Protocolo: 135260000012345
</linha_simples>
</linha_simples>
</linha_simples>
</linha_simples>
<ce><n>Consulta via QR Code</n></ce>
<ce><n>Consulte pela chave ou QR Code</n></ce>
<ce><n>Obrigado pela preferencia!</n></ce>
<ce><n>Volte sempre!</n></ce>
```

### ADICIONADAS / ALTERADAS (só no Compacto)

```
NFC-e: 123  Serie: 1  Protocolo: 135260000012345
<ce><n>Obrigado pela preferencia! Volte sempre!</n></ce>
```

### Ultra extras vs Compacto

```
<ce><n>PDV Margin Engine</n></ce>
```

### Campos obrigatórios extraídos (devem ser iguais)

```json
{
  "padrao": {
    "chaveDigits": "35261012345678000199650010000001231000001234",
    "protocolo": "135260000012345",
    "numeroNfe": "123",
    "serieNfe": "1",
    "consultaLine": "Consulte em www.nfce.fazenda.sp.gov.br",
    "portal": "www.nfce.fazenda.sp.gov.br",
    "qrPlaceholder": true,
    "qrTag": "",
    "temTitulosFiscais": true,
    "total": "69,00",
    "volumes": "6",
    "troco": "",
    "recebido": "",
    "pagamentos": [
      "DINHEIRO R$ 20,00",
      "PIX R$ 15,00",
      "DEBITO R$ 34,00"
    ],
    "cliente": "",
    "cpf": ""
  },
  "compacto": {
    "chaveDigits": "35261012345678000199650010000001231000001234",
    "protocolo": "135260000012345",
    "numeroNfe": "123",
    "serieNfe": "1",
    "consultaLine": "Consulte em www.nfce.fazenda.sp.gov.br",
    "portal": "www.nfce.fazenda.sp.gov.br",
    "qrPlaceholder": true,
    "qrTag": "",
    "temTitulosFiscais": true,
    "total": "69,00",
    "volumes": "6",
    "troco": "",
    "recebido": "",
    "pagamentos": [
      "DINHEIRO R$ 20,00",
      "PIX R$ 15,00",
      "DEBITO R$ 34,00"
    ],
    "cliente": "",
    "cpf": ""
  },
  "iguais": true
}
```

