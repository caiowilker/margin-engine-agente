# PDV Margin Engine — Agente Local v1.0

Servidor Node.js que roda na máquina do caixa e conecta o frontend web
à impressora térmica, ao ACBr Monitor (NFC-e), à fila offline SQLite
e ao modo de contingência EPEC automático.

---

## Instalação (Windows — recomendado)

**Basta executar o `setup.bat` como Administrador.**

> Se aparecer erro `'cho' não é reconhecido` ou `'PDV' não é reconhecido`, o arquivo
> estava com codificação errada. Use o `setup.bat` atual (ele chama o `setup.ps1`).

O instalador:
- Detecta se o Node.js 18+ está instalado
- Se não estiver → instala automaticamente via `winget` ou baixando o `.msi`
- Roda `npm install` automaticamente
- Cria o `.env` a partir do `.env.example`
- Detecta e corrige conflito de porta entre o agente (9100) e a impressora de rede
- Instala o serviço Windows (inicia com o PC, sem terminal aberto)
- Abre http://localhost:9100 no navegador ao final

```
Clique com botão direito em setup.bat → "Executar como administrador"
```

---

## Instalação manual

```bash
# 1. Entrar na pasta
cd agente-local

# 2. Instalar dependências
npm install

# 3. Copiar e preencher o .env
copy .env.example .env
# Abra o .env e ajuste as configurações (ou use a ativação pelo painel)
```

---

## Rodando

```bash
# Modo normal (fecha quando fechar o terminal)
npm start

# Modo desenvolvimento (reinicia ao salvar arquivos)
npm run dev

# Instalar como serviço Windows (recomendado para produção)
npm run install-service

# Remover o serviço Windows
npm run uninstall-service

# Deploy produção — gerar manifest com SHA-256 (obrigatório antes de publicar)
# Gere o manifest NO MESMO AMBIENTE do servidor de destino (evita divergência LF/CRLF).
# Ver docs/LIMITACOES_ARQUITETURA.md
npm run manifest
npm run predeploy
npm test
npm run smoke   # com agente rodando + ACBr online
```

---

## Ativação

Após iniciar, acesse `http://localhost:9100` e insira o código gerado
no painel administrativo. O agente se configura automaticamente
(backendUrl, token, tenantId).

> **Recomendado:** use sempre a ativação pelo painel.
> Evite editar `BACKEND_URL` e `BACKEND_TOKEN` manualmente no `.env`.

---

## Como o frontend acessa o agente

```
[Navegador]  →  https://pdv.suaempresa.com.br   (frontend web)
     ↓
[Navegador]  →  http://localhost:9100/status-basico   (agente local, sem token)
     ↓
[Navegador]  →  http://localhost:9100/status           (com X-Agent-Token após ativação)
     ↓
[Agente]     →  https://SEU_BACKEND.com.br       (backend Spring)
```

Chamadas de `https` → `http://localhost` são permitidas pelos navegadores
modernos (localhost é exceção de mixed-content).

---

## Endpoints

| Método | Endpoint                          | Descrição                                   |
|--------|-----------------------------------|---------------------------------------------|
| GET    | /status-basico                    | Status reduzido (sem token, rede local)     |
| GET    | /status                           | Status completo (exige X-Agent-Token)       |
| GET    | /config                           | Configuração atual do agente                |
| POST   | /ativar                           | Ativa o agente com código do painel         |
| POST   | /venda                            | Registra venda (online ou offline)          |
| GET    | /fila                             | Lista vendas na fila SQLite                 |
| POST   | /fila/sincronizar                 | Força sync manual com o backend             |
| POST   | /impressora/imprimir              | Imprime cupom na térmica                    |
| POST   | /impressora/cupom                 | Alias de /impressora/imprimir (compat. PDV) |
| POST   | /impressora/fechamento            | Imprime relatório de fechamento de caixa    |
| POST   | /impressora/movimento-caixa       | Imprime comprovante de suprimento/sangria   |
| GET    | /impressora/status                | Verifica conexão com a impressora           |
| GET    | /impressora/listar                | Lista impressoras Windows/USB detectadas    |
| POST   | /impressora/detectar              | Força nova detecção da impressora           |
| POST   | /acbr/nfce/emitir                 | Emite NFC-e via ACBr Monitor                |
| POST   | /acbr/nfce/cancelar               | Cancela NFC-e                               |
| GET    | /contingencia/status              | Estado atual do modo EPEC                   |
| POST   | /contingencia/encerrar            | Encerra modo contingência manualmente       |
| POST   | /contingencia/epec/salvar         | Salva XML EPEC gerado pelo ACBr             |
| GET    | /contingencia/epec/pendentes      | Lista XMLs EPEC aguardando transmissão      |

---

## Modo Contingência EPEC (v4.0)

Quando a SEFAZ fica inacessível durante emissão de NFC-e:

1. O agente detecta a falha automaticamente
2. Ativa o modo EPEC — notifica o backend
3. Armazena os XMLs EPEC localmente no SQLite
4. A cada 5 minutos tenta retransmitir quando a SEFAZ volta
5. Ao transmitir todos os EPECs, encerra a contingência automaticamente

---

## Modo Offline (fila de vendas)

Quando o backend está inacessível:

- A venda é salva localmente no `data/fila.db` (SQLite)
- O frontend recebe `{ origem: "offline" }` e continua normalmente
- A cada 30 segundos (ajustável em `SYNC_INTERVAL_MS`) as vendas são sincronizadas
- Idempotência garantida pelo `numeroVendaCliente`

---

## Impressora

Suporta ESC/POS via **auto-detect** (recomendado), Windows spooler RAW, USB ou rede TCP/IP.

| Configuração    | auto (padrão)                | usb / network / windows       |
|-----------------|------------------------------|-------------------------------|
| PRINTER_TYPE    | detecta sozinho              | força um modo específico      |
| PRINTER_NAME    | nome no Windows (opcional)   | filtra impressora instalada   |
| PRINTER_HOST    | IP da impressora (rede)      | —                             |
| PRINTER_PORT    | porta TCP (9100/9101)        | —                             |

**Ordem de detecção no modo `auto` (Windows):**
1. Impressora instalada no Windows (spooler RAW — funciona como serviço)
2. Impressora de rede TCP (9100, 9101)
3. USB direto (escpos-usb)

Modelos testados: Bematech MP-4200, Elgin i9, Epson TM-T20, Daruma DR800.

---

## Deploy via Docker (Linux / servidor)

Alternativa ao deploy Windows nativo. **ACBr Monitor não roda dentro do container** — use este modo apenas se a emissão fiscal for desligada (`EMISSAO_FISCAL=false`) ou se o ACBr estiver acessível via rede no host.

```bash
cd agente-local
cp .env.example .env
# Edite .env (PORT, BACKEND_URL após ativação, etc.)
docker build -t pdv-agente:1.0.0 .
docker compose up -d
```

Verifique saúde:

```bash
curl http://localhost:9100/diagnostico/saude
```

Volumes persistentes (definidos no `docker-compose.yml`):

- `./data` → bancos SQLite, config, logs
- `./.env` → configuração (somente leitura no container)

Para rebuild após update:

```bash
docker compose down
docker build -t pdv-agente:1.0.0 .
docker compose up -d
```

Guia completo para campo: `docs/OPERACAO.md`.

Documentação técnica completa (arquitetura, API, fiscal, integração front): **`docs/GUIA_COMPLETO.md`**.

---

## ACBr Monitor

O agente é um **adaptador TCP**: monta o INI da venda, envia `NFE.CriarEnviarNFe` e interpreta a resposta.
Certificado A1, CSC, URLs SEFAZ e ambiente devem estar configurados **no ACBr Monitor** (aba DFe / WebServices).

Configure no `.env`:
```
ACBR_HOST=127.0.0.1
ACBR_PORT=9200
EMISSAO_FISCAL=false
ACBR_AUTO_PATCH=false   # não editar ACBrNFeServicos.ini automaticamente
ACBR_AUTO_CSC=false     # não gravar CSC via TCP automaticamente
```

Comunicação TCP: terminador oficial `CR+LF + '.' + CR+LF`.
Emissão NFC-e: `NFE.CriarEnviarNFe(ini, 1, 0, 1, 0, 0, 0, 0)` — síncrono, sem PDF/DANFE no ACBr (impressão ESC/POS pelo agente).

Diagnóstico completo: `GET /diagnostico/fiscal` ou `node scripts/setup-acbr-nfce.js`

---

## Requisitos

- Windows 10/11 (ou Linux/macOS)
- Node.js 18 ou superior → instalado automaticamente pelo `setup.bat`
- ACBr Monitor Pro (apenas para emissão de NFC-e)
- Impressora térmica USB ou em rede ESC/POS
