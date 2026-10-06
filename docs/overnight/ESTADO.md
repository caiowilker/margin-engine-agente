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
- [ ] C — central de conversas da IA
- [ ] D — agendamento e "Local" no Pedido Rápido
- [ ] F — variações de mensagem
- [ ] E — endurecimento financeiro
- [ ] ENCERRAMENTO — RELATORIO.md

## Hashes

| Tarefa | Back | Front | Agente |
|---|---|---|---|
| INÍCIO | `964f9424` | `c72a130` | `72999d5` |
| A1 | ver git log "fix(print)" | ver git log "fix(print)" | ver git log "fix(print)" |
| B1 | — | `89c6463` | (docs) |
| B2–B5 | — | `45cb106` | (docs) |

## Próximo passo

C — central de conversas da IA (migration aditiva + endpoints + job + painel).

Suíte E2E completa do front: 27 testes, 26 verdes + `mesa-close-bill` instável (passa no retry; não tocado).
