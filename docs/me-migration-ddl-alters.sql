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
