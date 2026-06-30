# PROGRESS — Agente Local

**Última atualização:** 2026-06-29

> **Missão 1.0:** [`../../margin-engine/.ai/MISSAO_1.0.md`](../../margin-engine/.ai/MISSAO_1.0.md)  
> **Execução Fiscal:** [`../../margin-engine/.ai/EXECUCAO_1.0_PARTE_01_FISCAL.md`](../../margin-engine/.ai/EXECUCAO_1.0_PARTE_01_FISCAL.md)  
> **Estado oficial:** [`../../margin-engine/.ai/PROJECT_STATUS.md`](../../margin-engine/.ai/PROJECT_STATUS.md)

---

## Maturidade

| Dimensão | Indicador |
|----------|-----------|
| ACBr Monitor (produção) | 🟢 Estável |
| Fila fiscal + callback | 🟢 Produção |
| Impressão térmica + QR | 🟢 Produção |
| Idempotência venda | 🟢 Mergeado |
| ACBrLib (padrão 1.0) | 🟢 Código + CI ✅ · homolog SEFAZ **Windows (você)** |
| Impressão térmica (ACBrPosPrinter) | 🟢 Provider Pattern + CI · homolog hardware **Windows** |
| Homologação SEFAZ por loja | 🔵 `homolog-acbrlib/README.md` |

---

## Concluído — Fiscal

* Fila fiscal SQLite, mutex ACBr, callback backend com PDF Base64 e `qrcode`
* Preflight A1/CSC, reconciliação automática, retry classificado
* NF-e 55 + NFC-e 65, DANFC-e/DANFE PDF, inutilização, cancelamento
* Rotas `/fiscal/*`, `/acbr/*`, diagnóstico fiscal
* **Idempotência venda** — `registrarLocalFirst` por `numeroVendaCliente` (hotfix 27/06)
* **fiscalDriver** — factory `monitor` | `lib` (`fiscal/`, ADR-011)
* **EPEC nativo Lib** — `emitirEpecLib` (`carregarXML` + `enviar`)
* **Diagnóstico** — `/diagnostico` expõe `acbr.driver/mode/native`; pacote ZIP JSON
* **Config fiscal local** — `GET/PUT /config/fiscal`, painel diagnóstico, sync ambiente INI
* **fiscalDriverResposta** + **acbrLibResposta** — parse unificado Monitor/Lib
* **fiscalDriverNfceSetup** — preflight Lib-aware
* **L9 eventos fiscais** — CCe + manifestação (builders Java + `POST /fiscal/evento` + `enviarEventoFiscal` Lib/Monitor)
* **Benchmark regressão CI** — `MarginBenchmarkRegressionTest`

---

## Concluído — Impressão e cupom (2026-06)

| Item | Arquivo |
|------|---------|
| QR ESC/POS nível M + fallback PNG | `impressora.js` |
| Bloqueio NFC-e 65 sem URL QR | `imprimirCupom` |
| Portal consulta dinâmico (host da UF) | `documentosFiscais.js` |
| NF-e 55 vs NFC-e 65 no layout fiscal | `renderCupomConteudo` |
| Endereço sem duplicar bairro | `formatarLinhaEnderecoEmpresa` |
| CORS/PNA rotas `/impressora/*` | `index.js` |
| Config sync catálogo com backend | `configSync.js` |

---

## Desenvolvimento local (merge pendente)

| Item | Status |
|------|--------|
| `fiscal/factory.js` + `acbrLibDriver.js` | ✅ código local |
| `acbrlib/` + homolog produção | ✅ |
| Docs `ACBRLIB-INTEGRACAO.md`, instalador Windows | ✅ |
| Refator recovery / watchdog / reconciliação | ✅ diff local |

> Branch `main` pode estar **behind** do remoto (hotfix mergeado). Alinhar com `git pull`.

---

## Deploy

* `EMISSAO_FISCAL=true`, ACBr `127.0.0.1:9200`
* Certificado A1 + CSC no ACBrMonitorPLUS
* `IMPRIMIR_QR_NFCE=true` (padrão)
* Ver `.ai/DEPLOY_PRODUCTION.md`

---

## Pendente operacional

* Validar impressão QR em impressoras do cliente piloto
* Homologação SEFAZ ponta a ponta por UF
* Piloto ACBrLib com paridade MFCS Monitor = Lib

---

## Referências

| Documento | Conteúdo |
|-----------|----------|
| `.ai/project-brain.md` | Arquitetura agente |
| [`../../margin-engine/.ai/PROJECT_STATUS.md`](../../margin-engine/.ai/PROJECT_STATUS.md) | Estado oficial Platform |
| [`../../margin-engine/.ai/progress.md`](../../margin-engine/.ai/progress.md) | Progresso Platform |
| `.ai/planning/migracao-acbrlib.md` | Migração ACBrLib |
| `docs/OPERACAO.md`, `docs/CONTRATOS_API.md` | Operação e API |
