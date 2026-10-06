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
