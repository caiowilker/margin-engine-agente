# ETAPA 12-3 — PASSO 0 (baseline físico) — CHECKLIST OPERADOR

**Status:** **DISPENSADO** por decisão do cliente (2026-10-13).  
A compactação 12-3a/12-3b segue com métrica oficial **linhas/dots**; mm só como ESTIMADO.

## Já fechado pelo agente (host)

| Item | Valor |
|------|--------|
| Impressora 80 mm | `POSPrinter POS80` / USB001 / RAW |
| Colunas Font A | **48** (`ColunasFonteNormal` no INI) |
| Modelo ACBr | **1** (Epson-compat) |
| `PaginaDeCodigo` (INI instalado) | **5** (`C:\ProgramData\MarginEngine\Config\posprinter.ini`) |
| Encoding ESC/POS amostras | CP860 |
| Densidade / velocidade / EspacoEntreLinhas | **ausentes no INI** → default driver |
| 6 jobs WritePrinter | ok (bins em `docs/etapa12-amostras/`) |
| Decode QR automático (payload) | OK — `ANTES-qr-decode.json` |
| Impressora 58 mm | **ausente** → Compacto/Ultra 58 mm = **NÃO VALIDADO / DESATIVADO** |

## Régua / fotos / celular

**Não bloqueiam** mais a 12-3. Se forem feitos depois, servem só para calibrar `mmReal` (fator medido) — nunca substituem linhas/dots como métrica oficial.

## Em seguida

1. ~~Infra de perfis com Padrão = idêntico~~ → feito (12-3a)
2. ~~12-3a só não-fiscal~~ → feito — **AGUARDA APROVAÇÃO** (`docs/etapa12-3a-naofiscal.md`)
3. 12-3b fiscal NFC-e → só com aprovação da 12-3a
4. Gaps de conformidade 12-2 → etapa **12-X** (contador), fora da 12-3
