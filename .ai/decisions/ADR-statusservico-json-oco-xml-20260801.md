# ADR — StatusServico: JSON oco vs XML WS (cStat 107)

**Status:** Aceito  
**Data:** 2026-08-01  
**Contexto:** Pós wipe/reinstall no Windows, Diagnóstico marcava Motor OFFLINE / “Verificar” apesar de mTLS e SEFAZ-MG operacionais. Emissão bloqueada por contingência falsa (`SEFAZ_OFFLINE`).

## Problema

1. ACBrLib com `TipoResposta=2` (JSON) frequentemente serializa StatusServico como  
   `{ "Status": { "CStat": 0, "XMotivo": "", ... } }` — JSON **oco**, sem erro nativo.
2. O XML gravado por SalvarWS (`%TEMP%\margin-acbrlib\notas\*-sta.xml`) contém o retorno real:  
   `cStat=107 Serviço em Operação`.
3. O agente/UI tratavam `CStat=0` como falha → watchdog → contingência → fila pausada.
4. Paridade de certificado: API precisa aplicar `Certificado.Arquivo/Senha` **e** `DFe.*`;  
   no INI runtime, `[Certificado] Senha=` em plaintext (comportamento estável 19/07); `DFe.Senha` permanece B64Crypt.

## Decisão

1. Detectar JSON oco de Status (`isHollowStatusJson`) em `acbrLibResposta.js`.
2. Se hollow: ler o `*-sta.xml` mais recente (janela ~120s) e normalizar com `parseRetConsStatServXml`.
3. Expor `statusSource: "sta_xml"` no `/acbr/sefaz/status` quando o fallback for usado.
4. Manter senha do certificado no INI runtime em plaintext na seção `[Certificado]` (paridade campo).
5. Não alterar `TipoResposta` global neste hotfix — fallback XML é defesa imediata e testável.

## Consequências

- Diagnóstico e preflight refletem SEFAZ real (107) mesmo com bug de serialização JSON.
- Contingência EPEC deixa de disparar por falso offline desse tipo.
- Dependência de SalvarWS/`notas` no staging — se XML ausente, comportamento anterior permanece.
- Evolução futura opcional: TipoResposta INI/XML nativo ou correção upstream ACBrLib JSON.

## Validação em campo (2026-08-01)

- Serviço Margin Engine 1.0.6 + hotfix: log  
  `[ACBrLib] StatusServico recuperado do XML WS … cStat=107`.
- API: `operacional: true`, `cStat: "107"`, `statusSource: "sta_xml"`.
- Contingência encerrada; fila fiscal retomada; backend `:8080` UP.
