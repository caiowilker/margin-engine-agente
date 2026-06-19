# Deploy Produção — Agente Local v5.4

## Checklist

1. Copiar **todos** os `.js` listados em `manifest.json` para `C:\Program Files\PDV Margin Engine\app\`
2. Copiar `manifest.json`
3. Atualizar `.env`: `AGENT_TOKEN_REQUIRED=true`, `FISCAL_BOOT_CANCEL=false`
4. Rebuild front (`margin-engine-front`) — correção `correlationId` deduplicado
5. Reiniciar serviço Windows do agente
6. Validar: `npm test` no repo
7. Validar: `GET /diagnostico/metricas` com `X-Agent-Token`
8. Testar venda: carrinho libera < 2s; NFC-e em background
9. Confirmar `integrity_check` no log de boot
10. Confirmar fila fiscal vazia ou jobs recuperados após reboot

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
