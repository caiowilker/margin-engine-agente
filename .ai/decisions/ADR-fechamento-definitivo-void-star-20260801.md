# ADR — Fechamento definitivo void**/koffi (conhecido × desconhecido)

**Data:** 2026-08-01  
**Status:** aceito (direção técnica)  
**Contexto:** caixa Caixa 1 / Win — emissão `FALHA_TEMPORARIA`, Diagnóstico “SEFAZ off”, logs `void **` em ~2s de uptime.

---

## 1. O que SABEMOS (provado)

| # | Fato |
|---|------|
| 1 | A mensagem `Unexpected External value, expected void **` nasce no **`NFE_Inicializar`** do wrapper oficial (`koffi.alloc` + bridge `void **`), **não** no StatusServico em si. StatusServico só é o 1º *acionador* comum. |
| 2 | `@projetoacbr/acbrlib-*-node` **é** FFI via **koffi**. Não existe “usar o npm sem koffi”. |
| 3 | Soft-abandon + `Symbol.dispose`/`Finalizar` em handle morto **envenena** o processo (ADR forense anterior). |
| 4 | Soft-retry com **nova Inicializar** no mesmo processo (sem Finalizar a abandonada) **amplifica** corrupção. Removido em NFe; NFS-e/preflight também alinhados. |
| 5 | Soft-dead é **terminal** neste processo — recuperação = **recycle** do serviço. |
| 6 | Com `EMISSAO_FISCAL=true`, recycle **não** espera graça de boot de 120s. |
| 7 | Boot **não** chama StatusServico no segundo 0; acionadores em ~2s: fila/recovery, worker fiscal (~500ms), HTTP preflight/diagnóstico. |
| 8 | PosPrinter in-process compartilha `process.chdir` com NFe — corrida real se `posWorkerActive=false` + fallback in-process. |
| 9 | “Motor OK” ≠ handle koffi saudável. “SEFAZ off” no UI frequentemente é **poison**, não SEFAZ. |

---

## 2. O que NÃO SABEMOS (precisa evidência de campo)

| # | Gap | Como fechar |
|---|-----|-------------|
| A | Por que o **primeiro** `NFE_Inicializar` de um processo limpo já falha com `void **`? | Log `acbrlib.inicializar_begin` (path DLL, arch, koffi, cwd) + hash/PE da DLL staged |
| B | DLL carregada é a certa (x64 MT cdecl) e bate com Node x64 / koffi? | `node -p process.arch`, `npm ls koffi --all` no caixa, Dependências da DLL |
| C | Houve chamada nativa **antes** do 1º log visível (fila recovery)? | Timeline fila + requests nos primeiros 2s |
| D | PosPrinter caiu em in-process e corrompeu heap antes do 1º NFe? | Flags `ACBR_POS_WORKER`, logs de fallback worker |
| E | INI/cert/staging apontam para path errado após update? | Dump `ACBR_LIB_PATH`, staged `%TEMP%/margin-acbrlib*` |

Até fechar A–B, qualquer “fix in-process” é mitigação, não garantia.

---

## 3. Direção definitiva (escolha)

### Opção 1 — Isolar NFe/NFS-e Lib em **processo filho** (RECOMENDADA)

- Espelha o padrão PosPrinter worker.
- `void **` / heap koffi matam só o worker; HTTP :9100 e PDV continuam.
- Recycle do worker ≠ crash-loop do serviço Windows.
- **Única** forma de eliminar a classe de falha “koffi no mesmo processo que o agente”.

### Opção 2 — Produção em **ACBr Monitor** (`ACBR_DRIVER=monitor`)

- Remove koffi do Node (modo antigo estável).
- Custo: instalar/gerir `ACBrMonitor.exe`, TCP, operação.
- Escape hatch imediato se o caixa precisar emitir **hoje**.

### Opção 3 — Continuar Lib in-process endurecido

- Mutex global cwd/FFI, sem retry, telemetria, Pos só em worker.
- **Não** elimina a classe de falha; só reduz probabilidade.

**Decisão:** seguir **Opção 1** como arquitetura alvo 1.0.x; Opção 2 como contingency operacional; Opção 3 como endurecimento enquanto o worker não sobe.

---

## 4. Já aplicado neste ciclo

- Sem retry in-process após `void **` (NFe + NFS-e + preflight).
- Soft-dead terminal até recycle.
- Recycle imediato com emissão ligada.
- Telemetria `acbrlib.inicializar_begin` / `_ok` / `_fail`.
- Graça de boot só quando emissão off (ativação ME-012).

---

## 5. Próximo incremento (worker NFe)

1. `fiscal/workers/acbrNfeWorker.js` + pool IPC (espelhar `acbrPosWorker`).
2. Rotas nativas (`statusServico`, `emitir*`, `consultar*`) → pool.
3. `process.chdir` / `koffi.load` **somente** no worker.
4. Crash do worker → respawn; processo HTTP intacto.
5. Teste de campo: 50 emissões homolog + Diagnóstico estável.

---

## 6. Contingência operacional (caixa agora)

```bat
REM Escape hatch se precisar emitir enquanto worker não está pronto:
REM No .env do agente (ProgramData / install):
ACBR_DRIVER=monitor
```

Exige ACBr Monitor instalado e escutando. Ou: reinstalar build atualizado + reiniciar serviço e observar log `acbrlib.inicializar_begin` na primeira falha.
