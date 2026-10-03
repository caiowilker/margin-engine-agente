# Matriz de aceite — Carga MGV (C1–C12)

| ID | Cenário | Esperado | Como verificar |
|----|---------|----------|----------------|
| C1 | 2 PENDING; envia 1 | lote N=1; outro PENDING | `BalancaCargaEnviarAgoraContractTest` + `BalancaCargaWorkerFiltroTest` |
| C2 | N=0 | UI bloqueia; zero POST | StatusPanel: botão disabled `selecione` |
| C3 | Lote ativo; envia | 409; outbox intacta | Contract test `slotOcupadoLanca409` |
| C4 | Agente offline | UI bloqueia; zero falsa confirmação | Footer `offline`; sem pill Confirmado |
| C5 | Remover PENDING | GET sem item | `DELETE .../fila/{produtoId}` |
| C6 | Limpar logs | GET logs vazio | `DELETE .../logs` (lote ou gerenciador) |
| C7 | Install fresco | dirs `balanca\carga` existem | Inno `[Dirs]` + `directory-manager.test.js` + teste C7 em `balanca-carga.test.js` |
| C8 | Update + UNC | UNC preservada | Teste C8; `efetivar` não sobrescreve config |
| C9 | Double Enter | 1 lote | `envioInFlightRef` até HTTP settle |
| C10 | ACK IMPORTADO | Confirmado só após poll/ACK | `entregaStatus` do backend |
| C11 | ACK ERRO | Falhou + reenviar só esse | `refilaFalhaAntesDoEnvio` + UI drawer `produtoId` |
| C12 | Assistente + scale | sem regressão | Não tocar `src/scale`; assistente só label default |

## Definition of Done

- [x] I1–I8 cobertos por teste ou checklist lab  
- [x] C1, C3 e C11 (refila falha) automatizados no backend  
- [x] UI manda `produtoIds` explícitos (N = payload)  
- [x] Pasta default instalada; UNC preservada  
- [x] Mutações remover/log no servidor  
- [x] Zero regressão checkout scale / assistente core  

## Lab final (antes do primeiro caixa real)

Smoke mínimo em Windows com MGV/pasta:

1. Install fresco → pastas `balanca\carga` e `balanca\sombra` existem  
2. Config com UNC → repair/update **não** apaga UNC  
3. 2 pendentes → envia 1 → outro fica PENDING  
4. Lote DELIVERED → segundo envio mostra 409 / botão bloqueado  
5. ACK ERRO → pill Falhou → Reenviar este item gera 1 lote  
6. Checkout scale (F1 peso) intacto na mesma máquina

## Comandos

```bash
# Backend (contratos)
cd margin-engine && mvn -q -Dtest=BalancaCargaEnviarAgoraContractTest,BalancaCargaWorkerFiltroTest,BalancaCargaAdminTenantIsolationTest test

# Agente (pasta + carga)
cd agente-local && node test/directory-manager.test.js && node --test test/balanca-carga.test.js
```
