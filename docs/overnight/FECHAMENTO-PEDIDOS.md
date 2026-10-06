# Fechamento — pedidos (O1)

Data: 2026-10-06. Commits: back `5ef2fb59`, front `39d5d39`.

## 1. Branches e bloqueios

| Pendência | Situação | Motivo |
|---|---|---|
| Branches `overnight/*` de pedidos | Nenhuma existe | Nenhuma em back, front ou agente: tudo do modo noturno já foi integrado na main. |
| CI remoto | Não verificado | `gh` sem autenticação; os gates foram rodados localmente. |

## 2. Suítes e E2E

| Gate | Resultado |
|---|---|
| Back `mvn -o test` (suíte completa) | OK |
| Front vitest | 524 arquivos, 3250 testes OK |
| Front lint / tsc / build | 0 erros (6 warnings já existentes) / OK / OK |
| `check:theme` | 36 (baseline) |
| `check:release-alignment` | OK |
| Secret scan | limpo |
| E2E novos (`e2e/pedidos-fluxos.spec.ts`, 6 testes) | OK |
| E2E suíte completa | **Adiada para o prompt 6**, a pedido do usuário (execução lenta) |

Cobertura E2E de pedido:

| Fluxo | Spec |
|---|---|
| Pedido Rápido: Entrega | `pedidos-fluxos` (novo) |
| Pedido Rápido: Retirada | `pedidos-fluxos` (novo; antes só o catálogo escondia o endereço) |
| Pedido Rápido: Agendado / Local | `agendamento` |
| Central: avançar / cancelar | `pedidos-fluxos` (novo; movimento pelo WebSocket) |
| Central: antecipar agendamento | `pedidos-fluxos` (novo) |
| Central: voltar para Agendados | `agendamento` |
| Central: selo e filtro Pedido Rápido | `pedidos-fluxos` (novo) + `orderCentralCanalEntrada.test.tsx` |
| Central de conversas (IA) | specs existentes de conversas |
| Impressão / mensagens automáticas | `pedido-rapido-sucesso`, `whatsapp-variacoes` |

Specs instáveis conhecidas (passam isoladas): `mesa-close-bill`, o teste 409 de `pedido-rapido-sucesso`.

## 3. Flags e testes desabilitados

| Item | Situação |
|---|---|
| `pedido_rapido_habilitado` | Resolvido. O back ignora o valor no PUT de config, e o front não envia nem lê mais o campo. A coluna fica (proibido DROP); a resposta continua `true` para clientes antigos. |
| `FEATURE_DISABLED` | Resolvido. Removido do enum (nunca era lançado), do OpenAPI, do runbook e do README. O front usa `PLAN_REQUIRED` (402). O OpenAPI ganhou `SCHEDULE_INVALID` e `SCHEDULE_FULL`. |
| `@Disabled` | Só `JavaNfeXmlBuilderTest#dinheiroComTrocoGeraVTroco`, com motivo: depende de homologação SEFAZ (E3). |
| Grupos excluídos do surefire | benchmark, chaos, stress, homolog, e2e, openapi, postgres-it. Precisam de Docker ou credenciais. É intencional. |

## 4. Canal de entrada do Pedido Rápido

- O campo já existia: `orders.canal_entrada` (migration `V20261098__pedido_rapido_canal_entrada.sql`, rollback em `docs/rollback/`). Ele é preenchido na criação via `CanalEntradaContexto.com(PEDIDO_RAPIDO, …)`. **Nenhuma migration nova.** Pedidos antigos ficam com `NULL`.
- Adicionado nesta etapa:
  - Central: selo "Pedido Rápido" no card e filtro "Pedido Rápido" em "Filtrar origem".
  - Relatório por origem: `by_entry_channel` no dashboard de Pedidos Digitais (seção "Por canal de entrada"); `NULL` aparece como "Outros canais".
  - Telemetria: `order_engine.pedidos.criados{origem,canal}`, com as tags limitadas aos valores dos enums.

## 5. Em aberto

- Rodar a suíte E2E completa (prompt 6).
- Verificar o CI remoto quando o `gh` estiver autenticado.
- Pendências herdadas do `RELATORIO.md` (homologação SEFAZ, validação em Postgres real dos grupos excluídos).
