# Changelog

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
