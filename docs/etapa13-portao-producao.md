# ETAPA 13 — Portão de produção

**Versão desta entrega:** 1.0.121  
**Data:** 2026-10-13  
**Status:** **APROVADA PARA DEPLOY DO BASELINE** (tudo opt-in OFF) com condições 2–5 tratadas abaixo.  
**12-3b:** aprovada com condição — Compacto/Ultra **fiscal BLOQUEADO** até aceite da prova MET (§1).

---

## 1) Prova fiscal Compacto (condição 1)

Artefato: [`docs/etapa12-3b-prova-conformidade-met.md`](etapa12-3b-prova-conformidade-met.md)  
Teste: `test/cupom-layout-profile.test.js` (bloqueio default + campos MET idênticos com liberação + multipag/troco).

| Ação | Status |
|------|--------|
| Diff linha a linha Compacto/Ultra × Padrão | Entregue no artefato |
| Mapa × tabela obrigatórios 12-2 (MET) | Entregue |
| REVERT `omitVolumes` no **fiscal** | Feito (qtde itens MET III) |
| Mesmo texto: consulta+URL, chave, protocolo, Volumes, TOTAL, pagamentos, troco, consumidor | Teste automático |
| Compacto/Ultra fiscal uso real | **BLOQUEADO** até `PRINT_CUPOM_FISCAL_COMPACTO=true` (após seu aceite do item 1) |

---

## 2) Baseline corrigido — o que JÁ VALE PARA TODOS vs flag

### Já vale para todos (sem flag / sem opt-in)

| Item | Evidência |
|------|-----------|
| Correção cancelamento crediário × venda cancelada | Etapas 1–2; saldo exclui cancelada |
| Vendas suspensas no **servidor** (default ON) | V20261133; kill switch disponível (§3) |
| `FOR UPDATE` em `gerarParcelas` (11-D) | `buscarClienteForUpdate` |
| Fórmula SSOT / auditoria enriquecida | V20261134+ |
| Cupom perfil **Padrão** (legado visual) | Default terminal |
| Finalizar offline (dinheiro/cartão) | **ON** (paridade produção; só crediário bloqueado offline) |
| Cache local catálogo / UI otimista | **ON** (features novas desta entrega) |

### Kill switch / opt-in (não mudam o baseline ligado)

| Feature | Flag |
|---------|------|
| Fechamento numerário novo | `controleNumerarioAtivo` (loja) → efetivo na próxima abertura |
| Cache local catálogo | `pdv-catalogo-cache-local=0` / `VITE_PDV_CATALOGO_CACHE_LOCAL=0` desliga |
| Finalizar offline | `pdv-finalizar-offline=0` / `VITE_PDV_FINALIZAR_OFFLINE=0` desliga |
| UI otimista leve | `pdv-frente-otimista=0` desliga |
| Cupom Compacto/Ultra **não fiscal** | `cupomLayoutPerfil` |
| Cupom Compacto/Ultra **fiscal** | Bloqueado; só após aceite + `PRINT_CUPOM_FISCAL_COMPACTO` |

**Texto antigo “tudo desligado = legado” está incorreto** — substituído por esta lista.

---

## 3) Kill switches (sem novo deploy)

| Chave | Onde | Efeito |
|-------|------|--------|
| `controleNumerarioAtivo` | Loja | OFF = fechamento legado |
| `localStorage pdv-catalogo-cache-local` | Terminal | default on (paridade produção) |
| `localStorage pdv-finalizar-offline` | Terminal | default on (paridade produção) |
| `localStorage pdv-frente-otimista` | Terminal | `0` desliga otimismo leve |
| `localStorage pdv-vendas-suspensas-servidor` | Terminal | `0` → localStorage legado |
| `pdv_configuracao.vendas_suspensas_servidor` | Loja/tenant (API config caixa) | `false` → API recusa; front local |
| `PDV_VENDAS_SUSPENSAS_SERVIDOR=false` | Env backend | kill global |
| `cupomLayoutPerfil` | Sidecar | PADRAO/COMPACTO/ULTRA (fiscal Compacto bloqueado) |
| `PRINT_CUPOM_FISCAL_COMPACTO` | Env agente | libera Compacto fiscal **após aceite** |
| `PDV_PERF_TIMING_HEADERS` | Backend | timing |

Teste kill suspensas: `VendaSuspensaServiceTest` + `vendasSuspensasPolicy.test.ts`.

---

## 4) FOR UPDATE gerarParcelas (condição 3)

Teste: `GerarParcelasForUpdateBenchTest` (N=8 × 3 rounds).  
**Resultado real:** `ok=24/24` · **deadlock=0** · p50=**26 ms** · p95=**42 ms** · p99=**48 ms**.  
Detalhe: `margin-engine/docs/diagnostico/ETAPA13-for-update-gerarParcelas.md`.

---

## 5) E2E HTTP real (condição 4)

**Resultado desta sessão:** não executado — sem homolog/`BASE_URL`.  
Harness: `margin-engine/scripts/pdv-e2e-http-regressao.sh`  
Relatório: `margin-engine/docs/diagnostico/ETAPA13-e2e-http-resultado.md`  

**Obrigatório antes do piloto numerário ON:** rodar harness em homolog e anexar log.

---

## 6) Pendentes / evidência perf

- **11-C/E entregues em 1.0.122** — ver `margin-engine/docs/diagnostico/ETAPA11C-E-performance-evidencia.md`
- **Falta:** p50/p95/p99 HTTP de finalizar/fechar em homolog (`k6` + `__mePdvFrentePerf`)
- Dry-run órfãs crediário: entregar relatório e **aguardar aprovação** do `--apply` (backup antes)

---

## 7) Plano de liberação

1. Deploy **1.0.121** baseline (flags OFF; Compacto fiscal bloqueado).  
2. Homolog: E2E HTTP (condição 4) → anexar resultado.  
3. Piloto 1 loja / 1 terminal: uma feature opt-in por vez.  
4. Compacto fiscal: só após aceite explícito do item 1 + `PRINT_CUPOM_FISCAL_COMPACTO`.

---

## Pare

Correções **1–5 entregues**. Aguardando: (a) aceite da prova MET para desbloquear Compacto fiscal; (b) E2E HTTP em homolog com credenciais; (c) aprovação dry-run órfãs quando o relatório for apresentado.
