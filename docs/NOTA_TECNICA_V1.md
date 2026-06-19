# Nota Técnica v1.0 — Agente Local Margin Engine

**Versão:** 1.0.0  
**Data:** 2026-06-19  
**Escopo:** Avaliação honesta do sistema entregue após Fases 1–5 de hardening + release Fase 6.

---

## 1. Notas por área

Escala: 0–10 (10 = excelência para o segmento alvo).

| Área | Nota | Comentário pós-hardening |
|------|------|--------------------------|
| **Fiscal** | **8,0** | Fila assíncrona, dedup, recovery por consulta de chave, rate limit SEFAZ, PDF fora do caminho quente. Limitado pelo ACBr síncrono TCP. |
| **Performance** | **7,5** | Checkout 1–2s; worker 500ms–1s; métricas p50/p95. Gargalo permanece no mutex ACBr (~3–5s/emissão). |
| **Segurança** | **8,0** | Token obrigatório, cofre de credenciais, SHA-256 manifest, headers nosniff/DENY, purge audit, logs sem PII completo. |
| **Resiliência** | **8,0** | Recovery boot, backoff consulta, graceful shutdown, purge automático, watchdog ACBr, fila WAL. |
| **Operação** | **8,5** | Dashboard, alertas, webhooks, relatório diário, recovery manual, guia OPERACAO.md, predeploy/smoke. |
| **Escalabilidade** | **5,5** | 1 instância = 1 caixa. Multi-caixa = N agentes (front já suporta). Sem pool ACBr ou orquestrador central. |
| **Arquitetura** | **7,0** | Módulos fiscais bem separados; `index.js` ainda monolítico (~1800 linhas). Adequado para varejo médio. |

**Nota geral ponderada: 7,6 / 10** — apto para produção comercial em cenários de 1 caixa e volume moderado.

---

## 2. Capacidade estimada por cenário

Premissas: emissão NFC-e ~30–60s por ciclo SEFAZ + ACBr; rate limit 12/min; worker serial.

| Cenário | Vendas/dia | NFC-e/dia | Aptidão | Observação |
|---------|------------|-----------|---------|------------|
| **1 caixa — padaria/mercearia** | 100 | 80 | ✅ Confortável | Margem ampla; fila raramente acumula |
| **1 caixa — farmácia** | 200 | 200 | ✅ Adequado | Fiscal obrigatório; monitorar incertos |
| **1 caixa — conveniência** | 300 | 280 | ✅ Adequado | Pico de manhã/noite; rate limit protege |
| **1 caixa — mercado pequeno** | 400 | 350 | ⚠️ Limite | Fila pode crescer em pico; exige dashboard |
| **1 caixa — supermercado** | 500+ | 500+ | ❌ Insuficiente | ~60–120 NFC-e/h máx; fila > 1h em pico |
| **Multi-caixa (3 caixas)** | 900 | 800 | ✅ Com 3 agentes | 1 agente por caixa, portas distintas |
| **Multi-caixa (5+)** | 1500+ | 1200+ | ⚠️ Operacional | Gestão de N instâncias; sem painel central |
| **24×7 contínuo** | Variável | Variável | ⚠️ Com monitoramento | Purge + watchdog + alertas obrigatórios |

**Throughput máximo sustentável por instância:** ~60–120 NFC-e/hora (~1.400–2.800/dia teórico, com margem operacional ~800/dia).

---

## 3. O que seria necessário para escalar além de 1 caixa por instância

Sem trocar componentes externos, **não há solução de código** que multiplique caixas na mesma instância:

| Componente atual | Limitação | Evolução necessária |
|------------------|-----------|---------------------|
| Cliente ACBr TCP | Mutex global, não thread-safe | Pool de processos ACBr ou API fiscal assíncrona (Focus NFe, Nuvem Fiscal, etc.) |
| Worker fiscal serial | 1 job EMISSAO por vez | Orquestrador com fila distribuída (Redis/RabbitMQ) |
| SQLite local | 1 writer | PostgreSQL ou fila centralizada multi-tenant |
| Manifest por instância | Deploy manual N vezes | CI/CD + orquestrador de agentes (Ansible, fleet manager) |
| Dashboard local | 1 URL por caixa | Painel central no backend agregando `/diagnostico/alertas` de N agentes |

**Roadmap sugerido para supermercado 500+ vendas/dia:**
1. Fase A: 1 agente/caixa (já suportado) — custo operacional linear.
2. Fase B: Substituir `acbr.js` por provedor fiscal cloud assíncrono.
3. Fase C: Fila central no backend; agente vira thin client (impressora + cache offline).

---

## 4. Recomendação: quando usar vs. quando evoluir

### Use este agente (v1.0) quando:

- 1 a 4 caixas físicos, cada um com seu PC
- 100–350 vendas/dia por caixa
- NFC-e via ACBr Monitor já instalado
- Rede instável tolerável (fila offline de vendas)
- Equipe de suporte consegue acessar o PC do caixa (TeamViewer, etc.)

### Evolua a arquitetura quando:

- Supermercado com 500+ NFC-e/dia **por caixa**
- Necessidade de orquestração central sem acesso remoto a cada PC
- SLA 99,9% 24×7 sem intervenção humana
- Multi-tenant SaaS com centenas de lojas
- Exigência de auditoria centralizada de todos os agentes em tempo real

### Veredito final v1.0

| Segmento | Veredito |
|----------|----------|
| Mercearia, padaria, pet shop | **Apto** |
| Farmácia, conveniência | **Apto** (com monitoramento) |
| Mercado médio (até 400 vendas/dia) | **Apto com ressalvas** |
| Supermercado alto volume | **Não apto** (usar multi-instância ou evoluir) |
| Operação 24×7 sem monitoramento | **Não recomendado** |

---

## 5. Riscos residuais (honestos)

| Risco | Probabilidade | Impacto | Mitigação atual |
|-------|---------------|---------|-----------------|
| SEFAZ instável (cStat 999) | Média | Médio | Rate limit + backoff + incertos + recovery |
| Callback backend falha pós-autorização | Baixa | Médio | Job CALLBACK_BACKEND na fila |
| Credential Manager não migra entre PCs | Alta (troca HW) | Baixo | Reativação pelo painel |
| Manifest SHA diverge pós-cópia | Média | Baixo | `npm run manifest` no destino |
| Crescimento audit.db | Baixa | Baixo | Purge 90 dias (Fase 6) |

---

## 6. Evidências de qualidade (release v1.0)

- **21/21** testes automatizados (`npm test`)
- **predeploy** — checks de manifest, SQLite, disco, ACBr, porta
- **smoke** — fluxo HTTP end-to-end
- **27+ arquivos** com SHA-256 no manifest
- Documentação: OPERACAO.md, LIMITACOES_ARQUITETURA.md, CHANGELOG.md

---

*Documento gerado na Fase 6 — Release. Não substitui contrato de SLA ou parecer fiscal/contábil.*
