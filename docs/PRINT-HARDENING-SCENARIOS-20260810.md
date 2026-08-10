# Print hardening — evidência cenários A–F (2026-08-10)

## A — Duas abas, mesmo stationId
- Leader tab via `printStationLeader` (localStorage + BroadcastChannel).
- Follower não claima; 409 ×5 → silêncio + drop da fila local.
- Evidência: `margin-engine-front/src/test/printHardeningScenarios.test.ts` (A)

## B — Estação trava no claim
- Heartbeat stale `PRINT_LEADER_STALE_MS` (3.5s) → outra aba assume.
- Backend TTL claim 30s → `clearExpiredClaims` libera lease; outra estação claima.
- Evidência: teste B + `PrintDispatchServiceClaimTest` (TTL/renew/busy)

## C — Bar + Entrega mesma estação
- Jobs de categorias distintas: filas/prioridade sem race de claim entre tipos.
- Agente: `physicalResourceLock.run` serializa RAW (sem buffer ESC/POS corrompido).
- Evidência: teste C front + `print-hardening-scenarios.test.js` (mutex)

## D — Rede cai 30s
- Claim error → backoff/requeue; sucesso marca `seen` (anti-dupla no pending pós-rede).
- Evidência: teste D

## E — 2ª via imediata
- `clickId` + chave idempotency distinta; banner expandido; `REIMPRESSAO_AUDIT`.
- Evidência: teste E + vasilhame tags

## F — Jobs incidente produção
- `985be217-6169-4bc2-95ca-202e6bdcb4f6` e `564216bb-a289-4ea8-9a06-bb08fd8b8351`
- Loop 409 corrigido: dropLocalJob + silêncio; `force-release` / `GET …/stuck` para órfãos.
- Evidência: teste F

## Vasilhame
- CODE128 `{B`; CODE39 com `forceCode128Fail`; QR module 58mm=4; texto VAS expandido.
