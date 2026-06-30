# Plano de migração ACBr Monitor → ACBrLib

**Status:** Execução 1.0 — Lib = provider padrão (ver Missão)

> **Execução canônica:** [`../../margin-engine/.ai/EXECUCAO_1.0_PARTE_01_FISCAL.md`](../../margin-engine/.ai/EXECUCAO_1.0_PARTE_01_FISCAL.md)  
> **Decisão atual (1.0):** ACBrLib Pro padrão · Monitor fallback · paridade 100% gate

---

## Resumo executivo

| Pergunta | Resposta |
|----------|----------|
| ACBrLib é tecnicamente correta para substituir o Monitor? | Sim — mesmo motor ACBrNFe, integração oficial Node.js |
| Migrar agora? | **Não** — integração Monitor está madura e hardened |
| Compensa no futuro? | Provavelmente sim — menos processos, menos latência, config programática |
| Esforço realista | 3–6 semanas (paridade + homologação + piloto) |
| Mudança mínima correta | Driver adapter atrás da API atual de `acbr.js`, com feature flag |

---

## Contexto — o que temos hoje

A integração atual **não é frágil**. É uma camada production-ready:

| Módulo | Responsabilidade |
|--------|------------------|
| `acbr.js` (~1.750 linhas) | Cliente TCP → ACBr Monitor `:9200`, mutex global, parsing |
| `fiscalService.js` | Orquestração: fila SQLite, retry, recovery, callback backend |
| `acbrResposta.js` | Normalização `cStat`, protocolo, casos 103/104/217 |
| `fiscalPreflight.js` | Valida certificado, ambiente, SEFAZ antes de emitir |
| `watchdog.js` | Health check, pausa da fila se ACBr cair |
| `acbrNfceSetup.js` | Diagnóstico CSC/URLs (leitura do INI do Monitor) |

**Comandos TCP usados hoje** (via `NFE.*` no Monitor):

- `SetModeloDF(65|55)`, `SetVersaoDF`, `SetAmbiente`
- `CriarEnviarNFe(ini, …)` — emissão NFC-e 65 e NF-e 55
- `EnviarNFe(xml)` — retransmissão EPEC
- `CancelarNFe`, `InutilizarNFe`
- `ConsultarNFe`, `StatusServico`
- `ImprimirDANFEPDF`, `ImprimirDanfe`
- `ConfigGravarValor` — CSC no Monitor

O agente **gera os INIs** (`montarIniNfce`, `montarIniNfe`) e delega assinatura/envio ao ACBr. Grande parte da lógica fiscal já é nossa.

**Decisões formais vigentes:**

- [ADR-002](../../../margin-engine/.ai/decisions/adr-002-acbr-tcp-armazenamento.md) — TCP + pastas locais
- [ADR-010](../../../margin-engine/.ai/decisions/adr-010-emissao-fiscal-agente-local.md) — emissão exclusiva via agente + ACBr

**Limitação que NÃO some com a migração:**

- `docs/LIMITACOES_ARQUITETURA.md` — 1 agente = 1 ACBr = 1 caixa (~60–120 NFC-e/h)
- ACBrLib também exige singleton + fila serializada (não é thread-safe)

---

## O que é ACBrLib

Biblioteca nativa (DLL no Windows, `.so` no Linux) que expõe o componente ACBrNFe sem processo externo.

**Pacote oficial Node.js:**

```bash
npm install @projetoacbr/acbrlib-nfe-node
```

- Wrapper TypeScript sobre **koffi** (FFI)
- Licença: **LGPL-2.1**
- Cobre NFe + NFC-e (modelos 55 e 65)
- Repositório: https://github.com/Projeto-ACBr-Oficial/ACBrLib-Nodejs

**Mapeamento operacional:**

| Operação hoje (Monitor) | ACBrLib |
|-------------------------|---------|
| `CriarEnviarNFe(ini)` | `carregarINI()` → `assinar()` → `enviar()` |
| `EnviarNFe(xml)` | `carregarXML()` → `enviar()` |
| `CancelarNFe` | `cancelar()` |
| `InutilizarNFe` | `inutilizar()` |
| `StatusServico` | `statusServico()` |
| `ConsultarNFe` | `consultar()` |
| `ImprimirDANFEPDF` | `salvarPDF()` / `imprimirPDF()` |

A migração troca o **transporte** (TCP texto → chamada nativa), não o motor fiscal.

---

## Comparativo: Monitor vs Lib

### Vantagens da ACBrLib

1. **Um processo a menos** — elimina ACBr Monitor como serviço/GUI separado
2. **Menos latência** — sem socket TCP, banner, idle, parsing de texto ruidoso
3. **Configuração programática** — certificado, CSC, paths e ambiente via `acbrlib.ini`
4. **Instalador mais limpo** — agente + `ACBrNFe64.dll` + inis
5. **Mesmo motor fiscal** — rejeições SEFAZ, layouts e contingência seguem ACBrNFe

### Desvantagens / riscos

1. **Throughput igual** — mutex continua obrigatório; não escala multi-caixa num único agente
2. **Perde GUI do Monitor** — técnico configura via ini + painel do agente
3. **Deploy sensível** — DLL versionada, alinhada ao pacote npm, assinada pelo Projeto ACBr
4. **LGPL-2.1** — avaliar juridicamente distribuição em produto comercial
5. **Retrabalho de parsing** — `acbrResposta.js` e testes chaos precisam revalidação
6. **Ecossistema npm jovem** — `@projetoacbr/acbrlib-nfe-node` v1.0.x (2025–2026)

### O que NÃO muda na migração (se feita corretamente)

- Frontend (`useFrenteCaixa`, `agenteService.emitirFiscal`)
- Backend (callbacks, `statusFiscal`, XML/PDF)
- `fiscalService.js`, `filaFiscal.js`, recovery, EPEC (quase inalterados)
- `montarIniNfce` / `montarIniNfe` — reutilizáveis via `carregarINI`

---

## Arquitetura alvo

```
fiscalService.js
       │
       ▼
  fiscalDriver (interface)
       │
   ┌───┴───┐
   ▼       ▼
acbrMonitorDriver   acbrLibDriver
 (acbr.js atual)     (novo acbrLib.js)
```

### Interface mínima (espelhar exports de `acbr.js`)

```javascript
{
  testar, statusServico, consultarChave,
  emitirNfce, emitirNfe, cancelarNfce, inutilizarNfce,
  gerarPdfFiscal, gerarPdfDanfce, gerarPdfDanfe,
  withAcbrLock, isAcbrBusy, obterStatusMemoria,
  setRuntimeEmissaoFiscal, getRuntimeEmissaoFiscal,
  parseResposta, montarIniNfce, montarIniNfe, …
}
```

### Feature flag proposta

```env
# Padrão em produção — não alterar até piloto aprovado
ACBR_DRIVER=monitor

# Futuro — após homologação
# ACBR_DRIVER=lib
# ACBR_LIB_PATH=C:\MarginEngine\ACBrNFe64.dll
# ACBR_LIB_INI=C:\MarginEngine\data\acbrlib.ini
```

Permite rollback instantâneo em loja e homologação paralela (mesmo INI, comparar chave/protocolo).

---

## Inventário de operações e esforço

| # | Operação | Esforço | Notas |
|---|----------|---------|-------|
| 1 | Emissão NFC-e 65 | Médio | `carregarINI` + `enviar(sincrono=1)` |
| 2 | Emissão NF-e 55 | Médio | Modelo no `acbrlib.ini` |
| 3 | Cancelamento | Baixo | API direta |
| 4 | Inutilização | Baixo | API direta |
| 5 | Consulta chave | Baixo | Recovery depende disso |
| 6 | Status serviço | Baixo | Preflight + watchdog |
| 7 | PDF DANFC-e/DANFE | Médio | Paths no ini (`PathPDF`, `PathNFe`) |
| 8 | EPEC / contingência | Alto | `carregarXML` + `enviar` — retestar scheduler |
| 9 | CSC / URLs NFC-e | Alto | Hoje lê Monitor; com Lib = dono do `acbrlib.ini` |
| 10 | Config runtime (`configSync`) | Médio | `configGravarValor` na Lib |
| 11 | Instalador Windows | Alto | DLL, ini template, smoke test |
| 12 | Testes chaos/hardening | Alto | Suite fiscal inteira |

---

## Plano de fases (quando decidir executar)

### Fase 0 — Decisão (1–2 dias)

- [ ] Criar ADR-011: ACBrLib como driver opcional; Monitor permanece default
- [ ] Validar LGPL com jurídico
- [ ] Fixar versão da DLL (ex.: alinhada ao npm 1.0.11)
- [ ] Critérios de go/no-go do piloto (taxa INCERTO, tempo emissão, zero divergência chave)

### Fase 1 — POC (3–5 dias)

- [x] Criar `acbrLibDriver.js` com: `inicializar`, `statusServico`, `emitirNfce`
- [x] Runtime WSL/Windows (`acbrLibRuntime.js`)
- [x] Homolog nativo produção (`acbrlib/` + `homolog-acbrlib/`)
- [ ] Homologação SEFAZ apenas
- [ ] Usar mesmo INI que `montarIniNfce` já gera
- [ ] Comparar vs Monitor: chave, protocolo, `cStat`, XML autorizado
- [ ] Documentar diferenças de resposta (texto TCP vs estruturado)

### Fase 2 — Paridade (1–2 semanas)

- [ ] Cancelar, inutilizar, consulta, PDF
- [x] EPEC nativo Lib (`carregarXML` + `enviar` em `emitirEpecLib`)
- [ ] EPEC + contingência — retestar scheduler em homologação Windows
- [ ] Template `acbrlib.ini` por UF (default MG)
- [ ] Migrar `acbrNfceSetup` de leitura Monitor → configuração Lib
- [ ] `fiscalDriver.js` factory (`ACBR_DRIVER`)
- [ ] Manter `acbr.js` intacto como `acbrMonitorDriver`

### Fase 3 — Hardening (1 semana)

- [ ] Reexecutar: `fiscal-hardening`, `fiscal-production`, `fiscal-chaos`, `contract.test`
- [ ] Smoke em hardware real (certificado A1 homologação)
- [ ] Instalador: copiar DLL + inis
- [ ] `npm run smoke` / `smoke:integration` com `ACBR_DRIVER=lib`
- [ ] Atualizar `OPERACAO.md`, `GUIA_COMPLETO.md`, `CONTRATOS_API.md`

### Fase 4 — Piloto (2–4 semanas)

- [ ] 1 loja com `ACBR_DRIVER=lib`
- [ ] Monitor instalado como fallback manual
- [ ] Métricas: tempo emissão, taxa INCERTO, rejeições, suporte em campo
- [ ] Runbook: certificado vencido, DLL ausente, ini incorreto

### Fase 5 — Default Lib (opcional)

- [ ] Só após piloto sem incidentes fiscais
- [ ] Atualizar instalador para não exigir Monitor
- [ ] Deprecar documentação TCP (manter código Monitor por 1 release)

---

## O que NÃO fazer

| Abordagem | Motivo |
|-----------|--------|
| Reescrever `fiscalService` do zero | Desperdiça fila/recovery maduros |
| Migrar front + backend junto | Driver é só no agente |
| Remover Monitor sem feature flag | Sem rollback em loja = risco fiscal |
| Assumir que Lib resolve multi-caixa | Mutex continua; escala = 1 agente/caixa |
| Configurar CSC/URLs só no `.env` | Lib exige `acbrlib.ini` + `ACBrNFeServicos.ini` |

---

## Gatilhos para reavaliar este plano

Migrar passa a compensar quando **pelo menos um** destes for prioridade de negócio:

1. Reduzir suporte em campo (“Monitor não abriu”, porta 9200, GUI em ambiente errado)
2. Configuração fiscal 100% pelo painel web (sem abrir ACBr Monitor)
3. Agente servidor na LAN (ADR-010 Fase 2a) — um processo fiscal central
4. Instalador one-click sem dependência externa além do agente
5. Latência de emissão como KPI (ganho estimado: centenas de ms por nota, não segundos)

**Não é gatilho:** checkout lento (já resolvido com local-first), sidebar mobile, sync offline.

---

## Dependências e artefatos futuros

| Artefato | Caminho sugerido |
|----------|------------------|
| ADR decisão | `margin-engine/.ai/decisions/adr-011-acbrlib-driver-opcional.md` |
| Driver Lib | `agente-local/acbrLib.js` |
| Factory | `agente-local/fiscalDriver.js` |
| Template ini | `agente-local/templates/acbrlib.ini.template` |
| Testes paridade | `agente-local/test/acbrlib-parity.test.js` |
| Instalador | `pdv-agente-installer.iss` — wizard certificado/CSC + seção `dist\lib\` ACBrLib |

**Pacotes npm:**

```json
{
  "@projetoacbr/acbrlib-nfe-node": "^1.0.11",
  "@projetoacbr/acbrlib-dfe-node": "^1.0.11"
}
```

**Binários nativos (Windows):**

- `ACBrNFe64.dll` — distribuir com instalador, versão pinada
- `ACBrNFeServicos.ini` — por UF/ambiente
- `acbrlib.ini` — certificado, paths, CSC, tpAmb

---

## Critérios de sucesso do piloto

| Métrica | Meta |
|---------|------|
| Paridade chave/protocolo vs Monitor | 100% em homologação |
| Taxa jobs INCERTO | ≤ baseline Monitor |
| Tempo médio emissão | ≤ baseline ou −10% |
| Incidentes suporte fiscal (7 dias) | 0 críticos |
| Rollback testado | `ACBR_DRIVER=monitor` em < 5 min |

---

## Referências

- `agente-local/acbr.js` — implementação atual
- `agente-local/docs/LIMITACOES_ARQUITETURA.md` — limite 1:1 caixa
- `agente-local/docs/OPERACAO.md` — operação NFC-e/NF-e
- `agente-local/docs/CONTRATOS_API.md` — contratos HTTP agente
- https://acbr.sourceforge.io/ACBrLib/SobreaACBrLibNFe.html
- https://github.com/Projeto-ACBr-Oficial/ACBrLib-Nodejs
- https://www.npmjs.com/package/@projetoacbr/acbrlib-nfe-node

---

## Histórico

| Data | Evento |
|------|--------|
| 2026-06-26 | Estudo concluído — decisão: não migrar agora; plano arquivado neste documento |
