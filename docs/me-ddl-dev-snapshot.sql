CREATE TABLE public.finance_categoria_custo (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    natureza_id uuid NOT NULL,
    categoria_pai_id uuid,
    codigo character varying(40) NOT NULL,
    nome character varying(120) NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.finance_centro_custo (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    codigo character varying(20) NOT NULL,
    nome character varying(120) NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    setor_producao character varying(20)
);

CREATE TABLE public.finance_conta_pagar (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    fornecedor_id uuid,
    fornecedor_nome character varying(200),
    descricao character varying(300) NOT NULL,
    documento character varying(60),
    valor numeric(19,4) NOT NULL,
    vencimento date NOT NULL,
    data_pagamento date,
    valor_pago numeric(19,4),
    status character varying(20) DEFAULT 'ABERTA'::character varying NOT NULL,
    observacao text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    centro_custo_id uuid,
    nota_fiscal_entrada_id uuid,
    numero_duplicata character varying(60),
    categoria_custo_id uuid,
    loja_id uuid,
    recorrencia_id uuid,
    anexo_url character varying(500),
    aprovado_por uuid,
    aprovado_em timestamp without time zone,
    created_by uuid,
    competencia character varying(7),
    colaborador_id uuid,
    origem character varying(30),
    CONSTRAINT chk_finance_conta_pagar_status CHECK (((status)::text = ANY ((ARRAY['ABERTA'::character varying, 'PENDENTE_APROVACAO'::character varying, 'PAGA'::character varying, 'CANCELADA'::character varying])::text[])))
);

CREATE TABLE public.finance_natureza_custo (
    id uuid NOT NULL,
    codigo character varying(20) NOT NULL,
    nome character varying(80) NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pdv_caixa (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    operador character varying(80) NOT NULL,
    abertura_em timestamp without time zone DEFAULT now() NOT NULL,
    fechamento_em timestamp without time zone,
    valor_abertura numeric(19,4) DEFAULT 0 NOT NULL,
    valor_fechamento numeric(19,4),
    observacao character varying(255),
    status character varying(10) DEFAULT 'ABERTO'::character varying NOT NULL,
    numero_caixa character varying(20),
    dispositivo_id bigint,
    caixa_terminal_id uuid,
    CONSTRAINT chk_caixa_status CHECK (((status)::text = ANY ((ARRAY['ABERTO'::character varying, 'FECHADO'::character varying])::text[])))
);

CREATE TABLE public.pdv_cliente (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    tipo_pessoa character varying(2) DEFAULT 'PF'::character varying NOT NULL,
    cpf_cnpj character varying(18) NOT NULL,
    nome_razao_social character varying(120) NOT NULL,
    telefone character varying(20),
    email character varying(120),
    cep character varying(8),
    logradouro character varying(120),
    numero character varying(20),
    complemento character varying(60),
    bairro character varying(60),
    municipio character varying(60),
    uf character varying(2),
    codigo_ibge character varying(7),
    inscricao_estadual character varying(20),
    ind_ie_dest smallint,
    criado_em timestamp without time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp without time zone DEFAULT now() NOT NULL,
    segmento character varying(20) DEFAULT 'NAO_CLASSIFICADO'::character varying NOT NULL,
    ticket_medio_cents bigint DEFAULT 0 NOT NULL,
    total_compras_count integer DEFAULT 0 NOT NULL,
    total_compras_cents bigint DEFAULT 0 NOT NULL,
    ultima_compra_at timestamp without time zone,
    primeiro_compra_at timestamp without time zone,
    score_recencia integer DEFAULT 0 NOT NULL,
    score_frequencia integer DEFAULT 0 NOT NULL,
    score_monetario integer DEFAULT 0 NOT NULL,
    whatsapp_marketing_consent boolean DEFAULT false NOT NULL,
    telefone_normalizado character varying(20),
    whatsapp_opt_out boolean DEFAULT false NOT NULL,
    ativo boolean DEFAULT true NOT NULL
);

CREATE TABLE public.pdv_crediario_cliente (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    limite_credito numeric(19,4) DEFAULT 500.00 NOT NULL,
    saldo_devedor numeric(19,4) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'ATIVO'::character varying NOT NULL,
    observacao character varying(255),
    criado_em timestamp without time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp without time zone DEFAULT now() NOT NULL,
    cliente_id uuid,
    dia_vencimento integer DEFAULT 10 NOT NULL,
    max_parcelas integer DEFAULT 3 NOT NULL,
    motivo_bloqueio text,
    aprovado_por character varying(120),
    aprovado_em timestamp without time zone,
    juros_atraso_percentual_mes numeric(5,2),
    multa_atraso_percentual numeric(5,2),
    dias_bloqueio_inadimplencia integer DEFAULT 30 NOT NULL,
    dias_carencia_juros integer,
    dias_carencia_multa integer,
    modo_aplicacao_encargos character varying(40),
    periodicidade character varying(20)
);

CREATE TABLE public.pdv_crediario_conta (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    crediario_cliente_id uuid NOT NULL,
    venda_id uuid,
    numero_conta character varying(32) NOT NULL,
    valor_total numeric(19,4) NOT NULL,
    valor_pago numeric(19,4) DEFAULT 0 NOT NULL,
    valor_pendente numeric(19,4) NOT NULL,
    status character varying(24) DEFAULT 'ABERTA'::character varying NOT NULL,
    data_venda timestamp without time zone DEFAULT now() NOT NULL,
    observacoes text,
    criado_em timestamp without time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pdv_crediario_encargo (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    parcela_id uuid NOT NULL,
    tipo character varying(16) NOT NULL,
    valor numeric(19,4) NOT NULL,
    data_calculo date NOT NULL,
    data_referencia_atraso date NOT NULL,
    criado_em timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_crediario_encargo_tipo CHECK (((tipo)::text = ANY ((ARRAY['JUROS'::character varying, 'MULTA'::character varying])::text[]))),
    CONSTRAINT chk_crediario_encargo_valor CHECK ((valor >= (0)::numeric))
);

CREATE TABLE public.pdv_crediario_parcela (
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
    atualizado_em timestamp without time zone DEFAULT now() NOT NULL,
    crediario_conta_id uuid,
    recebido_por character varying(120)
);

CREATE TABLE public.pdv_crediario_recebimento (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    crediario_parcela_id uuid NOT NULL,
    crediario_conta_id uuid NOT NULL,
    valor_recebido numeric(19,4) NOT NULL,
    forma_pagamento character varying(30) NOT NULL,
    data_recebimento timestamp without time zone DEFAULT now() NOT NULL,
    recebido_por character varying(120) NOT NULL,
    observacoes text,
    criado_em timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pdv_item_venda (
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
    preco_original numeric(19,4),
    categoria character varying(80),
    unidade character varying(6),
    csosn character varying(3),
    cest character varying(7),
    c_class_trib character varying(6),
    acrescimo_item numeric(19,4) DEFAULT 0 NOT NULL,
    preco_alterado_manual boolean DEFAULT false NOT NULL,
    apresentacao_venda_id uuid,
    fator_para_estoque numeric(19,4),
    quantidade_estoque numeric(19,4),
    gtin_comercial character varying(14),
    pis_cofins_classificacao character varying(20),
    valor_icms_st numeric(19,4) DEFAULT 0 NOT NULL,
    aliquota_icms_efetiva numeric(7,4),
    reducao_bc_icms_efetiva numeric(7,4) DEFAULT 0 NOT NULL
);

CREATE TABLE public.pdv_movimento_caixa (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    caixa_id uuid NOT NULL,
    tipo character varying(20) NOT NULL,
    valor numeric(19,4) NOT NULL,
    saldo_apos numeric(19,4) NOT NULL,
    motivo character varying(255),
    operador character varying(80),
    registrado_em timestamp without time zone NOT NULL,
    autorizado_por character varying(120)
);

CREATE TABLE public.pdv_produto (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    codigo character varying(50) NOT NULL,
    nome character varying(120) NOT NULL,
    preco double precision NOT NULL,
    custo double precision DEFAULT 0 NOT NULL,
    margem double precision DEFAULT 0 NOT NULL,
    estoque numeric(19,4) DEFAULT 0 NOT NULL,
    unidade character varying(10) DEFAULT 'un'::character varying NOT NULL,
    por_peso boolean DEFAULT false NOT NULL,
    categoria character varying(60),
    ncm character varying(10),
    cfop character varying(6) DEFAULT '5102'::character varying,
    cst character varying(4) DEFAULT '400'::character varying,
    aliquota_icms double precision DEFAULT 0,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    estoque_minimo numeric(19,4) DEFAULT 0 NOT NULL,
    alerta_estoque_baixo boolean DEFAULT false NOT NULL,
    codigo_plu character varying(10),
    unidade_compra character varying(10) DEFAULT 'UN'::character varying,
    unidade_estoque character varying(10) DEFAULT 'UN'::character varying,
    unidade_venda character varying(10) DEFAULT 'UN'::character varying,
    fator_conversao numeric(19,4) DEFAULT 1 NOT NULL,
    estoque_maximo numeric(19,4),
    estoque_seguranca numeric(19,4) DEFAULT 0,
    lead_time_dias integer DEFAULT 0,
    cobertura_dias integer DEFAULT 0,
    custo_medio numeric(19,4),
    tipo_produto character varying(20) DEFAULT 'SIMPLES'::character varying NOT NULL,
    ponto_pedido numeric(19,4),
    quantidade_compra_padrao numeric(19,4),
    csosn character varying(3),
    cest character varying(7),
    c_class_trib character varying(6) DEFAULT '000001'::character varying NOT NULL,
    validade date,
    lote character varying(40),
    centro_custo_id uuid,
    pendente_revisao boolean DEFAULT false NOT NULL,
    venda_fracionada boolean DEFAULT false NOT NULL,
    categoria_id uuid,
    rendimento_percent numeric(5,2) DEFAULT 100.00 NOT NULL,
    fiscal_profile_id uuid,
    ean_fabricante character varying(14),
    natureza character varying(12) DEFAULT 'MERCADORIA'::character varying NOT NULL,
    servico_item_lista character varying(10),
    servico_codigo_cnae character varying(7),
    servico_codigo_tributacao character varying(20),
    servico_aliquota_iss numeric(6,4),
    servico_iss_retido boolean DEFAULT false NOT NULL,
    servico_discriminacao_padrao text,
    pis_cofins_classificacao character varying(20) DEFAULT 'NORMAL'::character varying NOT NULL,
    pis_cofins_classificacao_manual boolean DEFAULT false NOT NULL,
    icms_st_classificacao character varying(20) DEFAULT 'INDEFINIDO'::character varying NOT NULL,
    icms_st_classificacao_manual boolean DEFAULT false NOT NULL,
    icms_st_classificacao_confirmado_em timestamp without time zone,
    icms_st_classificacao_confirmado_por character varying(120),
    icms_st_aviso_ack_em timestamp without time zone,
    classificacao_fiscal_insumo character varying(32) DEFAULT 'INDEFINIDO'::character varying NOT NULL,
    classificacao_fiscal_insumo_manual boolean DEFAULT false NOT NULL,
    aliquota_icms_efetiva numeric(7,4),
    reducao_bc_icms_efetiva numeric(7,4) DEFAULT 0 NOT NULL,
    vasilhame_tipo_id uuid,
    conteudo_importado_percentual numeric(7,4),
    origem_mercadoria character varying(1),
    reforma_cclass_override boolean DEFAULT false NOT NULL,
    reforma_cclass_override_motivo character varying(500),
    reforma_cclass_override_em timestamp with time zone,
    reforma_cclass_override_por character varying(255),
    requer_reclassificacao_cclasstrib boolean DEFAULT false NOT NULL,
    cclass_orfao_codigo character varying(6),
    cclass_reclass_sugeridos text,
    cclass_trib_revisado_em timestamp with time zone,
    cclass_trib_revisado_por character varying(255),
    cst_ibs_cbs character varying(3),
    cclass_catalogo_versao character varying(20),
    CONSTRAINT chk_pdv_produto_natureza CHECK (((natureza)::text = ANY ((ARRAY['MERCADORIA'::character varying, 'SERVICO'::character varying])::text[]))),
    CONSTRAINT chk_pdv_produto_pis_cofins_classificacao CHECK (((pis_cofins_classificacao)::text = ANY ((ARRAY['NORMAL'::character varying, 'MONOFASICO'::character varying, 'SUBSTITUICAO'::character varying, 'ALIQUOTA_ZERO'::character varying])::text[]))),
    CONSTRAINT chk_pdv_produto_servico_item_lista CHECK ((((natureza)::text <> 'SERVICO'::text) OR ((servico_item_lista IS NOT NULL) AND (length(TRIM(BOTH FROM servico_item_lista)) > 0)))),
    CONSTRAINT chk_pdv_produto_tipo CHECK (((tipo_produto)::text = ANY ((ARRAY['SIMPLES'::character varying, 'MATERIA_PRIMA'::character varying, 'FABRICADO'::character varying])::text[])))
);

CREATE TABLE public.pdv_venda (
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
    fiscal_email_status character varying(20),
    fiscal_email_enviado_em timestamp without time zone,
    fiscal_email_erro character varying(500),
    abertura_caixa_id uuid,
    fiscal_emitido_em timestamp without time zone,
    fiscal_tentativas integer DEFAULT 0 NOT NULL,
    chave_nfce_origem character varying(44),
    pedido_id uuid,
    loja_id uuid,
    acrescimo numeric(19,4) DEFAULT 0 NOT NULL,
    order_engine_order_id uuid,
    deposito_id uuid,
    dh_recbto_nfe character varying(50),
    data_emissao_nfe timestamp without time zone,
    competencia_fiscal_em timestamp without time zone,
    fiscal_content_version text,
    CONSTRAINT chk_venda_status CHECK (((status)::text = ANY ((ARRAY['CONCLUIDA'::character varying, 'CANCELADA'::character varying])::text[])))
);

CREATE TABLE public.pdv_venda_pagamento (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    venda_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    forma character varying(30) NOT NULL,
    valor numeric(19,4) NOT NULL,
    troco numeric(19,4) DEFAULT 0 NOT NULL,
    referencia character varying(100),
    registrado_em timestamp without time zone DEFAULT now() NOT NULL,
    numero_parcelas integer,
    bandeira character varying(40)
);

CREATE TABLE public.retail_fornecedor (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    nome character varying(120) NOT NULL,
    cnpj character varying(14),
    email character varying(120),
    telefone character varying(20),
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    razao_social character varying(200),
    nome_fantasia character varying(120),
    cpf character varying(14),
    celular character varying(20),
    endereco_logradouro character varying(200),
    endereco_numero character varying(20),
    endereco_complemento character varying(80),
    endereco_bairro character varying(80),
    endereco_cidade character varying(80),
    endereco_uf character varying(2),
    endereco_cep character varying(10),
    observacoes text,
    regime_tributario character varying(40),
    regime_tributario_alerta text
);

ALTER TABLE ONLY public.finance_categoria_custo
    ADD CONSTRAINT finance_categoria_custo_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.finance_centro_custo
    ADD CONSTRAINT finance_centro_custo_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.finance_conta_pagar
    ADD CONSTRAINT finance_conta_pagar_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.finance_natureza_custo
    ADD CONSTRAINT finance_natureza_custo_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_caixa
    ADD CONSTRAINT pdv_caixa_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_cliente
    ADD CONSTRAINT pdv_cliente_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_crediario_cliente
    ADD CONSTRAINT pdv_crediario_cliente_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_crediario_conta
    ADD CONSTRAINT pdv_crediario_conta_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_crediario_encargo
    ADD CONSTRAINT pdv_crediario_encargo_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_crediario_parcela
    ADD CONSTRAINT pdv_crediario_parcela_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_crediario_recebimento
    ADD CONSTRAINT pdv_crediario_recebimento_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_item_venda
    ADD CONSTRAINT pdv_item_venda_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_movimento_caixa
    ADD CONSTRAINT pdv_movimento_caixa_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_produto
    ADD CONSTRAINT pdv_produto_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_venda_pagamento
    ADD CONSTRAINT pdv_venda_pagamento_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_venda
    ADD CONSTRAINT pdv_venda_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.retail_fornecedor
    ADD CONSTRAINT retail_fornecedor_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pdv_crediario_conta
    ADD CONSTRAINT uk_crediario_conta_numero UNIQUE (tenant_id, numero_conta);

ALTER TABLE ONLY public.pdv_venda
    ADD CONSTRAINT uk_pdv_venda_tenant_numero UNIQUE (tenant_id, numero_venda);

ALTER TABLE ONLY public.finance_centro_custo
    ADD CONSTRAINT uq_centro_custo_tenant_codigo UNIQUE (tenant_id, codigo);

ALTER TABLE ONLY public.finance_categoria_custo
    ADD CONSTRAINT uq_finance_categoria_custo_tenant_codigo UNIQUE (tenant_id, codigo);

ALTER TABLE ONLY public.finance_natureza_custo
    ADD CONSTRAINT uq_finance_natureza_custo_codigo UNIQUE (codigo);

ALTER TABLE ONLY public.finance_categoria_custo
    ADD CONSTRAINT finance_categoria_custo_categoria_pai_id_fkey FOREIGN KEY (categoria_pai_id) REFERENCES public.finance_categoria_custo(id);

ALTER TABLE ONLY public.finance_categoria_custo
    ADD CONSTRAINT finance_categoria_custo_natureza_id_fkey FOREIGN KEY (natureza_id) REFERENCES public.finance_natureza_custo(id);

ALTER TABLE ONLY public.finance_conta_pagar
    ADD CONSTRAINT finance_conta_pagar_categoria_custo_id_fkey FOREIGN KEY (categoria_custo_id) REFERENCES public.finance_categoria_custo(id);

ALTER TABLE ONLY public.finance_conta_pagar
    ADD CONSTRAINT finance_conta_pagar_centro_custo_id_fkey FOREIGN KEY (centro_custo_id) REFERENCES public.finance_centro_custo(id);

ALTER TABLE ONLY public.finance_conta_pagar
    ADD CONSTRAINT finance_conta_pagar_fornecedor_id_fkey FOREIGN KEY (fornecedor_id) REFERENCES public.retail_fornecedor(id);

ALTER TABLE ONLY public.finance_conta_pagar
    ADD CONSTRAINT finance_conta_pagar_loja_id_fkey FOREIGN KEY (loja_id) REFERENCES public.retail_loja(id);

ALTER TABLE ONLY public.pdv_crediario_cliente
    ADD CONSTRAINT fk_crediario_pdv_cliente FOREIGN KEY (cliente_id) REFERENCES public.pdv_cliente(id);

ALTER TABLE ONLY public.finance_conta_pagar
    ADD CONSTRAINT fk_finance_conta_pagar_recorrencia FOREIGN KEY (recorrencia_id) REFERENCES public.finance_recorrencia_custo(id);

ALTER TABLE ONLY public.pdv_caixa
    ADD CONSTRAINT fk_pdv_caixa_dispositivo FOREIGN KEY (dispositivo_id) REFERENCES public.pdv_dispositivo(id);

ALTER TABLE ONLY public.pdv_caixa
    ADD CONSTRAINT pdv_caixa_caixa_terminal_id_fkey FOREIGN KEY (caixa_terminal_id) REFERENCES public.pdv_caixa_terminal(id);

ALTER TABLE ONLY public.pdv_crediario_conta
    ADD CONSTRAINT pdv_crediario_conta_crediario_cliente_id_fkey FOREIGN KEY (crediario_cliente_id) REFERENCES public.pdv_crediario_cliente(id);

ALTER TABLE ONLY public.pdv_crediario_conta
    ADD CONSTRAINT pdv_crediario_conta_venda_id_fkey FOREIGN KEY (venda_id) REFERENCES public.pdv_venda(id);

ALTER TABLE ONLY public.pdv_crediario_encargo
    ADD CONSTRAINT pdv_crediario_encargo_parcela_id_fkey FOREIGN KEY (parcela_id) REFERENCES public.pdv_crediario_parcela(id);

ALTER TABLE ONLY public.pdv_crediario_parcela
    ADD CONSTRAINT pdv_crediario_parcela_crediario_conta_id_fkey FOREIGN KEY (crediario_conta_id) REFERENCES public.pdv_crediario_conta(id);

ALTER TABLE ONLY public.pdv_crediario_parcela
    ADD CONSTRAINT pdv_crediario_parcela_crediario_id_fkey FOREIGN KEY (crediario_id) REFERENCES public.pdv_crediario_cliente(id);

ALTER TABLE ONLY public.pdv_crediario_parcela
    ADD CONSTRAINT pdv_crediario_parcela_venda_id_fkey FOREIGN KEY (venda_id) REFERENCES public.pdv_venda(id);

ALTER TABLE ONLY public.pdv_crediario_recebimento
    ADD CONSTRAINT pdv_crediario_recebimento_crediario_conta_id_fkey FOREIGN KEY (crediario_conta_id) REFERENCES public.pdv_crediario_conta(id);

ALTER TABLE ONLY public.pdv_crediario_recebimento
    ADD CONSTRAINT pdv_crediario_recebimento_crediario_parcela_id_fkey FOREIGN KEY (crediario_parcela_id) REFERENCES public.pdv_crediario_parcela(id);

ALTER TABLE ONLY public.pdv_item_venda
    ADD CONSTRAINT pdv_item_venda_apresentacao_venda_id_fkey FOREIGN KEY (apresentacao_venda_id) REFERENCES public.produto_apresentacao_venda(id);

ALTER TABLE ONLY public.pdv_item_venda
    ADD CONSTRAINT pdv_item_venda_venda_id_fkey FOREIGN KEY (venda_id) REFERENCES public.pdv_venda(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pdv_produto
    ADD CONSTRAINT pdv_produto_categoria_id_fkey FOREIGN KEY (categoria_id) REFERENCES public.pdv_categoria(id);

ALTER TABLE ONLY public.pdv_produto
    ADD CONSTRAINT pdv_produto_centro_custo_id_fkey FOREIGN KEY (centro_custo_id) REFERENCES public.finance_centro_custo(id);

ALTER TABLE ONLY public.pdv_produto
    ADD CONSTRAINT pdv_produto_fiscal_profile_id_fkey FOREIGN KEY (fiscal_profile_id) REFERENCES public.fiscal_profile(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.pdv_produto
    ADD CONSTRAINT pdv_produto_vasilhame_tipo_id_fkey FOREIGN KEY (vasilhame_tipo_id) REFERENCES public.vasilhame_tipo(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.pdv_venda
    ADD CONSTRAINT pdv_venda_abertura_caixa_id_fkey FOREIGN KEY (abertura_caixa_id) REFERENCES public.pdv_caixa(id);

ALTER TABLE ONLY public.pdv_venda
    ADD CONSTRAINT pdv_venda_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.pdv_caixa(id);

ALTER TABLE ONLY public.pdv_venda
    ADD CONSTRAINT pdv_venda_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.pdv_cliente(id);

ALTER TABLE ONLY public.pdv_venda
    ADD CONSTRAINT pdv_venda_crediario_cliente_id_fkey FOREIGN KEY (crediario_cliente_id) REFERENCES public.pdv_crediario_cliente(id);

ALTER TABLE ONLY public.pdv_venda
    ADD CONSTRAINT pdv_venda_dispositivo_id_fkey FOREIGN KEY (dispositivo_id) REFERENCES public.pdv_dispositivo(id);

ALTER TABLE ONLY public.pdv_venda
    ADD CONSTRAINT pdv_venda_loja_id_fkey FOREIGN KEY (loja_id) REFERENCES public.retail_loja(id);

ALTER TABLE ONLY public.pdv_venda_pagamento
    ADD CONSTRAINT pdv_venda_pagamento_venda_id_fkey FOREIGN KEY (venda_id) REFERENCES public.pdv_venda(id) ON DELETE CASCADE;

CREATE INDEX idx_centro_custo_tenant ON public.finance_centro_custo USING btree (tenant_id);

CREATE INDEX idx_conta_pagar_nota_entrada ON public.finance_conta_pagar USING btree (tenant_id, nota_fiscal_entrada_id) WHERE (nota_fiscal_entrada_id IS NOT NULL);

CREATE INDEX idx_crediario_conta_cliente ON public.pdv_crediario_conta USING btree (crediario_cliente_id, status);

CREATE INDEX idx_crediario_conta_tenant ON public.pdv_crediario_conta USING btree (tenant_id, data_venda);

CREATE INDEX idx_crediario_encargo_parcela ON public.pdv_crediario_encargo USING btree (parcela_id);

CREATE INDEX idx_crediario_encargo_tenant_data ON public.pdv_crediario_encargo USING btree (tenant_id, data_calculo);

CREATE INDEX idx_crediario_recebimento_conta ON public.pdv_crediario_recebimento USING btree (crediario_conta_id);

CREATE INDEX idx_crediario_recebimento_parcela ON public.pdv_crediario_recebimento USING btree (crediario_parcela_id);

CREATE INDEX idx_crediario_recebimento_tenant_data ON public.pdv_crediario_recebimento USING btree (tenant_id, data_recebimento);

CREATE INDEX idx_crediario_tenant ON public.pdv_crediario_cliente USING btree (tenant_id, status);

CREATE INDEX idx_finance_ap_colaborador ON public.finance_conta_pagar USING btree (tenant_id, colaborador_id) WHERE (colaborador_id IS NOT NULL);

CREATE INDEX idx_finance_ap_origem ON public.finance_conta_pagar USING btree (tenant_id, origem) WHERE (origem IS NOT NULL);

CREATE INDEX idx_finance_ap_paga_centro_data ON public.finance_conta_pagar USING btree (tenant_id, centro_custo_id, data_pagamento) INCLUDE (categoria_custo_id, origem, valor_pago, valor) WHERE (((status)::text = 'PAGA'::text) AND (centro_custo_id IS NOT NULL));

CREATE INDEX idx_finance_ap_paga_dre_cover ON public.finance_conta_pagar USING btree (tenant_id, data_pagamento) INCLUDE (categoria_custo_id, origem, valor_pago, valor, loja_id, centro_custo_id) WHERE ((status)::text = 'PAGA'::text);

CREATE INDEX idx_finance_ap_paga_loja_data ON public.finance_conta_pagar USING btree (tenant_id, loja_id, data_pagamento) INCLUDE (categoria_custo_id, origem, valor_pago, valor, centro_custo_id) WHERE (((status)::text = 'PAGA'::text) AND (loja_id IS NOT NULL));

CREATE INDEX idx_finance_categoria_custo_pai ON public.finance_categoria_custo USING btree (tenant_id, categoria_pai_id);

CREATE INDEX idx_finance_categoria_custo_tenant ON public.finance_categoria_custo USING btree (tenant_id);

CREATE INDEX idx_finance_categoria_natureza ON public.finance_categoria_custo USING btree (natureza_id);

CREATE INDEX idx_finance_conta_pagar_abertas_venc ON public.finance_conta_pagar USING btree (tenant_id, vencimento) WHERE ((status)::text = ANY ((ARRAY['ABERTA'::character varying, 'PENDENTE_APROVACAO'::character varying])::text[]));

CREATE INDEX idx_finance_conta_pagar_categoria ON public.finance_conta_pagar USING btree (tenant_id, categoria_custo_id);

CREATE INDEX idx_finance_conta_pagar_centro ON public.finance_conta_pagar USING btree (centro_custo_id);

CREATE INDEX idx_finance_conta_pagar_loja ON public.finance_conta_pagar USING btree (tenant_id, loja_id);

CREATE INDEX idx_finance_conta_pagar_recorrencia ON public.finance_conta_pagar USING btree (tenant_id, recorrencia_id);

CREATE INDEX idx_finance_conta_pagar_tenant_centro ON public.finance_conta_pagar USING btree (tenant_id, centro_custo_id) WHERE (centro_custo_id IS NOT NULL);

CREATE INDEX idx_finance_conta_pagar_tenant_status ON public.finance_conta_pagar USING btree (tenant_id, status);

CREATE INDEX idx_finance_conta_pagar_tenant_status_pagamento ON public.finance_conta_pagar USING btree (tenant_id, status, data_pagamento) WHERE (data_pagamento IS NOT NULL);

CREATE INDEX idx_finance_conta_pagar_tenant_venc ON public.finance_conta_pagar USING btree (tenant_id, vencimento, status);

CREATE INDEX idx_parcela_conta ON public.pdv_crediario_parcela USING btree (crediario_conta_id, status);

CREATE INDEX idx_parcela_crediario ON public.pdv_crediario_parcela USING btree (crediario_id, status);

CREATE INDEX idx_parcela_tenant ON public.pdv_crediario_parcela USING btree (tenant_id, vencimento, status);

CREATE INDEX idx_parcela_venda ON public.pdv_crediario_parcela USING btree (venda_id);

CREATE INDEX idx_pdv_caixa_dispositivo_status ON public.pdv_caixa USING btree (dispositivo_id, status);

CREATE INDEX idx_pdv_caixa_tenant_status ON public.pdv_caixa USING btree (tenant_id, status);

CREATE INDEX idx_pdv_caixa_terminal ON public.pdv_caixa USING btree (caixa_terminal_id);

CREATE INDEX idx_pdv_cliente_segmento ON public.pdv_cliente USING btree (tenant_id, segmento);

CREATE INDEX idx_pdv_cliente_tenant_ativo_nome ON public.pdv_cliente USING btree (tenant_id, ativo, nome_razao_social);

CREATE INDEX idx_pdv_cliente_tenant_nome ON public.pdv_cliente USING btree (tenant_id, nome_razao_social);

CREATE INDEX idx_pdv_cliente_ultima_compra ON public.pdv_cliente USING btree (tenant_id, ultima_compra_at);

CREATE INDEX idx_pdv_item_venda_produto_id ON public.pdv_item_venda USING btree (produto_id) WHERE ((produto_id IS NOT NULL) AND (TRIM(BOTH FROM produto_id) <> ''::text));

CREATE INDEX idx_pdv_item_venda_venda_id ON public.pdv_item_venda USING btree (venda_id);

CREATE INDEX idx_pdv_item_venda_venda_produto ON public.pdv_item_venda USING btree (venda_id, produto_id);

CREATE INDEX idx_pdv_movimento_caixa_caixa ON public.pdv_movimento_caixa USING btree (caixa_id, registrado_em);

CREATE INDEX idx_pdv_movimento_caixa_tenant ON public.pdv_movimento_caixa USING btree (tenant_id, registrado_em);

CREATE INDEX idx_pdv_pagamento_tenant ON public.pdv_venda_pagamento USING btree (tenant_id, registrado_em);

CREATE INDEX idx_pdv_pagamento_venda ON public.pdv_venda_pagamento USING btree (venda_id);

CREATE INDEX idx_pdv_pagamento_venda_registrado ON public.pdv_venda_pagamento USING btree (venda_id, registrado_em);

CREATE INDEX idx_pdv_prod_icms_st_class_tenant ON public.pdv_produto USING btree (tenant_id, icms_st_classificacao) WHERE (ativo = true);

CREATE INDEX idx_pdv_produto_categoria_id ON public.pdv_produto USING btree (categoria_id);

CREATE INDEX idx_pdv_produto_cclass_default_migracao ON public.pdv_produto USING btree (id) WHERE (COALESCE(NULLIF(TRIM(BOTH FROM c_class_trib), ''::text), '000001'::text) = '000001'::text);

CREATE INDEX idx_pdv_produto_cclass_nao_revisado ON public.pdv_produto USING btree (tenant_id) WHERE ((ativo = true) AND (cclass_trib_revisado_em IS NULL) AND (COALESCE(NULLIF(TRIM(BOTH FROM c_class_trib), ''::text), '000001'::text) = '000001'::text));

CREATE INDEX idx_pdv_produto_centro_custo ON public.pdv_produto USING btree (centro_custo_id);

CREATE INDEX idx_pdv_produto_codigo ON public.pdv_produto USING btree (tenant_id, codigo);

CREATE INDEX idx_pdv_produto_codigo_trgm ON public.pdv_produto USING gin (lower((codigo)::text) public.gin_trgm_ops);

CREATE INDEX idx_pdv_produto_fiscal_profile ON public.pdv_produto USING btree (tenant_id, fiscal_profile_id) WHERE (fiscal_profile_id IS NOT NULL);

CREATE INDEX idx_pdv_produto_nome_trgm ON public.pdv_produto USING gin (lower((nome)::text) public.gin_trgm_ops);

CREATE INDEX idx_pdv_produto_pendente_revisao ON public.pdv_produto USING btree (tenant_id, pendente_revisao) WHERE (pendente_revisao = true);

CREATE INDEX idx_pdv_produto_reclass_cclass ON public.pdv_produto USING btree (tenant_id, requer_reclassificacao_cclasstrib) WHERE (requer_reclassificacao_cclasstrib = true);

CREATE INDEX idx_pdv_produto_tenant ON public.pdv_produto USING btree (tenant_id);

CREATE INDEX idx_pdv_produto_tenant_ativo_nome ON public.pdv_produto USING btree (tenant_id, ativo, nome);

CREATE INDEX idx_pdv_produto_tenant_natureza ON public.pdv_produto USING btree (tenant_id, natureza) WHERE (ativo = true);

CREATE INDEX idx_pdv_produto_tenant_nome ON public.pdv_produto USING btree (tenant_id, nome);

CREATE UNIQUE INDEX idx_pdv_produto_tenant_plu_unique ON public.pdv_produto USING btree (tenant_id, codigo_plu) WHERE ((ativo = true) AND (por_peso = true) AND (codigo_plu IS NOT NULL) AND (TRIM(BOTH FROM codigo_plu) <> ''::text));

CREATE INDEX idx_pdv_produto_validade ON public.pdv_produto USING btree (tenant_id, validade) WHERE ((validade IS NOT NULL) AND (ativo = true));

CREATE INDEX idx_pdv_produto_vasilhame_tipo ON public.pdv_produto USING btree (tenant_id, vasilhame_tipo_id) WHERE (vasilhame_tipo_id IS NOT NULL);

CREATE INDEX idx_pdv_venda_abertura_caixa ON public.pdv_venda USING btree (abertura_caixa_id);

CREATE INDEX idx_pdv_venda_chave_nfe ON public.pdv_venda USING btree (chave_nfe);

CREATE UNIQUE INDEX idx_pdv_venda_cliente_idempotencia ON public.pdv_venda USING btree (tenant_id, numero_venda_cliente) WHERE (numero_venda_cliente IS NOT NULL);

CREATE INDEX idx_pdv_venda_concluida_status_emitido ON public.pdv_venda USING btree (tenant_id, status_fiscal, emitido_em) WHERE ((status)::text = 'CONCLUIDA'::text);

CREATE INDEX idx_pdv_venda_concluidas ON public.pdv_venda USING btree (tenant_id, emitido_em DESC) WHERE ((status)::text = 'CONCLUIDA'::text);

CREATE INDEX idx_pdv_venda_dispositivo ON public.pdv_venda USING btree (dispositivo_id, emitido_em);

CREATE INDEX idx_pdv_venda_fiscal_painel_emitido ON public.pdv_venda USING btree (tenant_id, emitido_em DESC) WHERE (((status)::text = 'CONCLUIDA'::text) AND ((status_fiscal IS NULL) OR ((status_fiscal)::text <> ALL ((ARRAY['AUTORIZADA'::character varying, 'CANCELADA'::character varying])::text[]))));

CREATE INDEX idx_pdv_venda_fiscal_pendente_recovery ON public.pdv_venda USING btree (tenant_id, emitido_em) WHERE (((status)::text = 'CONCLUIDA'::text) AND ((chave_nfe IS NULL) OR ((chave_nfe)::text = ''::text)) AND ((status_fiscal IS NULL) OR ((status_fiscal)::text = ANY ((ARRAY['PENDENTE'::character varying, 'PENDENTE_FISCAL'::character varying, 'REJEITADA'::character varying])::text[]))) AND ((emitir_nfce = true) OR ((modelo_fiscal)::text = '55'::text) OR ((origem_venda)::text = 'PAINEL_NFE'::text)));

CREATE INDEX idx_pdv_venda_forma_pagamento ON public.pdv_venda USING btree (tenant_id, forma_pagamento, emitido_em) WHERE ((status)::text = 'CONCLUIDA'::text);

CREATE INDEX idx_pdv_venda_loja ON public.pdv_venda USING btree (tenant_id, loja_id, emitido_em DESC) WHERE ((status)::text = 'CONCLUIDA'::text);

CREATE INDEX idx_pdv_venda_nfce_aut_periodo ON public.pdv_venda USING btree (tenant_id, emitido_em) WHERE (((status)::text = 'CONCLUIDA'::text) AND ((status_fiscal)::text = 'AUTORIZADA'::text) AND ((modelo_fiscal)::text = '65'::text));

CREATE INDEX idx_pdv_venda_nfce_status ON public.pdv_venda USING btree (tenant_id, status_fiscal);

CREATE INDEX idx_pdv_venda_nfe_pendentes ON public.pdv_venda USING btree (tenant_id, emitido_em DESC) WHERE (((status)::text = 'CONCLUIDA'::text) AND ((chave_nfe IS NULL) OR ((chave_nfe)::text = ''::text)));

CREATE INDEX idx_pdv_venda_order_engine_order ON public.pdv_venda USING btree (tenant_id, order_engine_order_id);

CREATE INDEX idx_pdv_venda_pedido ON public.pdv_venda USING btree (pedido_id);

CREATE INDEX idx_pdv_venda_resumo_periodo ON public.pdv_venda USING btree (tenant_id, emitido_em) INCLUDE (total, lucro, forma_pagamento, status) WHERE ((status)::text <> 'CANCELADA'::text);

CREATE INDEX idx_pdv_venda_status_fiscal ON public.pdv_venda USING btree (status_fiscal);

CREATE INDEX idx_pdv_venda_tenant_caixa_emitido ON public.pdv_venda USING btree (tenant_id, caixa_id, emitido_em DESC);

CREATE INDEX idx_pdv_venda_tenant_chave_nfe ON public.pdv_venda USING btree (tenant_id, chave_nfe) WHERE ((chave_nfe IS NOT NULL) AND (TRIM(BOTH FROM chave_nfe) <> ''::text));

CREATE INDEX idx_pdv_venda_tenant_cliente_emitido ON public.pdv_venda USING btree (tenant_id, cliente_id, emitido_em DESC) WHERE (cliente_id IS NOT NULL);

CREATE INDEX idx_pdv_venda_tenant_competencia_fiscal ON public.pdv_venda USING btree (tenant_id, competencia_fiscal_em) WHERE (((status)::text = 'CONCLUIDA'::text) AND (competencia_fiscal_em IS NOT NULL));

CREATE INDEX idx_pdv_venda_tenant_competencia_fiscal_autorizada ON public.pdv_venda USING btree (tenant_id, competencia_fiscal_em) WHERE (((status)::text = 'CONCLUIDA'::text) AND (upper((status_fiscal)::text) = 'AUTORIZADA'::text) AND (competencia_fiscal_em IS NOT NULL));

CREATE INDEX idx_pdv_venda_tenant_data ON public.pdv_venda USING btree (tenant_id, emitido_em DESC);

CREATE INDEX idx_pdv_venda_tenant_data_emissao_nfe ON public.pdv_venda USING btree (tenant_id, data_emissao_nfe) WHERE (data_emissao_nfe IS NOT NULL);

CREATE INDEX idx_pdv_venda_tenant_emitido_desc ON public.pdv_venda USING btree (tenant_id, emitido_em DESC);

CREATE INDEX idx_pdv_venda_tenant_emitido_paged ON public.pdv_venda USING btree (tenant_id, emitido_em DESC);

CREATE INDEX idx_pdv_venda_tenant_operador_emitido ON public.pdv_venda USING btree (tenant_id, operador, emitido_em DESC);

CREATE INDEX idx_pdv_venda_tenant_status_emitido ON public.pdv_venda USING btree (tenant_id, status, emitido_em DESC);

CREATE INDEX idx_retail_fornecedor_tenant ON public.retail_fornecedor USING btree (tenant_id);

CREATE UNIQUE INDEX uk_crediario_tenant_cliente ON public.pdv_crediario_cliente USING btree (tenant_id, cliente_id) WHERE (cliente_id IS NOT NULL);

CREATE UNIQUE INDEX uk_pdv_cliente_tenant_doc ON public.pdv_cliente USING btree (tenant_id, cpf_cnpj);

CREATE UNIQUE INDEX uq_finance_ap_recorrencia_competencia ON public.finance_conta_pagar USING btree (tenant_id, recorrencia_id, competencia) WHERE ((recorrencia_id IS NOT NULL) AND (competencia IS NOT NULL));

CREATE UNIQUE INDEX uq_pdv_caixa_dispositivo_aberto ON public.pdv_caixa USING btree (dispositivo_id) WHERE ((status)::text = 'ABERTO'::text);

CREATE UNIQUE INDEX uq_pdv_cliente_tenant_telefone_norm ON public.pdv_cliente USING btree (tenant_id, telefone_normalizado) WHERE (telefone_normalizado IS NOT NULL);

CREATE UNIQUE INDEX uq_pdv_produto_tenant_codigo ON public.pdv_produto USING btree (tenant_id, codigo);

CREATE UNIQUE INDEX uq_pdv_produto_tenant_ean_fabricante ON public.pdv_produto USING btree (tenant_id, ean_fabricante) WHERE (ean_fabricante IS NOT NULL);