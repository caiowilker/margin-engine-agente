# Etapa 11-A — Conferências (evidência)

Versão alinhada: **1.0.124**.  
Defaults: cache local **ON**, finalização offline **ON** (paridade produção — lojas já vendem offline; só crediário bloqueado), UI otimista **ON**. Kill switch sem redeploy:
- `localStorage.pdv-catalogo-cache-local=0` ou `VITE_PDV_CATALOGO_CACHE_LOCAL=0`
- `localStorage.pdv-finalizar-offline=0` ou `VITE_PDV_FINALIZAR_OFFLINE=0`
- `localStorage.pdv-frente-otimista=0` ou `VITE_PDV_FRENTE_OTIMISTA=0`

## 1) Lápides (inativação / exclusão)

**Comportamento**
- Soft-delete (`ativo=false`): `syncCaixa` coloca o id em `desativados`.
- Hard-delete: grava `pdv_catalogo_lapide` e o sync inclui o id em `desativados`.
- Front: `mesclarCatalogoCaixaSync` remove; `isProdutoVendavelNoCaixa({ativo:false})` = false.

**Testes**
- Backend: `PdvProdutoServiceSyncCaixaTest#produtoInativadoVaiEmDesativados`
- Front: `pdvFinalizacaoOffline.test.ts` (lápide + ativo=false no delta)

## 2) Cursor do servidor + overlap

**Comportamento**
- `serverTime = Instant.now()` no servidor (não relógio do cliente).
- Cliente reenvia `meta.serverTime` como `since`.
- Servidor aplica `since - 2s` (`SYNC_CAIXA_OVERLAP_SECONDS`) antes da query.
- Preço/estoque no `pdv_produto` disparam `@PreUpdate` → entram no delta.
- Promoção em outra tabela: `PromocaoService` faz bump de `updated_at` nos produtos do escopo.

**Testes**
- `PdvProdutoServiceSyncCaixaTest#sinceAplicaOverlapDeDoisSegundos`
- `PdvProdutoServiceSyncCaixaTest#mudancaDePrecoEntraNoDelta`
- Front já chama `syncCaixa(meta.serverTime)` (`useFrenteCatalogo.test.ts`)

Clock skew do cliente (adiantado/atrasado) não altera o cursor: o `since` é o ISO do servidor.

## 3) Crediário — servidor recusa na finalização

Cache/UI podem liberar a tela; a finalização chama `gerarParcelas` no servidor.

**Testes (servidor decide HOJE)**
- `PdvCrediarioServiceTest#gerarParcelasBloqueiaClienteBloqueadoSemPermissao`
- `PdvCrediarioServiceTest#gerarParcelasRecusaLimiteEstourado`
- Front: `crediarioCheckout` bloqueia offline / sem cliente

Trava transacional completa → 11-D.

## 4) Off+cache — finalizar sem conexão

**Regra**
- Finalização offline (fila/emergência) **ligada por padrão** (paridade produção). `modoOfflineConfirmado` não é exigido — blip de rede também enfileira.
- Kill switch `pdv-finalizar-offline=0` → `FinalizacaoOfflineBloqueadaError`; carrinho permanece.
- Crediário continua bloqueado offline (`avaliarCrediarioCheckout.bloqueioOffline`).

**Testes**: `pdvFinalizacaoOffline.test.ts`; `etapa13DefaultsOff.test.ts`; `registrarVendaCheckout` com `permitirFinalizacaoOffline: false`.

**Riscos do modo planejado**: estoque/preço/crediário não revalidados no servidor até o sync; NFC-e fica pendente.

## 5) Segurança / LGPD do cache

- IndexedDB nomeado `pdv-cache-{tenantId}:{userId}`; LS prefixado igualmente (`configurarPdvCacheEscopo`).
- Logout / `switchTenant`: `limparCache()` + reset de escopo.
- Troca de operador: limpa CPF/CNPJ/nome/crediário na frente + `limparDadosPessoaisClienteCache`.
- Nada de um estabelecimento fica no DB do outro (bancos distintos).

## 6) Resiliência IndexedDB

- Schema version **3** (`PDV_CACHE_SCHEMA_VERSION`); store `meta`.
- Quota/VersionError/corrupção → `reconstruirCacheAposFalha()` e fallback `listar?view=caixa` (sem travar venda).
- Kill switch cache off → sempre listagem plena.

## 7) Kill switch

| Chave | Efeito |
|-------|--------|
| `pdv-catalogo-cache-local=0` | Desliga cache/sync; volta `listar?view=caixa` |
| `pdv-finalizar-offline=0` | Bloqueia qualquer finalização offline |

## 8) Medição hardware fraco / 50k

Rodar: `cd margin-engine-front && npx vitest run src/test/catalogoCache50k.bench.test.ts`

Números típicos (WSL2, Node vitest — emulação CPU compartilhada; cole o log `[11-A bench 50k]`):

| Métrica | Valor (WSL2 / vitest 2026-10-13) |
|---------|----------------------------------|
| Full merge 50k | **3 ms** |
| Filtro vendável 50k | **5 ms** |
| Delta 100 lápides | **9 ms** |
| Proxy abertura (filtro 5k) p50 / p95 / p99 | **0.22 / 0.36 / 0.40 ms** |
| JSON cache approx | **~20 MB** |

> Medição de abertura real do PDV no browser depende do build; o proxy acima cobre CPU do caminho crítico de hidratação do catálogo.
