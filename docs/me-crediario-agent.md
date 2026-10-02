# Relatório de schema — domínio CREDIÁRIO (`pdv_crediario_*`)

Fonte: `/home/caio/projects/margin-engine` (somente leitura).

---

## 1. Flyway migrations que CREATE/ALTER `pdv_crediario_*`

### Inventário completo

| Arquivo | Ação |
|---|---|
| `V20260600__schema_foundation.sql` | CREATE `pdv_crediario_cliente`, `pdv_crediario_parcela` + function/trigger `saldo_devedor` |
| `V20260630__crediario_integracao.sql` | CREATE IF NOT EXISTS cliente/parcela (shape legado com `cliente_nome`/`cliente_cpf`) |
| `V20260705__cliente_nfe_venda_painel.sql` | ALTER `pdv_crediario_cliente` (cols fiscais) |
| `V20260707__pdv_cliente_central.sql` | ALTER: `cliente_id` FK; DROP cols de identidade |
| `V20260714__pdv_crediario_motor.sql` | ALTER cliente; CREATE conta/recebimento/renegociacao; ALTER parcela |
| `V20260867__pdv_crediario_encargos.sql` | ALTER cliente (carência/modo/periodicidade); CREATE encargo |
| `V20260868__pdv_crediario_cobranca_evento.sql` | CREATE cobranca_evento |
| `V20260903__cobranca_whatsapp_assistido_e164.sql` | ALTER status CHECK (+`AGUARDANDO_CONFIRMACAO`) |
| `V20260906__widen_cobranca_status.sql` | ALTER `status` VARCHAR(40) |
| `V20261080__crediario_modo_aplicacao_automatico_legado.sql` | UPDATE legado `AUTOMATICO`→`SUGESTAO` + CHECK |

Referências FK apenas (sem CREATE/ALTER da tabela crediário): `V20260759__finance_desconto_titulo.sql`, `V20260870__cobranca_evento.sql` (comentário).

---

### `V20260600__schema_foundation.sql` — CREATE + trigger

```318:351:/home/caio/projects/margin-engine/src/main/resources/db/migration/V20260600__schema_foundation.sql
CREATE TABLE IF NOT EXISTS public.pdv_crediario_cliente (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    limite_credito numeric(19,4) DEFAULT 500.00 NOT NULL,
    saldo_devedor numeric(19,4) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'ATIVO'::character varying NOT NULL,
    observacao character varying(255),
    criado_em timestamp without time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp without time zone DEFAULT now() NOT NULL,
    cliente_id uuid
);

CREATE TABLE IF NOT EXISTS public.pdv_crediario_parcela (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    crediario_id uuid NOT NULL,
    venda_id uuid,
    numero_parcela smallint NOT NULL,
    total_parcelas smallint NOT NULL,
    valor numeric(19,4) NOT NULL,
    valor_pago numeric(19,4) DEFAULT 0 NOT NULL,
    vencimento date NOT NULL,
    pago_em timestamp without time zone,
    forma_pagamento character varying(30),
    status character varying(20) DEFAULT 'ABERTA'::character varying NOT NULL,
    observacao character varying(255),
    criado_em timestamp without time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp without time zone DEFAULT now() NOT NULL
);
```

Trigger de saldo (mesmo arquivo):

```51:66:/home/caio/projects/margin-engine/src/main/resources/db/migration/V20260600__schema_foundation.sql
CREATE OR REPLACE FUNCTION public.fn_atualiza_saldo_crediario() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

```1990:1990:/home/caio/projects/margin-engine/src/main/resources/db/migration/V20260600__schema_foundation.sql
CREATE TRIGGER trg_saldo_crediario AFTER INSERT OR DELETE OR UPDATE ON public.pdv_crediario_parcela FOR EACH ROW EXECUTE FUNCTION public.fn_atualiza_saldo_crediario();
```

---

### `V20260630__crediario_integracao.sql` — CREATE legado

```3:50:/home/caio/projects/margin-engine/src/main/resources/db/migration/V20260630__crediario_integracao.sql
CREATE TABLE IF NOT EXISTS pdv_crediario_cliente (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    cliente_nome VARCHAR(120) NOT NULL,
    cliente_cpf VARCHAR(14),
    cliente_telefone VARCHAR(20),
    limite_credito NUMERIC(19, 4) NOT NULL DEFAULT 500.0000,
    saldo_devedor NUMERIC(19, 4) NOT NULL DEFAULT 0.0000,
    status VARCHAR(20) NOT NULL DEFAULT 'ATIVO',
    observacao VARCHAR(255),
    criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
);
-- ... indexes ...
CREATE TABLE IF NOT EXISTS pdv_crediario_parcela (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    crediario_id UUID NOT NULL REFERENCES pdv_crediario_cliente(id),
    venda_id UUID,
    numero_parcela SMALLINT NOT NULL,
    total_parcelas SMALLINT NOT NULL,
    valor NUMERIC(19, 4) NOT NULL,
    valor_pago NUMERIC(19, 4) NOT NULL DEFAULT 0.0000,
    vencimento DATE NOT NULL,
    pago_em TIMESTAMP,
    forma_pagamento VARCHAR(30),
    status VARCHAR(20) NOT NULL DEFAULT 'ABERTA',
    observacao VARCHAR(255),
    criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

### `V20260714__pdv_crediario_motor.sql` (pedido especial) — FULL

```1:109:/home/caio/projects/margin-engine/src/main/resources/db/migration/V20260714__pdv_crediario_motor.sql
-- PROMPT 7 — Motor de crediário: conta, recebimento, renegociação e configuração por cliente

ALTER TABLE pdv_crediario_cliente
    ADD COLUMN IF NOT EXISTS dia_vencimento INTEGER NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS max_parcelas INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS motivo_bloqueio TEXT,
    ADD COLUMN IF NOT EXISTS aprovado_por VARCHAR(120),
    ADD COLUMN IF NOT EXISTS aprovado_em TIMESTAMP,
    ADD COLUMN IF NOT EXISTS juros_atraso_percentual_mes NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS multa_atraso_percentual NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS dias_bloqueio_inadimplencia INTEGER NOT NULL DEFAULT 30;

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
-- indexes ...
ALTER TABLE pdv_crediario_parcela
    ADD COLUMN IF NOT EXISTS crediario_conta_id UUID REFERENCES pdv_crediario_conta(id),
    ADD COLUMN IF NOT EXISTS recebido_por VARCHAR(120);
-- ...
CREATE TABLE IF NOT EXISTS pdv_crediario_recebimento (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    crediario_parcela_id UUID NOT NULL REFERENCES pdv_crediario_parcela(id),
    crediario_conta_id UUID NOT NULL REFERENCES pdv_crediario_conta(id),
    valor_recebido NUMERIC(19, 4) NOT NULL,
    forma_pagamento VARCHAR(30) NOT NULL,
    data_recebimento TIMESTAMP NOT NULL DEFAULT NOW(),
    recebido_por VARCHAR(120) NOT NULL,
    observacoes TEXT,
    criado_em TIMESTAMP NOT NULL DEFAULT NOW()
);
-- ...
CREATE TABLE IF NOT EXISTS pdv_crediario_renegociacao (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    crediario_conta_id UUID NOT NULL REFERENCES pdv_crediario_conta(id),
    parcelas_originais JSONB NOT NULL,
    novo_valor_total NUMERIC(19, 4) NOT NULL,
    motivo TEXT,
    aprovado_por VARCHAR(120) NOT NULL,
    criado_em TIMESTAMP NOT NULL DEFAULT NOW()
);
-- backfill numero_conta legado: 'CC-LEG-' || first 12 hex of venda_id
```

---

### `V20260867__pdv_crediario_encargos.sql` — FULL

```1:32:/home/caio/projects/margin-engine/src/main/resources/db/migration/V20260867__pdv_crediario_encargos.sql
-- Crediário B1: carência de encargos, modo de aplicação e trilha pdv_crediario_encargo
ALTER TABLE pdv_configuracao
    ADD COLUMN IF NOT EXISTS crediario_dias_carencia_juros INTEGER NOT NULL DEFAULT 7,
    ADD COLUMN IF NOT EXISTS crediario_dias_carencia_multa INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS crediario_modo_aplicacao_encargos VARCHAR(40) NOT NULL DEFAULT 'SUGESTAO',
    ADD COLUMN IF NOT EXISTS crediario_multa_atraso_percent NUMERIC(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS crediario_periodicidade VARCHAR(20) NOT NULL DEFAULT 'MENSAL';

ALTER TABLE pdv_crediario_cliente
    ADD COLUMN IF NOT EXISTS dias_carencia_juros INTEGER,
    ADD COLUMN IF NOT EXISTS dias_carencia_multa INTEGER,
    ADD COLUMN IF NOT EXISTS modo_aplicacao_encargos VARCHAR(40),
    ADD COLUMN IF NOT EXISTS periodicidade VARCHAR(20);

CREATE TABLE IF NOT EXISTS pdv_crediario_encargo (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    parcela_id UUID NOT NULL REFERENCES pdv_crediario_parcela(id),
    tipo VARCHAR(16) NOT NULL,
    valor NUMERIC(19, 4) NOT NULL,
    data_calculo DATE NOT NULL,
    data_referencia_atraso DATE NOT NULL,
    criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_crediario_encargo_tipo CHECK (tipo IN ('JUROS', 'MULTA')),
    CONSTRAINT chk_crediario_encargo_valor CHECK (valor >= 0)
);
```

---

### `V20260868__pdv_crediario_cobranca_evento.sql` — FULL

```4:25:/home/caio/projects/margin-engine/src/main/resources/db/migration/V20260868__pdv_crediario_cobranca_evento.sql
CREATE TABLE IF NOT EXISTS pdv_crediario_cobranca_evento (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID         NOT NULL,
    parcela_id          UUID         NOT NULL REFERENCES pdv_crediario_parcela (id),
    cliente_id          UUID         NOT NULL REFERENCES pdv_cliente (id),
    canal               VARCHAR(20)  NOT NULL DEFAULT 'WHATSAPP',
    template_key        VARCHAR(40)  NOT NULL,
    status              VARCHAR(20)  NOT NULL DEFAULT 'PENDENTE',
    provider_message_id VARCHAR(120),
    erro                TEXT,
    agendado_para        TIMESTAMP,
    enviado_em           TIMESTAMP,
    idempotency_key     VARCHAR(180) NOT NULL,
    data_referencia     DATE         NOT NULL,
    criado_em           TIMESTAMP    NOT NULL DEFAULT NOW(),
    atualizado_em       TIMESTAMP    NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_pdv_crediario_cobranca_idempotency UNIQUE (idempotency_key),
    CONSTRAINT ck_pdv_crediario_cobranca_canal CHECK (canal = 'WHATSAPP'),
    CONSTRAINT ck_pdv_crediario_cobranca_status CHECK (
        status IN ('PENDENTE', 'ENVIADO', 'FALHA', 'CANCELADO')
    )
);
```

---

### `V20261080__crediario_modo_aplicacao_automatico_legado.sql` — ALTER relevante

```43:67:/home/caio/projects/margin-engine/src/main/resources/db/migration/V20261080__crediario_modo_aplicacao_automatico_legado.sql
UPDATE pdv_crediario_cliente
   SET modo_aplicacao_encargos = 'SUGESTAO'
 WHERE modo_aplicacao_encargos IS NOT NULL
   AND upper(modo_aplicacao_encargos) = 'AUTOMATICO';
-- ... idem pdv_configuracao ...
ALTER TABLE pdv_crediario_cliente
    ADD CONSTRAINT chk_crediario_cliente_modo_aplicacao
    CHECK (
        modo_aplicacao_encargos IS NULL
        OR modo_aplicacao_encargos IN ('SUGESTAO', 'OBRIGATORIO_NO_RECEBIMENTO')
    );
```

### Outros ALTERs (resumo)

- **V20260705** `3:16` — ADD `tipo_pessoa`, `cliente_cnpj`, endereço/IE, etc.
- **V20260707** `32:33` ADD `cliente_id`; `122:138` DROP cols de identidade migradas para `pdv_cliente`.
- **V20260903** — amplia CHECK status cobranca com `AGUARDANDO_CONFIRMACAO`.
- **V20260906** — `status` → `VARCHAR(40)`.

---

## 2. Enums Java relacionados

### `ModoAplicacaoEncargoCrediario` — FULL

```10:13:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/model/ModoAplicacaoEncargoCrediario.java
public enum ModoAplicacaoEncargoCrediario {
    SUGESTAO,
    OBRIGATORIO_NO_RECEBIMENTO
}
```

### `TipoEncargoCrediario` — FULL

```3:6:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/model/TipoEncargoCrediario.java
public enum TipoEncargoCrediario {
    JUROS,
    MULTA
}
```

### `CrediarioCobrancaCanal` — FULL

```4:6:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/model/CrediarioCobrancaCanal.java
public enum CrediarioCobrancaCanal {
    WHATSAPP
}
```

### `CrediarioCobrancaEventoStatus` — FULL

```3:10:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/model/CrediarioCobrancaEventoStatus.java
public enum CrediarioCobrancaEventoStatus {
    PENDENTE,
    /** Evolution/Z-API: pendência sinalizada — operador deve confirmar envio. */
    AGUARDANDO_CONFIRMACAO,
    ENVIADO,
    FALHA,
    CANCELADO
}
```

### `PaymentType` (forma de pagamento / quitação)

```9:21:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/model/PaymentType.java
public enum PaymentType {
    DINHEIRO,
    CARTAO_CREDITO,
    CARTAO_DEBITO,
    PIX,
    FIADO,
    CREDIARIO,
    VOUCHER,
    TRANSFERENCIA
}
```

### Periodicidade — **NÃO É enum Java**

Constante em record:

```9:19:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/model/PoliticaCobrancaCrediario.java
public record PoliticaCobrancaCrediario(
        Integer diaVencimento,
        String periodicidade,
        ...
        ModoAplicacaoEncargoCrediario modoAplicacao) {
    public static final String PERIODICIDADE_MENSAL = "MENSAL";
}
```

Campo em entidade: `PdvCrediarioCliente.periodicidade` (`String`, coluna `periodicidade`).

### Status cliente / conta / parcela — **NÃO há enums Java dedicados**

São `String` nas entidades. Valores documentados/usados:

| Domínio | Valores observados no código |
|---|---|
| Cliente | `ATIVO`, `BLOQUEADO` |
| Conta | `ABERTA`, `PAGA`, `PARCIALMENTE_PAGA`, `VENCIDA`, `RENEGOCIADA`, `CANCELADA` (`PdvCrediarioConta:56`) |
| Parcela (DB) | `ABERTA`, `PAGA`, `ATRASADA`, `CANCELADA`, `RENEGOCIADA` |
| Parcela (API display) | `PENDENTE`/`VENCIDA`/`PARCIALMENTE_PAGA` via `mapStatusApi` |

`CrediarioStatusLabels` só traduz strings (não é enum).

`CrediarioCobrancaTemplateKey` — classe utilitária com constantes `LEMBRETE_D-3`, `VENCIMENTO_D0`, `ATRASO_D+{n}` (não enum).

---

## 3. Entity fields / `@Column` / FK venda / `numero_conta`

### `PdvCrediarioCliente` → `pdv_crediario_cliente`

| Campo Java | Mapping |
|---|---|
| `id` | `@Id` UUID |
| `cliente` | `@ManyToOne` `@JoinColumn(name="cliente_id")` → `PdvCliente` |
| `limiteCredito` | `limite_credito` |
| `saldoDevedor` | `saldo_devedor` |
| `status` | `status` (String, default `ATIVO`) |
| `observacao` | `observacao` |
| `diaVencimento` | `dia_vencimento` |
| `maxParcelas` | `max_parcelas` |
| `motivoBloqueio` | `motivo_bloqueio` |
| `aprovadoPor` / `aprovadoEm` | `aprovado_por` / `aprovado_em` |
| `jurosAtrasoPercentualMes` | `juros_atraso_percentual_mes` |
| `multaAtrasoPercentual` | `multa_atraso_percentual` |
| `diasBloqueioInadimplencia` | `dias_bloqueio_inadimplencia` (default 30) |
| `diasCarenciaJuros/Multa` | `dias_carencia_juros` / `dias_carencia_multa` |
| `modoAplicacaoEncargos` | `modo_aplicacao_encargos` (+ converter) |
| `periodicidade` | `periodicidade` |
| `criadoEm` / `atualizadoEm` | `criado_em` / `atualizado_em` |
| `tenantId` | herdado de `TenantScopedEntity` |

### `PdvCrediarioConta` → `pdv_crediario_conta`

| Campo | Mapping |
|---|---|
| `crediarioCliente` | `@JoinColumn(name="crediario_cliente_id")` |
| `vendaId` | `venda_id` (**UUID simples**, FK SQL → `pdv_venda(id)`; **sem** `@ManyToOne`) |
| `numeroConta` | `numero_conta` |
| `valorTotal` / `valorPago` / `valorPendente` | cols homônimas |
| `status` | String default `ABERTA` |
| `dataVenda`, `observacoes`, timestamps | |

### `PdvCrediarioParcela` → `pdv_crediario_parcela`

| Campo | Mapping |
|---|---|
| `crediario` | `@JoinColumn(name="crediario_id")` |
| `conta` | `@JoinColumn(name="crediario_conta_id")` |
| `vendaId` | `venda_id` (**UUID**, FK SQL → `pdv_venda`; sem `@ManyToOne`) |
| `numeroParcela` / `totalParcelas` | `numero_parcela` / `total_parcelas` |
| `valor` / `valorPago` | |
| `vencimento`, `pagoEm` | |
| `formaPagamento` | `@Enumerated(STRING)` `PaymentType` |
| `status` | String default `ABERTA` |
| `observacao`, `recebidoPor` | |

### `PdvCrediarioRecebimento` → `pdv_crediario_recebimento`

| Campo | Mapping |
|---|---|
| `parcela` | `@JoinColumn(name="crediario_parcela_id")` |
| `conta` | `@JoinColumn(name="crediario_conta_id")` |
| `valorRecebido` | `valor_recebido` |
| `formaPagamento` | `forma_pagamento` (**String**, não enum) |
| `dataRecebimento`, `recebidoPor`, `observacoes`, `criadoEm` | |

### Geração de `numero_conta`

```126:129:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/service/PdvCrediarioMotorService.java
    public String gerarNumeroConta(UUID tenantId) {
        int ano = LocalDate.now().getYear();
        long seq = contaRepo.countByTenantAndAno(tenantId, ano) + 1;
        return String.format("CC-%d-%06d", ano, seq);
    }
```

Query: `COUNT` onde `EXTRACT(YEAR FROM c.dataVenda) = :ano` (`PdvCrediarioContaRepository:20-25`).

Backfill legado (migration): `CC-LEG-` + 12 primeiros hex do `venda_id` sem hífens.

---

## 4. Como a venda cria crediário (conta + parcelas)

### Decisão: “este pagamento vira crediário”

**Única forma que cria crediário:** `PaymentType.CREDIARIO` (string front `crediario` / `CREDIARIO`).

```2108:2139:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/service/PdvVendaService.java
        private void processarCrediario(UUID tenantId, PdvVenda venda,
                        List<PagamentoVendaRequest> pagamentos,
                        CrediarioParcelaRequest crediario) {
                boolean temCrediario = pagamentos.stream()
                                .anyMatch(p -> PaymentType.CREDIARIO == PdvVendaPagamentoUtil.mapearForma(p.forma()));
                if (!temCrediario) {
                        return;
                }
                // exige crediario.crediarioClienteId
                BigDecimal valorCrediario = pagamentos.stream()
                                .filter(p -> PaymentType.CREDIARIO == PdvVendaPagamentoUtil.mapearForma(p.forma()))
                                .map(p -> BigDecimal.valueOf(p.valor()))
                                .reduce(BigDecimal.ZERO, BigDecimal::add);
                // ...
                crediarioService.gerarParcelas(tenantId, contaId, venda.getId(),
                                valorCrediario, parcelas, primeiroVencto, crediario.supervisorToken());
                venda.setCrediarioClienteId(contaId);
```

Chamado em `PdvVendaService` ~linha **1727** após registrar a venda.

Mapeamento:

```128:137:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/service/PdvVendaPagamentoUtil.java
    public static PaymentType mapearForma(String formaFront) {
        ...
            case "pix", "asaas_pix" -> PaymentType.PIX;
            ...
            case "crediario" -> PaymentType.CREDIARIO;
```

### Criação conta + parcelas

`PdvCrediarioService.gerarParcelas` (`278:348`):

1. Valida status cliente (`ATIVO`, ou `BLOQUEADO` se config permitir), limite, supervisor token.
2. `motorService.criarContaParaVenda(...)` → conta `status="ABERTA"`, `vendaId` setado, `numeroConta` gerado.
3. Loop cria N parcelas com `vendaId`, `conta`, `status` default **`ABERTA`** (não seta explicitamente).
4. `recalcularSaldoDevedor(cliente)`.

### PIX a conferir / aguardando / `PIX_CONFERIR`

**NÃO ENCONTRADO** como forma de pagamento que cria crediário.

Buscado em:
- `src/main/java/com/marginengine/pdv/**` (`PIX_CONFERIR`, `PIX_A_CONFERIR`, `A_CONFERIR`, `a conferir`)
- `PaymentType` / `PdvVendaPagamentoUtil`
- `PdvVendaService.processarCrediario`

`PIX` / `asaas_pix` mapeiam para `PaymentType.PIX` e **não** entram em `processarCrediario`.  
`AGUARDANDO_CONFIRMACAO` existe só em **cobrança WhatsApp** de parcela (`CrediarioCobrancaEventoStatus`), não em pagamento de venda.

---

## 5. `saldo_devedor`, status VENCIDA/ATRASADA, `dias_bloqueio_inadimplencia`

### Atualização de `saldo_devedor`

1. **Trigger SQL** `trg_saldo_crediario` / `fn_atualiza_saldo_crediario`:  
   `SUM(valor - valor_pago)` de parcelas com `status NOT IN ('CANCELADA')`.
2. **Java** também recalcula explicitamente (só `ABERTA`+`ATRASADA`):

```734:742:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/service/PdvCrediarioService.java
    private void recalcularSaldoDevedor(PdvCrediarioCliente cliente) {
        // ABERTA + ATRASADA → sum(saldoRestante) → setSaldoDevedor + save
    }
```

(Idem em `PdvCrediarioMotorService:785-793`.)

Comentário do service (`:55`) diz “mantido por trigger; aqui apenas lemos”, mas o código **também escreve**.

### `ATRASADA` vs `VENCIDA`

| Onde | Comportamento |
|---|---|
| **Parcela DB** | Status persistido: `ATRASADA` (job + UPDATE JPQL). **Não** existe status `VENCIDA` na parcela. |
| **Job** | `marcarAtrasadasJob` cron `0 0 1 * * *` → `parcelaRepo.marcarAtrasadas` (`ABERTA` + vencimento < hoje → `ATRASADA`) |
| **Helper** | `isVencida()` = status `ABERTA` && hoje > vencimento (**computado**, não persiste sozinho) |
| **API** | `mapStatusApi` devolve `"VENCIDA"` se `ATRASADA` ou `isVencida()` |
| **Conta** | Status persistido `VENCIDA` se alguma parcela `ATRASADA` (`atualizarStatusConta`) |

### Quem aplica `dias_bloqueio_inadimplencia`

`PdvCrediarioMotorService.verificarBloqueioPorDias` (chamado pelo job após marcar atrasadas):

```642:656:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/service/PdvCrediarioMotorService.java
    public void verificarBloqueioPorDias(UUID tenantId) {
        int diasGlobal = configuracaoPdvService.config(tenantId).getCrediarioDiasBloqueioInadimplencia();
        // por cliente: diasLimite = cliente.diasBloqueioInadimplencia ?? diasGlobal
        // se countAtrasadasAntesDe(cliente, hoje - diasLimite) > 0 → status BLOQUEADO
```

Bloqueio paralelo por **contagem** de atrasadas: `LIMITE_ATRASO_BLOQUEIO = 2` em `PdvCrediarioService` (`verificarBloqueiosAutomaticos` / pós-quitação).

---

## 6. Overpayment (valor pago > parcela)

### `receberParcela` — **bloqueia**

```434:436:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/service/PdvCrediarioMotorService.java
        if (valorReceber.compareTo(restante) > 0) {
            throw new IllegalArgumentException("Valor excede saldo da parcela.");
        }
```

Sem crédito ao cliente.

### `quitarParcelas` (FIFO) — **não credita; sobra ignorada**

Loop aplica no máximo o `restante` de cada parcela; o excedente fica na variável local `saldo` e **não** vira crédito:

```457:457:/home/caio/projects/margin-engine/src/main/java/com/marginengine/pdv/service/PdvCrediarioService.java
        double totalRecebido = req.valorPago() - saldo.doubleValue();
```

**NÃO ENCONTRADO** mecanismo de crédito por overpayment (buscado em `PdvCrediarioService` / `PdvCrediarioMotorService`).

---

## 7. Confirmação posterior de PIX

**NÃO ENCONTRADO** fluxo automático “PIX confirmado → baixa parcela de crediário”.

Baixa de parcela é **manual**:
- `POST .../parcelas/{id}/receber` → `motorService.receberParcela`
- quitação FIFO

Movimento de caixa: auditoria `OperacaoCaixa.CREDIARIO_RECEBIMENTO` no controller (`PdvCrediarioController:258`, `:412`) — **não** é movimento de caixa de venda PIX.

Confirmação Asaas/PIX na venda (`consumePaidReferences` ~1724) é independente e **não** chama `gerarParcelas`/`receberParcela`.

---

## 8. Formato de `numero_conta`

| Origem | Formato | Exemplo |
|---|---|---|
| Sistema (runtime) | `CC-{ANO}-{SEQ 6 dígitos}` | `CC-2026-000042` |
| Backfill V20260714 | `CC-LEG-{12 hex do venda_id}` | `CC-LEG-a1b2c3d4e5f6` |

`SEQ` = `count(contas do tenant no ano de data_venda) + 1` (não usa sequence SQL). Unique `(tenant_id, numero_conta)`.

---

## Resumo executivo

- Crediário nasce **somente** com pagamento `CREDIARIO` → `processarCrediario` → `gerarParcelas` → conta `ABERTA` + parcelas `ABERTA` ligadas por `venda_id`.
- **PIX / PIX a conferir / PIX_CONFERIR**: inexistentes como origem de conta/parcela neste código.
- `saldo_devedor`: trigger SQL + recalc Java.
- Parcela atrasada: **`ATRASADA` persistida** (job); `VENCIDA` é label de API/conta.
- Overpayment: **exception** em receber; **ignorado** em quitação FIFO.
- `numero_conta`: `CC-YYYY-NNNNNN`.