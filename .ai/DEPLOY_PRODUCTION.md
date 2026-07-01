# Deploy Produção — Agente Local v5.4

## Checklist

1. Preferir **`Margin-Engine-Setup-1.0.0.exe /MODE=update`** (preserva `%ProgramData%\MarginEngine`)
2. Alternativa manual: copiar arquivos listados em `manifest.json` para `%ProgramFiles%\Margin Engine\app\`
3. Copiar `manifest.json`
4. Atualizar `.env`: `AGENT_TOKEN_REQUIRED=true`, `FISCAL_BOOT_CANCEL=false`
5. Rebuild front (`margin-engine-front`) — correção `correlationId` deduplicado
6. Reiniciar serviço Windows do agente
7. Validar: `npm test` no repo
8. Validar: `GET /diagnostico/metricas` com `X-Agent-Token`
9. Testar venda: carrinho libera < 2s; NFC-e em background
10. Confirmar `integrity_check` no log de boot
11. Confirmar fila fiscal vazia ou jobs recuperados após reboot

## Migrations SQLite (automáticas no boot)

- `fila_fiscal.numero_venda`, `prioridade`
- `documentos_fiscais.serie_nfe`, `numero_nfe`
- `fiscal_metrics.db`, `audit.db` criados automaticamente

## Rollback auto-update

Backup em `data/backup-pre-update/<timestamp>/`

## Riscos residuais

- Multi-caixa no mesmo agente/ACBr ainda proibido
- Throughput limitado pelo mutex ACBr (~200–400 NFC-e/dia)
- Homologação SEFAZ MG instável — rate limit ativo
