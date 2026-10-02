# RELATÓRIO DE LEVANTAMENTO — Margin Engine

**Escopo:** schema + regras reais para migrar contas a receber/pagar em aberto (legado Firebird → Margin Engine).  
**Tenant alvo:** `391bee82-eff9-4b4e-87eb-316f5b68a4ac` (BRENO V. LIMA).  
**Fontes:** código `/home/caio/projects/margin-engine` (Flyway + JPA + serviços) + Postgres **dev** `margin_db@localhost` (**somente SELECT**).  
**Data do levantamento:** 2026-10-01.

### Aviso crítico de ambiente

| Item | Valor |
|------|--------|
| Tenant `391bee82-…` no dev | **NÃO EXISTE** (`SELECT` em `tenants` → 0 linhas; `pdv_cliente`/`pdv_crediario_*` do tenant → 0) |
| Flyway no **dev** | última version aplicada: **`20261044`** |
| Flyway no **código** | migrations até **`V20261089`** (e além) |
| Divergência | Tabelas/colunas pós-`20261044` (ex.: `pdv_conta_tesouraria` em `V20261074`, fix `AUTOMATICO`→`SUGESTAO` em `V20261080`, `conta_tesouraria_origem_id` em `V20261089`) **existem no código e NÃO no dump do dev**. Fonte da verdade para migração = **migrations + entidades**. |

Tudo que depende de dados reais desse tenant está marcado **`DEPENDE DE PRODUÇÃO`** (seção 13).

Anexos gerados neste workspace:
- `docs/me-ddl-dev-snapshot.sql` — CREATE/ALTER/INDEX do schema **dev** (snapshot)
- `docs/me-crediario-agent.md`, `docs/me-vendas-agent.md`, `docs/me-finance-agent.md` — investigações detalhadas

---

## 1. Inventário de tabelas relevantes

### Domínio PDV / crediário / venda / caixa

| Tabela | Finalidade |
|--------|------------|
| `pdv_cliente` | Cadastro central de clientes (doc fiscal ou sintético) |
| `pdv_crediario_cliente` | Conta de crediário do cliente (limite, saldo, status, encargos) |
| `pdv_crediario_conta` | Conta/compra a prazo ligada a uma venda (`venda_id`) |
| `pdv_crediario_parcela` | Parcelas da conta |
| `pdv_crediario_recebimento` | Baixas/recebimentos por parcela |
| `pdv_crediario_renegociacao` | Renegociação de conta |
| `pdv_crediario_encargo` | Multa/juros aplicados no recebimento |
| `pdv_crediario_cobranca_evento` | Eventos de cobrança (WhatsApp etc.) |
| `pdv_venda` | Cabeçalho da venda |
| `pdv_item_venda` | Itens da venda |
| `pdv_venda_pagamento` | Pagamentos da venda (misto) |
| `pdv_produto` | Produtos (mapa legado via `codigo`) |
| `pdv_caixa` / `pdv_caixa_terminal` / `pdv_fechamento_caixa` | Turno/terminal de caixa |
| `pdv_movimento_caixa` | Sangria/suprimento/auditoria de caixa |
| `pdv_configuracao` | Config PDV (incl. política de crediário) |
| `pedido_venda` / `pedido_venda_item` | Pedido comercial (≠ venda PDV; R1 do legado `PE` mapeia para **`pdv_venda`**) |
| `devolucao_venda` / `devolucao_venda_item` | Devoluções |

### Financeiro / fornecedor

| Tabela | Finalidade |
|--------|------------|
| `retail_fornecedor` | Fornecedores |
| `finance_conta_pagar` | Contas a pagar (1 linha = 1 título; **sem** tabela de parcelas) |
| `finance_centro_custo` | Centro de custo (por tenant, `codigo` único) |
| `finance_natureza_custo` | Natureza fixa do sistema (FIXO/VARIAVEL/DIRETO/INDIRETO) |
| `finance_categoria_custo` | Categorias (hierarquia, por tenant) |
| `finance_rateio_conta_pagar` | Rateio de AP |
| `finance_recorrencia_custo` | Recorrência |
| `finance_desconto_titulo` | Desconto em título |
| `finance_alcada_aprovacao` / `finance_auditoria_log` / `finance_orcamento*` | Aprovação / auditoria / orçamento |
| `produto_fornecedor` | Vínculo produto↔fornecedor |

### Tesouraria (código ≥ V20261074; **ausente no dev**)

| Tabela | Finalidade |
|--------|------------|
| `pdv_conta_tesouraria` | Contas BANCO/COFRE/MALOTE/OUTRO |
| `pdv_transferencia` | Transferências caixa↔conta |
| `pdv_movimento_tesouraria` | Movimentos de saldo |

### Loja

| Tabela | Finalidade |
|--------|------------|
| `retail_loja` | Lojas do tenant (`pdv_venda.loja_id` nullable) |

Lista literal do inventário A (dev): ver `docs/me-tables-A.txt`.

---

## 2. Convenções globais (3.1)

### `tenant_id` / `loja_id`

- Quase todas as tabelas PDV/finance têm `tenant_id UUID NOT NULL`.
- Multi-loja: `retail_loja` + `pdv_venda.loja_id` / `finance_conta_pagar.loja_id` / `pdv_caixa_terminal.loja_id` — **nullable**. Relatórios podem mostrar `loja=null`.
- **Qual loja usar na migração:** `DEPENDE DE PRODUÇÃO` (listar `retail_loja` do tenant). Se single-loja, preencher a única; se multi, mapear CENTRO/loja do legado ou deixar `NULL` (aceitável pelo schema).

### Dinheiro

| Domínio | Tipo predominante | Evidência |
|---------|-------------------|-----------|
| Crediário (`valor`, `saldo_devedor`, `valor_pago`, …) | `NUMERIC(19,4)` | `V20260714`, entidades |
| Venda / item / pagamento | `NUMERIC(19,4)` | foundation / dump |
| Conta a pagar | `NUMERIC(19,4)` | `V20260752` |
| Cliente RFM / totais | **centavos `BIGINT`**: `total_compras_cents`, `ticket_medio_cents` | `pdv_cliente` |
| Produto `preco`/`custo` | legado `double precision` no foundation (evoluiu; conferir dump) | foundation |

### Auditoria / timestamps / soft delete

- Crediário: `criado_em` / `atualizado_em` `TIMESTAMP` (sem TZ explícito; sessão JDBC `America/Sao_Paulo` em `application.properties:73-74`).
- Finance AP / fornecedor: `created_at` / `updated_at`.
- Soft delete cliente: `pdv_cliente.ativo` (`V20260924`). **Sem** `deleted_at`.
- Soft delete fornecedor: `retail_fornecedor.ativo`.
- **NÃO ENCONTRADO** coluna genérica `origem`/`external_id`/`codigo_legado`/`legacy_id` em crediário/venda/cliente.
- Venda tem `origem_venda VARCHAR(20)` (valores de app: `PDV`, `PAINEL_NFE`, `ORDER_ONLINE`) — **livre**; nada impede gravar `LEGADO` (app não filtra hoje).

### Mapa produto legado → novo

- Coluna: **`pdv_produto.codigo`** (`VARCHAR(50) NOT NULL`), unique `(tenant_id, codigo)`.
- Opcional: `ean_fabricante`, `codigo_plu` (balança).
- **NÃO ENCONTRADO** `codigo_interno` / `external_id` / `codigo_legado` em `pdv_produto`.
- Consulta mapa (produção):  
  `SELECT id, codigo, ean_fabricante, nome FROM pdv_produto WHERE tenant_id = '391bee82-…' ORDER BY codigo;`

### Sequências / numeração

| Número | Quem gera | Pode inserir próprio? |
|--------|-----------|------------------------|
| `pdv_venda.numero_venda` | Serviço PDV (sequence/serviço interno) | Sim via SQL direto; respeitar `UNIQUE (tenant_id, numero_venda)`. Preferir `numero_venda_cliente` = nº legado para idempotência. |
| `pdv_crediario_conta.numero_conta` | `PdvCrediarioMotorService.gerarNumeroConta` → `CC-{ANO}-{seq 6 dígitos}` (`count` do ano + 1) — **não** usa SEQUENCE SQL | Sim, desde que unique `(tenant_id, numero_conta)`. Evitar colidir com `CC-2026-******`. |
| Conta a pagar | Sem número auto; campo livre `documento` | Sim |

---

## 3. Clientes e identificador sem CPF (3.2)

### Algoritmo oficial (R7) — **não use `LEG-`**

Fonte: `TelefoneUtil.java:75-113` + `PdvClienteService.criarParaCrediarioSemDocumento` (`:167-196`) + `resolverDocumentoParaCadastro` (`:791-827`).

**Pseudocódigo:**

```
se telefone válido (E.164 / DDD):
    doc = "P" + digitos_locais_telefone   // truncado a 18 chars
    // ex.: P11999999999
    reutiliza cliente existente com mesmo (tenant_id, cpf_cnpj)
senão (sem CPF e sem telefone) — só fluxo crediário sem doc:
    doc = "SN" + uuid4.hex[:12]           // ex.: SN3f2c4a1b9e7d
    nunca reutiliza
cadastro “simples” pela API (sem CPF):
    exige telefone válido; senão IllegalArgumentException
    NÃO gera SN pela API de cadastro normal
```

`isDocumentoSintetico`: começa com `P`+dígitos (≥11) **ou** `SN`+≥12 hex (`TelefoneUtil:101-112`).  
Documentos sintéticos **não** vão para SEFAZ (`DocumentoFiscalClienteResolver`).

Unique: `uk_pdv_cliente_tenant_doc` `(tenant_id, cpf_cnpj)` + unique parcial telefone normalizado.

### Colunas NOT NULL / negócio

Do dump/entity (essenciais): `tenant_id`, `tipo_pessoa`, `cpf_cnpj`, `nome_razao_social`, `ativo`.  
Endereço/telefone: **nullable** no schema. Cadastro simples sem CPF **exige telefone** na API (`PdvClienteService:811-815`).

### Enums / RFM

- `tipo_pessoa`: `"PF"` | `"PJ"` (string, não enum Java).
- `segmento` (job RFM): `VIP`, `RECORRENTE`, `INATIVO`, `NAO_CLASSIFICADO` (`PdvClienteSegmentacaoService` cálculo ~`:57-71`).
- Job recalcula: `segmento`, e usa/atualiza `total_compras_count`, `total_compras_cents`, `ticket_medio_cents`, última compra (`atualizarClienteAposVenda` em venda normal `:1696-1698`).

### Exemplos DEV de clientes sem CPF

**0 linhas** no dev (`P%` / `SN%`). Não criados. Valores derivados pelo código acima.

---

## 4. Crediário (3.3)

### DDL (resumo; completo no Anexo A / `me-ddl-dev-snapshot.sql`)

- `pdv_crediario_conta.venda_id UUID REFERENCES pdv_venda(id)` — **ligação venda↔conta** (`V20260714:17`).
- Unique: `(tenant_id, numero_conta)`.
- Trigger `trg_saldo_crediario` em `pdv_crediario_parcela` → `fn_atualiza_saldo_crediario()` recalcula `saldo_devedor = SUM(valor - valor_pago)` onde status ≠ `CANCELADA` (`V20260600:51-65`).

### Status / enums

| Conceito | Valores reais | Fonte |
|----------|---------------|-------|
| `ModoAplicacaoEncargoCrediario` | **`SUGESTAO`**, **`OBRIGATORIO_NO_RECEBIMENTO`** | `ModoAplicacaoEncargoCrediario.java:10-12`; CHECK em `V20261080` |
| ~~`AUTOMATICO`~~ | **INVÁLIDO** (quebra tela; migration corrige → `SUGESTAO`) | `V20261080` |
| Status crediário cliente | `ATIVO`, `BLOQUEADO` (+ uso em código) | entity default `ATIVO` |
| Periodicidade | v1: **`MENSAL`** apenas | `PoliticaCobrancaCrediario.java:7-18` |
| Status **conta** | `ABERTA`, `PAGA`, `PARCIALMENTE_PAGA`, `VENCIDA`, `RENEGOCIADA`, `CANCELADA` | `PdvCrediarioConta.java:56-58` |
| Status **parcela** | `ABERTA`, `PAGA`, `ATRASADA`, `CANCELADA` (+ `RENEGOCIADA` no receber) | `PdvCrediarioParcela.java:31-32,84-86` |
| **`PARCIAL` em parcela** | **NÃO EXISTE** | parcial = `valor_pago > 0` e status `ABERTA`/`ATRASADA` |

### Como a venda cria crediário

1. Pagamento com forma mapeada para `PaymentType.CREDIARIO` (`PdvVendaPagamentoUtil.mapearForma` — string `"crediario"` / `"CREDIARIO"`).
2. `PdvVendaService.processarCrediario` (`:2110-2156`) → `crediarioService.gerarParcelas(...)`.
3. `PdvCrediarioMotorService.criarContaParaVenda` (`:108-123`): `status=ABERTA`, `numero_conta=CC-YYYY-NNNNNN`, `venda_id` setado, `valor_pendente=valorTotal`.
4. Parcelas criadas `ABERTA` com `crediario_conta_id` + `venda_id`.

### PIX a conferir (R3) — achado importante

**NÃO ENCONTRADO** no código qualquer mapeamento `PIX CONFERIR` / `PIX_A_CONFERIR` / “PIX aguardando” → criação automática de crediário.

- Forma `PIX` → `PaymentType.PIX` (pagamento à vista / conciliação).
- Crediário só nasce com forma **`CREDIARIO`**.

**Para as 189 contas migradas:** gravar venda com pagamento `CREDIARIO` (e parcelas/conta), **sem** linha `PIX` pendente em `pdv_venda_pagamento`. Isso reproduz o resultado do fluxo oficial de crediário; não o fluxo de PIX.

Confirmação posterior de PIX (Asaas etc.) **não** baixa parcela de crediário automaticamente (`NÃO ENCONTRADO` ligação). Baixa = `receberParcela` / quitação FIFO + auditoria `CREDIARIO_RECEBIMENTO`.

### Pagamento a maior

```434:436:src/main/java/com/marginengine/pdv/service/PdvCrediarioMotorService.java
        if (valorReceber.compareTo(restante) > 0) {
            throw new IllegalArgumentException("Valor excede saldo da parcela.");
        }
```

- **Bloqueia** (sem crédito).  
- Em quitação FIFO, excedente local é **ignorado** (não vira crédito).  
- Títulos legados com recebido > valor: **não cabem** no modelo; precisa ajustar `valor`/`valor_pago` antes ou criar observação + valor_pago = min(recebido, valor).

### `saldo_devedor` / atraso / bloqueio

- Persistido + **trigger SQL** + `recalcularSaldoDevedor` no Java após receber.
- Parcela vencida: job `marcarAtrasadasJob` (01:00) marca `ATRASADA`; função SQL `fn_marcar_parcelas_atrasadas` também existe.
- Bloqueio:
  1. ≥ **2** parcelas `ATRASADA` → `BLOQUEADO` (`LIMITE_ATRASO_BLOQUEIO=2`, `PdvCrediarioService:67,571`).
  2. `dias_bloqueio_inadimplencia` (default 30 no cliente; config global) via `verificarBloqueioPorDias`.
- Clientes migrados já atrasados: **não bloqueiam no INSERT**; bloqueio ocorre no **próximo job** diário (ou se alguém chamar verificação). Leitura `isClienteInadimplente` já bloqueia nova venda crediário se status/atraso.

---

## 5. Vendas (3.4)

### Tabelas

- `pdv_venda`, `pdv_item_venda`, `pdv_venda_pagamento` (sem tabela `pdv_venda_parcela` — parcelas de prazo ficam no crediário).
- Fiscal vs não fiscal: `emitir_nfce` / campos NFCe/NFe; para migração **não fiscal** (R2): `emitir_nfce=false`, sem chave/protocolo, `origem_venda` sugerido `LEGADO` ou `PDV`.

### Status / origem / forma

- Status venda em uso no dev: `CONCLUIDA`, `CANCELADA`.
- `origem_venda`: `PDV`, `PAINEL_NFE`, `ORDER_ONLINE` (app). Coluna livre.
- Formas em `pdv_venda_pagamento.forma`: enum `PaymentType` — `DINHEIRO`, `CARTAO_CREDITO`, `CARTAO_DEBITO`, `PIX`, `FIADO`, `CREDIARIO`, `VOUCHER`, `TRANSFERENCIA`.

### FKs / obrigatoriedade para venda histórica

| Campo | Obrigatório? | Migração |
|-------|--------------|----------|
| `cliente_id` | nullable | Preencher quando houver cliente |
| `caixa_id` / `abertura_caixa_id` | nullable se config não exige abertura | **Deixar NULL** para histórico |
| `loja_id` | nullable | Ver lojas do tenant |
| `dispositivo_id` | nullable | NULL |
| `operador` | string | Nome/login do vendedor legado |

Vendedor: **NÃO ENCONTRADO** tabela `vendedor` dedicada na venda; identidade em `pdv_venda.operador` (e comissão usa esse texto).

### Efeitos colaterais de `PdvVendaService.registrar` / `gravarVendaInterno`

Lista (completa do caminho feliz):

1. Validação/abertura de **caixa** (se exigir).
2. Persistência venda + itens + pagamentos.
3. **`segmentacaoService.atualizarClienteAposVenda`** (totais/RFM).
4. Concilição → `pagamento_conciliacao` / Asaas PIX refs.
5. **`processarCrediario`** se forma CREDIARIO.
6. **Baixa de estoque** em lote + padaria/receitas (**ainda ocorre com `syncOffline=true`**).
7. `alimentarMarginEngine` → `sale_entry` (pula se retail ERP).
8. Promoções aplicadas.
9. **Comissão** (`comissaoService.registrarPosVenda` — `vendedor` = texto de `operador`).
10. Order-engine reconcile.
11. **`VendaFinalizadaEvent`** → listener fiscal async AFTER_COMMIT se `emitirNfce`.
12. Auditoria de caixa **afterCommit**.
13. Invalidação de caches de analytics / DRE (DRE é leitura sobre `pdv_venda`; insert direto já entra nos relatórios).

**Não há** no create: fidelidade/pontos, WhatsApp de venda, outbox de venda, movimento em `pdv_movimento_caixa` (caixa fecha **consultando** vendas por `caixa_id`).

**Como migrar sem efeitos:** **NÃO** chamar `registrar`. Fazer **INSERT SQL** (ou JDBC) em `pdv_venda` / `pdv_item_venda` / `pdv_venda_pagamento` / crediário, com `emitir_nfce=false`, sem caixa, sem baixar estoque.  
`syncOffline=true` **não** basta (ainda baixa estoque, RFM, comissão, conciliação).  
Triggers relevantes em venda: **nenhum** no dump (só estoque alerta em produto + saldo crediário em parcela).  
Listeners JPA `@PostPersist` de venda: **NÃO ENCONTRADO**.

### Produto ausente / inativo

- Item guarda `produto_id` (string UUID) **nullable** no DDL + `codigo`/`nome` desnormalizados (`pdv_item_venda`).
- Sem mapa: gravar item com `produto_id=NULL`, `codigo` legado, `nome` do legado — relatórios de produto podem omitir; venda permanece.
- Checkout via API exige UUID resolvível; produto **inativo** ainda pode vender se o `produtoId` for enviado (lookup de scan filtra `ativo=true`, o carrinho não).

### Ligação crediário (item 4 da 1ª rodada)

Coluna: **`pdv_crediario_conta.venda_id`** (e parcelas também têm `venda_id` legado).  
Criar `pdv_venda` + setar `venda_id` nas contas existentes (ou recriar contas).

---

## 6. Contas a pagar e fornecedores (3.5 / 3.5b)

### Módulo existe

- Tabela `finance_conta_pagar` + API `ContaPagarController` / `ContaPagarService`.
- Status enum: `ABERTA`, `PENDENTE_APROVACAO`, `PAGA`, `CANCELADA` (`ContaPagarStatus.java`).
- **NÃO ENCONTRADO** tabela de parcelas AP: 1 título = 1 row (`valor`, `vencimento`, `valor_pago`, `data_pagamento`). Duplicatas de NF = **várias** linhas com `numero_duplicata`.
- Baixa: update in-place + movimento tesouraria / `conta_tesouraria_origem_id` (`V20261089`) — **obrigatória na baixa via API**; coluna nullable no DDL. **Pagamento parcial de AP não é suportado** pela API (`ContaPagarService.baixar`).

### Fornecedor sem CNPJ/CPF

- `retail_fornecedor.cnpj` / `cpf` **nullable** (`Fornecedor.java:31-41`).
- Unique CNPJ: **NÃO ENCONTRADO** (só PK + index tenant).
- Pode cadastrar só com `nome` (+ `ativo=true`).

### Mesmo CNPJ cliente e fornecedor

- Tabelas distintas; **sem** constraint cruzada → **permitido**.
- Cliente 000008 (LATICINIOS…) vs fornecedor 000008 (MGE…): podem coexistir; decisão de negócio é remover o cliente falso (seção 8).

### Centro de custo / natureza / categoria

- `finance_centro_custo`: `(tenant_id, codigo)` unique — **sem seed global**; cadastro por tenant (`DEPENDE DE PRODUÇÃO` listar códigos do BRENO).
- `finance_natureza_custo` seed: `FIXO`, `VARIAVEL`, `DIRETO`, `INDIRETO` (`V20260951`) + `PESSOAL` (`V20260963`).
- `finance_categoria_custo`: por tenant, hierarquia 2 níveis, liga a natureza — **sem seed fixo**.
- Plano de contas contábil clássico: **NÃO ENCONTRADO**.

### Vínculo NF entrada

- `finance_conta_pagar.nota_fiscal_entrada_id` + `numero_duplicata` (sem FK rígida no CREATE inicial; ver alters `V20260771`).

### Contas financeiras / caixa (3.5b)

- Caixa operacional: `pdv_caixa` + movimentos.
- Contas banco/cofre: `pdv_conta_tesouraria` (migration `V20261074`) — **não aplicada no dev**.
- Pagamentos AP migrados **em aberto**: podem ficar sem conta origem; na **baixa futura** a API pedirá conta tesouraria.

---

## 7. Relatórios e marcação de origem (3.6)

Consomem vendas/crediário/AP (não exaustivo):

- Crediário: `/pdv/crediario/*`, dashboard inadimplência, cobrança WhatsApp.
- Vendas/analytics: serviços `PdvVendas*` em `report/`, DRE/finance, ticket médio via agregações em `pdv_venda`.
- AP: `/finance/contas-pagar`, alerts financeiros, DRE (origem `COMISSAO` etc. em AP).

**Campo pronto para excluir legado:** `pdv_venda.origem_venda` — app **não** filtra `LEGADO` hoje. Recomendação: gravar `origem_venda='LEGADO'` e, se distorcer dashboards, acrescentar filtro nos relatórios (trabalho futuro).  
Alternativa: não incluir vendas migradas em janelas “hoje” (datas históricas até 28/09/2026).

---

## 8. Diagnóstico da primeira rodada (seção 5)

| # | Problema | O que o sistema espera | Como corrigir sem apagar/duplicar |
|---|----------|------------------------|-----------------------------------|
| 1 | `cpf_cnpj='LEG-…'` | `P+tel` ou `SN+hex12` | UPDATE para `SN…` (sem tel) ou `P…` (com tel). Unique `(tenant_id,cpf_cnpj)`. Lógica de UI/fiscal trata `LEG-` como **documento fiscal inválido** (não sintético). |
| 2 | `modo_aplicacao_encargos` | `SUGESTAO` (default) ou `OBRIGATORIO_NO_RECEBIMENTO` | Confirmar `SUGESTAO` após `V20261080`. **Não** usar `AUTOMATICO`. |
| 3 | `numero_conta='LEG-…'` | `CC-YYYY-NNNNNN` | UPDATE para formato `CC-2026-000001`… garantindo unique; ou manter LEG se não conflitar visualmente (sistema gera CC-). Preferir normalizar. |
| 4 | Contas sem venda | `venda_id` em `pdv_crediario_conta` | Inserir vendas/itens/pagamentos CREDIARIO e `UPDATE … SET venda_id=…`. |
| 5 | Status `PARCIAL`/`PAGA` | Parcela: sem `PARCIAL`; parcial = `ABERTA`/`ATRASADA` + `valor_pago` | Normalizar status; `valor_pago ≤ valor`. |
| 6 | Totais RFM sem vendas | Inconsistente vs motor | **Zerar** totais migrados **ou** recalcular job **depois** de inserir só vendas em aberto (não as 30k). Manter histórico completo nos totais **sem** vendas no banco = métricas falsas em telas. |
| 7 | 3 clientes >30d atraso | Job diário / `verificarBloqueioPorDias` | Podem ser bloqueados no próximo job; ou pré-marcar `ATRASADA` + rodar verificação. |
| 8 | Cliente 000008 falso | Soft `ativo=false` ou exclusão definitiva se órfão | Se sem venda/crediário/orçamento: `PdvClienteExclusaoDefinitivaService` (DELETE). Bloqueios: `pdv_venda`, `pdv_crediario_cliente`, orçamento, vasilhame, locação. Preferir **Desativar** se houver dúvida. Fornecedor MGE entra em `retail_fornecedor` (mesmo CNPJ OK). |

Itens 1–8 com estado atual das linhas: **`DEPENDE DE PRODUÇÃO`**.

---

## 9. Lacunas e riscos

1. **PIX CONFERIR ≠ código automático de crediário** — decisão R3 deve mapear explicitamente para `CREDIARIO`.
2. **Overpayment legado** incompatível com API (exception).
3. **Dev desatualizado** vs migrations (tesouraria, fix AUTOMATICO, etc.).
4. **Sem flag nativa `LEGADO`** com exclusão em todos os relatórios.
5. **`numero_conta` por count+1** — race se gerar via API em paralelo; migração SQL deve escolher faixa livre.
6. **Trigger saldo** recalcula ao tocar parcelas — inserts de parcela atualizam `saldo_devedor` automaticamente.
7. **Pedido (`pedido_venda`) ≠ venda PDV** — R1 usa `pdv_venda`.
8. **Vendedor** sem FK tipada.
9. **Centro de custo** do legado (`000021`…) precisa de mapa manual em `finance_centro_custo.codigo`.
10. Clientes `LEG-` podem falhar validadores que esperam CPF ou sintético `P`/`SN`.

---

## 10. Anexo A: DDL completo

Snapshot literal do **dev** (CREATE TABLE + ALTER + INDEX das tabelas-chave):  
**`docs/me-ddl-dev-snapshot.sql`** (~40 KB).

CREATE fundacionais (trechos):

```sql
-- V20260600 (função saldo) — arquivo:linha ~51-65
CREATE OR REPLACE FUNCTION public.fn_atualiza_saldo_crediario() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE pdv_crediario_cliente
    SET saldo_devedor = (
            SELECT COALESCE(SUM(valor - valor_pago), 0)
            FROM pdv_crediario_parcela
            WHERE crediario_id = COALESCE(NEW.crediario_id, OLD.crediario_id)
              AND status NOT IN ('CANCELADA')
        ),
        atualizado_em = NOW()
    WHERE id = COALESCE(NEW.crediario_id, OLD.crediario_id);
    RETURN NEW;
END;
$$;
```

```sql
-- V20260714 — pdv_crediario_conta (arquivo completo migration)
CREATE TABLE IF NOT EXISTS pdv_crediario_conta (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    crediario_cliente_id UUID NOT NULL REFERENCES pdv_crediario_cliente(id),
    venda_id UUID REFERENCES pdv_venda(id),
    numero_conta VARCHAR(32) NOT NULL,
    valor_total NUMERIC(19, 4) NOT NULL,
    valor_pago NUMERIC(19, 4) NOT NULL DEFAULT 0,
    valor_pendente NUMERIC(19, 4) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'ABERTA',
    data_venda TIMESTAMP NOT NULL DEFAULT NOW(),
    observacoes TEXT,
    criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_crediario_conta_numero UNIQUE (tenant_id, numero_conta)
);
```

```sql
-- V20260752 — finance_conta_pagar (CREATE inicial; status CHECK depois ampliado)
CREATE TABLE IF NOT EXISTS finance_conta_pagar (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    fornecedor_id UUID REFERENCES retail_fornecedor(id),
    fornecedor_nome VARCHAR(200),
    descricao VARCHAR(300) NOT NULL,
    documento VARCHAR(60),
    valor NUMERIC(19, 4) NOT NULL,
    vencimento DATE NOT NULL,
    data_pagamento DATE,
    valor_pago NUMERIC(19, 4),
    status VARCHAR(20) NOT NULL DEFAULT 'ABERTA',
    observacao TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_finance_conta_pagar_status CHECK (status IN ('ABERTA', 'PAGA', 'CANCELADA'))
);
-- Dev atual: CHECK inclui PENDENTE_APROVACAO (alter posterior).
```

Migrations posteriores obrigatórias em produção (não no dump dev): `V20261074` tesouraria, `V20261080` modo encargos, `V20261089` origem tesouraria AP.

---

## 11. Anexo B: Enums completos

```java
// ModoAplicacaoEncargoCrediario.java:10-12
SUGESTAO, OBRIGATORIO_NO_RECEBIMENTO
```

```java
// PaymentType.java
DINHEIRO, CARTAO_CREDITO, CARTAO_DEBITO, PIX, FIADO, CREDIARIO, VOUCHER, TRANSFERENCIA
```

```java
// ContaPagarStatus.java
ABERTA, PENDENTE_APROVACAO, PAGA, CANCELADA
```

```text
Crediário cliente.status: ATIVO | BLOQUEADO
Conta.status: ABERTA | PAGA | PARCIALMENTE_PAGA | VENCIDA | RENEGOCIADA | CANCELADA
Parcela.status: ABERTA | PAGA | ATRASADA | CANCELADA | RENEGOCIADA
Periodicidade encargos v1: MENSAL
Segmento cliente: VIP | RECORRENTE | INATIVO | NAO_CLASSIFICADO
Tipo pessoa: PF | PJ
pdv_conta_tesouraria.tipo: BANCO | COFRE | MALOTE | OUTRO
```

Distribuição real no **dev** (todos os tenants): ver `docs/me-enums-F.txt` (sem dados do tenant BRENO).

---

## 12. Anexo C: linhas de exemplo do DEV

| Tabela | Resultado |
|--------|-----------|
| Clientes sintéticos `P%`/`SN%` | **0 linhas** |
| Crediário / contas / parcelas | Quase vazio (1 crediário ATIVO sem modo/periodicidade preenchidos no F) |
| Vendas | Existem (242 `CONCLUIDA`) — **outros tenants**; não são do BRENO |
| Fornecedor | 1 ativo |

Sem mascarar linhas do tenant alvo (inexistente). Exemplos devem ser tirados em **produção** (seção 13).

---

## 13. Itens marcados DEPENDE DE PRODUÇÃO

Consultas prontas (colar em produção; somente SELECT):

```sql
-- 13.1 Tenant e lojas
SELECT id, name FROM tenants WHERE id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac';
SELECT id, codigo, nome, ativo FROM retail_loja WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac' ORDER BY codigo;

-- 13.2 Estado 1ª rodada — clientes
SELECT id, nome_razao_social, cpf_cnpj, ativo, segmento,
       total_compras_count, total_compras_cents, ticket_medio_cents, criado_em
FROM pdv_cliente
WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac'
ORDER BY criado_em;

-- 13.3 Crediários
SELECT id, cliente_id, limite_credito, saldo_devedor, status,
       modo_aplicacao_encargos, periodicidade, dias_bloqueio_inadimplencia, aprovado_por
FROM pdv_crediario_cliente
WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac';

-- 13.4 Contas / parcelas (enums + ligação venda)
SELECT status, count(*) FROM pdv_crediario_conta
 WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac' GROUP BY 1;
SELECT status, count(*) FROM pdv_crediario_parcela
 WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac' GROUP BY 1;
SELECT count(*) AS contas_sem_venda
FROM pdv_crediario_conta
WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac' AND venda_id IS NULL;
SELECT numero_conta, venda_id, valor_total, valor_pago, valor_pendente, status
FROM pdv_crediario_conta
WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac'
ORDER BY criado_em LIMIT 50;

-- 13.5 Cliente 000008 (CNPJ 38532537001309) — vínculos
SELECT id, nome_razao_social, cpf_cnpj, ativo
FROM pdv_cliente
WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac'
  AND regexp_replace(cpf_cnpj, '\D', '', 'g') = '38532537001309';
-- (substituir :cid pelo id retornado)
-- SELECT 'pdv_venda' t, count(*) FROM pdv_venda WHERE tenant_id=... AND cliente_id=:cid
-- UNION ALL SELECT 'crediario', count(*) FROM pdv_crediario_cliente WHERE tenant_id=... AND cliente_id=:cid
-- UNION ALL SELECT 'orcamento', count(*) FROM pdv_orcamento WHERE tenant_id=... AND cliente_id=:cid;

-- 13.6 Mapa produto legado
SELECT id, codigo, ean_fabricante, left(nome,60), ativo
FROM pdv_produto
WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac'
ORDER BY codigo;

-- 13.7 Centros de custo / categorias / contas tesouraria
SELECT id, codigo, nome, ativo FROM finance_centro_custo
 WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac' ORDER BY codigo;
SELECT id, codigo, nome, natureza_id, ativo FROM finance_categoria_custo
 WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac' ORDER BY codigo;
SELECT id, nome, tipo, ativo, saldo FROM pdv_conta_tesouraria
 WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac' ORDER BY nome;

-- 13.8 Fornecedores já existentes (evitar duplicar CNPJ visualmente)
SELECT id, nome, cnpj, cpf, ativo FROM retail_fornecedor
 WHERE tenant_id = '391bee82-eff9-4b4e-87eb-316f5b68a4ac' ORDER BY nome;

-- 13.9 Flyway produção (confirmar ≥ 20261080 / 20261089)
SELECT version, description, installed_on, success
FROM flyway_schema_history
WHERE version::text >= '20261074'
ORDER BY installed_rank;
```

---

## Perguntas que ainda dependem de decisão sua

1. Confirma mapear **todas** as 189 “PIX CONFERIR” → pagamento/venda **`CREDIARIO`** (sem PIX), apesar de o código **não** fazer isso sozinho?
2. Para overpayment (4 títulos), prefere **cap** `valor_pago = valor`, **inflar** `valor` da parcela, ou **não migrar** esses quatro até ajuste manual?
3. `modo_aplicacao_encargos` definitivo na migração: **`SUGESTAO`** (default produto) ou **`OBRIGATORIO_NO_RECEBIMENTO`**?
4. Clientes sem CPF **e sem telefone**: gerar **`SN+hex12`** únicos (um por cliente) — ok?
5. Clientes sem CPF **com telefone**: usar **`P+tel`** (com risco de colisão se dois clientes compartilham telefone) — ok?
6. `origem_venda='LEGADO'` em todas as vendas migradas + filtro futuro nos dashboards — ok, ou prefere `PDV`?
7. Totais RFM da 1ª rodada: **zerar agora** ou manter até recalcular só com vendas em aberto?
8. Cliente 000008: **exclusão definitiva** ou só **`ativo=false`**?
9. `numero_conta`: renumerar para `CC-2026-…` ou manter `LEG-…` se unique?
10. Contas a pagar: criar **centros de custo** espelhando códigos legado (`000021`…) antes da carga, ou deixar `centro_custo_id` null?
11. Qual **`retail_loja.id`** usar nas vendas/AP (resultado da query 13.1)?
12. Na baixa futura (delta R6) de crediário migrado: registrar movimento de **caixa** / **tesouraria** ou só `pdv_crediario_recebimento`?
13. Flyway em produção já aplicou `V20261080` e `V20261089`? (query 13.9)
14. Itens de venda sem produto mapeado: gravar com `produto_id` null ou **bloquear** a carga até mapear 100%?
