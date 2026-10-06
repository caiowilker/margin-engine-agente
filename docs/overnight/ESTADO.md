# Estado — modo autônomo noturno (2026-10-06)

Ordem: INÍCIO, A, B, C, D, F, E, ENCERRAMENTO. Repos: `margin-engine` (back), `margin-engine-front` (front),
`agente-local` (agente).

Tag de backup em todos: `backup/pre-overnight-20261006` (back `8e7f78d`, front `444218b2`, agente `c15c0fd`).

## Checklist

- [x] INÍCIO — remoção de vestígios de flag (back + front + docs)
- [x] A1 — impressão enganosa (fila ≠ impresso; consulta por pedido)
- [x] A2 — trava de status (`expected_workflow_status` → 409)
- [x] A3 — PIX preserva agendamento (back `4af88bb4`)
- [x] A4 — IA WhatsApp: janela de sessão após handoff
- [x] A5 — pendências pós-release documentadas (`margin-engine/docs/pendencias-pos-release.md`)
- [x] B1 — E2E do Pedido Rápido verde (front `89c6463`); canário delivery e mesa também corrigidos (specs desatualizados desde 1.0.49)
- [x] B2–B5 — sucesso ao vivo, impressão, Confirmar seguro (409), confirmação automática, E2E (front `45cb106`)
- [x] C — central de conversas da IA (migration `V20261101` validada em Postgres local)
- [x] D — agendamento e "Local" no Pedido Rápido (sem migration)
- [x] F — variações de mensagem (sem migration)
- [x] E1 — desconto/preço autorizados no servidor + token one-time (back `c1f5ab17`, front `049420b`)
- [x] E3 — `vTroco` reproduzido (`@Disabled`) + proposta (back `c1f5ab17`)
- [ ] E2 — troca de forma de pagamento no faturamento
- [ ] ENCERRAMENTO — RELATORIO.md

## Hashes

| Tarefa | Back | Front | Agente |
|---|---|---|---|
| INÍCIO | `964f9424` | `c72a130` | `72999d5` |
| A1 | ver git log "fix(print)" | ver git log "fix(print)" | ver git log "fix(print)" |
| B1 | — | `89c6463` | (docs) |
| B2–B5 | — | `45cb106` | (docs) |
| C | `5e916502` | `1f43970` | (docs) |
| D | `0d5b0509` | `3d1d574` | (docs) |
| F | `e1e763b6` | `f87af06` | (docs) |
| E1+E3 | `c1f5ab17` | `049420b` | (docs) |

## Próximo passo

E2 — troca de forma de pagamento no faturamento (log, bloqueio sem permissão, relatório diário). Depois ENCERRAMENTO.

Após E1+E3: back suíte completa verde; front 3248 vitest, 39 E2E verdes (inclui `e2e/desconto-supervisor.spec.ts`); lint 0 erros; theme 36 (baseline); release alinhada.

Suíte E2E completa do front após F: 37 verdes. Back: suíte completa verde. Front: 3248 testes vitest.
Suíte E2E completa do front após D: 36 verdes (inclui `e2e/agendamento.spec.ts`). Back: 7584 testes verdes. Front: 3241 testes vitest.
Suíte E2E completa do front após C: 32 verdes. Antes: 27 testes, 26 verdes + `mesa-close-bill` instável (passa no retry; não tocado).
