# PROGRESS — Agente Local

**Última atualização:** 2026-07-01  
**Versão:** `1.0.0` — certificada com a plataforma

> **Certificação:** [`../../margin-engine/.ai/certification/CERTIFICACAO_1.0.md`](../../margin-engine/.ai/certification/CERTIFICACAO_1.0.md)  
> **Estado oficial:** [`../../margin-engine/.ai/PROJECT_STATUS.md`](../../margin-engine/.ai/PROJECT_STATUS.md)

---

## Maturidade

| Dimensão | Indicador |
|----------|-----------|
| ACBrLib (padrão 1.0) | 🟢 `ACBR_DRIVER=lib` default |
| ACBr Monitor (fallback) | 🟢 `ACBR_DRIVER=monitor` |
| Fila fiscal + callback | 🟢 Produção |
| Impressão (PrintJobService + hardening F13) | 🟢 Pipeline único certificado |
| Contingência EPEC | 🟢 Automática F14/F16 |
| Instalador Windows | 🟢 Stop/start + anti-downgrade + `check:release-alignment` |
| Build Windows | 🟢 Pipeline documentado em `build/windows/LEIA-ME.md` |
| Recovery SQLite degradado | 🟢 F15 |
| Testes automatizados | 🟢 `npm test` verde |

---

## Entregas F13–F17

| Frente | Entrega |
|--------|---------|
| F13 | `print/printJobService.js`, worker, retry, catálogo config |
| F14 | Watchdog → contingência; instalador stop/restart; docs antivírus |
| F15 | Limites fila offline/fiscal; `recoverCorruptedBootDbs`; métricas diagnóstico |
| F16 | EPEC UUID; restore SEFAZ; bootstrap abort; paths docs |
| F17 | Certificação plataforma 1.0.0 |

---

## Driver fiscal

```
fiscal/factory.js
  ├── lib      ← padrão 1.0 (ACBrLib Pro)
  └── monitor  ← fallback (ACBr Monitor TCP)
```

Contrato unificado: `fiscal/contract.js` + testes paridade.

---

## Operação

- Docs: `docs/OPERACAO.md`, `docs/CONTRATOS_API.md`
- Checklist Windows: `../../margin-engine/.ai/homologacao/checklist-homologacao-windows-1.0.md`
- Deploy: `.ai/DEPLOY_PRODUCTION.md`

---

## Pendente (não bloqueante 1.0)

- Homologação SEFAZ em hardware Windows por loja piloto
- Remoção componentes legados exportados sem uso (coordenação com front)
