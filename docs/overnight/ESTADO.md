# Estado — modo autônomo noturno (2026-10-06)

Ordem: INÍCIO, A, B, C, D, F, E, ENCERRAMENTO. Repos: `margin-engine` (back), `margin-engine-front` (front),
`agente-local` (agente).

Tag de backup em todos: `backup/pre-overnight-20261006` (back `8e7f78d`, front `444218b2`, agente `c15c0fd`).

## Checklist

- [x] INÍCIO — remoção de vestígios de flag (back + front + docs)
- [x] A1 — impressão enganosa (fila ≠ impresso; consulta por pedido)
- [x] A2 — trava de status (`expected_workflow_status` → 409)
- [x] A3 — PIX preserva agendamento (back `4af88bb4`)
- [ ] A4 — IA WhatsApp: janela de sessão após handoff
- [ ] A5 — pendências pós-release documentadas
- [ ] B1–B5 — fechamento do Pedido Rápido
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

## Próximo passo

A4 — IA WhatsApp: janela de sessão.

Observação: 4 E2E do Pedido Rápido falham desde a fase 3.1 (PRICE_CHANGED, catálogo, matriz do painel, PiP) — escopo de B1.
