# ADR — Dois códigos de ambiente fiscal (não misturar)

**Data:** 2026-07-23  
**Status:** Aceito

## Contexto

Há dois enums diferentes no stack fiscal. Confundi-los grava produção/homologação errado no ACBrLib ou filtra XML do contador de forma incorreta.

## Decisão

| Camada | Produção | Homologação | Onde |
|--------|----------|-------------|------|
| **ACBrLib / Monitor `Ambiente`** | **0** | **1** | `acbrlib.ini`, `NFE.SetAmbiente` |
| **SEFAZ `tpAmb` (XML/documento)** | **1** | **2** | XML autorizado, INI do documento, índice contador |

- UI do PDV e `AMBIENTE_SEFAZ` usam strings `producao` / `homologacao`.
- Contador filtra pelo **tpAmb do XML** (1/2), nunca pelo enum Lib (0/1).

## Consequências

- Gravar `Ambiente=2` no acbrlib.ini está errado para a Lib (usar `1` + `AmbienteSefaz=homologacao`).
- `resolverTpAmb()` → SEFAZ 1/2; `resolverTpAmbAcbr()` / `ambienteToAmbienteLib()` → 0/1.
