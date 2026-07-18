# PROGRESS — Agente Local

**Última atualização:** 2026-07-18  
**Versão:** `1.0.0` — certificada com a plataforma

## Changelog (2026-07-18)

### Update remoto — fase 5 (fechamento / hardening)

- **ACK pós-restart:** `updaterCloudPending.js` persiste pedido de ACK após apply cloud; flush no poll de config (idempotente).
- **Rollback HTTP:** `/updater/rollback` restaura backup e **agenda reinício** (evita processo com código velho em memória).
- Testes: `updater-cloud-pending.test.js`.

### Update remoto — fase 4 (observabilidade no ERP)

- Listagem `GET /pdv/ativacao/terminais` inclui `agentVersion`, heartbeat, flags de update (`updatePendente`, erro, `versionOutdated`) e `latestAgentVersion`.
- Front Terminais PDV: chips de status, alerta de frota desatualizada, cancelar pedido pendente.
- Testes em `PdvAtivacaoControllerTest` (toTerminalListItem).

### Update remoto — fase 3 (comando por dispositivo no cloud)

- Backend: colunas `update_requested_*` / `update_applied_at` / `update_last_error`; `POST /pdv/dispositivos/{id}/update/request|cancel`; `POST /pdv/agente/update/ack`.
- Agente: após poll de config, se `aplicarUpdateQuandoOcioso`, tenta apply ocioso (`force: false`) e envia ACK; ocupado não ACK (reintenta).
- Front: Terminais PDV → “Atualizar agente” por terminal ATIVO.
- Teste: `updater-cloud-request.test.js`.

### Update remoto — fase 2 (publicação + apply seguro)

- **`npm run release:update`**: gera `dist/update.zip` + `update-release.json` + `update-release.env` (variáveis `PDV_AGENTE_*` para o Render).
- **`updaterIdleGuard`**: `UPDATE_REQUIRE_IDLE=true` (padrão) — não aplica com fiscal/fila ativos; Diagnóstico oferece força com confirmação; AUTO_UPDATE nunca força.
- Front Diagnóstico: confirm “Aplicar mesmo assim” quando 409 ocupado.

### Update remoto — fase 1 (manifest completo + anti-downgrade)

- **Política** `scripts/manifestPolicy.js`: update.zip inclui JS da raiz, `package.json`, `print/`, `fiscal/`, `runtime/`, `storage/` e `frontend-dist/`; exclui nativos, DLLs, `node_modules`, testes e scripts de build.
- **Geração** `generate-manifest.js` / `package:update` validam cobertura obrigatória (ex.: `print/qrCodeAcbrBmp.js`) antes de publicar.
- **Anti-downgrade** `updaterVersion.js` (paridade Inno) em `updaterRemoteCheck` e `manifestUpdater.aplicarPacote`.
- **Apply sólido:** grava o novo `manifest.json` após copiar arquivos (corrige boot `manifestOk: false`); backup formato 2 com `_backup-index.json` sem sobrescrever o manifest real; exige `package.json` no pacote.
- Testes: `manifest-policy.test.js`, anti-downgrade em `updater-remote-check` e `manifest-updater-front`.

### QR Code NFC-e no cupom térmico — BMP sem sharp

- **Bug:** `gerarBmpQrAcbr` usava `sharp.toFormat("bmp")`, formato de saída **não suportado** pelo sharp. Toda URL de QR NFC-e (contém `|`) falhava na geração do BMP → `printExecutor` caía no fallback ESC/POS nativo → impressoras sem comando QR nativo imprimiam a **URL em texto** no lugar do QR.
- **Correção:** `print/qrCodeAcbrBmp.js` agora codifica BMP monocromático 1-bpp diretamente da matriz do QR (`qr-image.matrix`), com quiet zone de 4 módulos e escala via `PRINTER_QR_BMP_WIDTH` (padrão 280 px). Sem dependência de sharp no fluxo de impressão.
- **Teste:** harness de `test/print-extended.test.js` corrigido para aguardar testes assíncronos (a falha era engolida); teste do QR BMP agora valida header `BM`, 1 bpp e tamanho do arquivo gerado.

## Changelog (2026-07-17)

### Impressão — contrato HTTP e status honest

- Helper `responderResultadoImpressao`: contrato único **200** impresso / **202** fila em cupom, abertura, fechamento, movimento, pedido, gaveta, teste, segunda-via.
- `GET /status`: durante fiscal ocupado, **não** chama `impressora.testar()` (paridade com `/status-basico`); evita falso `impressoraConectada=false` / timeout → offline no PDV.

> **Certificação:** [`../../margin-engine/.ai/certification/CERTIFICACAO_1.0.md`](../../margin-engine/.ai/certification/CERTIFICACAO_1.0.md)  
> **Estado oficial:** [`../../margin-engine/.ai/PROJECT_STATUS.md`](../../margin-engine/.ai/PROJECT_STATUS.md)

---

## Maturidade

| Dimensão | Indicador |
|----------|-----------|
| ACBrLib (padrão 1.0) | 🟢 `ACBR_DRIVER=lib` default |
| ACBr Monitor (fallback) | 🟢 `ACBR_DRIVER=monitor` |
| Fila fiscal + callback | 🟢 Produção |
| Impressão (PrintJobService + hardening F13) | 🟢 Pipeline único certificado |
| Contingência EPEC | 🟢 Automática F14/F16 |
| Instalador Windows | 🟢 Stop/start + anti-downgrade + `check:release-alignment` |
| Build Windows | 🟢 Pipeline documentado em `build/windows/LEIA-ME.md` |
| Recovery SQLite degradado | 🟢 F15 |
| Testes automatizados | 🟢 `npm test` + `test:integration` verdes |
| Order Engine / Print Station | 🟢 `POST /impressora/pedido` + `frontend-dist` alinhado |
| NFS-e (modelo 99) | 🟢 Rotas `/fiscal/nfse/emitir`, callback `chaveNfe`+`chaveNfse`, 6 testes contrato |

---

## Entregas F13–F17

| Frente | Entrega |
|--------|---------|
| F13 | `print/printJobService.js`, worker, retry, catálogo config |
| F14 | Watchdog → contingência; instalador stop/restart; docs antivírus |
| F15 | Limites fila offline/fiscal; `recoverCorruptedBootDbs`; métricas diagnóstico |
| F16 | EPEC UUID; restore SEFAZ; bootstrap abort; paths docs |
| F17 | Certificação plataforma 1.0.0 |

---

## Driver fiscal

```
fiscal/factory.js
  ├── lib      ← padrão 1.0 (ACBrLib Pro)
  └── monitor  ← fallback (ACBr Monitor TCP)
```

Contrato unificado: `fiscal/contract.js` + testes paridade.

---

## Operação

- Docs: `docs/OPERACAO.md`, `docs/CONTRATOS_API.md`
- Checklist Windows: `../../margin-engine/.ai/homologacao/checklist-homologacao-windows-1.0.md`
- Deploy: `.ai/DEPLOY_PRODUCTION.md`

---

## Pendente (não bloqueante 1.0)

- Homologação SEFAZ em hardware Windows por loja piloto
- Remoção componentes legados exportados sem uso (coordenação com front)
