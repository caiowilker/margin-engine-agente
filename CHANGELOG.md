## [1.0.204] — 2026-10-20

- Alinhamento 1.0.204: Contas a Pagar liberado paga à vista em dinheiro do terminal sem pedir sangria (respeita limite).

## [1.0.203] — 2026-10-18

- Devolução venda/compra: paginação real, saldo em lote, histórico lean (sem LOB), React Query.

## [1.0.202] — 2026-10-18

- Etiquetas: uma tela central; preview proporcional ao rolo e quantidade sólida.

## [1.0.201] — 2026-10-18

- Fornecedor: preenchimento automático CEP/CNPJ de alta qualidade.

## [1.0.200] — 2026-10-18

- Inputs RFQ/cotação: padrão caixa (moeda/inteiro) sem travar no 0.

## [1.0.199] — 2026-10-18

- RFQ/cotação: polish UX/design extremo (buyer + portal + e-mail).

## [1.0.198] — 2026-10-18

- RFQ/cotação: telas buyer + portal público premium; alinhamento release.

## [1.0.197] — 2026-10-18

- Formação de preço mercado + devolução ST produção (vICMSSTRet, remap 60/500, NFref fail-closed).

## [1.0.196] — 2026-10-18

- Build Windows: corrige tsc do front embarcado (RFQ await, token PDV, unused).

# Changelog

## [1.0.195] — 2026-10-18

- Fornecedor QA: validação endereço/IE/IBGE; dest devolução usa IE do cadastro; IBGE persistido após resolução.

## [1.0.194] — 2026-10-18

- Fornecedor: cadastro/edição com endereço+IE+IBGE; auto-fill do XML de entrada (`enderEmit`).

## [1.0.193] — 2026-10-18

- Devoluções legais: agente tpNF compra=1 / tPag=90; ST retido 5411; pacote/Contador com XMLs; indFinal/cMun/indIEDest alinhados MOC.

## [1.0.192] — 2026-10-18

- Devoluções: Ver NF-e (XML/DANFE) na compra; XML no ZIP Contador; rota PDF `DC-`.

## [1.0.191] — 2026-10-18

- Devolução compra (solidez): Focus/cloud saída correta; financeiro idempotente; endereço fornecedor obrigatório; testes + aviso lista truncada.

## [1.0.190] — 2026-10-18

- Devoluções produção: listagem Este mês/Mês passado/90 dias; copy anti-confusão venda vs compra; devolução de compra com emissão SEFAZ (finNFe=4), estoque pós-autorização e abate Conta a Pagar / crédito pendente.

## [1.0.189] — 2026-10-18

- Produção formação/RFQ: 404 tipados; opt-out portal; OC RFQ numerada; lembretes/expiração ShedLock; bounce Resend→contato; alíquota vigência no simular; front opt-out.

## [1.0.188] — 2026-10-18

- Solidez formação de preço + RFQ (reposicao NF, mapa, portal, reprec).


## [1.0.187] — 2026-10-18

- Formação de preço avançada + RFQ fornecedores (motor, aba, portal token, OC/reprecificação).


## [1.0.186] — 2026-10-18

- Escrituração NF entrada: se dataEntrada ficou em mês anterior (importou e só escriturou depois), avança para o momento da escrituração — entra no pacote do mês da escrituração e chega ao contador.


## [1.0.185] — 2026-10-18

- Pacote fiscal mensal: timeout extremo 45 min (configurável 15–120) para não cortar geração no envio automático ao contador; paralelismo 3 (2–4); pool drena até o mesmo teto.

## [1.0.184] — 2026-10-18

- Perf solidez: orçamento checkout em degraus (25 WARN / 45 ERROR); flush PEPS sem double-save; lote aninhado fail-closed; escriturar ERROR &gt;55 queries.

## [1.0.183] — 2026-10-18

- Perf caixa/escriturar: orçamento `POST /pdv/vendas` ≤800 ms / ≤25 queries; escriturar ≤3 s; log `request_p95_budget` com topSql; alertas Grafana; lote PEPS/custo/CIAP + balança afterCommit.

## [1.0.182] — 2026-10-18

- Crediário › venda (solidez): `gerarParcelas` sempre aplica SSOT (compra+prazo); recusa duplicata da mesma venda, valor ≤0 e vendaId nulo; renegociação valida janela do 1º vencimento.

## [1.0.181] — 2026-10-18

- Crediário › venda: 1º vencimento SSOT no servidor = data da compra (fuso loja) + prazo do tenant (default 30 dias); preview do front ignorado se divergir; defesa contra vencimento no passado.

## [1.0.180] — 2026-10-18

- Crediário produção (fecho): receber/quitar fail-closed sem conta (antes de caixa/encargos); status de conta trata CANCELADA como encerrada; sync pós-recebimento e Ver itens respeitam gen-gate (não sobrescrevem Trocar cliente); migration V20261153 com backfill de saldo; comprovante: clickId sozinho não marca 2ª via.

## [1.0.179] — 2026-10-18

- Crediário › Ver itens: query leve (só colunas exibidas, sem EntityGraph da venda); prefetch no hover/foco; timeout 8s; cache anti-duplo-fetch.

## [1.0.178] — 2026-10-18

- Crediário (solidez): status de conta não marca PAGA em lista vazia; flush+idempotência no quitar; saldo lido do trigger após flush; posição por documento em 1 TX; comprovante não marca 2ª via só por clickId.

## [1.0.177] — 2026-10-18

- Crediário › Receber: posição/consulta bem mais rápida (sem COUNT extra, filtro de venda cancelada no SQL, índice de parcelas abertas).
- Crediário › Receber/quitar: trava só as parcelas alvo, flush em lote, status de contas em 1 query; trigger de saldo só soma ABERTA/ATRASADA.

## [1.0.176] — 2026-10-18

- Crediário › Receber › Ver itens: botão **2ª via da compra** (reimprime o cupom da venda).
- Comprovante térmico de recebimento/quitação: cabeçalho completo da empresa, valor recebido em destaque, alinhamento e banner de segunda via.

## [1.0.175] — 2026-10-16

- Crediário › Receber: após gravar, sincroniza saldo/parcelas com o backend (sem depender de Recarregar); detalhe da conta aberta também atualiza.

## [1.0.174] — 2026-10-16

- Crediário › Receber: coluna **Data compra** ao lado do vencimento; ordenar por data da compra.

## [1.0.173] — 2026-10-16

- TXITENS clássico: layout oficial 320 bytes (D1/D2=25+25, T=0/1, VVV validado); validador estrito + CLI `validar-txitens`.
- Isolamento de perfil: carga TXITENS quarentena residual ITENSMGV/DEPTO/ARQSOK (e o inverso já existente).
- Fixture de campo: `docs/balanca/fixtures/teste_txitens_1_linha/` (+ variante D1/D2 50 para prova A/B).

## [1.0.172] — 2026-10-16

- Carga de balança: "Reenviar" / enviar-agora idempotente — não revive FAILED se já existe PENDING do mesmo dedupe (elimina 409 `uq_balanca_carga_outbox_pending_dedupe`).
- Duplicatas ativas → `SUPERSEDED`; "Remover da fila" apaga todas as linhas do grupo; endpoint limpar falhas.
- Migration V20261152: status SUPERSEDED + saneamento de duplicatas.

## [1.0.171] — 2026-10-16

- Frente de caixa: catálogo sincroniza a cada **15s** (antes ~5 min); ao focar a aba, sync imediato.
- Mesma máquina / outra aba: salvar produto ou edição rápida dispara sync na frente na hora (BroadcastChannel).
- Ao adicionar item: revalida preço no servidor (`obter`) e corrige o carrinho se o preço mudou.

## [1.0.170] — 2026-10-16

- Crediário: configuração **dias de vencimento após a compra** (padrão 30) em Configurações › Crediário; 1ª parcela = hoje+N dias.

## [1.0.169] — 2026-10-16

- Layout MGV6 byte a byte: Lote=12 zeros, DEPTO 43 bytes (E), EAN só em T=2/5, D1/D2 quebra por palavra, sanitização ASCII.
- Validador estrito bloqueia entrega inválida; CLI `validar-itensmgv`; fixtures de teste G (1 linha vs espaços no L).

## [1.0.168] — 2026-10-16

- Carga de Balança: remove modo sombra por completo (assistente só produção, ACK DIAGNOSTICO rejeitado, SPEC_DERIVADA só MANUAL com aviso).
- Migration limpa hashes de gerenciadores que estavam em sombra; Reenviar tudo ignora hash.
- Status: Pendente → Enviando → Aguardando confirmação → Confirmado (.BAK) / Falhou (motivo).
- ITENSMGV ACBr-150: campo Lote (pos. 90–101) vazio grava zeros (não espaços) — corrige "Lote inválido" no MGV6.

## [1.0.167] — 2026-10-16

- Release alignment (copy MGV6 importação auto/MT1 no front).

## [1.0.166] — 2026-10-16

- Carga MGV6: quarentena TXITENS case-insensitive; follow-up campo (parcial → ITENSMGV).

## [1.0.165] — 2026-10-16

- Carga MGV6: copy pasta = só path (ITENSMGV, não TXITENS); alinhamento release.

## [1.0.164] — 2026-10-16

- Carga MGV6: TXITENS residual não bloqueia ITENSMGV (quarentena antes do diagnóstico); teste de ordem ITENSMGV→DEPTO→ARQSOK.

## [1.0.163] — 2026-10-16

- Carga MGV6: quarentena TXITENS residual **antes** do diagnóstico de pasta ocupada (não bloqueia ITENSMGV); testes de entrega + suite `test:balanca`.

## [1.0.162] — 2026-10-16

- Carga MGV6: quarentena de TXITENS residual ao gravar ITENSMGV na pasta (evita import falho no MGV).

## [1.0.161] — 2026-10-15

### Fixed / hardened
- Preview da faixa com gap/perfuração proporcional (rolo duplo/triplo).
- Calibração ZPL com molduras + marca no meio; botões Calibrar/Teste 1× em destaque.
- Ajuste fino L×A/colunas (personalizado); presets duplo alinhados a rolos reais.

## [1.0.160] — 2026-10-15

### Fixed
- Presets 2 e 3 colunas exclusivos (seleção por `id`, não por mm).
- Inputs numéricos permitem apagar/digitar sem forçar 0 no meio da edição.
- Rolo duplo com presets maiores (40×30, 50×25, 50×40); UX Central e avulsa.

## [1.0.159] — 2026-10-15

### Added
- Central de impressão de etiquetas (`/pdv/etiquetas/central`): lote multi-produto, mídia multi-coluna ZPL (1–4, padrão 33×22·3 col), calibração, histórico Postgres, CSV codigo;qtd.
- Backend: `POST /pdv/etiquetas/lote/preparar`, calibração, histórico; grouper multi-coluna com ^PQ; busca de produtos sem acento + categoria/estoque.

### Fixed / hardened
- Orquestrador: só marca OK após envio RAW; cancelamento/pendentes → FALHA; histórico sempre gravado; exige porta.
- Gaps padrão 2 mm → linha 104 mm (cabe na L42 Pro); aviso de largura na UI e na calibração.
- Preview da 1ª faixa com `colunaInicial`; teste 1×; `modelo` no gerarDeProduto/preview.

### Notes
- Multi-coluna só em ZPL na v1 (PPLA desabilitado com colunas>1).
- Preset 33×22·3 col: margem 1 + 3×33 + 2×2 = 104 mm (área útil típica da L42 Pro).

T
