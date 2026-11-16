# ETAPA 12-2 — Conformidade fiscal DANFE NFC-e (ANTES)

**Status:** entregue para aprovação — **nenhuma alteração de layout/runtime**.  
**UF de referência das amostras:** SP (`www.nfce.fazenda.sp.gov.br`).  
**Fonte principal:** Manual de Especificações Técnicas do DANFE NFC-e e QR Code **v6.0 (mar/2025)** — divisões I–IX; MOC / Ajuste SINIEF 19/2016 (contingência); Lei 12.741/2012 (tributos aproximados).  
**Parque medido:** `POSPrinter POS80` @80 mm, 48 colunas Font A, `PaginaDeCodigo=2` (ACBr) / `CP860` (ESC/POS). Impressora 58 mm: **não disponível** neste host.

---

## A) Medição real do “ANTES” (baseline físico)

### Hardware e página de código

| Papel | Modelo | Porta | Colunas Font A | Página código | Fonte cupom hoje |
|-------|--------|-------|----------------|---------------|------------------|
| 80 mm | **POSPrinter POS80** | USB001 | **48** | ACBr `PaginaDeCodigo=2` (pc850); ESC/POS `CP860` | Font A (corpo); `<e><n>` no fantasia; **sem Font B / `<c>`** |
| 58 mm | — | — | 32 (planejado) | idem | N/A — sem impressora na lista Windows |

Fator teórico: Font A 24 dots @203 dpi → **3,00 mm/linha**. QR estimado **28 mm** (`{{ME_QR_BMP}}` / raster nativo).

### Jobs físicos enviados (WritePrinter RAW)

Arquivo: `docs/etapa12-amostras/ANTES-print-jobs.json` + bins `ANTES-print-*-80mm.bin`.

| Cenário | Bytes | Spooler |
|---------|------:|---------|
| fiscal 1 / 5 / 20 itens | 1674 / 1873 / 2549 | `ok=True` |
| não fiscal 1 / 5 / 20 | 1158 / 1357 / 2033 | `ok=True` |

### Régua e foto

| Campo | Status |
|-------|--------|
| `mmReal` por cenário | **PENDENTE_OPERADOR** — slots em `ANTES-baseline-fisico.json` |
| Foto/scan | Pasta `docs/etapa12-amostras/fotos/` + README do protocolo |
| Correção do fator 3 mm/linha | **não aplicada** até régua (sem acesso óptico do agente à bobina) |
| 58 mm físico | **N/A** — só amostras `.tags.txt` 58 mm (estimativa) |

### QR Code — decode referência ANTES

| Método | Resultado |
|--------|-----------|
| Automático (payload canônico + PNG `ANTES-qr-baseline.png`) | **OK** — URL SP idêntica às amostras |
| Celular / óptica no papel | **PENDENTE_OPERADOR** (`ANTES-qr-decode.json`) |

Payload referência:

`https://www.nfce.fazenda.sp.gov.br/qrcode?p=35261012345678000199650010000001231000001234|2|1|1|A1B2C3D4E5F6789012345678901234567890ABCD`

---

## B) Análise por bloco (desperdício)

Base: `ANTES-blocos.json` + `ANTES-blocos-fixo-por-item.json`. Estimativa mm = linhas × 3 + QR 28.

### Mapa de blocos (cupom fiscal atual)

| Bloco | Tipo | ~mm (5 itens @80) | Conteúdo típico |
|-------|------|------------------:|-----------------|
| emitente | FIXA | 15 | Fantasia, razão, CNPJ, endereço, cidade |
| titulo_modo | FIXA | 6 | `CUPOM FISCAL NFC-e` + `=` |
| meta_venda (+ consumidor) | FIXA | 15 | Nro, Data, Operador, Cliente, CPF |
| itens | **POR ITEM** | 30 | Header + 1–2 linhas/item (+ qty>1) |
| totais | FIXA | 9 | Subtotal/desconto se houver, TOTAL |
| pagamentos | FIXA* | 9 | Forma(s) + Volumes (*cresce com multipag) |
| tributos / IBPT | FIXA | 0 nestas amostras | Só se `vTotTrib`/resolverIbpt |
| chave_protocolo | FIXA | 21 | Título, nNF/série, protocolo, chave, portal |
| qr_mensagens | FIXA+QR | **34** | 2 textos + QR |
| rodapé | FIXA | 12 | Obrigado / Volte / PDV Margin Engine |

\* Consumidor está em `meta_venda` nas amostras (não bloco separado no parser).

### FIXA × POR ITEM (fiscal)

| Papel | Itens | Fixa (linhas / mm) | Itens (linhas / mm) | QR mm | Total est. |
|-------|------:|-------------------:|--------------------:|------:|-----------:|
| 80 | 1 | 31 / 93 | 5 / 15 | 28 | **136** |
| 80 | 5 | 31 / 93 | 10 / 30 | 28 | **151** |
| 80 | 20 | 29 / 87 | 30 / 90 | 28 | **205** |
| 58 | 1 | 31 / 93 | 6 / 18 | 28 | **139** |
| 58 | 5 | 31 / 93 | 15 / 45 | 28 | **166** |
| 58 | 20 | 29 / 87 | 50 / 150 | 28 | **265** |

Em 80 mm com poucos itens a parte **fixa (~93 mm + QR 28)** domina. Em 20 itens @58 mm a parte **por item (~150 mm)** domina.

### Onde começar a compactação (12-3) — maiores primeiro

1. **qr_mensagens** (~34 mm fixos) — textos redundantes; **não** reduzir QR abaixo de 25×25 mm.  
2. **chave_protocolo** (~21 mm) — rótulos/duplicidade; preservar chave 11×4, portal, protocolo.  
3. **rodapé sistema** (~12 mm) — só produto; candidato a remoção.  
4. **Divisores `=`/`-` + Volumes** — sistema / UX.  
5. **Itens** — densificar com Font B/`<c>`/espaçamento (campos Div II obrigatórios).  
6. **Emitente / meta** — só após contador (texto canônico DANFE, IE, etc.).

---

## C) Conformidade por bloco (obrigatório × opcional × sistema)

Fontes citadas: **MET DANFE NFC-e QR Code v6.0 (2025)** §§3.1.1–3.1.9; **Lei 12.741/2012**; FAQ NFC-e/SP (tributos); **Ajuste SINIEF 19/2016** + MOC Anexo IV (contingência).

| Bloco (nosso) | Divisão manual | Obrigatório | Opcional / a critério | Só sistema (hoje) | Gaps vs manual (não alterar agora) |
|---------------|----------------|-------------|------------------------|-------------------|-------------------------------------|
| emitente | I | CNPJ/CPF máscara; razão/nome; endereço completo s/ país; texto **“Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica”** | Logo | Fantasia expandida; IE **não impressa** | Título canônico ausente (`CUPOM FISCAL NFC-e` no lugar) |
| titulo_modo | I / VIII | (ver texto DANFE acima); contingência/homologação em VIII | — | `CUPOM FISCAL NFC-e`, divisores | Ver gaps VIII |
| meta_venda | VII (parcial) | nNF, série, dhEmi local | Operador PDV | Nro venda PDV, Operador | dhEmi da NFC-e vs hora PDV — conferir paridade |
| itens | II | Se completo: cProd, xProd, qCom, uCom, vUnCom, vProd | DANFE **resumido** (sem itens) se UF + consumidor | Header DESCRICAO/UNIT/TOTAL; nº sequencial | Código = índice, não `cProd`; `uCom` implícito |
| totais | III | Qtde total itens; Valor total; acrésc./desc. se houver; valor a pagar se houver; forma(s); valor pago; troco se houver | — | Linhas `=` | “Volumes: N item(ns)” ≠ “Qtde. Total de Itens” do manual |
| pagamentos | III | tPag + vPag (+ troco) | — | Label `Pagamento:` | — |
| tributos | IX / Lei 12.741 | **Não** obrigatório no DANFE se informado por painel/meio eletrônico; se imprimir, deve refletir XML `vTotTrib` | Texto IBPT | — | Impressão só se `resolverIbptCupom` achar dados |
| consumidor | VI | CONSUMIDOR CPF/CNPJ/Id. estrang. ou **CONSUMIDOR NÃO IDENTIFICADO**; nome+endereço se entrega | Nome/endereço extras | Labels `Cliente:`/`CPF:` | Falta frase canônica “CONSUMIDOR NÃO IDENTIFICADO” quando sem doc |
| chave_protocolo | IV + VII | “Consulte pela Chave de Acesso em” + URL UF; chave **11×4**; nNF/série/dhEmi; “Protocolo de autorização:” + nProt + dhRecbto (exceto contingência) | — | Título `DOCUMENTO FISCAL NFC-e`; `Consulte em …` (variação) | Wording portal ligeiramente diferente do canônico |
| QR | V | Imagem ≥ **25×25 mm** (+ quiet zone); URL do XML (ZX) | Layout lateral vs centro | Textos “Consulta via QR Code” / “Consulte pela chave ou QR Code” | Textos extras = sistema (removíveis) |
| mensagens fiscais | VIII | Contingência / homologação (abaixo) | infAdFisco / xMsg | — | **Homologação: texto canônico ausente no térmico** |
| rodapé | após IX | — | infCpl do XML | Obrigado / Volte / PDV Margin Engine | OK após DANFE se não misturar com fiscal |

### Contingência

| Exigência (MET §3.1.8 / SINIEF) | Nosso comportamento atual | Dúvida UF/contador |
|--------------------------------|---------------------------|-------------------|
| Destaque **“EMITIDA EM CONTINGÊNCIA / Pendente de autorização”** (2 locais) | Banner único `*** EMITIDA EM CONTINGENCIA ***` via `bannersStatusCupom` | Adequar wording/locais? |
| 2ª via estabelecimento **ou** guarda XML com termo | Uma via térmica; sem automação explícita “Via do Estabelecimento” | SP exige 2 vias papel ou aceita guarda XML? |
| Sem protocolo na via de contingência | Protocolo só se vier no payload | — |

### Reimpressão

- Mesmo template (`renderCupomTags` / `renderCupomConteudo`) + banner `*** SEGUNDA VIA ***` (`segundaVia.js` / `tagSegundaViaBanner`).  
- Não é documento fiscal novo; não remover chave/QR/protocolo.

### NFC-e cancelada

- Banner `*** VENDA CANCELADA ***` se `vendaCancelada`.  
- **Dúvida contador:** conteúdo mínimo da via de cancelamento / se reimprimir DANFE da nota cancelada ou só comprovante interno.

### Homologação (`tpAmb=2`)

- MET: obrigatório na Divisão VIII, caixa alta: **“EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO – SEM VALOR FISCAL”**.  
- Hoje: texto aplicado no **XML/destinatário** (`acbr.js`); **não** há impressão desse texto no template térmico do cupom.  
- **Gap de conformidade a tratar após 12-2 (não nesta etapa).**

### Dúvidas — não decidir sozinho

1. SP permite **DANFE resumido** (sem itens) no PDV? Em quais condições?  
2. Impressão de **tributos aproximados** no cupom vs painel/QR no estabelecimento?  
3. Exigência de **IE** / telefone no cabeçalho térmico?  
4. Contingência: **duas vias** papel vs guarda XML (termo modelo 6)?  
5. Wording exato contingência/homologação vs banners atuais?  
6. Consumidor não identificado: obrigar frase canônica sempre?  
7. Cancelamento: o que imprimir obrigatoriamente?

**Regra 12-3:** nada marcado Obrigatório pode ser removido ou alterado sem aprovação explícita + contador.

---

## D) Caminhos de impressão

```
POST cupom → printJobService → acbrPosPrinterProvider.imprimirCupom
  ├─ preferNativeEscPos?
  │    • não fiscal + RAW:Windows (PRINT_FAST_NATIVE=raw default) → native
  │    • circuito ACBr aberto + RAW → native também no fiscal
  │    • PRINT_FAST_NATIVE=always → tudo native
  │    • caso contrário fiscal com chave → ACBr tags (renderCupomTags)
  └─ falha ACBr pré-impressão (ativar/config/timeout) → printExecutor
       fallback nativeEscPos (mesmo renderCupomConteudo)
       mid-print / hard drain → SEM segundo envio (anti-dupla)
```

| Situação | Fiscal tem papel? |
|----------|-------------------|
| ACBr OK | Sim — tags |
| ACBr circuito aberto / lib ausente / parity | Sim — **fallback ESC/POS nativo** |
| Falha no meio do `POS_Imprimir` | Não reenvia (evita 2 vias) |

**Implicação 12-3:** compactação deve valer em **ACBr tags e ESC/POS nativo** com o mesmo resultado visual (`cupomLayoutShared` + paridade já existente).

### Tags / recursos ACBr para densificar (ainda não usados no cupom)

| Recurso | Como | Uso atual cupom | Nota POS80 |
|---------|------|-----------------|------------|
| Condensado | `<c>…</c>` | Só na página de teste | Suporte ESC/POS típico; validar colunas reais |
| Font B | `<fb>` / `</fa>` | Não | ~mais colunas; validar no POS80 |
| Fonte normal | `</fn>` | Evitar após `</zera>` (doc interno: cupom “apagado”) | — |
| Negrito / expandido | `<n>` / `<e>` | Sim (destaques / fantasia) | OK |
| `EspacoEntreLinhas` (INI) | byte DPI, default **0** | Não reduzido | Economia de papel se >0 — testar legibilidade |
| `ColunasFonteNormal` | INI (48/32) | Sim | Alinha `thermalCols` |

Native: `escpos` Font B / size condensado precisa espelhar as mesmas regras quando 12-3 aplicar.

---

## E) Compartilhamento do template

| Saída | Renderer | Layout compartilhado |
|-------|----------|----------------------|
| 1ª via fiscal | `cupomAcbrTags.renderCupomTags` **ou** `impressoraCore.renderCupomConteudo` | `cupomLayoutShared` (FOOTER, banners, QR opts, corte, barcodes) |
| Não fiscal | Mesmo par (ramo sem chave/QR/IBPT) | idem |
| Reimpressão / 2ª via | `imprimirSegundaVia` → **mesmo** `imprimirPayloadTags` + banner | idem |
| Contingência / cancelada | Mesmo template + `bannersStatusCupom` | idem |

**Confirmado:** não há segundo template divergente para reimpressão. Mudança de compactação deve tocar tags **e** native (ou só shared + ambos os renderers).

---

## Artefatos desta etapa

```
docs/etapa12-2-conformidade.md          (este documento)
docs/etapa12-amostras/ANTES-baseline-fisico.json
docs/etapa12-amostras/ANTES-print-*.bin / ANTES-print-jobs.json
docs/etapa12-amostras/ANTES-blocos.json / ANTES-blocos-fixo-por-item.json
docs/etapa12-amostras/ANTES-qr-baseline.png|.txt / ANTES-qr-decode.json
docs/etapa12-amostras/fotos/README.md
```

Zero mudança em `print/*.js` de layout/runtime. Sem bump de versão.

---

## Pare aqui — aprovação 12-2

Próxima (**12-3 Compactação**): aplicar ganhos na ordem da §B, sem remover obrigatórios da §C; validar paridade ACBr ↔ native (§D/E); depois medir papel de novo (12-4).

Confirme: (1) aceitar gaps homologação/contingência/wording como dívida pós-compactação ou exigir correção antes; (2) preencher régua/foto/celular quando possível; (3) liberar 12-3.
