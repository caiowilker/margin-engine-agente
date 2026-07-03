# Auditoria Arquitetural Completa — Fluxo Fiscal (NFC-e / NF-e)

Data: 2026-07-03
Repos analisados:
- margin-engine (backend)
- margin-engine-front (frontend)
- agente-local (agent)

Objetivo
- Mapear fluxo ponta a ponta para NFC-e (modelo 65) e NF-e (modelo 55), verificar validações, idempotência, retry/backoff, timeouts de impressão, observabilidade e cobertura de testes. Priorizar achados e recomendar próximos passos (sem aplicar mudanças aqui).

SUMÁRIO EXECUTIVO
- O ecossistema implementa os pilares essenciais: validação no backend (Java), validação no agente (JS), fila local com retries/backoff, emissão via ACBr (lib/parity), persistência de documentos e callbacks ao backend. As deficiências mais críticas são lacunas de testes de integração de falhas de rede em escala, riscos operacionais em picos (rate limits SEFAZ por UF) e necessidade de testes controlados de contingência EPEC ponta a ponta.

1. Correção ponta a ponta
- Fluxo NFC-e (modelo 65) — checkout → backend → agente → ACBr → SEFAZ → callback → UI:
  1. Checkout (margin-engine backend) monta venda, marca emitirNfce flag e constrói payload (PdvNfeService / PdvVendaService).
  2. Backend enfileira emissão: POST `/fiscal/emitir` (ou internal enfileira via `fiscalService.enfileirarEmissao`), persistência de resultado PENDENTE em `emissao_resultados`.
  3. Agente-local (fila local `filaFiscal`) recebe payload via endpoint do backend (quando backend chama agente ou agente puxa via sync), grava job EMISSAO na `fila_fiscal` e processa com worker.
  4. Agente monta INI (`acbr.montarIniNfce`) — validações em `fiscalValidacao.js`/`acbr.validarEmpresaFiscal`.
  5. Agente envia para ACBr (native via lib ou parity Monitor TCP) — `acbr.emitirNfce` / `acbrLibDriver`.
  6. ACBr → SEFAZ; resposta de autorização/recusa/pendente retornada ao agente.
  7. Agente persiste documentos (XML/PDF) em `documentos_fiscais`, salva resultado em `emissao_resultados` e agenda callback ao backend (`callbackBackend`) — ou enfileira `CALLBACK_BACKEND`.
  8. Backend recebe callback e atualiza venda/UI (painel PDV) — mostra status CONCLUÍDO / INCERTO / FALHA.

- Fluxo NF-e (modelo 55) — diferenças principais:
  - Backend pode iniciar conversão (post-checkout) ou admin inicia NF-e (PdvNfeService).
  - Validação de destinatário mais estrita (PdvNfeDestinatarioValidator / fiscalValidacaoNfe).
  - Emissão pode exigir fluxo síncrono/assíncrono distinto e geração de DANFE em PDF (potencial trabalho assíncrono por fila GERAR_PDF).
  - Regras adicionais para CFOP, NCM, inscrição estadual; conversão pós-NFC-e (CFOP 5929) requer chave NFC-e autorizada.

- Validação de campos obrigatórios antes de emitir:
  - Backend (margin-engine Java) implementa validações ricas: `PdvNfeService`, `PdvFiscalService`, `PdvNfeDestinatarioValidator`, `NfeDocumentBuilder` e `FiscalBuildContext` validam empresa, itens, NCM/CFOP, destinatário (NF-e), total, etc.
  - Agente-local também valida antes de montar INI: `fiscalValidacao.js` (NFC-e) e `fiscalValidacaoNfe.js` (NF-e) e `acbr.validarEmpresaFiscal`.
  - Risco residual: código nativo/3rd-party (ACBr/parity) ou módulos auxiliares (ex.: `fiscalDhEmiIni`) podem introduzir regressões se não importados/validos — já ocorrida e corrigida (fiscalDhEmiIni). Caso semelhante pode ocorrer em pontos menos testados (e.g., montarIniLib patch paths); mitigação: cobertura de testes e contratos entre camadas.

- Idempotência:
  - Backend evita duplicar vendas via numeroVendaCliente; `fiscalService/enfileirarEmissao` e `filaFiscal.enfileirar` fazem deduplicação por correlationId / numeroVenda e verificam `vendaJaConcluida`.
  - Porém, emissão fiscal pode gerar múltiplas notas se retries / timeouts forem mal coordenados na borda: `filaFiscal.enfileirar` previne duplicação por job/payload quando já existe job ativo ou resultado concluído — mitigação já presente.
  - Risco residual: se dois requests distintos (com correlationId diferente) forem enviados para a mesma venda por erro de cliente/frontend, há chance de duplicação. Recomendação: garantir que frontend/retries usem correlationId persistente por venda.

- Contingência EPEC:
  - Implementação presente (`acbr.emitirEpec`, `PdvContingenciaService`) e há testes unitários/certification (mfcs cases) que incluem contingência.
  - Não está claro se existe um teste de integração que simule queda SEFAZ e valida recuperação automática ponta a ponta (backend→agente→EPEC→retransmit) em ambiente real. Recomendação: teste-integration que simule SEFAZ indisponível e confirme reenfileiramento e retransmissão automática quando SEFAZ retorna.

2. Escalabilidade
- Backend (margin-engine):
  - O backend centraliza montagem de payload e enfileiramento; processamento de emissões é delegado ao agente local via callback/agent API (arquitetura distribuída).
  - Ponto de serialização: a fila de vendas e a numeração fiscal (reservas) podem ser centralizadas no backend (fiscalNumeracao) — risco de serialização se muitas lojas interagirem com mesma série/numeração controlada centralmente.
  - Para 50 lojas simultâneas:
    - Backend enfileira vendas em DB e dispara chamadas ao agente. O gargalo provável é a reserva de numeração e operações síncronas de consulta de config (configSync) ou locks de numeração se todas competirem pela mesma série.
  - Recomendações: avaliar escalar numeração por tenant/região, aumentar paralelismo de workers e usar backpressure para evitar contenção.

- Agente local:
  - É stateful no nível local (fila.db), projetado para processar localmente e tolerar desconexões com backend.
  - Se receber rajada de vendas, fila.db crescerá; `filaFiscal` tem limites configuráveis (FISCAL_QUEUE_WARN_MAX/CRITICAL). Quando ultrapassados, fiscalAlertas.verificarFila é invocado (alerta) — isso protege em nível operacional.
  - Com disco suficiente, agente enfileira indefinidamente, mas operacionalmente isso causa atraso e risco de reprocessamento em massa ao restaurar conectividade.
  - Recomendações: políticas de retenção/eviction, monitor de uso de disco, e limitação de taxa de aceitação de emissões por intervalo.

- Rate limit SEFAZ por UF:
  - Não existe código que implemente throttling global por UF no agente ou backend. `fiscalRetry` contém heurística para cStat 999 e limites de tentativas reduzidas, mas não throttling por UF.
  - Risco: picos (Black Friday) podem exceder limites SEFAZ e provocar bloqueio (cStat 999 em massa).
  - Recomendações: implementar rate-limiting por UF (token-bucket) e backpressure na fila local para escalonar reenvios por UF.

- Reprocessamento em massa:
  - Fila local usa backoff por job (`agendarRetry` com BACKOFF_MS). Quando SEFAZ retorna, jobs agendados com proxima_tentativa irão expirar e serem processados; o worker processará conforme prioridade.
  - Risco: se muitos jobs ficam prontos simultaneamente, pode ocorrer "thundering herd" — mitigate com jitter, staggered retry e taxa máxima de reprocessamento.

3. Observabilidade e recuperação
- Distinção erro de código vs falha operacional:
  - `fiscalRetry.isPermanente` / `isTransient` / `isIncerto` tentam classificar erros por cStat e padrão de mensagem; loggingService enriquece registro com causa/acaoRecomendada.
  - Em logs, há contexto (correlationId, numeroVenda, tenant, module), permitindo triagem. Dedup evita spam.
  - Em geral operador consegue distinguir com logs; porém alertas proativos podem faltar.

- Alertas proativos:
  - `fiscalAlertas.verificarFila` é chamado quando fila atinge thresholds; existe gravação de status em `/diagnostico/saude` e painel.
  - Recomenda-se alerta configurável (eg. webhook/SMS) quando jobs pendentes por > X minutos, ou retries > N em janela.

- Painel de diagnóstico:
  - Rotas `/diagnostico/*` agora servem HTML e JSON (corrigido SW). Cobertura de rotas inclui `alertas`, `fiscal`, `logs/fiscal`, `saude`, `pacote`, `relatorio`, `preflight/refresh`.
  - Escopo: painel cobre os cenários investigados (impressora, fila, logs). Recomenda-se adicionar painéis de métricas por `cStat`, retries por tenant e taxa de reemissões.

4. Cobertura de teste
- Suites existentes:
  - margin-engine: ampla suíte Java (MFCS certification, PdvNfeServiceTest, ParidadeMonitor tests) — muitos casos fiscais e montagem de INI validados.
  - agente-local: 600+ testes JS cobrindo validação, retry, print, dhEmi fix, path quoting, printer status unified, etc.
- Gaps críticos:
  - Testes de integração ponta a ponta com SEFAZ real ou mock que simule queda e recuperação em escala (múltiplas lojas simultâneas).
  - Testes de carga: emissão simultânea de 50+ lojas para validar numeração, rate limits, contenção de DB/locks.
  - Testes de throttling por UF e stress tests para verificar "thundering herd" ao retornar SEFAZ.
  - Testes de EPEC ponta a ponta (incluir backend ↔ agente ↔ ACBr parity/native com SEFAZ indisponível e posterior retransmissão).

Prioridade de achados (CRÍTICO / ALTO / MÉDIO)
- CRÍTICO
  1. Ausência de rate-limiting por UF — risco real em picos (já identificado em campo por cStat 999 em logs). Risco: bloqueio de emissões por SEFAZ (impacto operacional amplo). (Probabilidade: alta em grandes promoções; Impacto: alta)
  2. Falta de testes de integração e carga para cenário retorno SEFAZ (thundering herd) — risco de tempestade de reprocessamentos. (Probabilidade: média; Impacto: alta)

- ALTO
  1. Dependência de bibliotecas/patches nativos (ACBr, fiscalDhEmiIni) — regressões possíveis se módulos não carregarem; já ocorreu. Necessário adicionar contratos e testes mock. (Probabilidade: média; Impacto: alta operacionalmente)
  2. Potencial de duplicação fiscal quando correlationId não for corretamente preservado pelo frontend/clients. (Probabilidade: baixa-média; Impacto: alta por nota duplicada)
  3. Fila local crescendo sem backpressure operacional (disk growth, delays) — causa pendências e complexidade de recovery. (Probabilidade: média; Impacto: médio-alto)

- MÉDIO
  1. Logs e métricas faltando agregação por `cStat` e por tenant para operação proativa. (Probabilidade: alta; Impacto: médio)
  2. Documentação e testes faltando para validação de `documentIni` (entradas pré-montadas por backend). (Probabilidade: baixa; Impacto: médio)

Recomendações de ação (ordem proposta, sem implementar mudanças aqui)
1. CRÍTICO: Implementar rate-limiting por UF e jittered/staggered retries no agente; adicionar token-bucket global por UF. (sprint 1)
2. CRÍTICO: Criar testes de integração e carga simulando SEFAZ down e retorno com 50+ lojas; validar comportamento de filas, backoff e numeração. (sprint 1–2)
3. ALTO: Fortalecer contrato entre backend ↔ agente: correlationId obrigatório por venda; frontend deve reusar correlationId para retries. (sprint 1)
4. ALTO: Harden para dependências nativas: healthchecks de lib, fallback bem definido, e testes de parity automatizados na pipeline. (sprint 2)
5. MÉDIO: Expor métricas por `cStat`, retries por tenant e painel de alerta; criar alertas proativos quando fila cruza thresholds. (sprint 2)
6. MÉDIO: Adicionar validação adicional e testes para `documentIni` e casos corner de payload.

Conclusão
- Arquitetura atual é sólida e já resolve vários problemas (validação, fila, retry, dedup de logs). As principais fragilidades são operacionais e de escala (rate limits SEFAZ, thundering herd) e testes integrados de recuperação. Corrigir essas áreas reduz risco de indisponibilidade em picos e evita notas duplicadas e esforços de suporte.

Próximo passo sugerido (opcional)
- Posso abrir PRs separados com:
  1) Testes de integração que simulam SEFAZ indisponível/recuperação;
  2) Implementação de throttling por UF (agent/backend);
  3) Testes de carga simples para numeração/fila.

