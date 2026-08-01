# ADR — EMISSAO_FISCAL vivo no driver e INI de staging estável

**Data:** 2026-08-01  
**Status:** Aceito  
**Versão:** 1.0.6

## Contexto

Após salvar a configuração fiscal no painel (homologação, certificado, CSC, emissão ativa), o Diagnóstico continuava com “Emissão Desativada” e a fila fiscal retornava `EMISSAO_FISCAL desabilitada no agente`. Em paralelo, `testar()`/`statusServico` falhava a cada ~30s com `Unexpected External value, expected void **`, abrindo contingência EPEC falsa.

## Decisão

1. Drivers Lib e Monitor usam `wrapAcbrExports` (getter vivo de `EMISSAO_FISCAL` + set/get runtime).
2. Staging Windows: `writeFileIfChanged` + fingerprint por hash SHA do INI.
3. Erros koffi `void **` invalidam a sessão.
4. Boot e rotas de emissão chamam `garantirEmissaoFiscalAtiva` (self-heal autoridade/.env → runtime) antes de recusar.
5. NF-e com `forcarEmissao` respeita o bypass do toggle (painel) sem depender só de `isNfeModelo55Habilitado()`.

## Consequências

- Toggle “Emissão fiscal ativa” vale imediatamente na fila e no Diagnóstico.
- Menos churn de Inicializar/Finalizar e menos EPEC espúria.
- Pacote de update remoto `1.0.6` (pasta `fiscal/` incluída no manifest).
