# VENDAS — Migration Schema Report (`margin-engine`)

Path: `/home/caio/projects/margin-engine`

---

## 1. Entity / DDL

### 1.1 `pdv_venda` — CREATE (Flyway)

**File:** `/home/caio/projects/margin-engine/src/main/resources/db/migration/V20260600__schema_foundation.sql:550-586`

```sql
CREATE TABLE IF NOT EXISTS public.pdv_venda (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    numero_venda character varying(30) NOT NULL,
    numero_venda_cliente character varying(50),
    emitido_em timestamp without time zone DEFAULT now() NOT NULL,
    forma_pagamento character varying(20) NOT NULL,
    total numeric(19,4) NOT NULL,
    desconto numeric(19,4) DEFAULT 0 NOT NULL,
    valor_recebido numeric(19,4),
    lucro numeric(19,4) DEFAULT 0 NOT NULL,
    margem numeric(19,4) DEFAULT 0 NOT NULL,
    cpf_cliente character varying(14),
    nome_cliente character varying(120),
    operador character varying(80),
    chave_nfe character varying(44),
    numero_nfe character varying(10),
    serie_nfe character varying(3),
    qrcode_nfe character varying(500),
    status character varying(20) DEFAULT 'CONCLUIDA'::character varying NOT NULL,
    observacao_cancelamento character varying(255),
    cancelado_em timestamp without time zone,
    dispositivo_id bigint,
    caixa_id uuid,
    status_fiscal character varying(30),
    protocolo_nfe character varying(20),
    c_stat_nfe character varying(10),
    x_motivo_nfe character varying(500),
    correlation_id character varying(64),
    emitir_nfce boolean DEFAULT false,
    cnpj_cliente character varying(18),
    crediario_cliente_id uuid,
    origem_venda character varying(20) DEFAULT 'PDV'::character varying NOT NULL,
    modelo_fiscal character varying(2),
    cliente_id uuid,
    CONSTRAINT chk_venda_status CHECK (((status)::text = ANY ((ARRAY['CONCLUIDA'::character varying, 'CANCELADA'::character varying])::text[])))
);
```

**Later ADD COLUMNs (Flyway):**

| Migration | Column | Type |
|---|---|---|
| `V20260708__fiscal_email_automatico.sql` | `fiscal_email_status`, `fiscal_email_enviado_em`, `fiscal_email_erro` | VARCHAR(20) / TIMESTAMP / VARCHAR(500) |
| `V20260715__pdv_caixa_ciclo.sql:54` | `abertura_caixa_id` | UUID → `pdv_caixa(id)` |
| `V20260720__pdv_venda_nfce_cols.sql` | `fiscal_emitido_em`, `fiscal_tentativas` | TIMESTAMP / INTEGER DEFAULT 0 |
| `V20260724__pdv_fiscal_robusto.sql` | `chave_nfce_origem` | VARCHAR(44) |
| `V20260743__pedido_venda.sql:62` | `pedido_id` | UUID |
| `V20260753__pdv_venda_loja_meta_comercial.sql:3` | `loja_id` | UUID → `retail_loja(id)` |
| `V20260762__pdv_venda_acrescimo_ajuste_preco.sql:3` | `acrescimo` | NUMERIC(19,4) NOT NULL DEFAULT 0 |
| `V20260803__pdv_venda_order_engine_order_id.sql:2` | `order_engine_order_id` | UUID |
| `V20260905__estoque_multi_deposito.sql` | `deposito_id` | UUID |
| `V20260908__pdv_venda_dh_recbto.sql:2` | `dh_recbto_nfe` | VARCHAR(50) |
| `V20260986__pdv_venda_data_emissao_nfe.sql:6` | `data_emissao_nfe` | TIMESTAMP NULL |
| `V20261003__pdv_venda_competencia_fiscal_em.sql:5` | `competencia_fiscal_em` | TIMESTAMP NULL |
| `V20261040__fiscal_data_repository_fase0_fase1.sql` | `fiscal_content_version` | TEXT |
| `V20261076__nfe_info_complementar_transporte.sql` | `informacoes_complementares`, `transporte_*` | TEXT / SMALLINT / NUMERIC / VARCHAR |

Note: `fiscal_emitir_automatico` was added in `V20260720` and **dropped** in `V20260721__drop_fiscal_emitir_automatico.sql`.

**Entity:** `/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/model/PdvVenda.java` (mirrors above + `@OneToMany` itens/pagamentos). Unique: `(tenant_id, numero_venda)` via `V20260843__tenant_scoped_sale_numbers.sql`.

---

### 1.2 `pdv_item_venda` — CREATE (Flyway)

**File:** `V20260600__schema_foundation.sql:437-455`

```sql
CREATE TABLE IF NOT EXISTS public.pdv_item_venda (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    venda_id uuid NOT NULL,
    produto_id character varying(50),
    codigo character varying(50) NOT NULL,
    nome character varying(120) NOT NULL,
    quantidade numeric(19,4) NOT NULL,
    preco_unitario numeric(19,4) NOT NULL,
    custo_unitario numeric(19,4) DEFAULT 0 NOT NULL,
    margem numeric(19,4) DEFAULT 0 NOT NULL,
    total numeric(19,4) NOT NULL,
    por_peso boolean DEFAULT false NOT NULL,
    ncm character varying(10),
    cfop character varying(6),
    cst character varying(4),
    aliquota_icms numeric(19,4),
    desconto_item numeric(19,4) DEFAULT 0 NOT NULL,
    preco_original numeric(19,4)
);
```

**Later ADD COLUMNs:** `categoria`, `unidade`, `csosn`, `cest`, `c_class_trib`, `acrescimo_item`, `preco_alterado_manual`, `apresentacao_venda_id`, `fator_para_estoque`, `quantidade_estoque`, `gtin_comercial`, `pis_cofins_classificacao`, `valor_icms_st`, `aliquota_icms_efetiva`, `reducao_bc_icms_efetiva`.

**Entity:** `PdvItemVenda.java` (`/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/model/PdvItemVenda.java`).

FK: `pdv_item_venda_venda_id_fkey` → `pdv_venda(id) ON DELETE CASCADE` (`V20260600:2254`).

---

### 1.3 `pdv_venda_pagamento` — CREATE (Flyway)

**File:** `V20260600__schema_foundation.sql:612-621`

```sql
CREATE TABLE IF NOT EXISTS public.pdv_venda_pagamento (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    venda_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    forma character varying(30) NOT NULL,
    valor numeric(19,4) NOT NULL,
    troco numeric(19,4) DEFAULT 0 NOT NULL,
    referencia character varying(100),
    registrado_em timestamp without time zone DEFAULT now() NOT NULL
);
```

**Later:** `numero_parcelas INT`, `bandeira VARCHAR(40)` — `V20260915__pdv_maquina_cartao_taxa.sql:27`.

**Entity:** `PdvVendaPagamento.java` — `forma` is `@Enumerated(STRING) PaymentType` (lines 48-50).

FK: `pdv_venda_pagamento_venda_id_fkey` → `pdv_venda(id) ON DELETE CASCADE` (`V20260600:2294`).

---

### 1.4 Parcelas — `pdv_crediario_parcela`

**CREATE:** `V20260600__schema_foundation.sql:335-351` (also re-created/aligned in `V20260630__crediario_integracao.sql:34-50`).

```sql
CREATE TABLE IF NOT EXISTS public.pdv_crediario_parcela (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    crediario_id uuid NOT NULL,
    venda_id uuid,                    -- nullable
    numero_parcela smallint NOT NULL,
    total_parcelas smallint NOT NULL,
    valor numeric(19,4) NOT NULL,
    valor_pago numeric(19,4) DEFAULT 0 NOT NULL,
    vencimento date NOT NULL,
    pago_em timestamp without time zone,
    forma_pagamento character varying(30),
    status character varying(20) DEFAULT 'ABERTA' NOT NULL,
    observacao character varying(255),
    criado_em / atualizado_em ...
);
```

**Entity:** `PdvCrediarioParcela.java` — status docs: `ABERTA | PAGA | ATRASADA | CANCELADA` (line 84). Later also `crediario_conta_id`, `recebido_por` (entity lines 53-55, 91-92).

**Also (not PDV sale installments):** `pdv_orcamento_parcela` (`V20261058`), CIAP parcelas — unrelated to PDV checkout.

---

## 2. Enums / string domains

### Status venda (`pdv_venda.status`)
- DB CHECK: `CONCLUIDA` | `CANCELADA` — `V20260600:585`
- Entity default `"CONCLUIDA"` — `PdvVenda.java:159-160`

### Status fiscal (`pdv_venda.status_fiscal`) — string, no DB enum
Documented on entity (`PdvVenda.java:122-124`):
`PENDENTE | AUTORIZADA | REJEITADA | CANCELADA | INUTILIZADA | CONTINGENCIA_EPEC`

Also written as **`PENDENTE_FISCAL`** when NFC-e requested but fiscal data incomplete (`PdvVendaService.java:1561-1562`).

### Forma pagamento
**Enum `PaymentType`** — `PaymentType.java:9-21`:
`DINHEIRO`, `CARTAO_CREDITO`, `CARTAO_DEBITO`, `PIX`, `FIADO`, `CREDIARIO`, `VOUCHER`, `TRANSFERENCIA`

Front aliases (`PdvVendaPagamentoUtil.java:128-147`): `dinheiro`, `pix`/`asaas_pix`, `debito`/`cartao_debito`, `credito`/`cartao_credito`, `fiado`, `voucher`, `crediario`, `transferencia`.

Header summary on venda (`forma_pagamento` VARCHAR): single form (lowercase) or **`MISTO`** (`PdvVendaPagamentoUtil.java:162-170`).

Card installment count lives on **payment row** `numero_parcelas`, not a separate parcelas table (except CREDIARIO → `pdv_crediario_parcela`).

### Origem / tipo (`origem_venda`)
VARCHAR(20), **no CHECK constraint**. Known values set in code:
| Value | Where |
|---|---|
| `PDV` (default) | `PdvVenda.java:211`, DDL default |
| `PAINEL_NFE` | `PdvNfeService.java:517` |
| `ORDER_ONLINE` | `PdvVendaService.java:437` (Order Engine faturamento) |

Pedidos use `numero_venda_cliente` prefixes `PEDIDO-` / `ORDER-` (`FaturarPedidoPrecoAlinhamento.java:29`) but **do not** set a dedicated `origem_venda` unless via `VinculoFaturamento`.

### Canal
**NÃO ENCONTRADO** as column on `pdv_venda`. Closest: `CrediarioCobrancaCanal.WHATSAPP` (crediário cobrança only). Order Engine has its own order origin, not copied to `pdv_venda.canal`.

### Fiscal vs non-fiscal markers
| Field | Role |
|---|---|
| `emitir_nfce` BOOLEAN | Intent to emit NFC-e; gates `VendaFinalizadaEvent` |
| `status_fiscal` | Lifecycle of fiscal doc |
| `modelo_fiscal` | `'65'` NFC-e / `'55'` NF-e after auth (`PdvVenda.java:213-215`) |
| `chave_nfe`, `numero_nfe`, `serie_nfe`, `protocolo_nfe`, … | Authorization payload |
| `origem_venda = 'PAINEL_NFE'` | NF-e painel path (treated as fiscal in queries) |

Non-fiscal sale: `emitir_nfce=false` and `status_fiscal` null (typical PDV cupom-less).

### Parcela status
`ABERTA | PAGA | ATRASADA | CANCELADA` (+ motor also uses `RENEGOCIADA` in filters).

---

## 3. Required FKs — nullability (historical sales)

| FK / link | Column | Nullable? | FK constraint |
|---|---|---|---|
| Tenant | `tenant_id` | **NOT NULL** | (app-level; TenantScopedEntity) |
| Cliente | `cliente_id` | **YES** | → `pdv_cliente(id)` `V20260600:2270` / `V20260707:87` |
| Crediário conta | `crediario_cliente_id` | **YES** | → `pdv_crediario_cliente(id)` |
| Caixa / turno | `caixa_id` | **YES** | → `pdv_caixa(id)` `V20260600:2262` |
| Abertura caixa | `abertura_caixa_id` | **YES** | → `pdv_caixa(id)` `V20260715:54` |
| Loja | `loja_id` | **YES** | → `retail_loja(id)` `V20260753:3` |
| Depósito | `deposito_id` | **YES** (DB) | added `V20260905` |
| Dispositivo | `dispositivo_id` | **YES** | no FK in foundation |
| Pedido | `pedido_id` | **YES** | no FK in migration snippet |
| Order Engine | `order_engine_order_id` | **YES** | no FK |
| **Vendedor** | — | **NÃO ENCONTRADO** on `pdv_venda` | use `operador` VARCHAR(80) |

**Runtime create path** (`gravarVendaInterno`):
- Resolves `loja_id` via `PdvLojaResolverService`; **requires loja if multi-loja** (`exigirSeMultiLoja`) — `PdvVendaService.java:1415-1416`.
- Always resolves `deposito_id` via `depositoEstoqueService.resolveForOperacao` — `1417-1419`.
- Caixa: required only if `caixaCicloService.exigirAbertura(tenant)` — else optional (`656-661`). Online-paid Order Engine can have `caixa=null` (`417-419`).
- Cliente: optional; linked by CPF/CNPJ or crediário (`vincularClienteCentral` `2153-2191`).

**For historical migrated sales (recommendation from schema):**
- Leave `caixa_id` / `abertura_caixa_id` / `dispositivo_id` **NULL**.
- Set `loja_id` if tenant is multi-loja (reports/DRE filter by loja); else NULL OK.
- Set `deposito_id` only if you also want stock movements; otherwise NULL + **do not** call stock APIs.
- `cliente_id` NULL unless you map customers.
- Put seller name in `operador` (string).
- Set `emitido_em` to historical timestamp (column NOT NULL; default `now()` only if omitted).
- `status='CONCLUIDA'`, `emitir_nfce=false`, `status_fiscal` NULL (unless importing authorized fiscal docs).

---

## 4. Side effects on create (`PdvVendaService.gravarVendaInterno`)

Main entry: `registrar` → `gravarVendaInterno` — `PdvVendaService.java:636+`, core body `1400-1788`.

### In-transaction service calls (order)

1. **Cart resolve** — `apresentacaoVendaService.resolverCarrinhoParaVenda` (loads products)
2. **Stock pre-check** (skipped if `syncOffline`) — `validarEstoqueAntesDaVenda`
3. **Promo validation** (skipped if `syncOffline`) — `promocaoCheckoutValidacaoService.validarPromocoesVenda`
4. **Payment normalize/validate** — `PdvVendaPagamentoUtil`
5. **Cliente link** — `vincularClienteCentral` (may create client via `criarOuAtualizarRapido`)
6. **Inadimplência check** — `crediarioMotorService.isClienteInadimplente`
7. **Fiscal readiness** (if `emitirNfce`) — `fiscalService.avaliarDadosFiscaisVenda` → sets `status_fiscal`
8. **Fiscal content stamp** — `fiscalContentVersionService.carimbarVenda`
9. **Idempotency lock** — `idempotenciaService.lock` (if `numero_venda_cliente`)
10. **`vendaRepository.save` + flush** — persists venda + itens (cascade)
11. **Client totals / RFM** — `segmentacaoService.atualizarClienteAposVenda` (`PdvClienteSegmentacaoService.java:131`) — updates `total_compras_*`, scores, `segmento`
12. **Payments** — `pagamentoRepository.saveAll`
13. **Finance conciliation** — `pagamentoConciliacaoService.registrarDePagamentos` → rows in `pagamento_conciliacao`
14. **Asaas** — `pdvAsaasPaymentService.consumePaidReferences`
15. **Crediário** — `processarCrediario` → `crediarioService.gerarParcelas` (only if payment form CREDIARIO)
16. **Stock** — `produtoService.baixarEstoqueEmLote` (+ padaria MP `padariaEstoqueVendaService.baixarMateriasPrimasPorItensVenda`)
17. **Açougue analytics** — `alimentarMarginEngine` → `sale_entry` (skipped if `tenant.isRetailErpEnabled()`)
18. **Promo applications** — `promocaoService.registrarAplicacoesVenda`
19. **Comissões + cache** — `finalizarPosVenda` → `comissaoService.registrarPosVenda` + `cacheInvalidation.evictAnalyticsVenda`
20. **Auditoria (after commit)** — `agendarAuditoriaAposCommit` → `auditoriaService.registrarVenda` (+ ajustes)
21. **Order Engine reconcile** — `orderEngineOfflineSaleReconciler.reconcileIfOrderEngineSale`
22. **Event** — if `!syncOffline && emitirNfce`: `eventPublisher.publishEvent(new VendaFinalizadaEvent(...))` — `1778-1785`

**Caixa movimento:** sales are **not** inserted into `pdv_movimento_caixa` on create; caixa fechamento **queries** `pdv_venda` by `caixa_id` (`PdvCaixaCicloService` ~VENDA listing). Linking `caixa_id` is enough for caixa totals.

### Event listeners

| Listener | Annotation | Event | Effect |
|---|---|---|---|
| `VendaFinalizadaFiscalListener.java:37-39` | `@TransactionalEventListener(AFTER_COMMIT)` + `@Async` | `VendaFinalizadaEvent` | If `emitirNfce` and flag off: `fiscalService.registrarIntencaoEmissaoVenda` (NFC-e job) |
| `FiscalDocumentoEmailService.java:57` | `@EventListener` | `FiscalDocumentoAutorizadoEvent` | Email after auth (**not** on create) |
| `FiscalIbsCbsDebitoListener.java:56` | `@TransactionalEventListener(AFTER_COMMIT)` | `FiscalDocumentoAutorizadoEvent` | IBS/CBS ledger after auth |
| `FiscalEmissionGatewayListener.java:53` | `@TransactionalEventListener(AFTER_COMMIT)` | `FiscalJobCriadoEvent` | Dispatches fiscal job |

**`@PostPersist` on venda entities:** **NÃO ENCONTRADO**.

**Fidelidade / loyalty points on sale:** **NÃO ENCONTRADO**.

**WhatsApp on sale create:** **NÃO ENCONTRADO**. WhatsApp is post-authorization (`FiscalDocumentoWhatsAppService`) / crediário / orçamento — not in `gravarVendaInterno`.

**Outbox for vendas:** **NÃO ENCONTRADO** (outbox exists for balança carga only).

**DRE:** **read-time** from `pdv_venda` (`PdvRelatorioErpService.gerarDre`, `PdvDreConsolidadoService`, `DreOperacionalEnricher`). Inserting rows makes them appear in DRE; no write side-effect on create beyond cache evict.

### How to INSERT without triggering side effects

1. **Raw SQL / JDBC bulk INSERT** into `pdv_venda`, `pdv_item_venda`, `pdv_venda_pagamento` — bypasses JPA service entirely (no listeners on entity).
2. **Do not** call `PdvVendaService.registrar` / `gravarVendaInterno`.
3. If somehow using service: there is **no** dedicated `skipSideEffects` / `migracao` flag.
   - `emitirNfce=false` → skips `VendaFinalizadaEvent` / fiscal job.
   - `syncOffline=true` → skips stock pre-check & promo validation & fiscal event, but **still** baixas estoque, comissão, segmentação, conciliação, etc.
4. After raw insert, optionally run `PdvClienteSegmentacaoService.recalcularTenant` if you want client totals consistent (job already rebuilds from `pdv_venda`).

---

## 5. Product mapping columns (`pdv_produto`)

| Column | Purpose | Source |
|---|---|---|
| `codigo` VARCHAR(50) NOT NULL | SKU interno / cProd (primary business code) | foundation + `PdvProduto.java:48-49` |
| `ean_fabricante` VARCHAR(14) | GTIN/EAN fabricante (scan / cEAN) | `V20260863`, entity:54-57 |
| `codigo_plu` VARCHAR(10) | PLU balança | foundation + entity:78 |
| `produto_global_id` UUID | Optional link to global GTIN catalog | entity:61-62 |
| Apresentação: `gtin_comercial`, `codigo_comercial` | Commercial pack barcodes | `produto_apresentacao_venda` |

**NÃO ENCONTRADO:** `codigo_interno`, `codigo_legado`, `external_id`, `codigo_externo` on `pdv_produto`.

**Legacy product code mapping for migration:** map legacy SKU → `pdv_produto.codigo` (unique per tenant). Optional EAN → `ean_fabricante`. Sale item snapshots `codigo` + `produto_id` (UUID string) on `pdv_item_venda`.

---

## 6. Missing / inactive product on sale items

| Path | Behavior | Cite |
|---|---|---|
| **Checkout `resolverCarrinhoParaVenda`** | Invalid UUID → 400; product not in tenant → **404 `"Produto não encontrado"`** | `ProdutoApresentacaoVendaService.java:398-404` |
| **Inactive check on checkout** | **Not enforced** — loads via `findByTenantIdAndIdIn` (no `ativo` filter). Inactive product **can** be sold if `produtoId` is sent | `365-404` |
| **Scan / PDV lookup** | Only `...AndAtivoTrue`; inactive / pending review → `ScanResponse.naoEncontrado` | `PdvScanService.java:103-147` |
| **Apresentação inactive** | Lookup uses `AtivoTrue`; unknown apresentação → 400 | `417-419` |
| Device flag | `aviso_obrigatorio_produto_nao_cadastrado` on `pdv_dispositivo` — UX for unregistered scan, not sale persist | foundation:370 |

Items **must** have resolvable `produtoId` UUID; snapshot fields (`codigo`, `nome`, prices) are still required on the item row.

---

## 7. Vendedor table and link

| Concept | Finding |
|---|---|
| Dedicated `vendedor` table | **NÃO ENCONTRADO** |
| On `pdv_venda` | **NÃO ENCONTRADO** `vendedor_id` — only `operador` VARCHAR(80) |
| Pedido path | `pedido_venda.vendedor_id UUID NOT NULL` → user (`V20260743__pedido_venda.sql:8`) |
| Users | `users.seller_id`, `users.persona` (`V20260744__user_persona_seller.sql`) |
| Comissões | `comissao_lancamento.vendedor` VARCHAR(80) from `venda.getOperador()` (`ComissaoService.java:164`) |
| Metas | `pdv_meta_comercial.vendedor_id` VARCHAR(120) (`V20260757`) |

**For migration:** store seller identity in `pdv_venda.operador` (name/login). Pedido→venda does not copy `vendedor_id` onto the sale entity.

---

## 8. `origem=LEGADO` / migração / import flag

**NÃO ENCONTRADO** as first-class migration flag.

- No `LEGADO`, `MIGRACAO`, or `IMPORT` value written to `origem_venda` in Java sale paths.
- Documented/used values: `PDV`, `PAINEL_NFE`, `ORDER_ONLINE`.
- Column is free VARCHAR(20) — you *could* invent `LEGADO`/`MIGRACAO` for reporting, but nothing in the app currently branches on it.
- Idempotency key `numero_venda_cliente` can hold legacy sale numbers (unique per tenant when not null — `idx_pdv_venda_cliente_idempotencia`).

---

## Quick migration checklist

1. Map products by `pdv_produto.codigo` (+ optional `ean_fabricante`).
2. Raw INSERT `pdv_venda` / `pdv_item_venda` / `pdv_venda_pagamento` with historical `emitido_em`.
3. `status='CONCLUIDA'`, `origem_venda='PDV'` or custom, `emitir_nfce=false`.
4. Nullable: `cliente_id`, `caixa_id`, `loja_id` (set loja if multi-loja), `dispositivo_id`.
5. Skip service path to avoid stock, comissão, fiscal, Asaas, segmentação increments (recalc segmentação later if needed).
6. CREDIARIO only if you also insert `pdv_crediario_parcela` / update saldo.
7. DRE/analytics will pick up rows automatically on next report query.