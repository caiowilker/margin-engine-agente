# PDV Margin Engine — Agente Local v4.0

Servidor Node.js que roda na máquina do caixa e conecta o frontend web
à impressora térmica, ao ACBr Monitor (NFC-e), à fila offline SQLite
e ao modo de contingência EPEC automático.

---

## Instalação (Windows — recomendado)

**Basta executar o `setup.bat` como Administrador.**

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
[Navegador]  →  http://localhost:9100/status     (agente local)
     ↓
[Agente]     →  https://SEU_BACKEND.com.br       (backend Spring)
```

Chamadas de `https` → `http://localhost` são permitidas pelos navegadores
modernos (localhost é exceção de mixed-content).

---

## Endpoints

| Método | Endpoint                          | Descrição                                   |
|--------|-----------------------------------|---------------------------------------------|
| GET    | /status                           | Status geral (impressora, ACBr, fila, EPEC) |
| GET    | /config                           | Configuração atual do agente                |
| POST   | /ativar                           | Ativa o agente com código do painel         |
| POST   | /venda                            | Registra venda (online ou offline)          |
| GET    | /fila                             | Lista vendas na fila SQLite                 |
| POST   | /fila/sincronizar                 | Força sync manual com o backend             |
| POST   | /impressora/imprimir              | Imprime cupom na térmica                    |
| POST   | /impressora/fechamento            | Imprime relatório de fechamento de caixa    |
| POST   | /impressora/movimento-caixa       | Imprime comprovante de suprimento/sangria   |
| GET    | /impressora/status                | Verifica conexão com a impressora           |
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

Suporta ESC/POS via USB ou rede TCP/IP.

| Configuração    | USB                          | Rede                          |
|-----------------|------------------------------|-------------------------------|
| PRINTER_TYPE    | usb                          | network                       |
| PRINTER_NAME    | vazio (auto-detectar)        | —                             |
| PRINTER_HOST    | —                            | IP da impressora (ex: 192.168.1.100) |
| PRINTER_PORT    | —                            | Porta (geralmente 9100 ou 9101) |

> ⚠️ **Atenção:** Se a impressora usar a porta 9100 e o agente também usar 9100,
> o `setup.bat` detecta e corrige automaticamente (`PRINTER_PORT` vira 9101).

Modelos testados: Bematech MP-4200, Elgin i9, Epson TM-T20, Daruma DR800.

---

## ACBr Monitor

Configure no `.env`:
```
ACBR_HOST=127.0.0.1   # mesma máquina
ACBR_PORT=9200        # porta padrão do Monitor
EMISSAO_FISCAL=false  # true para habilitar NFC-e
```

O ACBr Monitor deve estar configurado com certificado digital A1
e apontando para o ambiente correto (homologação ou produção).

---

## Requisitos

- Windows 10/11 (ou Linux/macOS)
- Node.js 18 ou superior → instalado automaticamente pelo `setup.bat`
- ACBr Monitor Pro (apenas para emissão de NFC-e)
- Impressora térmica USB ou em rede ESC/POS
