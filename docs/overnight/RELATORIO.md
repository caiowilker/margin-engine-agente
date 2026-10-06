# Relatório — modo autônomo noturno (2026-10-06)

Todas as tarefas (A, B, C, D, F, E) foram publicadas na `main` dos três repositórios. Nenhuma ficou em branch
`overnight/*`. Versão continua 1.0.50 (não lançada), tudo registrado no `CHANGELOG.md` sob `[1.0.50]`.

Ponto de restauração: tag `backup/pre-overnight-20261006` em cada repo (back `8e7f78d`, front `444218b2`,
agente `c15c0fd`).

Detalhes de cada decisão em [`DECISOES.md`](DECISOES.md); bloqueios em [`BLOQUEIOS.md`](BLOQUEIOS.md).

## Gates usados antes de cada push

Build, lint (0 erros), typecheck, suíte completa do back (`mvn test`), suíte completa do front (vitest, 3248 no
fim), E2E Playwright completo do front, varredura de segredos/debug no diff, `check:theme` sem regressão
(36 falhas, iguais ao baseline) e `check:release-alignment`. O CI remoto não foi conferido (`gh` sem
autenticação).

## Por tarefa

| Tarefa | Status | Back | Front | Agente |
|---|---|---|---|---|
| INÍCIO — remover flags | main | `964f9424` | `c72a130` | `72999d5` |
| A1 — impressão (fila ≠ impresso) | main | `b77a1331` | `67afd3b` | `f9b91a6` |
| A2 — trava de status (409) | main | `cc1d5e7b` | `e33928a` | `6b80755` (docs) |
| A3 — PIX mantém agendamento | main | `4af88bb4` | — | `03b6b95` (docs) |
| A4 — IA WhatsApp após handoff | main | `a3014e2d` | — | `3d92fba` (docs) |
| A5 — pendências pós-release | main | `645fdbf9` (docs) | — | `3d92fba` (docs) |
| B1 — E2E do Pedido Rápido verde | main | — | `89c6463` | `3ea6db5` (docs) |
| B2–B5 — sucesso ao vivo | main | — | `45cb106` | `3627bc3` (docs) |
| C — central de conversas da IA | main | `5e916502` | `1f43970` | `0250778` (docs) |
| D — agendamento e "Local" | main | `0d5b0509` | `3d1d574` | `dbabe18` (docs) |
| F — variações de mensagem | main | `e1e763b6` | `f87af06` | `f3ec0e6` (docs) |
| E1 — desconto/preço autorizados no servidor | main | `c1f5ab17` | `049420b` | `6850050` (docs) |
| E2 — troca de forma de pagamento | main | `c32d7e85` | `e686dbd` | (docs, este commit) |
| E3 — `vTroco` reproduzido + proposta | main (teste `@Disabled`) | `c1f5ab17` | — | `6850050` (docs) |

Testes novos por tarefa (todos verdes no push):

- **A:** testes de serviço do back para impressão, 409 de workflow, PIX agendado e janela de sessão da IA.
- **B:** `e2e/pedido-rapido*.spec.ts` (matriz de temas/tamanhos, sucesso ao vivo, 409, confirmação automática).
- **C:** testes de serviço/controller da central de conversas e painel no front. **D:** `e2e/agendamento.spec.ts`
  e testes de `AgendamentoPedidoService`. **F:** vetores de hash idênticos no Java e no TS, editor no front.
- **E1:** `PdvDescontoAutorizacaoServiceTest` (14, inclui negativos: sem permissão, flag do cliente forjada,
  token reutilizado, BLOQUEADO, acima do limite), 3 em `PdvVendaServiceTest`, 2 em `OrderServiceTest`,
  `e2e/desconto-supervisor.spec.ts` (token enviado; 422 mantém o cupom).
- **E2:** `FormaPagamentoFaturamentoServiceTest` (14, inclui negativos: sem permissão nem token, token
  inválido/reutilizado, BLOQUEADO sem consumir token), 2 em `OrderEngineBillingServiceTest` (recusa antes de
  gravar a venda; auditoria com token), `e2e/delivery-forma-pagamento-supervisor.spec.ts` (reenvio com token;
  cancelar não fatura).
- **E3:** `JavaNfeXmlBuilderTest#dinheiroComTrocoGeraVTroco` reproduz a falta de `<vTroco>` (`@Disabled`).

Estado final: back suíte completa verde; front 3248 vitest; E2E 41 testes.

## Migrations

Só uma migration na noite: **`V20261101`** (C, central de conversas — colunas/índices aditivos e backfill).
Validada no Postgres local real (`margin_pr_carga`, Docker indisponível) subindo a aplicação: aplicada em
**0,079 s**, aplicação subiu (valida JPQL). Nenhum DROP. E1/E2 não precisaram de migration (enums gravados como
texto sem CHECK; `permissao` é `varchar(60)`, `operacao` é `varchar(40)`).

## Como reverter

Sempre com `git revert` (nada de reset/force push). Ordem sugerida: front, depois back, depois docs do agente.

- Uma tarefa: `git revert <hash>` nos hashes da tabela acima (back e front da mesma tarefa juntos).
- Tudo: `git revert --no-edit backup/pre-overnight-20261006..HEAD` em cada repo.
- **C (migration):** reverter o código não desfaz `V20261101`; as colunas novas ficam sem uso (aditivas, sem
  impacto). Não apagar as colunas.
- **E1/E2:** reverter só o back já desliga o bloqueio; o front continua funcionando (token extra é ignorado).
  Usuários com `ALTERAR_FORMA_PAGAMENTO` configurada no banco ficam com uma linha órfã inofensiva em
  `pdv_permissao_operador` (o enum antigo não a lê; não apagar sem revisar).

## Bloqueios

- CI remoto não conferido (`gh` sem autenticação). Conferir pela manhã os pipelines dos commits acima.

## Decisões que merecem revisão

- `check:theme` falha com 36 itens desde antes da noite; tratado como "sem regressão".
- E1 bloqueia só a venda direta online; sync offline, agente, faturamento de pedido/mesa e os endpoints de pedido
  só auditam.
- E2 bloqueia só `POST /order-engine/orders/{id}/faturar` com usuário humano; o front reage ao 422 (o pedido não
  traz a forma combinada). Pedido de venda legado fica fora.
- E3 não publicou a correção do XML fiscal (sem homologação); proposta em
  `margin-engine/docs/fiscal/proposta-vtroco-nfce-nuvem.md`.

## Perguntas em aberto

- **Retenção LGPD das conversas da IA (C):** prazo não definido; propriedade vazia = nada é apagado. Definir o
  prazo (ex.: 90/180 dias) e quem aprova.
- **`vTroco` (E3):** aprovar a proposta e homologar em ambiente da SEFAZ antes de publicar.
- **E1 em pedidos e mesas:** exigir token também em `/order-engine/orders`, `tables/{id}/sync`/`ops`? Exige o front
  repassar o token nos fluxos de mesa e cuidar dos replays offline.
- **E2:** tela dedicada do relatório diário de divergências (hoje só o endpoint
  `GET /pdv/auditoria/divergencias-pagamento` e a trilha de auditoria). Cobrir pedido de venda legado?
- **Permissão padrão de `ALTERAR_FORMA_PAGAMENTO`:** hoje SUPERVISOR para operador. Lojas onde o operador troca
  forma com frequência (cliente muda de ideia na porta) podem preferir LIVRE + auditoria.

## Riscos

- **Vendas da fila aplicadas mais de 1 dia depois (E1):** o token de supervisor já foi expurgado e a venda é
  recusada (fica em ERRO na fila, visível).
- **Requisição forjada com prefixo `ORDER-`/`PEDIDO-` (E1):** passa sem bloqueio, mas fica auditada como
  `SEM_AUTORIZACAO`.
- **E2 muda a rotina do caixa:** operador sem permissão que fatura entrega em forma diferente da combinada agora
  precisa de supervisor. Perfis gestores passam direto (auto-autorização).
- **UX da frente (pré-existente):** operador sem permissão de desconto global abre o "Ajuste" como acréscimo.
- **E2E instáveis, não tocados:** `mesa-close-bill` e `pedido-rapido-sucesso` (409) falham ocasionalmente na
  suíte completa e passam sozinhos/no retry. O spec novo de E2 falhou uma vez na suíte completa e passou no retry,
  em 10 repetições isoladas e na suíte seguinte.
- **CI não conferido** (ver bloqueios).
