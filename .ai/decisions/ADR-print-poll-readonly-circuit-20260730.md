# ADR — Poll de impressão read-only e circuito ACBr persistente

**Data:** 2026-07-30  
**Status:** Aceito  
**Contexto:** PC de loja com hang ~150s, `AbortError` no front, falso “Agente off” e loop de `Configuração salva` a cada poll de status.

## Decisão

1. **Poll/status é somente leitura** — `testar` / `probeImpressoraLeve` / `GET /impressora/status` **não** chamam `sincronizarDeDeteccao`, `salvar` nem `resetPrintProvider`.
2. **`salvar` / `sincronizarDeDeteccao` são idempotentes** — se porta/modelo/colunas/env não mudam, não gravam disco nem resetam provider.
3. **Circuito ACBr RAW** abre em timeout / `-10` / hard-drain e **persiste em disco** (`acbr-pos-circuit.json` ao lado do INI). Comerciais usam ESC/POS nativo; fiscal/DANFE ainda pode tentar ACBr. Reset só com Detectar/Salvar force do operador ou `PRINT_ACBR_CIRCUIT=false`.
4. **Front:** Abort/timeout de POST de impressão = `timeout_impressao` (ocupado), **não** `agente_offline`. Offline só por falha real de rede/`/health`.

## Consequências

- Elimina thrash de config no poll e disputa com o spooler durante job.
- Segundo cupom após falha ACBr fica rápido (native direto).
- UI não marca caixa offline só porque a impressão demorou além do AbortSignal.

## Alternativas rejeitadas

- Aumentar timeout do front para minutos (mascara hang; piora UX).
- Resetar circuito a cada `detectar` automático (reabre caminho lento).
- Marcar Abort de print como offline (falso positivo operacional).
