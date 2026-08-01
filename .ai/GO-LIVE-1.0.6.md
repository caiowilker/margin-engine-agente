# GO-LIVE — Agente 1.0.6 (fechamento sólido)

**Data:** 2026-08-01  
**Estado:** pronto para caixa (main + `C:\build\pdv-agente` syncados)

## Pilares validados

1. **Emissão fiscal viva** — `EMISSAO_FISCAL` não congela no boot; self-heal na fila/rotas.
2. **Sessão ACBrLib/koffi** — slots NFe≠NFS-e; sem overwrite de DLL ativa; fingerprint estável; idle sob lock; void** com soft-reset.
3. **Diagnóstico estável** — sem OFFLINE/CONTINGÊNCIA/Motor “Verificar” por glitch koffi; emissão off = `desligado`.
4. **Impressora Win10** — INI em ProgramData; status por porta SSOT; poll sem falso offline.
5. **Release** — versão alinhada agente/back/front; `npm test` verde; manifest 1.0.6.

## Deploy no caixa

1. `C:\build\pdv-agente` → `.\prepare-build.ps1 -Compile` (ou pipeline equivalente).
2. Instalar/atualizar e **reiniciar o serviço** do agente.
3. Se Contingência EPEC ainda ativa → **encerrar** no Diagnóstico.
4. Confirmar: Emissão Ativa · Motor OK · Impressora Online · Status ONLINE.
5. Cupom teste + NFC-e homologação (e NF-e se usada).

## Não fazer

- Não apagar `%ProgramData%\MarginEngine` no update.
- Não forçar `ACBR_POSPRINTER_INI` / fiscal INI no install-dir.
- Não reabrir contingência manual sem SEFAZ realmente fora.
