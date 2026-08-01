# ADR — Solidez impressora/status no Windows 10

**Status:** Aceito  
**Data:** 2026-08-01  
**Contexto:** Caixa Win11 estável; Win10 com impressora e status que oscilam / somem / não persistem após update.

## Decisão

1. **SSOT do `posprinter.ini`:** `%ProgramData%\MarginEngine\Config\posprinter.ini`, com migração única a partir de `{install}\data\posprinter.ini` e de `ACBR_POSPRINTER_INI` legado no install dir. Overrides só fora de install/ProgramData (testes).
2. **Status “conectada”:** se existe porta RAW/TCP/COM válida persistida, Get-Printer timeout/false **não** marca offline (`resolverConectada` → fonte `configurada`). Impressão física continua validando no job.
3. **Poll:** priorizar recente/busy; deadline duro no probe; cache maior da lista Windows; `impressaoRecenteOk` com janela padrão 15 min.

## Consequências

- Update/reparo do instalador não zera a porta da térmica.
- UI do PDV deixa de oscilar “impressora off” / timeout de status no Win10 (efeito cascata em operação de caixa).
- Offline real só quando não há porta SSOT e o probe falha de fato.

## Alternativas rejeitadas

- Branch de código Win10 vs Win11 — sem evidência de API diferente; o problema é timing/persistência.
- Abrir sessão ACBr no poll — já rejeitado (prende spooler).
