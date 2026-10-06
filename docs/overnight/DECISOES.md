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
