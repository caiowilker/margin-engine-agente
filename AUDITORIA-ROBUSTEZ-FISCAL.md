# Auditoria de Robustez do Fluxo de Emissão NFC-e (Agente Local)

Data: 2026-07-03

Resumo curto
- Objetivo: auditar o fluxo de emissão NFC-e/NF-e do agente local segundo boas práticas (validação de payload, retry/backoff, timeouts de impressão, logs com contexto e dedup).
- Escopo: código local do agente (módulos `fiscalService.js`, `acbr.js`, `fiscalValidacao.js`, `fiscalRetry.js`, `filaFiscal.js`, `print/*`, `runtime/loggingService.js`, drivers ACBr).

1) Validação de variáveis do payload (evitar regressões como `fiscalDhEmiIni`)
- Achado: Existem validações explícitas:
  - `fiscalValidacao.js` contém `validarPayloadNfce` (itens, total, quantidades, preço, CPF/CNPJ) — lançam erro com `err.permanente = true` quando inválido.
  - `fiscalValidacaoNfe.js` contém `validarPayloadNfe` / `validarDestinatarioNfe` usadas por `acbr.montarIniNfe` e pelo fluxo `enfileirarEmissaoNfe`.
  - `acbr.validarEmpresaFiscal()` valida dados do emitente antes de montar INI.
  - `fiscalIniPolicy.requireDocumentIniOrAllowLocal()` verifica `documentIni` conforme política de implantação.
- Conclusão: cobertura de validação existe e é chamada antes de montar INI / enviar para ACBr.
- Correção nesta rodada: foi corrigida a falta de import de `fiscalDhEmiIni` (causa da ReferenceError) no driver `fiscal/drivers/acbrLibDriver.js` (fix já aplicado em mudança anterior); isso evita falhas por variável não definida ao montar INI em caminhos que usam `documentIni`.
- Pendências / recomendações:
  - Acrescentar testes unitários que exercitem caminhos com campos opcionais incompletos (ex.: `empresa.codigoMunicipio` ausente, `pagamentos` com formatos atípicos) para garantir mensagens de erro claras.
  - Adicionar maturidade na validação do conteúdo `documentIni` quando presente (checar campo dhEmi, formatação) — hoje é delegada a `fiscalDhEmiIni.prepararIniParaEmissao`/ACBr patch; vale testar entradas inválidas explicitamente.

2) Retry com backoff (rede / SEFAZ vs erros permanentes)
- Achado: Mecanismo implementado:
  - `fiscalRetry.js` classifica erros em `isPermanente`, `isTransient`, `isIncerto` (usa cStat, padrões de mensagem).
  - `filaFiscal.js` agenda retries via `agendarRetry()` usando `BACKOFF_MS` e regras especiais para cStat=999 (máx tentativas reduzidas). `processarUm()` usa `fiscalRetry` para decidir fluxo (incerto vs permanente vs temporário).
- Conclusão: Retry com backoff existe e é distinto de erros permanentes; classificação baseada em cStat e padrões de erro.
- Correção nesta rodada: nenhuma mudança funcional adicional requerida; já existia. Foi verificado que `maxTentativas` e janela de backoff são configuráveis por env (`FISCAL_MAX_RETRY_999`, `BACKOFF_MS`).
- Pendências / recomendações:
  - Adicionar testes integrados que simulem falhas de rede/SEFAZ (ECONNRESET, timeout) e verifiquem a evolução de `tentativas` e `proxima_tentativa`.
  - Instrumentar métricas / alertas quando um job atinge > N retries em X minutos para operação de suporte.

3) Timeout de impressão e não travar o checkout
- Achado:
  - O serviço de impressão centraliza timeouts: `print/printJobService.js` usa `timeoutTotalMs` (env `PRINT_JOB_TIMEOUT_TOTAL_MS`, default 20000 ms).
  - Executor de impressão rejeita por timeout (`print/printExecutor.js`); retries com backoff aplicados a erros retryable.
  - O fluxo fiscal emite via fila (`fiscalService.enfileirarEmissao`) — por padrão o endpoint retorna imediatamente com `fiscal: "pending"`; somente se `sync=true` é aguardada conclusão com `filaFiscal.aguardarConclusao()` (timeout configurável via `FISCAL_EMISSAO_TIMEOUT_MS`, default 120000 ms).
- Conclusão: Timeout de impressão de ~20s está em código e respeitado; o checkout não fica bloqueado salvo quando o cliente usa explicitamente `sync` na chamada de emissão.
- Correção nesta rodada: verificado e confirmado que `PRINT_JOB_TIMEOUT_TOTAL_MS` existe e é aplicado; não foi necessária alteração.
- Pendências / recomendações:
  - Garantir que front-end não invoque `sync=1` por padrão no checkout — documentar comportamento `async` por padrão.
  - Documentar no README do PDV os limites de timeout e comportamento em caso de timeout (ex.: venda fica PENDENTE_FISCAL).

4) Logs de erro fiscal: contexto e deduplicação
- Achado:
  - `runtime/loggingService.js`:
    - adiciona contexto automático (correlationId, tenant, empresa, caixa, usuario).
    - extrai `erro` e `stack`, enriquece com sugestão de ação (`logSuggestions`).
    - implementa deduplicação dinâmica (`isRecentDuplicate`) para WARN/ERROR dentro de janela `LOG_DEDUP_WINDOW_MS` (default 1000ms) — evita spam de sondagens (p.ex. impressora).
  - `filaFiscal` e serviços fiscais registram `numeroVenda`, `correlationId`, `jobId`, `cStat` nas mensagens de erro.
- Conclusão: Logs incluem contexto suficiente para investigação (venda/correlationId/tenant) e dedup evita duplicação de entradas idênticas.
- Correção nesta rodada: `loggingService` foi atualizado para leitura dinâmica da janela de dedup e foi testado; fix aplicado.
- Pendências / recomendações:
  - Incluir `payload` sanitizado (ou campos-chave) em logs de `FALHA_PERMANENTE` para diagnóstico rápido, tomando cuidado para não vazar segredos. Hoje `filaFiscal.salvarResultadoEmissao` guarda `resultado` separadamente.
  - Instrumentar métricas de contagem por `cStat` para permitir visualização de padrões (p.ex. picos de 999).

Resumo das correções aplicadas nesta rodada (vs estado prévio)
- Corrigido: import ausente de `fiscalDhEmiIni` no driver `fiscal/drivers/acbrLibDriver.js` (evita ReferenceError ao montar INI com `documentIni`).
- Confirmado: validações de payload (`fiscalValidacao.js`, `fiscalValidacaoNfe.js`) são chamadas antes da montagem do INI.
- Confirmado: retry/backoff implementados (`fiscalRetry.js`, `filaFiscal.js`) com max attempts e comportamento especial para cStat=999.
- Confirmado: timeout de impressão (`PRINT_JOB_TIMEOUT_TOTAL_MS` = 20000ms) aplicado e impressão via fila não bloqueia checkout por padrão (reposta async).
- Confirmado: logs enriquecidos com contexto e dedup de WARN/ERROR ativado (`LOG_DEDUP_WINDOW_MS`).

Itens pendentes e recomendações priorizadas
1. Cobrir com testes: cenários de payload inválido não-triviais (campo de endereço parcial, IBGE inválido, payment arrays corner-cases) — prioridade alta.
2. Testes de integração para falhas de rede/SEFAZ que validem backoff e transição de estados na fila — prioridade alta.
3. Documentar política de `sync` no endpoint `/fiscal/emitir` e garantir front-end não usa `sync` por padrão no fluxo de venda — prioridade média.
4. Harden: validar conteúdo de `documentIni` antes de chamar `fiscalDhEmiIni.prepararIniParaEmissao` (atualmente delega) — adicionar validações básicas (dhEmi format) — prioridade média.
5. Métricas: exportar contagem por `cStat` e taxa de retries para alertas operacionais — prioridade média.

Arquivos-chave revisados
- fiscalService.js, acbr.js, fiscalValidacao.js, fiscalValidacaoNfe.js, fiscalRetry.js, filaFiscal.js, fiscalIniPolicy.js, fiscal/drivers/acbrLibDriver.js, print/printJobService.js, print/printExecutor.js, runtime/loggingService.js

Conclusão
- O agente local já implementa os pilares essenciais de robustez fiscal: validação de payload, retry/backoff diferenciado, timeouts de impressão e logs com contexto e dedup. A correção do `fiscalDhEmiIni` eliminou um ponto típico de regressão. Recomenda-se priorizar testes de integração de erro de rede/SEFAZ e cobertura adicional para validações de `documentIni` e cenários limites de payload.

Assinado: Auditoria automatizada (assistente) — acompanhe pendências e posso abrir PRs/tests para as recomendações.

