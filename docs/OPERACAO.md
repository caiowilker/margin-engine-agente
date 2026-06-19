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

1. Copie a pasta `agente-local` para o PC do caixa (ex.: `C:\Program Files\PDV Margin Engine\app\`).
2. Clique com botão direito em **`setup.bat`** → **Executar como administrador**.
3. Aguarde: instala Node (se necessário), roda `npm install`, cria `.env`, instala serviço Windows.
4. Abra o navegador em **http://localhost:9100**.
5. Digite o **código de ativação** gerado no painel administrativo.
6. Confirme que a página mostra o agente **online**.

### Sequência — manual (Linux ou Windows sem setup.bat)

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

### Como atualizar sem perder dados

1. **Pare o serviço** do agente (Serviços Windows → "PDV Margin Engine Agent" → Parar).
2. **Faça backup** da pasta `data/` (veja seção 6).
3. Copie os arquivos novos **por cima** dos antigos, **exceto**:
   - Não apague `data/` (bancos, config, logs).
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
| **statusGeral: critico** | ACBr offline, disco cheio ou muitos jobs falhos — ação imediata |
| **ACBr** | Conexão com ACBr Monitor (porta 9200). Offline = NFC-e não emite |
| **fila fiscal** | Jobs pendentes de emissão. Zero ou poucos = normal |
| **incertos** | Emissões com resultado desconhecido (timeout SEFAZ). Recovery tenta resolver |
| **manifestOk** | Integridade dos arquivos do agente |
| **espacoDisco** | Espaço livre para XML/PDF. **critico** = risco de parar emissão |

### Quando ligar para o suporte vs. resolver sozinho

| Situação | Ação |
|----------|------|
| Agente offline (front não conecta) | Ver seção 5 — porta, serviço, `.env` |
| ACBr offline | Reiniciar ACBr Monitor; se persistir, suporte |
| 1–3 jobs incertos | Aguardar 30 min (recovery automático) |
| Mais de 5 incertos ou > 4h em INCERTO | Forçar recovery (abaixo) ou suporte |
| Disco crítico | Liberar espaço (seção 5); se não resolver, suporte |
| Vendas OK mas NFC-e não sai | Verificar ACBr + `EMISSAO_FISCAL=true` |
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

## 4. Troubleshooting

### ACBr offline

**O que fazer:**
1. Abra o **ACBr Monitor** manualmente.
2. Verifique certificado A1 válido e CSC configurado.
3. Teste: menu do ACBr → Status do serviço SEFAZ.
4. Confirme `.env`: `ACBR_HOST=127.0.0.1`, `ACBR_PORT=9200`.
5. Reinicie o agente após ACBr voltar.

**O que NÃO fazer:**
- Não reinstalar o agente inteiro por causa de ACBr offline.
- Não apagar `data/fila_fiscal.db` — perde fila de emissão.
- Não emitir NFC-e duplicada manualmente pelo ACBr para a mesma venda.

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
| `C:\ProgramData\MarginEngine\acbr\xml\` | XMLs autorizados |
| `C:\ProgramData\MarginEngine\acbr\pdf\` | DANFC-e PDF |
| `C:\ProgramData\MarginEngine\acbr\backup\` | Backups fiscais |
| `agente-local\data\` | Bancos SQLite e logs |

**Como liberar:**
1. Confirme que XMLs antigos já foram transmitidos/arquivados no ERP.
2. O purge automático remove arquivos com mais de 180 dias (configurável via `.env`).
3. Para emergência: mova XML/PDF antigos para HD externo (não delete sem autorização fiscal).
4. Limpe logs antigos em `data/logs/` (mantenha os últimos 7 dias se possível).

### Agente não sobe

1. **Porta ocupada:** outro processo usando 9100 — altere `PORT` no `.env` ou pare o conflito.
2. **`.env` inválido:** compare com `.env.example`; `PORT` e `ACBR_PORT` devem ser números.
3. **Integridade do banco:** rode `npm run predeploy` — falha em `integrity_check` indica banco corrompido; restaure backup de `data/`.
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

| Arquivo / pasta | Função |
|-----------------|--------|
| `data/config.json` | Configuração do PDV (sem token em texto puro) |
| `data/fila.db` | Fila offline de vendas + EPEC |
| `data/fila_fiscal.db` | Fila de emissão NFC-e |
| `data/fiscal_metrics.db` | Métricas de performance |
| `data/audit.db` | Log de auditoria (operações sensíveis) |
| `data/logs/` | Logs do agente |
| `C:\ProgramData\MarginEngine\acbr\xml\` | XMLs fiscais |
| `C:\ProgramData\MarginEngine\acbr\pdf\` | PDFs DANFC-e |
| Credenciais | Windows Credential Manager (token do backend) |

### Backup manual

1. Pare o serviço do agente.
2. Copie a pasta **`data/`** inteira para pendrive ou nuvem.
3. Copie **`C:\ProgramData\MarginEngine\`** (ou `$MARGIN_ENGINE_ROOT`).
4. Anote a versão: `GET http://localhost:9100/diagnostico/saude` → campo `versao`.

### Restaurar em troca de máquina

1. Instale o agente na máquina nova (seção 1).
2. Pare o serviço.
3. Restaure `data/` e `ProgramData\MarginEngine\` nos mesmos caminhos.
4. Rode `npm run manifest` na pasta do agente.
5. Reative pelo painel **somente se** o token/cofre não foi migrado (Windows Credential Manager não migra entre PCs — nesse caso, gere novo código de ativação).
6. Inicie o serviço e confirme `manifestOk: true` no dashboard.

---

## Contatos e referências

- Contratos API front/back: `docs/CONTRATOS_API.md`
- Compatibilidade v1.0: `docs/COMPATIBILIDADE_V1.md`
- Limitações de arquitetura: `docs/LIMITACOES_ARQUITETURA.md`
- Nota técnica de capacidade: `docs/NOTA_TECNICA_V1.md`
- Histórico de versões: `CHANGELOG.md`
