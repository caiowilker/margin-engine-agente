# ADR — Sessão ACBrLib / koffi sólida (Windows)

**Status:** Aceito  
**Data:** 2026-08-01  
**Contexto:** `Unexpected External value, expected void **`, Diagnóstico OFFLINE/CONTINGÊNCIA e Motor “Verificar” com emissão ativa.

## Decisões

1. **Slots separados** NFe (`ACBrNFe64.dll`) e NFS-e (`ACBrNFSe64.dll`) — nunca o mesmo handle koffi.
2. **Não sobrescrever DLL** no staging com sessão ativa; sync só se ausente ou origem mais nova.
3. **INI staging** só regrava se conteúdo mudou; **fingerprint de sessão NÃO inclui hash do INI** (Lib grava em runtime).
4. **Idle finalize** sob `withAcbrLock` — sem corrida com emissão.
5. **Handle morto:** abandonar sem `Finalizar`; retry único; watchdog/preflight sem EPEC.
6. **StatusServico:** single-flight + cache ~45s; watchdog pula live se memória online <45s.
7. **Memória:** falha koffi → `degradado`; emissão off → `desligado` (não OFFLINE no Diagnóstico).
8. **PosPrinter:** mesmo padrão — não overwrite DLL com sessão ativa.

## Consequências

- Menos churn Finalizar/Inicializar, emissão e status mais rápidos e estáveis no Win10/11.
- Contingência EPEC só por SEFAZ realmente degradada.
