# ETAPA 12-3a — Infra de perfis + cupom NÃO FISCAL (Compacto/Ultra)

**Status:** **APROVADA COM CONDIÇÕES** (2026-10-13) → Compacto reforçado + 12-3b em `docs/etapa12-3b-fiscal.md`.  
**Passo 0 (régua/fotos/celular):** **DISPENSADO** por decisão do cliente (2026-10-13).

## Página de código (POS80 — confirmada)

| Fonte | Valor |
|-------|------:|
| `C:\ProgramData\MarginEngine\Config\posprinter.ini` → `PaginaDeCodigo` | **5** |
| Modelo | **1** (Epson-compat) |
| Colunas Font A | **48** (80 mm) |
| Encoding ESC/POS (caminho nativo) | CP860 |
| Docs 12-2 que citavam `PaginaDeCodigo=2` | **desatualizados** vs INI live — SSOT = INI instalado (=5) |

Font B (`<fb>`/`<c>`) e `EspacoEntreLinhas`: **desligados** neste modelo (não validados em papel). Compacto funciona só com remoção de linhas/espaços.

Acentuação: fluxo legado `toThermalText` continua ASCII-strip em Padrão e Compacto (paridade). Página 5 preservada; sem mudança de encoding nesta etapa.

## Infra de perfis

| Perfil | Default | 80 mm | 58 mm |
|--------|---------|-------|-------|
| **Padrão** | sim | idêntico ao layout atual (golden ANTES) | referência tags |
| **Compacto** | opt-in | liberado (12-3a não fiscal) | **DESATIVADO** |
| **Ultra** | opt-in | liberado (12-3a não fiscal) | **DESATIVADO** |

- Persistência: sidecar `cupom-layout-perfil.json` (ao lado do INI) + `PUT /config/impressora` `{ "cupomLayoutPerfil": "COMPACTO" }`.
- Volta ao Padrão: mesmo PUT com `"PADRAO"`.
- Imprimir teste: `POST /impressora/teste` (página de teste mostra perfil + `PaginaDeCodigo`).
- Env override (dev/teste): `PRINT_CUPOM_LAYOUT_PERFIL`.
- Fiscal (NFC-e): liberado na **12-3b** (Compacto/Ultra opt-in 80 mm).
- **QR:** `shrinkQr=false` por padrão. Redução de QR = opção futura separada.
- **Compacto reforçado (pós-aprovação):** inclui `omitVolumes` + `collapseTotalSeps` (antes só Ultra).

Template compartilhado: `cupomAcbrTags` ↔ `impressoraCore` ↔ `cupomLayoutShared`. Reimpressão / contingência / cancelada herdam o perfil.

## Métrica oficial

- **Linhas** e **dots** (Font A = 24 dots/linha @203 dpi).
- **mmEst** = ESTIMADO com fator **3,0 mm/linha** (+ QR 28 mm / ~224 dots se houver). **Não** afirmar economia em mm real.

Artefato: `docs/etapa12-amostras/goldens-12-3a/metricas-12-3a.json`.

### Não fiscal @80 mm — antes (Padrão) × depois

| Cenário | Padrão L | Compacto | −% L | Ultra | −% L |
|---------|---------:|---------:|-----:|------:|-----:|
| 1 item | 24 | 21 | 12,5% | 20 | 16,7% |
| 5 itens | 29 | 26 | 10,3% | 25 | 13,8% |
| 20 itens | 49 | 46 | 6,1% | 45 | 8,2% |
| 5 + desconto | 31 | 28 | 9,7% | 27 | 12,9% |
| 5 + crediário | 30 | 27 | 10,0% | 26 | 13,3% |
| 5 + multipag | 31 | 28 | 9,7% | 27 | 12,9% |

Compacto reforçado: rodapé merge + omite Volumes + colapsa ==== do TOTAL.  
Ultra: + rodapé 1 linha (omite PDV).

QR: **não** encolhido (módulo/conteúdo iguais). Bloco `qr_mensagens` só existe no fiscal → 12-3b.

## Testes (resultado real)

```text
node --test test/cupom-layout-profile.test.js  → 7/7 pass
node test/printer-local-config.test.js         → perfil sidecar + bloqueio 58 mm
```

- PADRAO ≡ `ANTES-naofiscal-*-80mm.tags.txt` byte a byte.
- Goldens Compacto/Ultra em `docs/etapa12-amostras/goldens-12-3a/`.
- Tokens de dados (R$, PDV…) idênticos antes/depois; 100 itens + descrição 60+ chars; fiscal pedido Compacto permanece Padrão.
- Diff desta etapa restrito a templates/formatadores de impressão + config/perfil + testes/docs.

## Fora desta etapa

- 12-3b fiscal NFC-e (mesmos moldes).
- Redução de QR (opção separada).
- Compacto/Ultra 58 mm.
- Gaps de conformidade 12-2 (textos fiscais intactos).

## Pare

**Aguardando aprovação da 12-3a** para iniciar 12-3b.
