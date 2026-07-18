# Deploy Produção — Agente Local v1.0.0

## Checklist

0. `npm run check:release-alignment` — versão alinhada agente ↔ backend ↔ instalador
1. Preferir **`Margin-Engine-Setup-1.0.0.exe /MODE=update`** (preserva `%ProgramData%\MarginEngine`)
2. **Update remoto (patches de código):** `npm run release:update -- --url=... --changelog="..."` → upload ZIP → colar `dist/update-release.env` no Render → no ERP **Terminais PDV → Atualizar agente** (ou Diagnóstico no caixa)
3. Alternativa manual: copiar arquivos listados em `manifest.json` para `%ProgramFiles%\Margin Engine\app\`
4. Copiar `manifest.json`
5. Atualizar `.env`: `AGENT_TOKEN_REQUIRED=true`, `FISCAL_BOOT_CANCEL=false`, `UPDATE_REQUIRE_IDLE=true`
6. Rebuild front (`margin-engine-front`) — correção `correlationId` deduplicado
7. Reiniciar serviço Windows do agente
8. Validar: `npm test` no repo
9. Validar: `GET /diagnostico/metricas` com `X-Agent-Token`
10. Testar venda: carrinho libera < 2s; NFC-e em background
11. Confirmar `integrity_check` no log de boot
12. Confirmar fila fiscal vazia ou jobs recuperados após reboot
13. Confirmar no ERP: versão do agente e chip de update (Terminais PDV)

## Rollback auto-update

Backup em `data/backup-pre-update/<timestamp>/` (índice `_backup-index.json` formato 2).  
`POST /updater/rollback` restaura o último backup e **reinicia** o agente.

## Riscos residuais

- Multi-caixa no mesmo agente/ACBr ainda proibido
- Throughput limitado pelo mutex ACBr (~200–400 NFC-e/dia)
- Homologação SEFAZ MG instável — rate limit ativo
