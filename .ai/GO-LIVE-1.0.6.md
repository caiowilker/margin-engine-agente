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

## Agente offline na ativação (ME-012)

1. `sc query "Margin Engine"` — deve estar `RUNNING`.
2. Se parado: `sc start "Margin Engine"` e aguarde ~15s.
3. Teste: `http://localhost:9100/health` no navegador do caixa.
4. Se crash-loop: veja `%ProgramData%\MarginEngine\Logs` e use **Reparar** no instalador (não apague ProgramData).
5. Hotfix 1.0.6: recycle com graça de boot + watchdog atrasado — recompile/instale antes de validar de novo.

## Não fazer

- Não apagar `%ProgramData%\MarginEngine` no update.
- Não forçar `ACBR_POSPRINTER_INI` / fiscal INI no install-dir.
- Não reabrir contingência manual sem SEFAZ realmente fora.
