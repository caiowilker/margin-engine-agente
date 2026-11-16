# ETAPA 12-1 — Inventário de impressão (ANTES)

**Status:** entregue para aprovação — **nenhuma alteração de apresentação/runtime**.  
**Escopo desta compactação (aprovado pelo pedido):** somente **cupom fiscal NFC-e** e **cupom não fiscal**. Demais documentos listados abaixo ficam **fora** da Etapa 12 até nova ordem.

**Estimativa de comprimento:** Font A ~3,0 mm/linha @203 dpi + QR NFC-e ~28 mm (placeholder `{{ME_QR_BMP}}`). Sem logo. Medição em papel real fica na etapa 12-4.

---

## 1. Mapa de documentos que imprimem

| Documento | Op / tipo job | Renderer | Caminho de saída | Larguras | Fonte (hoje) | Colunas | Espaçamento / divisores | mm estim. (ref.) | Escopo 12 |
|-----------|---------------|----------|------------------|----------|--------------|---------|-------------------------|------------------|-----------|
| Cupom fiscal NFC-e (DANFE térmico 65) | `imprimirCupom` → `cupom_fiscal` | `cupomAcbrTags.renderCupomTags` + paridade `impressoraCore.renderCupomConteudo` | **Fiscal:** ACBr PosPrinter (tags) preferencial; fallback ESC/POS nativo se circuito aberto / `PRINT_FAST_NATIVE=always` / RAW com ACBr morto. **Não usa PDF/HTML** no térmico. | 58 / 80 mm via `printerLocalConfig.colunas` (32 / 48) | Fonte A (corpo); negrito pontual (`<n>` / destaque); expandido no nome fantasia; **Font B / condensado não usado no cupom** | 80→48, 58→32 (`thermalCols.js`) | `=` / `-` full-width; 1 linha em branco residual no join; feed implícito no corte parcial | ver tabela §3 | **SIM** |
| Cupom não fiscal | `imprimirCupom` + `naoFiscal`/`cupomSemFiscal` → `cupom_nao_fiscal` | **Mesmo** `renderCupomTags` / `renderCupomConteudo` (ramo sem bloco chave/QR/IBPT) | Comercial RAW:Windows → ESC/POS nativo por default (`PRINT_FAST_NATIVE=raw`); TCP/COM → ACBr | idem | idem | idem | idem | ver §3 | **SIM** |
| Reimpressão / 2ª via do cupom | `imprimirSegundaVia` ou cupom com banner | Mesmo layout + banner `*** SEGUNDA VIA ***` | Mesmo caminho do cupom origem | idem | idem | idem | +1 linha banner | cupom + ~3 mm | herda fiscal/não fiscal |
| DANFE térmico NF-e 55 | `imprimirCupom` → `danfe_termico` | `danfeTermico.js` | ACBr tags / native | 58/80 | A | 32/48 | próprio | — | **NÃO** |
| Abertura de caixa | `imprimirAbertura` | `caixaAcbrTags` / core | ACBr ou native | 58/80 | A | 32/48 | — | — | **NÃO** |
| Fechamento de caixa | `imprimirFechamento` | `caixaAcbrTags` / core | idem | 58/80 | A | 32/48 | — | — | **NÃO** |
| Sangria / suprimento / movimento | `imprimirMovimentoCaixa` | `caixaAcbrTags` / core | idem | 58/80 | A | 32/48 | — | — | **NÃO** |
| Comprovante crediário (recebimento) | `imprimirCrediario` → `crediario_recebimento` | `crediarioAcbrTags` | ACBr ou native | 58/80 | A | 32/48 | — | — | **NÃO** (crediário **dentro** do cupom de venda = pagamento no layout do cupom → **SIM**) |
| Pedido / comanda | `imprimirPedido` | `pedidoAcbrTags` | ACBr ou native | 58/80 | A | 32/48 | — | — | **NÃO** |
| Relatório de vendas | `imprimirRelatorio` | `relatorioVendasAcbrTags` | ACBr ou native | 58/80 | A | 32/48 | — | — | **NÃO** |
| Vasilhame | `imprimirVasilhame` | `vasilhameAcbrTags` | ACBr ou native | 58/80 | A | 32/48 | — | — | **NÃO** |
| Cupom promocional | `imprimirCupomPromocional` | `cupomPromocionalAcbrTags` | ACBr ou native | 58/80 | A | 32/48 | — | — | **NÃO** |
| Página teste impressora | `imprimirTeste` | `renderPaginaTeste` | ACBr ou native | 58/80 | A + condensado na linha demo | 32/48 | — | — | **NÃO** |
| Etiqueta ZPL/PPLA | `imprimirRaw` | bytes raw | driver raw (não ESC/POS cupom) | n/a | n/a | n/a | — | — | **NÃO** |
| PDF fiscal (consulta/arquivo) | `gerarPdfFiscal` (ACBr) | PDF A4/térmico arquivo | **PDF** (não bobina PDV) | — | — | — | — | — | **NÃO** |

### Caminhos técnicos (cupom fiscal / não fiscal)

```
Front (cupomFiscalFormat / imprimirCupomFiscalAgente)
  → POST /impressora/cupom|/imprimir
  → printJobService (fila)
  → acbrPosPrinterProvider.imprimirCupom
       ├─ fiscal (chave) → prefer ACBr tags (renderCupomTags)
       └─ não fiscal + RAW:Windows → native ESC/POS (impressoraCore.renderCupomConteudo)
  Paridade visual: cupomLayoutShared + thermalCols
```

**Driver Windows:** porta `RAW:NomeImpressora` = spooler Win32 WritePrinter (bytes ESC/POS ou tags convertidas). TCP/COM = ACBr PosPrinter. Não há HTML/CSS na bobina.

---

## 2. Tipografia e layout atuais (cupom)

| Item | Valor atual |
|------|-------------|
| Colunas 80 mm | **48** (Font A) — Font B (~64) **não aplicada** |
| Colunas 58 mm | **32** (Font A) — Font B (~42) **não aplicada** |
| Itens 80 mm | 1 linha tabela: `NN + DESCRICAO(23) + UNIT(9) + TOTAL(9)`; qty>1 → linha extra `N un x R$` |
| Itens 58 mm | 2 linhas: nome; unit/total alinhados; qty>1 → 3ª linha |
| Limiar 2 linhas | `cols < 42` (`COLS_TABELA_ITENS_MIN`) |
| QR NFC-e | só modelo 65; URL com `\|` → BMP `{{ME_QR_BMP}}`; módulo sugerido 6 (80) / 4 (58); ErrorLevel M |
| Logo | opcional BMP monocromático (`tagLogoHeader`) — desligável |
| Rodapé | 3 linhas fixas: obrigado / volte / PDV Margin Engine |
| Corte | parcial default (`</corte_parcial>` / `printer.cut(partial)`); feed extra se cut=none |
| Acentuação | `toThermalText` / página de código do driver |
| IE no cabeçalho | **hoje não impressa** no template (dado existe no payload empresa) |

---

## 3. Medição ANTES (estimativa mm)

Fonte: `docs/etapa12-amostras/ANTES-*.tags.txt` + `ANTES-medicao.json`.  
Fórmula: `linhas × 3,0 mm + (QR ? 28 mm : 0)`.

### Fiscal NFC-e

| Cenário | Papel | Linhas | QR | mm est. |
|---------|-------|--------|----|---------|
| 1 item | 80 | 46 | sim | **166** |
| 1 item | 58 | 47 | sim | **169** |
| 5 itens | 80 | 51 | sim | **181** |
| 5 itens | 58 | 56 | sim | **196** |
| 20 itens | 80 | 69 | sim | **235** |
| 20 itens | 58 | 89 | sim | **295** |
| 5 + desconto | 80 | 51 | sim | **181** |
| 5 + crediário (pgto no cupom) | 80 | 50 | sim | **178** |
| 5 + multi pagamentos | 80 | 51 | sim | **181** |

### Não fiscal

| Cenário | Papel | Linhas | QR | mm est. |
|---------|-------|--------|----|---------|
| 1 item | 80 | 30 | não | **90** |
| 5 itens | 80 | 35 | não | **105** |
| 20 itens | 80 | 55 | não | **165** |
| 5 + desconto | 80 | 37 | não | **111** |
| 5 + crediário | 80 | 36 | não | **108** |
| 5 + multi pag | 80 | 37 | não | **111** |

### Amostras gravadas

Diretório: `docs/etapa12-amostras/`

- `ANTES-fiscal-{1item,5itens,20itens}-{58,80}mm.tags.txt`
- `ANTES-fiscal-5-{desconto,crediario,multipag}-80mm.tags.txt`
- `ANTES-naofiscal-{1item,5itens,20itens,...}-80mm.tags.txt`
- `ANTES-medicao.json`

Conteúdo = tags ACBr (texto + `{{ME_QR_BMP}}`). Bytes ESC/POS / PDF de papel real: etapa 12-4 com impressoras físicas.

---

## 4. Oportunidades de compactação (só apresentação — ainda não aplicadas)

Observadas no ANTES, **sem alterar nada**:

1. Divisores `=` / `-` redundantes (vários blocos seguidos).
2. Rodapé 3 linhas promocionais (não fiscal obrigatório).
3. Labels longos (`Pagamento:`, `Volumes:`, `Operador:`) — abreviar só se não fiscal obrigatório.
4. Font B / condensado: ganho típico ~25–33% de colunas (não usado).
5. Linhas extras de qty e “Consulta via QR Code” / “Consulte pela chave…” (duplicidade textual).
6. Logo + feed pré-corte: avanços configuráveis.
7. Em 80 mm: QR lateral com chave/protocolo (hoje QR em bloco vertical).

**Perfil Padrão = comportamento atual** até aprovação explícita.

---

## 5. Diff desta etapa

```
(apenas artefatos de inventário — zero mudança em print/*.js de layout)
docs/etapa12-1-inventario.md          (novo)
docs/etapa12-amostras/ANTES-*.tags.txt (novo)
docs/etapa12-amostras/ANTES-medicao.json (novo)
```

Nenhuma lógica de venda, XML, QR *conteúdo*, gaveta ou crediário alterada.

---

## 6. Pare aqui — aprovação 12-1

Próxima etapa (**12-2 Conformidade fiscal**): lista do que é obrigatório no DANFE NFC-e / UF, o que não pode sumir, e dúvidas para contador — **sem compactar ainda**.

Confirme se o inventário e as amostras ANTES estão ok (e se o escopo continua só fiscal + não fiscal).
