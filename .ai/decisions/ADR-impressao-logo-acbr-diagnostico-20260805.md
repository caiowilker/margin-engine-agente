# ADR: Logo térmica imprimível + diagnóstico ACBr no painel

**Data:** 2026-08-05  
**Status:** IMPLEMENTADO  
**Afeta:** agente-local (PosPrinter), painel ImpressoraLocalPanel

## Problema

Em vários PCs a logo não saía no cupom, o ACBr PosPrinter “não funcionava” (na prática o circuito abria e o fallback native era silencioso) e a impressão parecia lenta ou sem feedback.

## Decisão

1. Upload de logo aceita PNG/JPG/BMP e **converte** para BMP 1-bpp; grava em path estável (`ProgramData/.../printer` ou `MARGIN_ENGINE_ROOT`).
2. Motivo de omissão da logo (`toggle_off` | `sem_arquivo` | `bmp_invalido` | `erro`) fica disponível em diagnóstico e no resultado do teste.
3. Status da impressora expõe `effectiveMode`, `acbr.loaded/circuit`, `lastPrint` (provider + duração + logo).
4. Painel PDV mostra modo ACBr vs Native (circuito/DLL) e resultado do teste com tempo/logo.

## Consequências

- Operador vê por que a logo não saiu e se o ACBr está em circuito.
- Detectar vira “Reativar ACBr” quando o circuito está aberto.
- Cap de largura da logo reduz risco de timeout do worker USB.
