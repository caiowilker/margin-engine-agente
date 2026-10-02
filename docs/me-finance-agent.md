# Migration schema report — Contas a Pagar / Fornecedores / Custos / Tesouraria

Base: `/home/caio/projects/margin-engine`

---

## 1. Contas a pagar — existe? Tabelas + CREATE (Flyway)

**Sim.** Módulo completo em `com.marginengine.finance.contapagar`, API `/finance/contas-pagar`, gate `FINANCEIRO_COMPLETO`.

### Tabelas relacionadas

| Tabela | Origem |
|--------|--------|
| `finance_conta_pagar` | V20260752 (+ alters) |
| `finance_centro_custo` | V20260754 |
| `finance_natureza_custo` | V20260951 |
| `finance_categoria_custo` | V20260952 |
| `finance_recorrencia_custo` | V20260954 |
| `finance_rateio_conta_pagar` | V20260955 |
| `finance_alcada_aprovacao` | V20260956 (status PENDENTE_APROVACAO) |
| `finance_colaborador` | V20260963 (colaborador_id / origem em AP) |

### CREATE / ALTER pedidos

**V20260752** — `/home/caio/projects/margin-engine/src/main/resources/db/migration/V20260752__finance_contas_pagar.sql:3-25`

```sql
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
-- indexes :21-25
```

**V20260754** — `V20260754__finance_centro_custo.sql:3-24`

```sql
CREATE TABLE finance_centro_custo (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    codigo VARCHAR(20) NOT NULL,
    nome VARCHAR(120) NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    CONSTRAINT uq_centro_custo_tenant_codigo UNIQUE (tenant_id, codigo)
);
-- + pdv_produto.centro_custo_id; finance_conta_pagar.centro_custo_id
```

**V20260951** — `V20260951__finance_natureza_custo.sql:3-17`

```sql
CREATE TABLE IF NOT EXISTS finance_natureza_custo (
    id UUID PRIMARY KEY,
    codigo VARCHAR(20) NOT NULL,
    nome VARCHAR(80) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_finance_natureza_custo_codigo UNIQUE (codigo)
);
INSERT ... FIXO, VARIAVEL, DIRETO, INDIRETO ...
```

**V20260952** — `V20260952__finance_categoria_custo.sql:3-20`

```sql
CREATE TABLE IF NOT EXISTS finance_categoria_custo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    natureza_id UUID NOT NULL REFERENCES finance_natureza_custo (id),
    categoria_pai_id UUID REFERENCES finance_categoria_custo (id),
    codigo VARCHAR(40) NOT NULL,
    nome VARCHAR(120) NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    ...
    CONSTRAINT uq_finance_categoria_custo_tenant_codigo UNIQUE (tenant_id, codigo)
);
```

**V20260953** — `V20260953__finance_conta_pagar_onda1_extensao.sql:3-19`  
ADD: `categoria_custo_id`, `loja_id`, `recorrencia_id`, `anexo_url`, `aprovado_por`, `aprovado_em`, `created_by`

**V20260954** — `V20260954__finance_recorrencia_custo.sql:3-35`  
CREATE `finance_recorrencia_custo`; ADD `competencia`; FK `recorrencia_id`; unique parcial `(tenant_id, recorrencia_id, competencia)`

**V20260955** — `V20260955__finance_rateio_conta_pagar.sql:3-16`

```sql
CREATE TABLE IF NOT EXISTS finance_rateio_conta_pagar (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    conta_pagar_id UUID NOT NULL REFERENCES finance_conta_pagar (id) ON DELETE CASCADE,
    centro_custo_id UUID NOT NULL REFERENCES finance_centro_custo (id),
    percentual NUMERIC(19, 4) NOT NULL,
    ...
    CONSTRAINT uq_finance_rateio_conta_centro UNIQUE (conta_pagar_id, centro_custo_id)
);
```

**V20261089** — `V20261089__conta_pagar_tesouraria_origem.sql:4-32`  
AP: `conta_tesouraria_origem_id`, `forma_pagamento`, `movimento_tesouraria_id`  
Movimento: `conta_pagar_id`, `forma_pagamento`, `origem`

**V20260771** — `V20260771__conta_pagar_nota_entrada.sql:3-9`

```sql
ALTER TABLE finance_conta_pagar
    ADD COLUMN IF NOT EXISTS nota_fiscal_entrada_id UUID,
    ADD COLUMN IF NOT EXISTS numero_duplicata VARCHAR(60);
-- index parcial tenant + nota_fiscal_entrada_id
```

Status CHECK ampliado em **V20260956:17-20** → inclui `PENDENTE_APROVACAO`.

---

## 2. Entity `ContaPagar` + `ContaPagarStatus` — parcelas? baixas?

**Entity:** `/home/caio/projects/margin-engine/src/main/java/com/marginengine/finance/contapagar/ContaPagar.java` (`@Table(name = "finance_conta_pagar")`)

Campos principais: fornecedor, descrição, documento, valor, vencimento, dataPagamento, valorPago, status, centroCusto, notaFiscalEntradaId, numeroDuplicata, categoria, loja, recorrencia, anexo, aprovação, competencia, colaboradorId, origem, contaTesourariaOrigemId, formaPagamento, movimentoTesourariaId.

**Enum completo** — `ContaPagarStatus.java:3-8`:

```java
ABERTA,
PENDENTE_APROVACAO,
PAGA,
CANCELADA
```

### Parcelas?

**NÃO ENCONTRADO** tabela `finance_conta_pagar_parcela` / entidade de parcelas de AP.

Modelo: **1 título = 1 linha** em `finance_conta_pagar`. Duplicatas da NF viram **várias ContaPagar** com `numero_duplicata` (`NotaEntradaContaPagarService`). Parcelas de crediário (`pdv_crediario_parcela`) são outro domínio.

### Baixas?

**NÃO ENCONTRADO** tabela `finance_conta_pagar_baixa`.

Baixa é **in-place** no título:

- `ContaPagarService.baixar` `:225-283` → status `PAGA`, `valorPago`, `dataPagamento`, debita tesouraria, grava `movimentoTesourariaId`
- DTO `BaixaContaPagarRequest` (`ContaPagarDtos.java:32-37`): dataPagamento, valorPago, contaTesourariaOrigemId, formaPagamento
- **Pagamento parcial não suportado** (`ContaPagarService.java:245-248`)

---

## 3. Fornecedor — DDL, registro sem CNPJ/CPF, unique CNPJ

**Tabela:** `retail_fornecedor`  
**Entity:** `Fornecedor.java` → `@Table(name = "retail_fornecedor")`

### DDL base — `V20260621__retail_compras.sql:3-13`

```sql
CREATE TABLE IF NOT EXISTS retail_fornecedor (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID         NOT NULL,
    nome        VARCHAR(120) NOT NULL,
    cnpj        VARCHAR(14),          -- NULLABLE
    email       VARCHAR(120),
    telefone    VARCHAR(20),
    ativo       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);
```

Extensão — `V20260711__pdv_planejamento_compras.sql:13-24`: `razao_social`, `nome_fantasia`, `cpf` (nullable), celular, endereço, observacoes.

### Registrar sem CNPJ/CPF?

**Sim.** `cnpj`/`cpf` nullable no DDL e na entity (`Fornecedor.java:31-41`).

- `PurchaseService.criarFornecedor` (`PurchaseService.java:58-66`): só exige o que o request manda; CNPJ opcional.
- `CompraService.criarFornecedor` (`CompraService.java:127-134`): se nome vazio → `"Fornecedor"`; `aplicarFornecedor` só seta cnpj/cpf se não null (`:956-957`).
- `RetailDtos.FornecedorRequest` (`RetailDtos.java:13`): `(nome, cnpj, email, telefone)` — sem bean validation de documento.

Exceção: fluxo NF-e (`FornecedorEmitenteService`) cria **com** CNPJ do emitente.

### Unique constraints on CNPJ?

**NÃO ENCONTRADO** índice/`UNIQUE (tenant_id, cnpj)` em `retail_fornecedor`.

Só `findByTenantIdAndCnpj` para lookup (não bloqueia duplicata no create manual). DB permite N fornecedores com mesmo CNPJ (ou vários com CNPJ null).

---

## 4. Mesmo CNPJ como cliente e fornecedor?

**Sim.** Entidades separadas, sem constraint cruzada:

| Papel | Tabela | Doc | Unique |
|-------|--------|-----|--------|
| Cliente | `pdv_cliente` | `cpf_cnpj NOT NULL` | `uk_pdv_cliente_tenant_doc (tenant_id, cpf_cnpj)` — `V20260707:25-26` |
| Fornecedor | `retail_fornecedor` | `cnpj` opcional | **sem unique** |

Mesmo documento pode existir nas duas tabelas no mesmo tenant.

---

## 5. Centro de custo / natureza / categoria — estrutura e seeds

### Centro de custo — `finance_centro_custo`

- DDL: `V20260754:3-12` — `(tenant_id, codigo)` unique; `ativo`
- Entity: `CentroCusto.java`
- FK em AP, produto, recorrência, rateio, colaborador
- **Seed migrations:** **NÃO ENCONTRADO** `INSERT INTO finance_centro_custo` — catálogo por tenant via API

### Natureza de custo — `finance_natureza_custo` (sistema, não por tenant)

Seed `V20260951:12-16`:

| id | codigo | nome |
|----|--------|------|
| `a1000000-…0001` | FIXO | Fixo |
| `a1000000-…0002` | VARIAVEL | Variável |
| `a1000000-…0003` | DIRETO | Direto |
| `a1000000-…0004` | INDIRETO | Indireto |

Mais `PESSOAL` — `V20260963:5-7` (`a1000000-…0005`). Constantes: `NaturezaCustoCodigos.java:8-15`.

### Categoria de custo — `finance_categoria_custo`

- Hierarquia até 2 níveis (`categoria_pai_id`)
- FK obrigatória `natureza_id`
- Unique `(tenant_id, codigo)`
- **Seed:** **NÃO ENCONTRADO** — customizável por tenant

---

## 6. Contas financeiras / caixa / banco / tesouraria

### Plano de contas / `conta_financeira`

**NÃO ENCONTRADO** (`plano_conta`, `finance_plano_conta`, `ContaFinanceira`, chart of accounts).

Proxy de “contas financeiras” = **tesouraria PDV**.

### Tesouraria — `V20261074__pdv_tesouraria_transferencias.sql:6-71`

- `pdv_conta_tesouraria`: nome, tipo `BANCO|COFRE|MALOTE|OUTRO`, ativo, saldo, version  
  Unique: `(tenant_id, lower(nome))`
- `pdv_movimento_tesouraria`: ENTRADA/SAIDA, saldo_apos, transferencia_id  
  + `conta_pagar_id` / `forma_pagamento` / `origem` (V20261089)
- `pdv_transferencia`: CAIXA_CONTA, CONTA_CAIXA, CAIXA_CAIXA, CONTA_CONTA, PASSAGEM_TURNO

Entity tipos: `PdvContaTesouraria.Tipo` = BANCO, COFRE, MALOTE, OUTRO (`PdvContaTesouraria.java:25-27`).

### Caixa (turno operacional, não “conta bancária”)

- `pdv_caixa` — foundation ~`V20260600:255+` — turno ABERTO/FECHADO
- `pdv_caixa_terminal` — `V20260715:64+` — catálogo físico
- `pdv_fechamento_caixa`, `pdv_movimento_caixa`

### Pagamentos migrados precisam de conta origem?

| Camada | Obrigatório? |
|--------|----------------|
| DDL `conta_tesouraria_origem_id` | **Nullable** (`V20261089:5`) — sem FK formal no migrate |
| Runtime `ContaPagarService.validarPagamentoTesouraria` `:284-289` | **Sim** — `"Selecione a conta de onde sai o dinheiro."` + forma obrigatória |
| Formas aceitas | DINHEIRO, PIX, DEBITO, CREDITO, TRANSFERENCIA, OUTRO |

**Conclusão migração:** INSERT SQL histórico pode deixar origem null; baixa via API exige conta tesouraria existente. Para títulos já `PAGA`, mapear/criar `pdv_conta_tesouraria` e preencher origem se quiser trilha completa; movimento só é criado pelo serviço de baixa.

---

## 7. Link conta a pagar ↔ nota de entrada

**Sim** — colunas em `finance_conta_pagar` (`V20260771:3-5`):

- `nota_fiscal_entrada_id UUID` — **sem FK** para `nota_fiscal_entrada` (só coluna + índice)
- `numero_duplicata VARCHAR(60)`

Serviço: `NotaEntradaContaPagarService.java`

- `gerarTitulosSeAplicavel` `:54+` — na escrituração, se plano `FINANCEIRO_COMPLETO`, parseia duplicatas do XML → 1 ContaPagar por duplicata
- Skip: BONIFICACAO, DEVOLUCAO_VENDA_FORNECEDOR
- Idempotente: se já existem títulos da nota, devolve existentes
- Resolve fornecedor por CNPJ emitente; se não achar, `fornecedor_id=null` + nome da razão social (`:171-173`)
- `cancelarTitulosAbertosVinculados` cancela abertos da nota

---

## 8. Soft delete fornecedor / cliente

### Fornecedor

- Flag `ativo BOOLEAN NOT NULL DEFAULT TRUE` (`V20260621:10`, entity `:83-84`)
- Desativação via `FornecedorRequest.ativo` / `setAtivo` — **não** há `deleted_at` / `excluido`
- Listagens ativas: `findByTenantIdAndAtivoTrueOrderByNomeAsc`
- Soft delete explícito documentado: **parcial** (flag ativo), sem coluna soft-delete dedicada

### Cliente

- Soft delete documentado — `V20260924__pdv_cliente_ativo.sql:1-9`:

```sql
ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;
-- COMMENT: 'false = desativado (soft delete)...'
```

- `PdvClienteService` `:508` / `:545` → `setAtivo(false)`
- Também existe `PdvClienteExclusaoDefinitivaService` (hard delete path separado)

---

## Resumo rápido para migração

| Pergunta | Resposta |
|----------|----------|
| AP existe? | Sim — `finance_conta_pagar` |
| Parcelas AP? | NÃO ENCONTRADO (1 row = 1 título/duplicata) |
| Baixas AP tabela? | NÃO ENCONTRADO (update in-place + movimento tesouraria) |
| Fornecedor sem doc? | Sim (CNPJ/CPF nullable) |
| Unique CNPJ fornecedor? | NÃO ENCONTRADO no DB |
| CNPJ cliente+fornecedor? | Sim (tabelas distintas) |
| Plano de contas? | NÃO ENCONTRADO |
| Conta origem na baixa runtime? | Obrigatória |
| Conta origem no DDL/migração SQL? | Nullable |
| Link NF entrada? | `nota_fiscal_entrada_id` + `numero_duplicata` (sem FK) |
| Soft delete | Cliente: `ativo=false`; Fornecedor: `ativo=false` (sem `deleted_at`) |