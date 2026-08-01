# ADR — Sessão ACBrLib / koffi sólida (Windows)

**Status:** Aceito (revisado)  
**Data:** 2026-08-01  
**Contexto:** `Unexpected External value, expected void **`, Diagnóstico OFFLINE/CONTINGÊNCIA e Motor “Verificar” com emissão ativa. Auditoria P0 pós-1.0.6.

## Decisões

1. **Slots separados** NFe (`ACBrNFe64.dll`) e NFS-e (`ACBrNFSe64.dll`) — nunca o mesmo handle koffi; staging `margin-acbrlib` ≠ `margin-acbrlib-nfse`.
2. **Não sobrescrever DLL** no staging com sessão ativa **ou** após soft-abandon (`dllPinned` até recycle do processo); `prepareNativeRuntime` sob `withAcbrLock`.
3. **INI staging** só regrava se conteúdo mudou; **fingerprint de sessão NÃO inclui hash do INI** (Lib grava em runtime).
4. **Idle finalize** sob `withAcbrLock`; busy check **antes** do lock; dentro do lock (`isHoldingAcbrLock`) idle **pode** `Finalizar`.
5. **`withAcbrLock` reentrante** (AsyncLocalStorage) — emit → enrich cStat 104 → consultar sem deadlock.
6. **Handle morto:** abandonar sem `Finalizar`; **soft-dead até recycle** (sem re-Inicializar em loop); `clearSoftDead` só em refresh/shutdown/operator_reset.
7. **StatusServico:** single-flight + cache longo só para positivo; negativo TTL curto (~5s).
8. **Memória:** falha koffi → `degradado` sticky enquanto soft-dead/koffi recente; emissão off → `desligado`.
9. **PosPrinter:** não overwrite DLL com sessão, `_dllPinned` ou worker ativo com staged lib.
10. **Watchdog:** nunca EPEC por soft-dead / degradado / koffi recente.
11. **chdir:** Pos in-process recusa se fiscal busy ou sessão NFe ativa (worker default evita o problema).

## Consequências

- Menos churn Finalizar/Inicializar, emissão e status mais estáveis no Win10/11.
- Contingência EPEC só por SEFAZ realmente degradada (não por falha em cache).
- Soft-abandon exige restart do processo do agente para atualizar DLL no staging.
