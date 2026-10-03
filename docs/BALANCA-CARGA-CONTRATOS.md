# Carga MGV — contratos de produção

Alinhamento legal entre UI ↔ Admin API ↔ Outbox/Worker ↔ Agente ↔ Pasta.
Não é polish de tela: seleção ≡ lote ≡ ACK.

## Invariantes

| ID | Regra |
|----|--------|
| I1 | `produtoIds` no POST = claim outbox = `quantidadeProdutos` |
| I2 | 1 lote ativo/gerenciador; novo envio → 409 `BALANCA_LOTE_EM_ANDAMENTO` |
| I3 | Só claimável PENDING; ID inválido → 400, zero lote |
| I4 | Single-flight UI + claim atômico + 1 lote/agente |
| I5 | Pill UI ⊆ outbox/lote (sem Confirmado otimista) |
| I6 | Remover/limpar logs mutam servidor |
| I7 | Pasta: config preenchida > default `%ProgramData%\MarginEngine\balanca\carga` |
| I8 | Zero acoplamento com checkout `src/scale` |

## API

```http
POST /pdv/balanca/carga/gerenciadores/{id}/enviar-agora
{ "produtoIds": ["uuid", ...] }
```

- **200** `{ ok, loteId, quantidadeProdutos, mensagem }`
- **409** `{ codigo: "BALANCA_LOTE_EM_ANDAMENTO", erro, acaoRecomendada }`
- **400** seleção inválida / gerenciador inativo

```http
DELETE /gerenciadores/{id}/fila/{produtoId}   # cancela outbox + desativa mapa
DELETE /lotes/{loteId}/logs
DELETE /gerenciadores/{id}/logs
```

## Pasta (agente + install)

- Inno + DirectoryManager: `balanca\`, `balanca\carga\`, `balanca\sombra\` (`uninsneveruninstall`, espelho `cert`)
- `pastaCarga` vazia no JSON → runtime resolve default; **não** grava default de volta (UNC preservada em update)
- Falha de escrita → ACK/erro em PT (sem hex)

## Fora de escopo

Checkout scale · NFC-e · layout binário MGV · cosmético sem contrato

Ver checklist C1–C12 em [BALANCA-CARGA-MATRIZ-ACEITE.md](./BALANCA-CARGA-MATRIZ-ACEITE.md).
