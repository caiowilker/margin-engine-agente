# Guia de Operação — Agente Local v1.0

Documento para **técnico de campo**. Não exige conhecimento de programação.

---

## 1. Instalação limpa

### Pré-requisitos

| Item | Requisito |
|------|-----------|
| Sistema | Windows 10/11 (recomendado) ou Linux com Node 18+ |
| Node.js | Versão 18 ou superior |
| ACBr Monitor | Instalado e configurado (certificado A1, CSC, ambiente SEFAZ) — apenas se `EMISSAO_FISCAL=true` |
| Porta | **9100** liberada no firewall local (ou a porta definida no `.env`) |
| Impressora | Térmica ESC/POS (USB, rede ou spooler Windows) |

### Sequência — Windows (recomendado)

1. Execute **`Margin-Engine-Setup-1.0.0.exe`** como administrador (instalação, atualização ou reparo).
2. No wizard, confirme o diretório padrão (`%ProgramFiles%\Margin Engine`) e marque **Registrar como serviço Windows**.
3. Ao finalizar, abra **http://localhost:9100** (atalho criado pelo instalador).
4. Digite o **código de ativação** gerado no painel administrativo.
5. Configure certificado, CSC e impressora **no painel** (se necessário).
6. Confirme que a página mostra o agente **online**.

Dados persistentes ficam em **`%ProgramData%\MarginEngine`** (não removidos na desinstalação).

### Sequência — desenvolvimento / manual (Linux ou Windows sem instalador)

1. Clone ou copie o repositório `agente-local` para a máquina.
2. Execute `npm install`, copie `.env.example` → `.env`, ajuste porta e fiscal se necessário.
3. `npm run manifest` e `npm run predeploy`.
4. `node install-service.js` (Windows, como admin) ou `npm start` (foreground).
5. Ative em **http://localhost:9100**.

**Não use caminhos fixos** — o agente resolve pastas via `DirectoryManager` (`%ProgramData%\MarginEngine` no Windows).

### Sequência — manual legado (setup.bat)

```bash
cd agente-local
npm install
cp .env.example .env    # Windows: copy .env.example .env
# Edite .env se necessário (porta, ACBr, impressora)
npm run manifest
npm run predeploy
npm test
npm start
```

Depois acesse **http://localhost:9100** e ative com o código do painel.

---

## 2. Atualização de versão

### Como atualizar sem perder dados (recomendado)

1. Execute **`Margin-Engine-Setup-1.0.0.exe /MODE=update`** como administrador (ou o mesmo instalador sobre a versão existente).
2. O bootstrap preserva **`%ProgramData%\MarginEngine`** (bancos, config, logs, fiscal).
3. Ao finalizar, confira **http://localhost:9100/diagnostico/dashboard** → `manifestOk: true`.

### Atualização manual (desenvolvimento)

1. **Pare o serviço** do agente (Serviços Windows → **Margin Engine** → Parar).
2. **Faça backup** de `%ProgramData%\MarginEngine` (veja seção 6).
3. Copie os arquivos novos **por cima** dos antigos em `%ProgramFiles%\Margin Engine\app\`, **exceto**:
   - Não apague dados em ProgramData.
   - Não sobrescreva `.env` se já estiver configurado — compare com `.env.example` e adicione só variáveis novas.
4. Na pasta do agente, execute:

```bash
npm install
npm run manifest
npm run predeploy
npm test
```

5. **Inicie o serviço** novamente.

### Por que rodar `npm run manifest` após copiar arquivos

O manifest grava o **SHA-256** de cada arquivo `.js`. O agente usa isso para detectar adulteração e permitir auto-update seguro. Se o manifest não bater com os arquivos no disco, o update automático é bloqueado e o dashboard mostra `manifestOk: false`.

**Importante:** gere o manifest **no mesmo PC** onde o agente vai rodar (evita diferença de quebra de linha Windows/Linux).

### Como verificar que o update aplicou

1. Abra **http://localhost:9100/diagnostico/dashboard** (ou `/diagnostico/alertas` com token).
2. Confira:
   - **versão** = `1.0.0` (ou a versão esperada)
   - **manifestOk** = `true`
   - **statusGeral** = `ok` ou `atencao` (não `critico`)

---

## 3. Operação diária

### O que o técnico vê no dashboard

Acesse **http://localhost:9100/diagnostico/dashboard** no navegador do caixa. A página atualiza a cada 10 segundos.

| Indicador | Significado |
|-----------|-------------|
| **statusGeral: ok** | Tudo normal — nenhuma ação necessária |
| **statusGeral: atencao** | Algo merece olhar (fila crescendo, disco baixo, incertos) |
| **statusGeral: critico** | Emissor fiscal offline, disco cheio ou muitos jobs falhos — ação imediata |
| **Emissor fiscal** | Conexão com módulo fiscal (ACBrLib ou monitor fallback). Offline = documentos na fila |
| **fila fiscal** | Jobs pendentes de emissão. Zero ou poucos = normal |
| **incertos** | Emissões com resultado desconhecido (timeout SEFAZ). Recovery tenta resolver |
| **manifestOk** | Integridade dos arquivos do agente |
| **espacoDisco** | Espaço livre para XML/PDF. **critico** = risco de parar emissão |

### Quando ligar para o suporte vs. resolver sozinho

| Situação | Ação |
|----------|------|
| Agente offline (front não conecta) | Ver seção 5 — porta, serviço, `.env` |
| Emissor fiscal offline | Reiniciar serviço Margin Engine; verificar certificado/CSC no painel; se persistir, suporte |
| 1–3 jobs incertos | Aguardar 30 min (recovery automático) |
| Mais de 5 incertos ou > 4h em INCERTO | Forçar recovery (abaixo) ou suporte |
| Disco crítico | Liberar espaço (seção 5); se não resolver, suporte |
| Vendas OK mas NFC-e não sai | Verificar painel fiscal + `EMISSAO_FISCAL=true`; venda segue com cupom não fiscal (fail-safe) |
| Erro após update (`manifestOk: false`) | Rodar `npm run manifest` e reiniciar serviço |
| Token inválido (401) | Reativar terminal pelo painel |

### Como forçar recovery manual

Quando jobs ficam em **INCERTO** por muito tempo:

```bash
curl -X POST http://localhost:9100/diagnostico/recovery \
  -H "Content-Type: application/json" \
  -H "X-Agent-Token: SEU_TOKEN_DO_PAINEL"
```

Ou use o botão **Forçar recovery** no dashboard (se disponível).

Limite: **10 requisições por minuto** neste endpoint.

---

## 3.1 NF-e modelo 55 (além do NFC-e)

O agente suporta **dois modelos em paralelo**:

| Modelo | Documento | Endpoint | Uso típico |
|--------|-----------|----------|------------|
| 65 | NFC-e | `POST /fiscal/emitir` | Varejo / consumidor final no PDV |
| 55 | NF-e | `POST /fiscal/emitir-nfe` | Conversão de cupom / cliente com cadastro completo |

**NFC-e não muda** — o fluxo existente permanece igual.

### Configuração ACBr

O **mesmo ACBr Monitor** e o **mesmo certificado A1** costumam atender NFC-e e NF-e. No ACBr Monitor:

1. Certificado A1 válido (mesmo usado para NFC-e).
2. Ambiente SEFAZ: homologação ou produção (igual ao NFC-e).
3. Layout NF-e habilitado na instalação (padrão no ACBr Monitor Pro).
4. **Não** é necessário duplicar certificado — só garantir que o emitente está cadastrado para NF-e na UF.

No `.env` do agente:

```
EMISSAO_FISCAL=true
ACBR_NFE_ENABLED=true
NFE_SERIE_55=1
NFE_CFOP_PADRAO=5102
AMBIENTE_SEFAZ=homologacao
```

| Variável | Efeito |
|----------|--------|
| `EMISSAO_FISCAL` | Liga emissão fiscal (NFC-e e base para NF-e) |
| `ACBR_NFE_ENABLED` | `false` desliga **somente** NF-e; NFC-e continua |
| `NFE_SERIE_55` | Série da NF-e (contador local separado do NFC-e) |
| `NFE_CFOP_PADRAO` | CFOP padrão quando o item não informa |

### Emissão NF-e

- Endpoint: `POST /fiscal/emitir-nfe` (assíncrono, igual ao NFC-e).
- Consulta: `GET /fiscal/status/:correlationId` — resposta inclui `modeloDocumento: "55"`.
- **Destinatário completo é obrigatório** antes de enfileirar: CPF/CNPJ, razão social, endereço (CEP, município, UF, código IBGE), IE quando contribuinte PJ.
- Se faltar dado, o agente retorna erro **400** com lista `camposFaltando` — não envia para a SEFAZ.

### Homologação SEFAZ

Antes do primeiro uso em produção, emitir ao menos **uma NF-e de teste** com `AMBIENTE_SEFAZ=homologacao` e confirmar autorização na SEFAZ. Testes automatizados (unitário/contrato) **não substituem** essa validação.

### Checklist manual — validar NF-e em homologação (Item 6)

Execute na ordem quando tiver ACBr + certificado configurados:

1. **ACBr Monitor** — certificado A1 válido, ambiente **homologação**, TCP na porta **9200**.
2. **Agente** — `.env` com `EMISSAO_FISCAL=true`, `ACBR_NFE_ENABLED=true`, `AMBIENTE_SEFAZ=homologacao`; subir com `npm start`.
3. **Diagnóstico** — `GET http://localhost:9100/diagnostico/saude` → agente online; ACBr conectado.
4. **Painel** — `/pdv/nfe` (ADMIN/OWNER):
   - **Caminho A:** converter venda existente (cupom não fiscal) **ou**
   - **Caminho B:** “Nova venda para NF-e” (produto de teste, ex. R$ 0,01).
5. **Destinatário** — preencher CPF/CNPJ, nome, endereço completo (CEP → IBGE via ViaCEP).
6. **Emitir** — confirmar emissão; acompanhar status até **CONCLUIDO** ou mensagem de erro.
7. **Se rejeitado** — copiar `cStat` + `xMotivo` da SEFAZ (dashboard agente ou histórico); corrigir dado indicado.
8. **Validar XML/DANFE** — abrir arquivo gerado; conferir destinatário, itens e totais iguais à venda.
9. **Histórico de Vendas** — venda aparece com documento NF-e vinculado (`modelo 55`).

**Não considerar pronto para produção** até este checklist concluir com sucesso em homologação.

### Checklist — qualidade do artefato final (DANFE + cupom + retorno ao usuário)

Execute **após** a primeira NF-e autorizada em homologação (complementa o checklist acima).

#### Item 1 — DANFE NF-e (PDF via ACBr)

| Critério | Como validar |
|----------|----------------|
| Mecanismo | PDF gerado pelo **ACBr Monitor** (`NFE.ImprimirDANFEPDF`); agente salva em `{PATHS.pdf}/{chave}-danfe.pdf` — **não** há conversão Node pós-ACBr |
| Layout | Modelo **55**, `tpImp=1` (A4 retrato) — distinto do DANFC-e térmico (65) |
| Chave + Code128 | 44 dígitos legíveis + código de barras |
| Emitente/destinatário | Razão social, CNPJ/CPF, endereço completo |
| Itens | Código, descrição, NCM, CFOP, unidade, qtd, unitário, total — sem truncamento/sobreposição |
| Totais | Base ICMS, ICMS, total da nota coerentes com a venda |
| Protocolo | Número e data/hora de autorização SEFAZ visíveis |
| Encoding | Sem `?` no lugar de acentos (INI usa ASCII; PDF vem do ACBr/XML) |

#### Item 2 — Cupom NFC-e (impressão térmica)

| Critério | Como validar |
|----------|----------------|
| CNPJ/endereço | Impressão real — sem `?` (agente converte UTF-8 → CP860 via `thermalText.js`) |
| Topo | Sem espaço em branco excessivo (nome da loja em bold, sem `size(1,1)`) |
| Confirmação | **Somente** cupom físico impresso conta como resolvido |

#### Item 3 — QR Code

| Documento | Regra |
|-----------|--------|
| NFC-e (65) | QR obrigatório — escanear com celular → página de consulta SEFAZ com dados da venda |
| NF-e (55) | **Sem** QR no DANFE clássico — validação por chave + protocolo; agente **não** gera QR no PDF NF-e |

#### Item 4 — Retorno ao usuário (painel)

| Tela | Comportamento esperado |
|------|------------------------|
| `/pdv/nfe` | Após CONCLUIDO: botões **Baixar DANFE**, **Visualizar**, **Enviar por e-mail** (se destinatário tiver e-mail) |
| Histórico | Venda NF-e (chave modelo 55): botão **DANFE (PDF)**; NFC-e mantém **DANFC-e** (térmica) |
| Erro SEFAZ | Mensagem com `cStat` + `xMotivo` — nunca só "Erro ao emitir" |

#### Item 5 — E2E homologação (pendente até ACBr real)

- [ ] PDF abre em **2 leitores** (navegador + Adobe/outro)
- [ ] Tamanho > 128 bytes, header `%PDF`
- [ ] E-mail (se usado): anexo não corrompido

**Endpoints úteis:** `GET /fiscal/documento/pdf?chave=…&numeroVenda=…` (agente) · `GET /pdv/vendas/{numero}/nfce/pdf` (backend, fallback)

---

## 3.2 Configuração operacional do agente (Parte F)

**Regra de ouro:** configuração do dia a dia → **painel** (`Configurações PDV` → seção *Configurações do Agente*).  
O arquivo `.env` do agente serve só para:

1. **Primeiro setup** da máquina (categoria B — infraestrutura local: porta, host ACBr, impressora, caminhos).
2. **Emergência** sem acesso ao painel (fallback de boot).

**O que NÃO vai para o painel (permanece no ACBr Monitor):** certificado A1, senha do certificado, CSC, URLs de webservice SEFAZ, `ACBrNFeServicos.ini`.

### Fluxo de sincronização

1. Admin edita config em `/configuracoes/pdv` (por **dispositivo/caixa** em multi-caixa).
2. Backend persiste em `pdv_dispositivo` (`agente_config_json` + flags fiscais).
3. Agente faz polling em `GET /pdv/agente/config` (intervalo `configPollIntervalMs`, padrão 45s).
4. Agente aplica em runtime (`process.env` + `fiscalEnabled`) e confirma via `POST /pdv/agente/config/ack`.
5. Se o backend ficar offline, o agente **mantém o último valor sincronizado** — não regride para o `.env` original.

### Endpoints

| Método | Rota | Quem |
|--------|------|------|
| GET | `/pdv/agente/config/catalog` | Admin (metadados categoria A) |
| GET | `/pdv/dispositivos/{id}/config` | Admin |
| PUT | `/pdv/dispositivos/{id}/config` | Admin |
| GET | `/pdv/agente/config` | Agente (JWT do terminal) |
| POST | `/pdv/agente/config/ack` | Agente |

---

## 4. Troubleshooting

### Emissor fiscal offline

**O que fazer:**
1. Abra o **painel** em http://localhost:9100/diagnostico/painel e verifique status do módulo fiscal.
2. Confirme certificado A1 válido e CSC no painel (ou variáveis `.env`).
3. Se usar monitor fallback: reinicie o processo configurado em `ACBR_MONITOR_EXE`.
4. Reinicie o serviço **Margin Engine** após correção.

**O que NÃO fazer:**
- Não reinstalar o agente inteiro por falha fiscal temporária.
- Não apagar `%ProgramData%\MarginEngine\fila\fila_fiscal.db` — perde fila de emissão.
- Não emitir documento duplicado manualmente para a mesma venda.

### Job preso em INCERTO há mais de 4 horas

1. Anote o `correlationId` ou `numeroVenda` no dashboard.
2. Execute **POST /diagnostico/recovery** (com token).
3. Aguarde 5–10 minutos e atualize o dashboard.
4. Se continuar INCERTO: verifique internet e status SEFAZ da UF.
5. Se persistir > 24h: contate suporte com correlationId e horário.

### Disco cheio

**Onde ficam os arquivos grandes:**

| Local | Conteúdo |
|-------|----------|
| `%ProgramData%\MarginEngine\Fiscal\XML\` | XMLs autorizados |
| `%ProgramData%\MarginEngine\Fiscal\PDF\` | DANFC-e / DANFE PDF |
| `%ProgramData%\MarginEngine\Backup\` | Backups fiscais |
| `%ProgramData%\MarginEngine\data\` | Bancos SQLite |
| `%ProgramData%\MarginEngine\Logs\` | Logs do agente |

**Como liberar:**
1. Confirme que XMLs antigos já foram transmitidos/arquivados no ERP.
2. O purge automático remove arquivos com mais de 180 dias (configurável via `.env`).
3. Para emergência: mova XML/PDF antigos para HD externo (não delete sem autorização fiscal).
4. Limpe logs antigos em `%ProgramData%\MarginEngine\Logs\` (mantenha os últimos 7 dias se possível).

### Agente não sobe

1. **Porta ocupada:** outro processo usando 9100 — altere `PORT` no `.env` ou pare o conflito.
2. **`.env` inválido:** compare com `.env.example`; `PORT` e `ACBR_PORT` devem ser números.
3. **Integridade do banco:** rode `npm run predeploy` — falha em `integrity_check` indica banco corrompido; restaure backup de `%ProgramData%\MarginEngine\data\`.
4. **Serviço Windows:** verifique Event Viewer / log do serviço; tente `npm start` manual no terminal para ver erro.

---

## 5. Configuração de rede

### Desenvolvimento (Vite + agente local)

- Front: `http://localhost:5173` (Vite)
- Agente: `http://localhost:9100`
- O agente **já permite** qualquer origem `localhost:*` por padrão — não é necessário configurar CORS para dev local.

No `.env` do agente (opcional, explícito):

```
CORS_ORIGINS=http://localhost:5173
```

### Produção (terminal PDV)

Quando o front é servido de outro host (IP da loja, hostname interno):

1. Defina no `.env` do agente a origem exata do navegador:

```
CORS_ORIGINS=http://192.168.1.50:5173
```

Use vírgula para múltiplas origens.

2. Alternativa: ative o terminal pelo painel — o campo `frontendOrigin` gravado na ativação também é aceito pelo CORS.

3. Multi-caixa: cada caixa pode ter seu agente em porta diferente (`9100`, `9101`, …). No front, configure `VITE_AGENTE_URLS` como array JSON com uma URL por agente.

### Mixed content (HTTPS → localhost)

Navegadores modernos exigem o header `Access-Control-Allow-Private-Network: true` no preflight — o agente já envia automaticamente.

---

## 6. Backup e restauração

### Onde ficam os dados

Todos os dados persistentes ficam em **`%ProgramData%\MarginEngine`** (Windows) ou no caminho definido por `MARGIN_ENGINE_ROOT`.

| Arquivo / pasta (relativo à raiz) | Função |
|-----------------------------------|--------|
| `Config/config.json` | Configuração do PDV (sem token em texto puro) |
| `fila/fila.db` | Fila offline de vendas + EPEC |
| `fila/fila_fiscal.db` | Fila de emissão NFC-e |
| `data/fiscal_metrics.db` | Métricas de performance |
| `data/audit.db` | Log de auditoria (operações sensíveis) |
| `Logs/` | Logs do agente (LoggingService) |
| `Fiscal/XML/` | XMLs fiscais |
| `Fiscal/PDF/` | PDFs DANFC-e |
| Credenciais | Windows Credential Manager (token do backend) |

### Backup manual

1. Pare o serviço do agente.
2. Copie **`%ProgramData%\MarginEngine`** inteira para pendrive ou nuvem.
3. Anote a versão: `GET http://localhost:9100/diagnostico/saude` → campo `versao`.

### Restaurar em troca de máquina

1. Instale o Margin Engine na máquina nova (seção 1).
2. Pare o serviço.
3. Restaure `%ProgramData%\MarginEngine` no mesmo caminho padrão.
4. Rode `npm run manifest` na pasta do app (`%ProgramFiles%\Margin Engine\app`).
5. Reative pelo painel **somente se** o token/cofre não foi migrado (Windows Credential Manager não migra entre PCs — nesse caso, gere novo código de ativação).
6. Inicie o serviço e confirme `manifestOk: true` no dashboard.

---

## Contatos e referências

- Contratos API front/back: `docs/CONTRATOS_API.md`
- Compatibilidade v1.0: `docs/COMPATIBILIDADE_V1.md`
- Limitações de arquitetura: `docs/LIMITACOES_ARQUITETURA.md`
- Nota técnica de capacidade: `docs/NOTA_TECNICA_V1.md`
- Histórico de versões: `CHANGELOG.md`
