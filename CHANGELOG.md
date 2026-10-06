# Changelog

Todas as mudanças relevantes do Agente Local Margin Engine são documentadas neste arquivo.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

## [Unreleased]

## [1.0.50] - 2026-10-05

### Changed — modo noturno (2026-10-06)

- Pedido Rápido sempre ligado: removidas a chave global `margin.pedido-rapido.habilitado` e as checagens de `pedido_rapido_habilitado` no front (coluna mantida, não lida). Temas Claro/Escuro/Sol sempre ligados (sem `VITE_THEME_STRATEGY_V1`).

### Added — Pedido Rápido: tela de sucesso ao vivo

- Status do pedido atualiza sozinho pelo WebSocket da Central (`/ws/order-central`); sem WebSocket, consulta o board a cada 5 s com backoff até 30 s (para após 15 min).
- Indicador de impressão via `GET /order-engine/print/orders/{id}`: Enfileirado (fila ou despachado), Impresso (só com confirmação da impressora), Falhou, Sem impressora.
- Botão "Confirmar" (Recebido → Confirmado) envia `expected_workflow_status`; se o pedido já mudou, mostra "O pedido já mudou para <status>" e atualiza sem mover.
- Envio automático da confirmação: "Confirmação enviada ao cliente"; sem WhatsApp vinculado, "Copiar confirmação".

### Added — Central de conversas da IA do WhatsApp

- Conversas têm estado (Ativa, Precisa de você, Pausada, Resolvida), última atividade e quem pausou/retomou/resolveu e quando (migration aditiva `V20261101`; sem texto de mensagem).
- API `/order-engine/central/whatsapp-ai/conversas`: lista com filtro, busca por telefone e paginação; `POST {id}/pausar|retomar|resolver` idempotentes, auditados (`whatsapp_ai_conversa_auditoria`) e restritos à loja do token. Perfis Contador, Vendedor e Fiscal não acessam (403).
- Conversas pausadas voltam para a IA depois de `margin.whatsapp-ai.conversas.auto-retomar-horas` (padrão 12 h; job com ShedLock a cada 5 min).
- Evento `whatsapp_ai_conversa` no WebSocket da Central e alerta aos operadores (`WHATSAPP_IA_AGUARDANDO_HUMANO`) quando o cliente precisa de alguém.
- Limpeza LGPD do log de mensagens por `margin.whatsapp-ai.message-log.retencao-dias` — **sem padrão** (vazio = não apaga); também limpa o último texto da conversa.
- Central de Pedidos: botão "Conversas" com contador de quem precisa de você; painel com filtros (Precisam de você, Ativas, Pausadas, Todas), busca, ações Ajuda / Retomar IA / Resolver, som opt-in com botão mudo e "Abrir pedido" (abre o Pedido Rápido com o telefone; só preenche rascunho vazio).

### Fixed — Pedido Rápido: E2E e tela estreita

- Catálogo: Enter logo após digitar a busca adicionava o primeiro item da lista antiga (busca adiada); agora usa o termo atual.
- Painel estreito: barra de total não vaza 8 px para fora (sem rolagem horizontal); botões pequenos com 44 px de altura; link "Não é nenhum destes? Buscar outro" quebra linha; atalhos de teclado e selos dos itens com 12 px e contraste AA nos três temas (selos usam os pares `*-bg`/`*-text`); aviso informativo não bloqueia o clique no que está por baixo.
- E2E: PRICE_CHANGED (cotação seguinte já com o preço novo), catálogo (tipo como `radio`), canário delivery (sacola lateral, checkout em etapas, volta ao Hub) e mesa (botão "Faturar pedido") alinhados à UI atual.

### Fixed — IA do WhatsApp muda para sempre após handoff

- Janela de sessão configurável (`openai.whatsapp-ai.session-window-hours`, padrão 12 h): sem mensagem do cliente nesse período, o contador de turnos zera e a IA volta a responder, inclusive depois de um handoff. Mensagens do cliente durante o atendimento humano renovam a janela. `0` desliga.

### Docs

- `margin-engine/docs/pendencias-pos-release.md`: vTroco na NFC-e em nuvem, forma de pagamento trocável no faturamento, mensagens fixas no código, resposta humana pelo celular do atendente.

### Fixed — PIX perdia o agendamento

- Pedido do cardápio QR agendado e pago por PIX (Asaas ou manual) agora guarda `agendado`/`agendadoPara` enquanto aguarda pagamento e entra em `AGENDADOS` (não `RECEBIDOS`) quando o PIX é confirmado.

### Fixed — trava de status na Central

- `POST /order-engine/central/orders/{id}/workflow` aceita `expected_workflow_status` opcional: se o pedido já mudou, responde `409 {code: WORKFLOW_STATUS_CHANGED, atual}` sem alterar nada. Sem o campo, comportamento anterior. Front: `orderEngineApi.moveWorkflow(id, destino, esperado?)`; erros HTTP passam a expor `code`/`payload`.

### Fixed — impressão enganosa

- Agente: toda resposta `202` com `fila: true` agora traz `status: "ENFILEIRADO"` e `impresso: false`; só `200` sem fila é `IMPRESSO` (`print/printHttpResposta.js`).
- Estação de impressão (front): fila do agente não confirma o job como impresso — envia ack `queued` (servidor mantém `DISPATCHED`) e só confirma quando o job local do agente chega a `IMPRESSO` (ou falha).
- Back: `GET /order-engine/print/jobs` inclui `orderId`; novo `GET /order-engine/print/orders/{orderId}` → `ENFILEIRADO | DESPACHADO | IMPRESSO | FALHOU | SEM_ESTACAO`; ack aceita `queued`.

### Added — Pedido Rápido, fase 1 (backend, aditivo)

- Novo namespace `/order-engine/pedido-rapido/*` (catálogo com ETag, cliente por telefone com repetição, cotação no servidor, criação idempotente de pedido, apelidos de produto, telemetria). Endpoints existentes sem alteração.
- Flag por loja `pedido_rapido_habilitado` (padrão desligada) e `pedido_rapido_janela_duplicidade_min` (padrão 10) como campos opcionais de `GET/PUT /order-engine/config`.
- Migration aditiva `V20261097` (coluna de apelidos, flag, tabelas de idempotência e auditoria) com rollback em `docs/rollback/`.
- Agente local: sem mudança de comportamento; versão alinhada ao release.

### Added — Pedido Rápido, fechamento da fase 1 (1.1)

- Canal persistido `order_engine_order.canal_entrada` (`V20261098`, nulável, só metadado): `PEDIDO_RAPIDO` gravado pelo servidor; exposto como campo opcional `canal_entrada` em `OrderResponse`, `OrderSummaryResponse`, card do kanban (board e WebSocket) e `OrderBusPayload` — omitido quando nulo, JSON dos demais pedidos inalterado.
- Índice de telefone em `V20261099` sem `CONCURRENTLY` no Flyway: criado só em tabela ≤ 100 mil linhas, repara índice INVALID; tabela grande usa procedimento manual `CREATE INDEX CONCURRENTLY` (runbook + `docs/pedido-rapido/sql/`).
- `quoteHash` e hash de idempotência com codificação canônica própria + SHA-256 (sem `hashCode`/Jackson), estáveis entre reinícios; quoteHash ignora campos voláteis e complementos em outra ordem.
- Falhas internas do Pedido Rápido não expõem mensagem interna (500 genérico).
- Testes: PostgreSQL real (migrations com locks por comando, rollback/reaplicação, idempotência concorrente), regressão da ACL de sessão de piso em todas as rotas, contrato de origem (Hub, mensagens, KDS, relatórios).
- Docs: `decisoes.md`, runbook de migração/rollback/carga, k6 de `/cotar` e `/pedidos`, divergências D-12 a D-14 e decisão do D-09 (paridade).

### Added — Pedido Rápido, fase 2 (interpretador no front, sem rede)

- Núcleo TypeScript puro em `margin-engine-front/src/modules/pedido-rapido/core/`: segmentação de conversas do WhatsApp (Web, Android, iOS, texto livre), extração de telefone/CEP/endereço/pagamento/tipo, matcher por trigramas com faixas ok/confirmar/ambíguo/não reconhecido, correções ("tira", "troca", "na verdade") e mapa de posições para destacar o texto original.
- Golden tests com casos sintéticos, avaliação com baseline (`npm run eval:pedido-rapido`), cobertura ≥ 90 % (`npm run test:pedido-rapido:coverage`) e ESLint impedindo React/rede/imports de fora no núcleo.

### Added — Pedido Rápido, fase 3 (tela no ERP)

- Tela `/pdv/pedido-rapido` (mesmas guardas da Central): colar conversa (Ctrl+V em qualquer ponto ou botão de área de transferência), revisão com ✓/⚠/✖, busca de produto, "Lembrar este apelido", endereço com CEP, pagamento, cliente pelo telefone com "Repetir último pedido", botões de copiar e mensagens rápidas editáveis.
- Valores só do servidor (`/cotar` com debounce de 300 ms, cancelamento e proteção contra resposta fora de ordem); catálogo em cache no IndexedDB com ETag; `Idempotency-Key` reaproveitada nas novas tentativas; diálogos para `PRICE_CHANGED`, duplicidade e loja fechada.
- Rascunho só no navegador (por loja + usuário, 4 h); telemetria agregada em lote. Backend: tipos de evento aditivos em `/eventos` (`itens_ok`, `itens_confirmar`, `itens_ambiguos`, `itens_nao_reconhecidos`, `correcao_feita`, `repetir_pedido`).
- Central de Pedidos: com a flag `pedido_rapido_habilitado` ligada, "Novo pedido" abre a tela nova e o menu antigo vira "Pedido manual (mesa/balcão)"; com a flag desligada, nada muda.
- Módulo isolado (ESLint bloqueia `api/api`, `AuthContext`, `react-router`, `usePlanFeatures`); testes de unidade, componentes (Testing Library) e e2e (Playwright), com capturas nos temas Claro, Escuro e Sol.

### Added — Pedido Rápido, fase 4 (modo painel ao lado do WhatsApp Web, só front)

- "Abrir ao lado do WhatsApp": janela estreita (~440 px) à direita com altura útil, tamanho/posição lembrados por aparelho; `?painel=1` sem menus do ERP; pop-up bloqueado mostra como liberar.
- "Janela flutuante" (Document Picture-in-Picture, Chrome/Edge 116+, só com suporte): mesma tela por portal, tema espelhado, atalhos, colar e clipboard funcionando; fechar mantém o rascunho.
- Um rascunho ativo por vez entre janelas/abas (trava com `BroadcastChannel` + evento `storage`, "Continuar aqui"); painel com rascunho pergunta "continuar" ou "novo".
- Layout por container queries (estreito < 480 px com rótulos curtos e ações no rodapé, médio, largo ≥ 900 px em duas colunas); chips de status a 12 px no módulo.
- E2E com matriz 360–1280 px × zoom 90/100/125 % × 3 temas (sem rolagem horizontal, nada cortado, controles alcançáveis, contraste AA), capturas por largura e tema, roteiro de teste manual.
- O painel não herda o id de aba da estação de impressão copiado pelo `window.open` (evita disputa de liderança — divergência legada D-15, não corrigida).

### Changed — Pedido Rápido, fase 3.1 (redesenho UX/UI, sem mudar regras de cotação/criação)

- Backend aditivo: `GET /order-engine/pedido-rapido/catalogo` traz `imagemUrl` (miniatura pública do cardápio, só URL http(s), sem base64) e `loja` (cidade/UF padrão); o ETag muda quando a foto ou a cidade mudam. `POST /cliente/buscar` traz `totalPedidos` (pedidos não cancelados do telefone).
- Projetado primeiro para o painel (~400 px): uma coluna com barra fixa (total + "Criar pedido"); ≥ 900 px em duas colunas com resumo fixo de 340 px e rolagem interna; sem rolagem horizontal em 360–1280 px nos 3 temas.
- Cartão "Cliente" no topo: selo Recorrente/Novo, nº de pedidos, último pedido, até 3 chips "Pediu antes" com miniatura (1 toque adiciona) e "Repetir último pedido"; cliente novo só precisa de telefone (nome opcional).
- Itens com foto (lazy, dimensão fixa, esqueleto, ícone da categoria como fallback), stepper, subtotal e menu "⋯"; ambíguo com até 3 opções (clique ou teclas 1–3) e "Lembrar apelido" só após a escolha; não reconhecido com busca e "Ignorar item".
- Catálogo em gaveta/folha ("/"), com busca, categorias, grade de fotos e "Pediu antes"; endereço com CEP primeiro e cidade/UF da loja; pagamento segmentado com troco só em dinheiro.
- "Criar pedido · R$ X" nunca fica morto: com pendência leva o foco até ela; sem pendência abre a Conferência (Enter confirma; pode ser desligada neste computador), substituindo a caixa "Conferi". Duplicidade e loja fechada mantêm a 2ª confirmação.
- Limpar sem diálogo, com "Desfazer" por 6 s. Sucesso mostra número, status, "Confirmação enviada ao cliente" (quando automática) ou "Copiar confirmação", "Ver na Central" e "Novo pedido".
- Menu "Copiar": resumo, total com taxa, chave PIX, link do cardápio (definido neste computador) e mensagens rápidas com título e várias variações (não repete a última); aceita `{nome} {numero} {total} {pix} {cardapio}` e `{customerName} {orderNumber} {storeName}`.
- Interpretação em Web Worker para textos longos (fallback na thread principal); números tabulares; animações de 120–180 ms respeitando movimento reduzido.

### Fixed — Tema Escuro (só front; Claro e Sol inalterados)

- Blocos brancos/ilegíveis no Escuro vinham de cores literais em `style={{…}}`, que não passam pelo remap de tokens. Nova rede gerada `src/styles/dark-inline-guard.css` (`npm run sync:dark-guard`, verificação `npm run check:dark-guard` + teste que falha se o CSS estiver desatualizado): só tela e só `html.soft`, troca fundo claro por superfície grafite/tinta do mesmo matiz, texto escuro por tom claro, borda clara (inclusive cor de borda usada em template), trilho cinza de toggle, sombra colorida clara, chip com texto de cor média e accent/accent-dark com texto branco. Corrige listas e tabelas (Clientes, Estoque, movimentações, Ranking, Curva ABC), abas/filtros (Gráficos, Comissões, Configurações, Trust Score, agendamentos/períodos da Locação), cards e stepper da Locação, “Como funciona” do KDS, toggle de Contas a Pagar na NF de entrada, Classificação/Categoria do produto.
- Prévias de impressão (2ª via, DANFE, comprovante de locação) marcadas com `data-pdv-paper`: no Escuro continuam papel branco com tinta escura, como saem na impressora.
- Painel “Funções” do header no PDV: hex arbitrários do Tailwind (`bg-[#E3F6EC]` etc.) mapeados para tokens no Escuro — o item em foco/hover não fica mais branco. Menu Funções da Frente de Caixa: item selecionado com fundo, borda e sombra escuros.
- Logo da sidebar: `BrandLogo surface="auto"` segue o tema do app (antes dependia de `dark:` do Tailwind, que nunca liga); arte da sidebar com placa e “ENGINE” mais legíveis.
- `PlanBadge` com os tons escuros previstos (antes chip lilás claro na sidebar).
- `check:theme` volta a ler o bloco `:root` (o seletor do papel tinha quebrado a extração; falhas restantes são as mesmas de antes).

### Added — Contas a Pagar: pagar com dinheiro do caixa (backend aditivo + front)

- À vista e baixa agora escolhem a origem: "Conta da tesouraria" (como antes) ou "Dinheiro do caixa" (caixa aberto do PDV). Contrato aditivo: `origemPagamento` (`CONTA` padrão / `CAIXA`) e `caixaOrigemId` nos requests; resposta ganha `origemPagamento`, `caixaOrigemId`, `caixaOrigemNome`, `movimentoCaixaId`. Clientes antigos seguem iguais (sem `origemPagamento` = conta).
- Saída do caixa vira SANGRIA vinculada ao título (`pdv_movimento_caixa.conta_pagar_id`): entra na conferência do fechamento e na fita ("Contas a pagar"); o fluxo de caixa financeiro ignora essa sangria porque o título pago já é a saída (sem contar duas vezes).
- Regras: caixa travado e conferido como ABERTO; valor ≤ dinheiro em espécie do caixa (abertura + vendas em dinheiro + suprimentos − sangrias), erro "Dinheiro insuficiente no Caixa X. Disponível: R$ …"; forma sempre DINHEIRO; data de pagamento = hoje da loja; conta e caixa juntos é recusado; exige BAIXAR + GERENCIAR_TESOURARIA (caixa escolhido em tela gerencial, como a transferência). Falha não deixa título nem movimento pela metade.
- Baixa trava a linha do título (PESSIMISTIC_WRITE) para conta e caixa: duplo clique / duas abas pagam uma vez só (a outra recebe 409). Índice único parcial `ux_pdv_mov_caixa_conta_pagar` como defesa extra.
- `GET /finance/contas-pagar/caixas-pagamento`: caixas abertos com operador e dinheiro disponível. Migração `V20261100` só com colunas NULL (rollback em `docs/rollback/`); índice criado no Flyway só com ≤ 100 mil linhas, senão NOTICE + `CREATE UNIQUE INDEX CONCURRENTLY` manual.
- Front: seletor de origem compartilhado (à vista e baixa), caixa pré-selecionado quando só há um, "Restará R$ … no caixa", aviso de falta, botão atualizar, data travada em hoje na baixa pelo caixa, proteção contra duplo envio, chip "Pago com …" nos títulos pagos (também na busca). A barra fixa de navegação deixa de cobrir o painel de lançamento/baixa aberto.

## [1.0.49] - 2026-10-05

### Fixed — Ficha técnica, custos e baixa de estoque (backend + front)

- **Crítico:** `estoque_movimento.tipo` era `varchar(20)` e `CONSUMO_FICHA_TECNICA` tem 21 caracteres — toda baixa por ficha técnica (venda/produção) falhava no Postgres. Migration `V20261096` amplia para `varchar(40)`.
- Venda de fabricado consome primeiro o estoque acabado do depósito e explode a ficha só do restante (antes ignorava o acabado produzido). Packs usam a quantidade de estoque (qtd × fator). Adicionais (modifiers) sempre baixam suas MPs. Tudo em um lote `CONSUMO_FICHA_TECNICA` com `FOR UPDATE` ordenado (mesma ordem da produção — sem deadlock).
- Cancelamento devolve exatamente o que o kardex registrou para a venda (acabado + MPs), não uma reexplosão da ficha atual.
- Custo do fabricado em BigDecimal com rendimento e custos das MPs em lote; recalcula automaticamente quando o custo da MP muda (entrada de nota, estorno, edição do cadastro). Endpoint `POST /padaria/ficha-tecnica/recalcular-custos` + botão “Recalcular custos”.
- CMV da venda de item com receita = consumo real da linha × custo atual das MPs (inclui adicionais).
- Salvar ficha não zera mais o estoque do fabricado; edição do produto não mexe em estoque; ajuste de estoque de fabricado liberado (balanço do acabado). MP inativa é rejeitada na ficha.
- Disponibilidade = estoque acabado + produção possível; alerta de estoque baixo filtrado por tenant.
- Front: ficha valida quantidade/rendimento/MP repetida antes de enviar (não descarta linha inválida em silêncio), permite remover linha e mostra a mensagem real do backend.

### Performance — Emissão NFC-e 65 / NF-e 55

- Prova do certificado A1 (openssl/PowerShell) cacheada por arquivo+senha — não spawna processo a cada nota.
- cStat 104 sem protocolo: consultas por chave em 1,5/3/5/6 s em vez de espera fixa de 15 s (teto mantido; 656 encerra).
- Pós-emissão não varre recursivamente `xml/saida/backup` quando a resposta já traz o protocolo.
- Cópia do log ACBr em sucesso sai do hot path (coalescida a cada 10 s); em falha continua imediata.
- Numeração: varredura de `acbr/xml` cacheada (5 min, elevada a cada autorização).
- Backend: prepare de NFC-e/NF-e com menos round-trips (job criado em 1 INSERT idempotente, listeners sem transação quando o agente local emite, config da reforma em cache).
- Front: polling de conclusão a 500 ms nos primeiros 8 s também no painel/conversão; NF-e não espera `emissao-iniciada` para acompanhar.

### Performance — Faturar pedido / mesa

- Liberação da mesa: limpeza local (rascunho, IndexedDB, snapshot, mapa) imediata; confirmação de mesa livre no agente sai em segundo plano — a navegação não espera mais o ACK. Aviso de mapa local chega por toast global.
- NFC-e disparada na hora mesmo com a checagem do agente ainda pendente (antes caía para o dreno, ~2 min); só não dispara quando o agente está comprovadamente indisponível.
- Preflight do agente reaproveitado: se o agente foi confirmado com emissão ligada há menos de 20 s, a emissão pula o round-trip de verificação. Se o agente cair nesse intervalo, a venda fica pendente fiscal e o dreno emite — sem nota duplicada.

### Fixed — Venda com emissão ligada que terminava sem NFC-e

- Dreno fiscal no agente (a cada 60 s): busca no backend (`GET /pdv/agente/fiscal/pendentes-emissao`) as NFC-e devidas deste terminal (até 72 h, mín. 2 min de idade) e coloca na fila — cobre cupom de segurança no F12 (agente ocupado/offline), prepare que falhou, venda sincronizada do offline e cadastro corrigido depois.
- Nunca gera segunda nota: job ativo é respeitado; INCERTO é só consultado; job em falha é reaberto com o mesmo nNF reservado (SEFAZ 539 recupera a chave existente); nota já autorizada localmente só reenvia o callback.
- Consulta INCERTO esgotada (`ACBr_OFFLINE_TIMEOUT`) volta a consultar uma vez antes de qualquer reemissão; venda INCERTO/PROCESSANDO no backend (após 10 min) também é vista, mas só age com job local — nunca número novo.
- Falha classificada por cStat: transitória (timeout, rede, 108/109/217/656/999) reabre o job com o próprio payload; rejeição só reabre com INI corrigido (senão aguarda o cadastro); duplicidade 539/204 fica para o operador.
- Rodízio com cursor (`apos`) e cota só para trabalho real: vendas travadas no início da fila não impedem as mais novas. Backoff por venda 1→60 min; respeita ACBr ocupado e fila ativa.
- Job concluído sem documento local reenvia o resultado ao backend.
- Catálogo de config Java alinhado com o agente (`fiscalCallbackWorkerMs`, `fiscalPdfWorkerMs`, `fiscalJobStaleMin`).
- Backend: autorização com correlation anterior em venda sem chave é adotada (antes era descartada e a venda ficava “sem NFC-e”).
- Backend/front: sync automático não desbloqueia mais INCERTO/PENDENTE para `NAO_EMITIDA`; só ação explícita do operador (`?desbloquear=true`), e o front recusa desbloquear com job INCERTO/RECUPERANDO/FALHA_TEMPORARIA no agente.
- Front: venda em modo offline com fiscal ligado mantém `emitirNfce=true` (emite quando sincronizar); recusa fiscal 400/422 na sincronização registra a venda sem NFC-e em vez de prendê-la na fila.

### Fixed — Numeração fiscal

- Varredura filtra pelo modelo da chave: NF-e 55 e NFC-e 65 da mesma série não contaminam o contador uma da outra.
- Rebaixamento do contador nunca fica abaixo de nNF já autorizado no índice local ou reservado por job aberto (INCERTO/PROCESSANDO).

### Fixed — Cardápio digital delivery (front embarcado)

- Barra de categorias em abas fixa logo abaixo do menu, junto com a busca; a aba ativa acompanha a rolagem pela posição real das seções e o toque leva a seção exatamente abaixo da barra.
- Menu superior cabe numa linha no celular (altura medida em tempo real; antes a barra fixa ficava por baixo quando o menu quebrava em duas linhas).
- Busca única: não troca mais de campo ao rolar (teclado não fecha mais no meio da digitação); um só botão de limpar; resultado aparece no topo.
- Produto sem foto não mostra caixa cinza vazia: mostra o botão "+" (ou a quantidade na sacola); item esgotado fica esmaecido e sem efeito de toque.
- Nome do produto não é lido duas vezes pelo leitor de tela (imagem decorativa); botão de categorias sem seta "voltar" sem função.
- Cardápio da mesa (QR) com o mesmo padrão: busca + abas fixas numa única barra no topo (antes o cabeçalho compacto e as abas grudavam no mesmo lugar, um cobrindo o outro, e a busca trocava de campo ao rolar); filtros rápidos acima da barra; sem caixa cinza em produto sem foto.

### Fixed — Mapa de entregas (Delivery Hub)

- Mapa real com marcadores: o iframe do OpenStreetMap era bloqueado pela CSP de produção (sem `frame-src`) e não marcava nada; agora o mapa é desenhado com tiles (permitidos em `img-src`), com pinos das entregas por status, motoboys com iniciais, arrastar, aproximar/afastar e "Ver todos". Clique na lista centraliza no item.
- Motoboy com situação do GPS: "Ao vivo", "Atualizado há N min", "Sem sinal há…" (marcador esmaecido) ou "GPS desligado" com orientação; horário lido no fuso da loja. Mostra quantas entregas cada um leva.
- "Abrir no mapa" vai para o Google Maps; entregas mostram cliente, endereço e motoboy.
- Backend: `GET /order-engine/delivery/map` informa `sem_localizacao` (entregas prontas/em rota sem coordenadas); o Hub avisa e soma no total em vez de mostrar "Entregas (0)".
- Sem coordenadas, a lista de motoboys continua visível (antes a tela inteira virava "Sem localização").

### Fixed — App do entregador (link do motoboy)

- GPS com estado visível (enviando / procurando / bloqueado / falha de envio / desligado) e horário do último envio; preferência ligada/desligada salva por loja no aparelho.
- Envio de localização contínuo e econômico: 15 s parado, 6 s em movimento (≥ 80 m), uma requisição por vez, releitura ao voltar para a tela e a cada 45 s se o aparelho ficar mudo.
- Tela mantida acesa durante entregas (Wake Lock) para o GPS não parar com o celular bloqueado.
- Cartão do pedido mostra o que cobrar na porta: valor, forma (dinheiro/cartão/PIX), troco a levar e caução de vasilhame; confirmação de entrega cita o recebimento.
- "Ir até o cliente" abre rota no Google Maps (coordenada ou endereço), botões Ligar e WhatsApp, observações com quebra de linha e conferência de itens.
- Pedido novo atribuído chega destacado ("Nova") e vibra o celular; tempo desde que saiu/foi despachado.
- Falha ao mudar status mantém a mensagem e ressincroniza com a loja (pedido cancelado/reatribuído some sem ficar travado); sair pede confirmação com entregas ativas.
- "Saí para entrega com todos (N)": avisa a saída de todos os pedidos despachados da tela em uma requisição (`POST /public/delivery/driver/me/orders/em-rota`). Cada pedido avança na própria transação — um cancelado/reatribuído não trava os demais, cada cliente recebe o aviso e falhas parciais dizem qual pedido não saiu.
- GPS mais rápido: 1º ponto imediato (posição em cache/rede) seguido do fix preciso; 3 s em movimento (≥ 25 m e acima da precisão, sem ruído parado), 10 s parado, releitura forçada a cada 20 s; envio imediato ao sair para entrega.
- Delivery Hub: com a aba Mapa aberta, posição dos motoboys atualiza a cada 5 s (só o mapa, sem recarregar quadro/cadastro).
- Botão WhatsApp do cartão não estoura mais em celular estreito (mantém a largura do texto; os demais botões cedem espaço).

### Fixed — Central de Operações

- Cabeçalho apagado no tema claro: a central usava o fundo do tema (branco) com textos para fundo escuro. Fundo e cabeçalho agora são escuros fixos.
- Produção mostrava "00:00" sem número do pedido: os tickets chegavam em camelCase e a tela lia snake_case. Agora mostra pedido, estação e o tempo certo.
- Cronômetros da fila e da produção andam em tempo real entre atualizações (antes congelavam até o próximo evento).
- Alertas legíveis ("Pedido parado há 51d 17h — finalize ou cancele" em vez de "74513 min"); pedido esquecido há mais de 24 h não distorce mais o "Tempo médio" (continua em Atrasados).
- Debounce do snapshot não perde mais o estado final: rajadas viram um rebuild a cada 500 ms, com execução final garantida e sem rebuilds paralelos do mesmo tenant (antes eventos na janela eram descartados e a tela ficava desatualizada).
- Snapshot não é montado quando nenhuma central está aberta no tenant; ao conectar/atualizar, vai só para a tela que pediu.
- Tela mostra "Carregando…" até o 1º snapshot (não mais zeros); se o WebSocket não conectar em 2,5 s busca por HTTP e, desconectado, atualiza a cada 20 s com rótulo "Reconectando…" em português.

### Performance — Estações KDS (roteamento produto → estação)

- Tela abre com uma requisição (`GET /order-engine/kitchen/stations/routing`): estações ativas + produtos ativos só com id/código/nome e a estação mapeada. Antes: 3 chamadas, incluindo o catálogo pleno (inclusive inativos, com dados fiscais) só para listar nomes.
- `product-mappings` sem N+1: produtos buscados em uma consulta (antes `findById` por mapeamento — 100+ consultas). Acelera também a impressão automática de comandas Cozinha/Bar, que usa o mesmo endpoint.
- Salvar roteamento em lote: estações e mapeamentos carregados uma vez, só o que mudou é gravado (`saveAll`); antes 2–3 consultas por produto.
- Após salvar estações, a grade de produtos realinha com o servidor (estação removida remapeia produtos para a Cozinha).

### Changed — Tema Escuro (front embarcado)

- Tema "Suave" substituído por "Escuro" (grafite sólido); Claro e Sol inalterados.

## [1.0.48] - 2026-10-05

### Changed — Temas e campos (front embarcado)

- Suave (quente, papel) e Sol (alto contraste, contornado) com identidades distintas; Claro inalterado.
- Contorno de campos/botões no PDV, Portal Fiscal, ERP e modais; telas públicas sempre no Claro; impressão sai no Claro.
- Central de Pedidos: itens do card só ao expandir.

### Chore — Release alignment

- Alinha agente/instalador à versão do front 1.0.48.

## [1.0.47] - 2026-10-05

### Changed — Central de Pedidos (front embarcado)

- Card mostra os itens do pedido; menu de ações dos três pontos refeito; inputs voltam a ter borda.

### Chore — Release alignment

- Alinha agente/instalador à versão do front 1.0.47.

## [1.0.46] - 2026-10-05

### Fixed — Operador em Movimentações/tesouraria

- Movimentações/tesouraria não mostram UUID de operador; baixa ContaPagar grava username/email.

### Chore — Release alignment

- Alinha agente/instalador à versão do front 1.0.46.

## [1.0.45] - 2026-10-05

### Fixed — Transferência PDV (caixa legado)

- Transferência usa `caixaId` quando `dispositivoId` está ausente (caixa aberto legado).

### Chore — Release alignment

- Alinha agente/instalador à versão do front 1.0.45 (transferência caixa legado, KPIs histórico, DataTable Crediário, Clientes).

## [1.0.44] - 2026-10-05

### Chore — Release alignment

- Alinha agente/instalador à versão do front 1.0.44 (lock de terminal + rodapé sidebar condensado).

## [1.0.41] - 2026-10-04

### Chore — Release alignment

- Alinha agente/instalador à versão do front 1.0.41 (temas Suave/Sol + F2).

## [Unreleased]

## [1.0.40] - 2026-10-04

### Improved — frontend-dist (PDV UX)

- Cardápio Delivery marketplace (nav, hero, grid, sacola).
- Hub Relatórios Início/Catálogo/Por tarefa; som da Central persistente e on por padrão.
- Frente sem stepper Total/Formas/Confirmação; CTAs sólidos; Delivery Hub e nav ERP.

### Fixed — Frente de caixa

- Remove o fluxo em 3 passos (Total/Formas/Confirmação) do painel de pagamento.

## [1.0.39] - 2026-10-04

### Fixed — Frente de caixa

- Produto não cadastrado no bip aparece na hora (não espera mais o `/pdv/scan` do backend).

## [1.0.38] - 2026-10-04

### Added — Delivery Fase 2 (agendamento, recompra, checkout)

- Pedidos agendados (`AGENDADOS`), job de liberação, antecipar na Central e config de slots.
- Recompra / carrinho salvo 24h, ViaCEP via backend, checkout mais curto e Pix copia-e-cola em destaque.
- Alinha versão agente ↔ back ↔ front ↔ instalador em `1.0.38`.

## [1.0.37] - 2026-10-04

### Added — Cardápio público Fase 1 (vitrine)

- Backend/front: campos `novidade` e `servePessoas` no menu digital + dados públicos da loja no QR.
- Front: busca instantânea, chips, layout desktop com sacola sticky, upsell, modal Mais informações e imagens responsivas.


## [1.0.36] - 2026-10-04

### Changed — UX sem flags

- Front: remove flags `VITE_UX_*`; Central abas/card, `/pdv/home` e checkout journey ficam sempre ativos para produção.
- Front: limpa scripts/envs/guard de rota ligados ao rollback por flag.

## [1.0.35] - 2026-10-04

### Changed — UX em produção (uso normal)

- Front: UX disponível para uso normal (Central abas/card, `/pdv/home`, checkout journey).
- Front: Delivery Hub logística (empty hero, colunas estreitas, métricas clicáveis) embutido no `frontend-dist` de produção.
- Build `build:pdv-prod`/`homolog`/`local` gera o front de produção.

## [1.0.34] - 2026-10-04

### Improved — Delivery Hub (UX logística)

- Front: topo 2 linhas com papel D6 + link para Central; empty hero quando não há entregas.
- Front: colunas vazias estreitas, hints por etapa, totais R$, SLA legível e métricas clicáveis (fila/mapa/motoboys).

## [1.0.33] - 2026-10-04

### Improved — Programa UX P2–P11

- Front: Central abas por tipo, card SLA.
- Front: DS canônicos + catálogo `/pdv/dev/design-system`; home tiles `/pdv/home`.
- Front: jornada checkout; polish KDS/mesas/dashboard/ERP/devolução; papéis D6 nos hubs.

## [1.0.32] - 2026-10-04

### Improved — Central de Pedidos (UX P1)

- Front: status de pedido em pt-BR (`orderStatusLabel`); remove tag “Faturar” duplicada; 1 CTA preenchida.
- Front: tempo com unidade (`12 min` / `1 h 05` / `desde DD/MM`); selo “De dias anteriores”.
- Front: totais R$ por coluna; toast Desfazer 5s ao mover; label “Pedidos online (hoje)”.

## [1.0.31] - 2026-10-04

### Fixed — Soft PDV sólido (inputs, CTAs, tom)

- Front: tom Suave de PDV — canvas fosco + surfaces/inputs levantados (`#fbfcfd`) para campos legíveis sem glare.
- Front: fallback de campos no shell/diálogos + autofill; `.input-base` e `pdvInputStyle` sem depender de `dark:`.
- Front: CTAs com `textOnAccent` (não mais `surface` cinza no Soft); dashboard/EAN/crediário alinhados a tokens.

## [1.0.30] - 2026-10-04

### Changed — Soft vira claro suave (anti-reflexo), não dark

- Front: tema Suave agora é **claro um pouco mais fosco** que o Claro (canvas `#e2e6eb`, surfaces off-white) — PDV Frente/Painel não usam mais charcoal/OLED.
- Front: classe `html.soft` (migra `theme=dark` legado); Tailwind `dark:` não ativa no Suave.
- Claro permanece congelado como baseline brilhante.

## [1.0.29] - 2026-10-03

### Fixed — Soft mid-solid: leaks e contraste AA no PDV

- Front: fecha vazamentos claros restantes na Frente/Painel (modais, drawers, fila off-line, atalhos, pin pad, peso, suspensas).
- Front: CTA/ícones usam `textOnAccent` (não `surface` cinza); chips de categoria e seleção alinhados ao teal Soft.
- Front: header Soft mid-solid (sem OLED navy); `::selection` usa `--pdv-selection-muted`.

## [1.0.28] - 2026-10-03

### Improved — Soft mid-solid no PDV

- Front: Soft charcoal médio (referência M3Soft), seleção teal AA, CTA fill AA, Painel/Frente sem chips claros bugando.

## [1.0.27] - 2026-10-03

### Fixed — build Windows / TypeScript do front

- Front: props JSX com tokens PDV, badge nav, donut do relatório dinâmico e data local no estoque — desbloqueia `build:pdv-prod` / sync Windows.

## [1.0.26] - 2026-10-03

### Improved — tema Soft Cool Graphite no PDV

- Front: paleta Soft (Cool Graphite) com tokens `--pdv-*` em shells, modais, overlays e Frente; Claro congelado; seletor compacto Claro|Suave no header.
- Front: hub/auditoria de relatórios e testes alinhados à UI atual (abas `role=tab`, empty states, permissão Gerenciamento de Caixa).
- Backend: catálogo de relatórios / auditoria interna (acompanha o front).

## [1.0.25] - 2026-10-03

### Improved — Campanha WhatsApp reativação (UX)

- Front: presets, toggle ativo/pausado, dirty/save, KPIs de resultado, tabela de execuções e link para editar mensagem.

## [1.0.24] - 2026-10-03

### Improved — Crediário + Contas a pagar UX solid

- Status legíveis com badges, empty states com CTA, Escape fecha modais, abas dense, aging/atraso na linha, DataTable minimal com ação.

## [1.0.23] - 2026-10-03

### Improved — Crediário UX operacional

- Front: dashboard acionável (KPIs, atalhos, vencimentos por dia, aging visual), abas sticky, filtros em chips + busca nas listas.

## [1.0.22] - 2026-10-03

### Improved — Contas a pagar (R53) UX operacional

- Front: navegação rápida sticky (urgência, busca, status), KPIs clicáveis, lista agrupada por atraso/hoje/a vencer, Escape fecha painéis.

## [1.0.21] - 2026-10-03

### Fixed — tipagem operacional da balança no painel do terminal

- `PdvTerminalConfigPanel`: preserva `Record` ao ligar `checkoutScaleEnabled` + default `autoConfirmScale` (desbloqueia `build:pdv-prod` / sync Windows).

## [1.0.20] - 2026-10-03

### Added — Checkout scale GA + contratos de carga MGV

- Checkout: leitura de balança no PDV (ENQ/PesoLiquido), hot-path e matriz de aceite.
- Carga MGV: `enviar-agora` com `produtoIds`, slot 409 (`BALANCA_LOTE_EM_ANDAMENTO`), pasta default ProgramData, refila FAILED/TIMEOUT→PENDING (C11).
- UI: seleção≡lote, single-flight, drawer por `produtoId`, banners/feedback de produção.
- Instalador/DirectoryManager: dirs `balanca/{carga,sombra}`; contratos e matriz de aceite documentados.

## [1.0.19] - 2026-10-02

### Fixed — Conversão NF-e emite com toggle da frente desligado

- Drivers NF-e 55 (`emitirNfe` / `emitirNfeLib`) respeitam `forcarEmissao` como a NFC-e já fazia.
- Painel Conversão (`/pdv/nfe`) emite 55 e 65 com “Emissão fiscal” OFF no caixa; checkout continua sem emitir.

## [1.0.18] - 2026-10-02

### Fixed — salão QR: comanda LAN no mesmo kick do cupom

- `pedido_comanda` dispara `processarFila()` na hora (igual cupom/gaveta) — papel sem esperar o poll.
- Exchange floor devolve `code: FLOOR_JWT_STALE` no JSON (front trata sessão morta sem parsear texto).
- Front: delta multi-estação com ACK por estação; mesa com `tableCode` sempre na chave `mesa-kitchen:` (sem folha dupla ORDER_CREATED).

### Fixed — sync Windows build: Schemas via cópia case-aware (DrvFS)

- `sync-windows-build.sh`: exclui `acbrlib/data/Schemas` do rsync principal e copia arquivo a arquivo
  com merge case-insensitive (rsync mkstemp falhava no 9p; `copytree` quebrava em `IssDSF`/`ISSDSF`).
- No NTFS, as duas pastas viram um destino único — XSDs de raiz + versões 1.00/1.01/2.03 no payload.

### Fixed — instalador Windows: schemas XSD sempre no payload e no ProgramData

- Sync (`sync-windows-build.sh`/`.ps1`) copia `acbrlib/data/Schemas` do repo (NFe+NFSe); não depende mais de instalação prévia.
- Bootstrap/`installer-apply-fiscal-config`: `ensureInstallerSchemas` roda sempre (mesmo com `emissaoFiscal=false` ou `.env` existente).
- Inno: Source explícito de Schemas; `assert-installer-payload` valida contagem mínima de XSD.

- **Cupom fiscal em contingência:** XML assinado (tpEmis=9) imprime sem consulta SEFAZ; QR opcional; banner `EMITIDA EM CONTINGENCIA`.
- **Cupom não fiscal intermitente 2–5s:** HANDLE WinSpool permanece aberto entre cupons (USB não dorme); keepalive 5s; path native não espera NFC-e/SEFAZ. Retry de HANDLE velho só em StartDoc/StartPage (nunca após WritePrinter).
- **Relatório térmico de vendas do histórico:** seleção múltipla no `/pdv/historico` envia um job `relatorio` ao agente (`POST /impressora/relatorio`) com produtos agregados — mesma fila da térmica, sem reimprimir N cupons.
- Keepalive USB não enfileira ping enquanto o worker WinSpool ainda está em WritePrinter (mesmo após timeout do job HTTP).
- **Impressão RAW rápida (Win serviço):** tmp/script/DLL em `ProgramData\MarginEngine\impressao\raw`; escrita async; script memoizado (sem I/O sync por cupom); waits `PRINT_CORE_LOCK_WAIT_MS` / `PRINT_PHYSICAL_LOCK_WAIT_MS`; métricas `print.raw_phase` / `print.event_loop_lag` / `physical_lock.wait_timeout`.

## [1.0.17] - 2026-08-28

### Fixed — instalador Windows enterprise (1ª instalação sólida)

- Bootstrap: stop do serviço também no **install**; auto-reparo inline se health falhar; exit code explícito para o Inno Setup.
- Espera do agente: 120s + retry 60s (teto 180s); health in-process com backoff adaptativo.
- SCM: polling com `Atomics.wait` (sem spawn Node a cada poll); fail-fast se pacote empacotado sem `node_modules`.
- `install-service.js`: timeouts maiores no fluxo `--from-installer`; sucesso só com serviço **RUNNING**.

### Fixed — agente sobrevive a restart do serviço Windows

- HTTP sobe antes de SQLite/integrity; boot degradado; recuperação JWT via `/pdv/ativar/renovar`; shutdown limpo SIGTERM/SIGINT.

## [1.0.14] - 2026-08-27

### Fixed — dashboard 7d/30d em PDVs instalados (Essencial/Mercado)

- `frontend-dist` rebuild com `resumoPeriodo` + DRE operacional sem gate `ABC_DRE` no front.
- Datas civis locais (sem deslocamento UTC após 21h BRT).
- `Cache-Control: no-store` em `index.html`, `sw.js`, `registerSW.js`, `version.json` e `manifest.webmanifest` (força UI nova após update remoto).

### Alterado

- Versão **1.0.14** — publicar `dist/update.zip` no CDN e atualizar `PDV_AGENTE_*` no Render.

## [1.0.10] - 2026-08-10

### Fixed — agente “off” no meio da comanda

- `unhandledRejection` **não encerra** mais o processo (só loga) — evita PDV ver agente offline por alguns segundos até o serviço Windows subir.
- Estação: retry curto se agente offline/timeout; **não** manda ack `ok:false` (não queima tentativas → 410); libera claim e refila.

### Fixed — texto "?" no cabeçalho do vasilhame

- Travessão Unicode (`—`) não cabe no codepage ESC/POS → trocado por hífen ASCII: `ETIQUETA - COLE NO VASILHAME`.

### Fixed — vasilhame com um só código de barras

- Removidos dual CODE39 e QR do comprovante; fica só **CODE128** + texto legível.
### Fixed — rota parcial Bar sem Entrega

- Com alguma rota preenchida, `requirePortaForPrintType("entrega")` falha explícito se Entrega estiver vazia (não cai mais na impressora padrão em silêncio).

### Alterado

- Versão **1.0.10** (alinhada ao backend/front do hotfix 410 Gone / soft-redispatch).

## [1.0.9] - 2026-08-10

### Fixed — latência RAW 0.8–3.7s (spawn PowerShell + AddType)

- **Causa:** cada job fazia `execFile(powershell)` + `Add-Type` (300–831ms) mesmo com DLL pré-compilada.
- **Fix:** `PRINT_RAW_BACKEND=auto` → **koffi WinSpool** in-process → host PowerShell **persistente** (AddType 1x) → spawn legado só como fallback.
- Warm real: `warmPrintHotPath` aquece koffi + host persistente.
- Métricas: `print.job_e2e` (enqueue→impresso), `backend` em `print.raw_phase`, warn se etapa >200ms / E2E >1s.
- Bench: `scripts/print-raw-latency-bench.js` (~350ms economizados vs AddType simulado).
- ADR: `.ai/decisions/ADR-raw-winspool-koffi-fast-20260810.md`.

### Alterado

- Versão **1.0.9**.

## [1.0.8] - 2026-08-10

### Corrigido — Elgin i9 barcode "?" (CODE128)

- **Causa raiz:** `escpos.utils.codeLength` omitia o byte `n` do `GS k m=73` para códigos curtos (`{BVAS01`). A Elgin lia `{` (0x7B) como comprimento → imprimia `"?"`.
- **Fix:** `print/barcodeDialect.js` monta Function B corretamente (`1D 6B 49 07 7B 42…`) via `printer.raw`, sem a lib quebrada.
- **Dialetos:** Genérica/Epson, Elgin (dual CODE128+CODE39, largura≤2), Bematech, Daruma, só CODE39.
- **UI:** seletor de dialeto + “Testar código de barras” + confirmação visual Sim/Não (avança dialeto e reimprime).
- **API:** `POST /impressora/teste-barcode` (hex dump) e `POST /impressora/barcode-visual`.
- Testes: `test/barcode-dialect.test.js` (hex Elgin vs bug escpos).

### Alterado

- Versão **1.0.8**.

## [1.0.7] - 2026-08-10

### Corrigido — blindagem impressão (6 frentes)

1. **Claim/fila (com order-engine):** TTL claim 30s no backend; agente serializa RAW (`physicalResourceLock` + `withPrintLock`) — Bar+Entrega no mesmo PC sem corromper buffer.
2. **Anti-dupla / anti-409:** alinhado ao front (leader tab); jobs do incidente prod documentados em `docs/PRINT-HARDENING-SCENARIOS-20260810.md`.
3. **Multi-categoria:** mutex local um job por vez na mesma impressora física.
4. **Observabilidade:** evento `REIMPRESSAO_AUDIT` + log estruturado em 2ª via.
5. **Vasilhame:** CODE128 Epson `{B`; fallback CODE39 com falha forçada testada; QR module 58mm; banner `*** SEGUNDA VIA ***` expandido; texto código em tamanho grande.
6. **Testes A–F:** `test/print-hardening-scenarios.test.js`.

### Alterado

- Versão instalador/manifest **1.0.7**.
- `VERSION` alinhado a `package.json` (1.0.7).

## [1.0.6] - 2026-08-01

### Corrigido

- **Diagnóstico Motor OFFLINE falso:** StatusServico no worker atualizava memória só no filho; o HTTP lia offline. Agora o pai espelha `statusServico`/`testar` (`syncStatusMemoriaFromWorkerResult`). ADR `ADR-diagnostico-motor-memoria-worker-20260801.md`.
- **IE no INI (Monitor):** emitente com apenas dígitos (máscara SIARE `004388631.00-00` → `0043886310000`).
- **CarregarINI XmlNode nulo:** staging preferia `acbrlib/lib/libxml2.dll` legado; agora prioriza `LibXml2/x64` (emissão NFC-e).
- **StatusServico JSON oco:** ACBrLib (`TipoResposta=2`) pode devolver `{Status:{CStat:0}}` vazio enquanto o XML WS (`*-sta.xml`) tem `cStat=107` — fallback lê o XML e evita Diagnóstico OFFLINE / contingência falsa. ADR `ADR-statusservico-json-oco-xml-20260801.md`.
- **Certificado mTLS:** `applyNativeCertConfig` restaura `Certificado.Arquivo/Senha` + `DFe.*`; prova de identidade do PFX; senha `[Certificado]` plaintext no runtime.ini (paridade campo).
- **EMISSAO_FISCAL vivo:** drivers Lib/Monitor não congelam mais o flag no boot (`wrapAcbrExports`); salvar no painel passa a valer na fila e no Diagnóstico sem reinício.
- **Sessão ACBrLib / koffi:** wrapper oficial `@projetoacbr`; soft-abandon **sem** `Symbol.dispose`/`Finalizar` (dispose do pacote envenena koffi); idle Finalizar off por padrão; processo envenenado → `ACBR_LIB_AUTO_RECYCLE` (restart do serviço); lock reentrante; staging NFe≠NFSe; StatusServico cache positivo.
- Self-heal `garantirEmissaoFiscalAtiva` na fila e nas rotas `/fiscal/emitir*` antes de recusar emissão.
- NF-e painel com `forcarEmissao` não depende mais só de `isNfeModelo55Habilitado()` (que exigia toggle on).
- Boot reaplica autoridade local → runtime antes do HTTP/worker.
- `VERSION` alinhado a `package.json` (1.0.6).
- **Win10 impressora/status:** `posprinter.ini` SSOT em ProgramData (migra install-dir legado); status/poll trata porta RAW/TCP salva como conectada mesmo se Get-Printer falhar/timeout; janela `impressaoRecenteOk` 15 min; cache lista Windows 90s; PosPrinter sem overwrite DLL com sessão ativa.

### Alterado

- Versão instalador/manifest **1.0.6**.
- Bootstrap do instalador grava `ACBR_POSPRINTER_INI` em `%ProgramData%\MarginEngine\Config`.
## [1.0.5] - 2026-07-31

### Corrigido

- Timeout do worker ACBr rejeita **antes** de `terminate()` (não segura `physicalLock` por minutos).
- `terminate()` com teto 2s; `taskkill` com hard deadline 6s.
- TCP inválido (`TCP:192168150:9100`) rejeitado na normalização/save; POS80 com modelo `0` → `1`.
- Get-Printer não dispara sob impressão/physicalLock (evita corrida USB + HTTP 502).

### Alterado

- Versão instalador/manifest **1.0.5**.

## [1.0.4] - 2026-07-30

### Adicionado

- **Worker PosPrinter** (`acbrPosWorker` + pool): `terminate()` real no hang, sessão quente, cooldown, fallback in-process.
- **`physicalResourceLock`** + `PHYSICAL_USB_TOPOLOGY=shared|separate` — serializa térmica/NFC-e no mesmo hub USB.
- **`config/printEnvSchema.js`** — SSOT de timeouts; `.env.example` gerado (`npm run generate:print-env` / `check:print-env`).
- ADR: worker + lock físico + schema env.

### Alterado

- Timeouts canônicos alinhados (4s/2s/4s/5s); typo de env → clamp (sem restart do serviço Windows).
- Native RAW e emissão NFC-e sob o mesmo modelo de locks físicos.
- Main bloqueado de carregar PosPrinter com worker ativo; Detectar/force limpa fallback in-process.
- Versão instalador/manifest **1.0.4**.

## [1.0.1] - 2026-07-12

### Adicionado

- **AUTO_UPDATE cobre `frontend-dist/`** — manifest com SHA-256, backup, rollback e validação para agente + PWA.
- `scripts/package-update-zip.js` (`npm run package:update`) — empacota `dist/update.zip` para `PDV_AGENTE_URL_DOWNLOAD`.
- Contrato HTTP front↔agente (`apiContract.js`, `apiContractVersion`) e telemetria de versão no heartbeat.
- Testes: `manifest-updater-front`, `updater-remote-check`, `api-contract`, `heartbeat-version`.

### Alterado

- `manifestUpdater.js` — suporte a subpastas `frontend-dist/` no apply/rollback.
- `scripts/sync-windows-build.sh` — manifest gerado após sync do front.

### Corrigido

- Impressão automática no checkout (via `frontend-dist` neste release) — fluxo fiscal/não fiscal sólido com `cupomModo: SEMPRE`.

## [1.0.0] - 2026-06-19

Primeira versão apta para produção comercial, consolidando cinco fases de hardening fiscal e operacional.

### Adicionado

**Fila fiscal e emissão assíncrona (Fases 1–2)**
- Fila fiscal v2 com estados, deduplicação por `correlationId` e `numeroVenda`, metadados `_fiscalMeta`
- Emissão NFC-e assíncrona (`POST /fiscal/emitir`) com checkout desacoplado da SEFAZ
- Job `GERAR_PDF` fora do caminho crítico de emissão
- Recovery de boot e consulta de chave antes de reemitir (`fiscalRecuperacao.js`)
- Rate limit anti-tempestade SEFAZ por CNPJ (`fiscalRateLimit.js`)
- Métricas persistentes (`fiscalMetrics.js`, `GET /diagnostico/metricas`)
- Purge automático de SQLite e arquivos fiscais (`fiscalPurge.js`, `fiscalStorage.js`)
- Watchdog ACBr com pausa de fila e restart opcional
- Testes automatizados: `fiscal-hardening`, `fiscal-production`, `fiscal-chaos` (21 casos)

**Segurança e integridade (Fase 3)**
- `POST /acbr/nfce/emitir` retorna 410 sem `numeroVenda`; com venda enfileira na fila fiscal
- `manifest.json` com SHA-256 obrigatório; auto-update bloqueado se hash vazio
- Graceful shutdown: `server.close()` + `aguardarJobsAtivos(30s)`
- Verificação de espaço em disco antes de gravar XML/PDF/backup
- Endpoints `GET /diagnostico/alertas` e `GET /diagnostico/saude`

**Resiliência e operação (Fase 4)**
- Backoff de recovery com `tentativas_consulta`, `proximo_retry_at`, `MAX_TENTATIVAS_CONSULTA`
- Checkout front-end fire-and-forget com badge "Emitindo NF..."
- Documento `docs/LIMITACOES_ARQUITETURA.md`
- Scripts `npm run predeploy` e `npm run smoke`

**Observabilidade e multi-caixa (Fase 5)**
- Dashboard HTML inline (`GET /diagnostico/dashboard`, refresh 10s)
- Recovery manual (`POST /diagnostico/recovery`)
- Multi-caixa no front via `VITE_AGENTE_URLS` / `getAgenteUrl(caixaId)`
- Webhooks de alerta (`fiscalAlertas.js`) e relatório diário (`fiscalRelatorio.js`, `GET /diagnostico/relatorio`)
- Alias `GET /fiscal/status/:correlationId`
- Manifest com 27+ arquivos SHA-256

**Release (Fase 6)**
- Headers de segurança globais (`X-Content-Type-Options`, `X-Frame-Options`)
- Rate limit separado para diagnóstico (10 req/min em recovery e relatório)
- Purge de `audit.db` configurável (`AUDIT_RETENCAO_DIAS`, padrão 90 dias)
- `CHANGELOG.md`, `docs/OPERACAO.md`, `docs/NOTA_TECNICA_V1.md`
- Deploy alternativo via Docker (`Dockerfile`, `docker-compose.yml`)

**Integração front (Fase 7)**
- `docs/CONTRATOS_API.md`, `docs/COMPATIBILIDADE_V1.md`, `docs/GUIA_COMPLETO.md`
- `test/contract.test.js`, `scripts/smoke-integration.js`
- Alias `CORS_ORIGINS`; tipos alinhados no margin-engine-front

### Corrigido

- Bug `purgeAntigos`: variável `diasDocumentos` não declarada em `filaFiscal.js`
- Front: polling fiscal passa a usar `correlationId` retornado pela API
- Front: `enviarImpressaoCupom` restaurado após desacoplamento fiscal
- `generate-manifest.js`: união de `ARQUIVOS_PADRAO` com manifest existente (27 arquivos)
- Função `contarIncertosComBackoff` restaurada após refactor acidental

### Segurança

- Remoção de `backendToken` de payloads SQLite; sanitização de registros legados
- Logs estruturados sem payload completo de venda (CPF, valor omitidos ou mascarados)
- Token do agente exigido em rotas sensíveis quando PDV ativado
- Credenciais sensíveis no cofre (`credenciais.js`), não em `config.json`

### Limitações conhecidas

- **1 agente = 1 ACBr = 1 caixa** — throughput ~60–120 NFC-e/hora por instância; escalar = uma instância por caixa
- **SHA-256 do manifest** sensível a LF/CRLF — gerar manifest no ambiente de deploy final
- **Supermercado 500+ vendas/dia ou multi-caixa centralizado** exige arquitetura evoluída (ver `docs/NOTA_TECNICA_V1.md`)
- Operação 24×7 contínua em volume alto requer monitoramento ativo e purge configurado
