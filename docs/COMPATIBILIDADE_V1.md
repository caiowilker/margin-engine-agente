# Compatibilidade front ↔ back — v1.0.0

**Data:** 2026-06-19  
**Fase:** 7 — Integration check  
**Back:** agente-local 1.0.0  
**Front:** margin-engine-front (checkout desacoplado, multi-caixa, badges)

---

## Tabela de rotas

| Rota | Front espera | Back retorna | Status |
|------|--------------|--------------|--------|
| POST /fiscal/emitir | `correlationId:string`, `fiscal:"pending"`, `async:true` | idem + `status:PENDENTE\|...` | ✓ |
| GET /fiscal/emissao/:id | `correlationId`, `status`, `resultado?`, `erro?` | idem | ✓ |
| GET /fiscal/status/:id | alias de emissao | idem | ✓ |
| GET /diagnostico/saude | `ok:true`, `versao`, `manifestOk` | idem | ✓ |
| GET /diagnostico/alertas | `acbr`, `versao`, `ultimaEmissaoSucesso` | idem | ⚠ snake_case opcional |
| GET /diagnostico/dashboard | HTML 200 | text/html com status | ✓ |
| POST /diagnostico/recovery | `jobsReprocessados:number` | idem | ✓ |
| GET /diagnostico/relatorio | `emissoes.total:number` | idem | ✓ |
| GET /health | `ok:true` | idem | ✓ |
| GET /status | `online`, `acbrConectado`, `filaOffline` | idem | ✓ |
| GET /status-basico | fallback público | idem | ✓ |
| GET /diagnostico | `DiagnosticoAgente` | idem | ✓ |
| GET /auth/local-token | `agentToken` | idem | ✓ |
| POST /impressora/cupom | `{ ok:true }` | idem | ✓ |
| GET /acbr/fiscal/preflight | `{ ok:boolean }` | idem | ✓ |
| POST /fiscal/cancelar | `{ ok?, protocolo? }` | idem | ✓ |
| GET /fila/fiscal | `{ pendentes, falhas }` | idem | ✓ |

---

## Divergências corrigidas (Fase 7)

| Item | Antes | Depois |
|------|-------|--------|
| `ResultadoEmissaoPendente.status` | só `ENFILEIRADO \| PROCESSANDO` | inclui `PENDENTE` (valor real do back) |
| `StatusEmissaoFiscal.status` | `string` genérico | union `StatusEmissaoFiscalAgente` com todos os estados do back |
| CORS produção | só `AGENTE_CORS_ORIGENS` | `CORS_ORIGINS` documentado + alias no código |
| Alias status fiscal | front só `/fiscal/emissao/:id` | método `consultarStatusFiscal()` para `/fiscal/status/:id` |

---

## Divergências aceitas (won't fix)

| Item | Motivo |
|------|--------|
| `ultimaEmissaoSucesso.correlation_id` (snake) vs `correlationId` (camel) | Back reflete SQLite; front/smoke aceitam ambos |
| Campos extras em `/diagnostico/alertas` (`filaFiscal`, `espacoDisco`, …) | Back enriquece payload; front ignora campos não usados — OK |
| `GET /diagnostico/saude` não usado pelo React ainda | Consumido por smoke/monitoramento — contrato validado |
| `POST /acbr/nfce/emitir` legado | Mantido; checkout usa `/fiscal/emitir` |
| Badge UI usa `"emitindo"\|"ok"\|"erro"` | Mapeamento local em `useFrenteCaixa`; statuses do agente mapeados no polling — OK |

---

## Resultado dos testes

```
npm test          : 21/21 ✓
npm run test:contract : 11/11 ✓ (HTTP live opcional com AGENTE_URL)
npm run smoke:integration : requer agente + ACBr online (8 passos base, +2 multi-caixa)
```

### Comandos de validação

```bash
cd agente-local
npm test && npm run test:contract

# Com agente rodando + ACBr online:
npm run smoke:integration
```

### Multi-caixa

Configure no `.env` do script ou ambiente:

```bash
AGENTE_URLS='["http://localhost:9100","http://localhost:9101"]'
npm run smoke:integration
```

No front: `VITE_AGENTE_URLS` com o mesmo formato JSON.

---

## Documentação relacionada

- Contratos detalhados: `docs/CONTRATOS_API.md`
- Operação / rede: `docs/OPERACAO.md` (seção Configuração de rede)
- Limitações: `docs/LIMITACOES_ARQUITETURA.md`
