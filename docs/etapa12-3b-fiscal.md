# ETAPA 12-3b — Cupom FISCAL NFC-e (tamanho/aparência)

**Status:** **APROVADA COM CONDIÇÃO** — Compacto/Ultra fiscal **BLOQUEADO** para uso real até aceite da prova MET.  
**Prova:** [`etapa12-3b-prova-conformidade-met.md`](etapa12-3b-prova-conformidade-met.md).  
**Escopo:** só espaçamento / linhas em branco / divisores / quebra / mensagens do sistema.  
**ZERO** alteração de XML, emissão, contingência, chave, protocolo, URL/tamanho do QR, textos fiscais obrigatórios ou ordem dos dados fiscais. Gaps 12-2 fora.  
**Correção:** `omitVolumes` **revertido no fiscal** (MET III — qtde itens).

## Respostas às condições da 12-3a

### a) O que cada perfil corta (não fiscal + fiscal aparência)

| Corte | Padrão | Compacto | Ultra |
|-------|:------:|:--------:|:-----:|
| Saída atual (golden ANTES) | ✓ | | |
| Remove `</linha_simples>` / sep antes do rodapé | | ✓ | ✓ |
| Remove feeds vazios rodapé (ESC/POS) | | ✓ | ✓ |
| Merge Obrigado + Volte (mantém PDV) | | ✓ | |
| Rodapé 1 linha (omite PDV) | | | ✓ |
| Omite `Volumes:` | | ✓ | ✓ |
| Colapsa `====` duplicados no TOTAL | | ✓ | ✓ |
| Remove labels/divisores em volta do QR (QR intacto) | | ✓ | ✓ |
| Quebra apertada nNF/série/protocolo (mesmo texto) | | ✓ | ✓ |
| Font B / EspacoEntreLinhas / QR menor | off | off* | off* |

\* Disponíveis só como override por terminal (`cupomLayoutFontB` / `espacoEntreLinhas` / `shrinkQr`), **default false**, após teste impresso.

**Decisão Compacto:** incorporou os cortes seguros que eram só do Ultra (`omitVolumes` + `collapseTotalSeps` + bloco QR/chave). Ultra permanece o máximo sem Font B/QR menor (= Compacto + rodapé 1 linha).

### b) Teste de acentos (PaginaDeCodigo=5)

INI live: **`PaginaDeCodigo=5`**. Corpo do cupom passa por `toThermalText` (strip NFD → ASCII) em **Padrão e Compacto** — saída idêntica para dados:

| Entrada | Depois (ambos os perfis) |
|---------|--------------------------|
| ç / Açaí | `Acai` |
| ã / São | `Sao` |
| é / café | `cafe` |
| õ / queijão | `queijao` |
| º / nº | `no` (ordinal strip) |
| Razão `COMÉRCIO DE AÇAÍ SÃO JOSÉ LTDA` | `COMERCIO DE ACAI SAO JOSE LTDA` |
| Item / observação acentuados | mesmo strip nos dois perfis |

Nenhum perfil altera a página de código nem o encoding.

### c) Padrão = default + volta em um passo

- Sem sidecar / instalador novo → **`cupomLayoutPerfil: "PADRAO"`** em todo terminal.
- Voltar: `PUT /config/impressora` `{ "cupomLayoutPerfil": "PADRAO" }` (um request; painel pode mapear a um clique).
- Compacto/Ultra só entram com opt-in explícito; 58 mm bloqueado.

## Métricas oficiais (linhas/dots) — fiscal @80 mm

Fator mmEst: **3,0 mm/linha** + QR **28 mm** (~224 dots) — só estimado.

| Cenário | Padrão L/d | Compacto | −% L | Ultra | −% L |
|---------|-----------:|---------:|-----:|------:|-----:|
| 1 item | 36 / 1088 | 29 | 19,4% | 28 | 22,2% |
| 5 itens | 41 / 1208 | 34 | 17,1% | 33 | 19,5% |
| 20 itens | 59 / 1640 | 52 | 11,9% | 51 | 13,6% |
| 5+desconto | 41 / 1208 | 34 | 17,1% | 33 | 19,5% |
| 5+crediário | 40 / 1184 | 33 | 17,5% | 32 | 20,0% |
| 5+multipag | 41 / 1208 | 34 | 17,1% | 33 | 19,5% |

### Por bloco (fiscal 5 itens → Compacto)

| Bloco | L antes→depois | −% L | nota |
|-------|---------------:|-----:|------|
| qr_mensagens | 2→0 (+ QR 1→1) | 100% textos | QR dots intactos (−17,6% no bloco por labels) |
| pagamentos | 3→1 | 66,7% | remove Volumes + sep |
| totais | 3→2 | 33,3% | colapsa ==== |
| rodapé | 4→3 | 25% | merge msgs |
| chave_protocolo | 7→6 | 14,3% | protocolo na mesma linha se couber |
| emitente / meta / itens | = | 0% | intocados (contador) |

Artefato: `docs/etapa12-amostras/goldens-12-3b/metricas-12-3b.json`.

## Testes (resultado real)

```text
node --test test/cupom-layout-profile.test.js  → 7/7
  - PADRAO ≡ ANTES fiscal+naofiscal tag a tag
  - campos fiscais obrigatórios idênticos Compacto/Ultra
  - QR placeholder/módulo idêntico ao Padrão
  - reimpressão / contingência / cancelada / homologação
  - acentos / 100 itens
```

Caminhos ACBr tags + ESC/POS nativo usam `cupomLayoutShared` (mesmas regras).

## Produção

- Sem sidecar → **Padrão**.
- Compacto/Ultra **não fiscal**: `cupomLayoutPerfil` (80 mm).
- Compacto/Ultra **fiscal**: bloqueado (`FISCAL_COMPACTO_BLOQUEADO`) até aceite da prova + `PRINT_CUPOM_FISCAL_COMPACTO=true`.
- Voltar: perfil `PADRAO` ou remover a env de liberação.

## Pare

Aguardando aceite do item 1 (prova MET) para liberar Compacto fiscal.
