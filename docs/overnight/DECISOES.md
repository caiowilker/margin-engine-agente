# Decisões — modo autônomo noturno (2026-10-06)

Ambiguidades resolvidas pela opção mais conservadora e reversível.

## INÍCIO

- **Docker indisponível** neste ambiente (WSL sem daemon). Migrations são validadas no Postgres local real
  (`margin_pr_carga`, só local) subindo a aplicação, que roda o Flyway no boot. Isso conta como "Postgres real";
  nunca se toca em `margin_db` nem em banco remoto.
- **Baseline de testes**: suites completas do front (3201 testes) e back verdes nos commits
  `444218b2` (front) / `8e7f78d` (back) / `c15c0fd` (agente), rodadas minutos antes da tag
  `backup/pre-overnight-20261006`. Reusada como baseline em vez de rodar de novo.
- **Flags removidas**: `margin.pedido-rapido.habilitado` (chave global), checagens de
  `pedido_rapido_habilitado` no front e o opt-out `VITE_THEME_STRATEGY_V1` (temas sempre ligados).
  A coluna `tenant_order_engine_config.pedido_rapido_habilitado` foi mantida (sem DROP) e o campo segue no
  `GET /order-engine/config` como `true` para clientes antigos.
- **`FEATURE_DISABLED` mantido** como código de erro: o front ainda mapeia o `402` de plano
  (FOOD_SERVICE ausente) para ele. É gating de plano, não flag de funcionalidade.
- **`check:theme` (front) já falhava no baseline** com os mesmos 36 itens (expectativas antigas de tokens do
  tema Escuro/Sol, anteriores ao redesenho). Nenhuma tarefa noturna mexe em CSS de tema; o gate é tratado como
  "sem regressão" (mesma contagem antes/depois) em vez de verde. Corrigir exige decidir tokens — fica para o dia.
- **Benchmark `interpret.test.ts` (< 50 ms)** pode falhar quando roda junto com a suíte Maven (CPU disputada);
  passa isolado. Reexecutado isolado quando isso acontece.
- **Versão** fica em 1.0.50 (não lançada); só CHANGELOG atualizado.

## A — correções

- **A1:** a fila do agente (202) gera ack `queued` → servidor mantém `DISPATCHED` e só renova o prazo do recovery.
  A estação consulta o job local do agente (`GET /impressora/jobs/:id`) a cada 3 s por até 10 min e só então
  confirma IMPRESSO/FALHOU. Sem desfecho no prazo, nada é confirmado (o recovery reenvia; o agente deduplica).
  `SEM_ESTACAO` = nenhum job ativo para o pedido **ou** pendente sem estação conectada por WebSocket.
  Impressão LAN de mesa (`mesaComandaLanPrint`) continua contando 202 como "enviado à estação" para não duplicar
  comanda — ela não informa IMPRESSO ao servidor.
- **A2:** `expected_workflow_status` divergente → 409 mesmo quando o pedido já está no destino (outro operador
  confirmou antes): o operador precisa ver que mudou.
- **A4:** "última mensagem do cliente" = `updated_at` da conversa (renovado a cada mensagem, inclusive durante o
  handoff). Sem migration nesta etapa; a central de conversas (C) traz coluna própria de atividade.
- **A5:** documento em `margin-engine/docs/` (back concentra os itens).

## B1 — E2E do Pedido Rápido

- Falhas eram defeitos reais de UI, não do teste: corrigido o CSS (barra sem margem negativa, `data-pequeno` 44 px no estreito, selos com pares `*-bg`/`*-text`, kbd 12 px, toast informativo com `pointer-events: none`) em vez de afrouxar a matriz.
- Catálogo: Enter filtrava com `useDeferredValue` (lista velha) e adicionava o produto errado; passou a usar o termo atual.
- `delivery-canary` e `mesa-close-bill` falhavam também no commit pré-noturno (`c15c0fd`): specs desatualizados com a UI da 1.0.49 (sacola lateral, checkout em etapas, botão "Faturar pedido", retorno ao Hub). Ajustados os specs, sem mudar produto.

## B2–B5 — tela de sucesso

- Módulo do Pedido Rápido continua desacoplado: o host injeta `acompanharPedido` e `confirmarPedido` (`src/lib/acompanhamentoPedidoRapido.ts`); sem host, a tela fica como antes.
- Polling usa `GET /order-engine/central/board` (não existe GET de um pedido só); mesmo endpoint que a Central já consulta a cada 15 s. Backoff 5→10→20→30 s, volta a 5 s quando algo muda, encerra após 15 min.
- `DESPACHADO` aparece como "Enfileirado" (entregue ao agente ≠ impresso). `SEM_ESTACAO` = "Sem impressora" e continua consultando (o job pode ser criado logo depois).
- "Confirmar" só aparece com status `recebidos`. O 409 atualiza o status com o `atual` da resposta (é o refresh).
- B4 já existia (`confirmacaoAutomatica` = WhatsApp vinculado ativo); só ganhou E2E.
- `mesa-close-bill` instável (espera 15 s pela mesa "livre"): passa sozinho e no retry; fluxo não tocado por B.

## C — central de conversas da IA

- **Permissão:** não existe permissão granular para "atender WhatsApp"; usado bloqueio por papel (CONTADOR, VENDEDOR, FISCAL_COMPLIANCE_ADMIN → 403), como outras rotas da Central. Front esconde o botão no 403.
- **Estado x status legado:** `estado` novo convive com `status` (ACTIVE/HANDED_OFF/…); `mudarEstado` sincroniza os dois para não quebrar o banner antigo nem `/handoffs`. Backfill a partir de `status`/`updated_at`.
- **Retenção LGPD sem padrão:** propriedade vazia = nada é apagado (decisão do negócio pendente, ver RELATORIO). Quando configurada, apaga em lotes o `whatsapp_ai_message_log` e zera `last_user_text` das conversas mais antigas que o prazo.
- **Resolver:** conversa resolvida reabre como Ativa quando o cliente volta a escrever.
- **"Ajuda" = pausar** (o operador assume, a IA para de responder). "Abrir pedido" não sobrescreve um rascunho com conteúdo: avisa e mantém.
- **Som opt-in** por usuário (`localStorage`), toca só quando o número de "Precisam de você" aumenta (nunca no primeiro carregamento).
- **Visibilidade do botão:** modo balcão ou qualquer conversa existente — lojas sem IA não ganham botão vazio. Banner antigo mantido.
- Migration validada em Postgres local (`margin_pr_carga`): aplicada em 0,079 s, app subiu (valida JPQL).

## D — agendamento e "Local"

- **Validação única:** `AgendamentoPedidoService` envolve `DeliveryScheduleSupport` sem mudar regras nem mensagens do QR; a exceção é subclasse de `OrderNegocioException`, então o handler global responde igual ao de antes. Só `OrderController` (e o Pedido Rápido) expõem `code` SCHEDULE_INVALID/SCHEDULE_FULL.
- **Reagendar na Central** (RECEBIDOS→AGENDADOS) usa as mesmas regras do agendamento novo (janela de preparo, expediente, limite por horário) e zera `agendadoLiberadoEm`, senão o job ignoraria o pedido.
- **Job de liberação:** busca global com horizonte "agora em UTC+14 + 60 min" e filtra por loja com "agora no fuso da loja + preparo" (40 min se não configurado). Conservador: nunca libera antes do horário da loja.
- **LOCAL** = origem BALCAO + nota "Consumo no local" (sem coluna nova, sem migration); o resumo do pedido reconhece a nota.
- **Hash de idempotência:** `agendadoPara` entra no hash só quando presente, para não invalidar chaves de pedidos imediatos já em voo durante o deploy.
- **Loja fechada:** pedido agendado não pede confirmação de loja fechada (o horário já é validado contra o expediente).
- **WhatsApp:** pedido agendado recebe "Pedido agendado" no lugar de "Pedido recebido" (não as duas). Template editável (`ORDER_SCHEDULED`); vazio = texto padrão.
- **Front:** "Agendar" só aparece quando a loja tem agendamento ligado (vem do `/cotar`). Horário do diálogo da Central usa o relógio do computador da loja (mesmo fuso na prática); o servidor valida contra o fuso configurado.
- Sem migration em D.

## F — variações de mensagem

- **Formato compatível:** JSON da coluna continua `{chave: texto}`; com 2+ variações o valor vira lista. Uma variação volta a ser texto (leitores antigos e o resto do código não mudam). `templatesForTenant` segue devolvendo a 1ª variação (reativação de inativos usa essa).
- **Leitura tolerante:** dado gravado com mais de 5 variações é cortado em 5 (não quebra envio); só a API recusa mais de 5.
- **Hash:** FNV-1a 32 bits sobre unidades UTF-16, semente `"<pedidoId>|<chave>"` (chave = `ORDER_READY`, `ORDER_SCHEDULED` etc.). Mesmos vetores testados no Java e no TS.
- **Menu Copiar:** as mensagens rápidas são locais (título + "---"); com pedido criado a semente é `"<pedido.id>|<título>"`. Sem pedido não há semente estável, então mantém a alternância antiga.
- **Editor:** adicionar variação não grava (linha vazia); grava ao sair do campo, ao reordenar e ao remover. Variações vazias são descartadas ao gravar.
- Sem migration em F.
