# Versão de contrato API (front ↔ agente)

## O que é

`apiContractVersion` é um **número inteiro** que representa a compatibilidade do **contrato HTTP** entre o PWA do PDV e o agente local (`:9100`). Não é a versão do pacote npm (`package.json`) nem o `buildId` do front.

| Artefato | Onde vive | Exemplo |
|----------|-----------|---------|
| Contrato API | `agente-local/apiContract.js` + `margin-engine-front/src/lib/agentApiContract.ts` | `3` |
| Versão do agente | `package.json` do agente | `1.0.0` |
| Versão do front | `dist/version.json` | `build-20260712` |

O agente expõe o contrato em `GET /diagnostico/saude` (`apiContractVersion`). O front declara o valor esperado em `FRONT_AGENT_API_CONTRACT_VERSION` e checa no boot da frente de caixa.

## Quando incrementar

Incremente **somente** quando houver mudança **breaking** que impeça o front atual de falar corretamente com o agente. Exemplos:

- Remoção ou renomeação de campo **obrigatório** em endpoint usado pelo PDV no boot ou no checkout (`/status`, `/venda`, `/fiscal/*`, etc.).
- Mudança de método HTTP, path ou formato de resposta que o front não consegue interpretar.
- Alteração semântica de status/código que muda o fluxo de emissão fiscal ou registro de venda.

**Não incremente** quando:

- Adicionar campos **opcionais** na resposta (retrocompatível).
- Corrigir bug sem alterar contrato observado pelo front.
- Atualizar apenas `versao` do pacote ou `frontVersion` do build.
- Mudanças internas do agente (SQLite, ACBr, fila) sem alterar payloads HTTP consumidos pelo front.

## Procedimento ao incrementar

1. Incrementar `API_CONTRACT_VERSION` em `agente-local/apiContract.js`.
2. Incrementar `FRONT_AGENT_API_CONTRACT_VERSION` em `margin-engine-front/src/lib/agentApiContract.ts` **no mesmo PR/release**.
3. Documentar no CHANGELOG o motivo (qual endpoint/payload quebrou).
4. Garantir que agente e front sejam implantados juntos no PDV (mesmo pacote `frontend-dist` + binário do agente).

## Comportamento no PDV (fase 1)

- **Compatível:** nenhum aviso.
- **Incompatível:** faixa de aviso não bloqueante na frente de caixa (“versão do sistema local desatualizada, contate suporte”).
- **Operação em andamento** (carrinho, checkout, fiscal processando): aviso suave — **não bloqueia** emissão nem fila fiscal offline.
- **Agente offline no boot:** checagem ignorada (sem aviso de incompatibilidade).

Bloqueio ativo de novas ações poderá ser avaliado em campo após validação; a fila fiscal e emissões em progresso **nunca** devem ser interrompidas por este gate.
