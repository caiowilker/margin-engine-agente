# PROGRESS — Agente Local

**Última atualização:** 2026-06-25  
**Status:** Fiscal NFC-e + impressão térmica QR + hardening rede

---

## Concluído — Fiscal

* Fila fiscal SQLite, mutex ACBr, callback backend com PDF Base64 e `qrcode`
* Preflight A1/CSC, reconciliação automática, retry classificado
* NF-e 55 + NFC-e 65, DANFC-e/DANFE PDF, inutilização, cancelamento
* Rotas `/fiscal/*`, `/acbr/*`, diagnóstico fiscal

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
| Teste QR | `test/qr-cupom.test.js` |
| Config sync catálogo com backend | `configSync.js`, `agentConfigCatalog.js` |

---

## Deploy

* `EMISSAO_FISCAL=true`, ACBr `127.0.0.1:9200`
* Certificado A1 + CSC no ACBrMonitorPLUS
* `IMPRIMIR_QR_NFCE=true` (padrão), `IMPRIMIR_QR_NFCE_SIZE=6`
* Ver `.ai/DEPLOY_PRODUCTION.md`

---

## Pendente operacional

* Validar impressão QR em impressoras Epson/Bematech/Elgin do cliente piloto
* Homologação SEFAZ ponta a ponta

---

## Referências

* `.ai/project-brain.md`
* `docs/OPERACAO.md`, `docs/CONTRATOS_API.md`
* `../margin-engine/.ai/progress.md`
