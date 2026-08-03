# ADR: Otimização de Desempenho na Impressão — Bloqueio de 120+ Segundos

**Data:** 2026-08-03  
**Status:** IMPLEMENTADO  
**Afeta:** Print Hot-Path, ESC/POS Rendering, Logo Processing  
**Impacto Esperado:** 120s → <1.5s

## Problema

Impressão de cupom com logo estava bloqueando o event loop por >120 segundos, causando timeout de cupons e degradação severa do PDV.

### Causa Raiz Identificada

**5 culpados críticos combinados:**

1. **escpos.Image.load() sincronizado no hot-path** (⭐⭐⭐⭐⭐)
   - Usa `get-pixels` internamente — decodificação síncrona
   - Se não houve warm-up, primeiro cupom paga 109 segundos
   - Windows Defender + TEMP lento = bloqueio total

2. **lerBuffer() — fs.readFileSync() síncrono não-cacheado** (⭐⭐⭐⭐)
   - Bloqueia event loop lendo arquivo de logo toda vez (se cache miss)
   - Falta cache em memória entre cupons

3. **ler() — múltiplos fs.existsSync() síncronos** (⭐⭐⭐)
   - Chamado 9+ vezes por cupom
   - Cada existsSync() = 1 bloqueio síncrono
   - Total: 6-8 chamadas sequenciais durante renderização

4. **prepararArquivoEscpos() — fs.readFileSync() verificação de KEY** (⭐⭐)
   - Relê arquivo de cache KEY toda vez
   - Falta cache em memória da verificação de validade

5. **Falta de aquecimento automático** (⭐⭐)
   - `warmPrintHotPath()` não era garantido ao boot
   - Primeiro cupom após inicialização pagava full penalty

## Solução Implementada

### 1. Cache em Memória de `ler()` — TTL 5s

**Arquivo:** `print/printerLogo.js:18-48`

```javascript
let loInfoCache = { data: null, expiresAt: 0 };
const LO_INFO_CACHE_TTL_MS = 5000;

function getCachedLoInfo() {
  const now = Date.now();
  if (loInfoCache.data && now < loInfoCache.expiresAt) {
    return loInfoCache.data;
  }
  return null;
}

function setCachedLoInfo(data) {
  loInfoCache = {
    data,
    expiresAt: Date.now() + LO_INFO_CACHE_TTL_MS,
  };
}
```

**Benefício:** Reduz 6-8 `fs.existsSync()` calls por cupom → 1 call a cada 5 segundos  
**Trade-off:** Logo alterada leva até 5s para refletir (aceitável, evento raro)

### 2. Cache em Memória de prepararArquivoEscpos() KEY

**Arquivo:** `print/printerLogo.js:50-55`

```javascript
let loPrintCacheKeyMemory = { sha256: null, key: null };
```

**Benefício:** Evita `fs.readFileSync(LOGO_PRINT_KEY)` a cada cupom se hash não mudou  
**Trade-off:** Cache invalidado ao restartar agente (ok, logo raramente muda)

### 3. Refatoração de `ler()` para usar cache

**Arquivo:** `print/printerLogo.js:173-207`

- Checa `getCachedLoInfo()` primeiro
- Se hit, retorna imediatamente (ZERO I/O)
- Se miss, executa sincronamente e caches por 5s
- Log de timing se >10ms

**Impacto:** Múltiplas chamadas a ler() durante cupom → 1ª = <10ms, resto = <1ms

### 4. Refatoração de `lerBuffer()` para usar cached ler()

**Arquivo:** `print/printerLogo.js:209-236`

- Usa `ler()` que já está cacheado
- Reduz número de `fs.existsSync()` calls de 3 → 1 (via ler())
- Mantém cache de buffer (já existia)
- Log detalhado de timing (readMs vs totalMs)

**Impacto:** fs.readFileSync() chamado apenas em cache miss (raro)

### 5. Refatoração de `prepararArquivoEscpos()` com cache de KEY

**Arquivo:** `print/printerLogo.js:243-315`

- **Fast path:** Checa `loPrintCacheKeyMemory` primeiro (ZERO I/O)
- **Secondary path:** Se memory miss, checa disco e atualiza memory
- **Regenerate path:** Se nenhum cache válido, executa sharp + writeFileSync
- Memory cache atualizado após cada operação

**Impacto:**
- Cache hit: <5ms (only memory check)
- Disco hit: ~10-50ms (one readFileSync)
- Regenerate: ~100-2000ms (sharp + I/O, mas raro)

### 6. Aquecimento Imediato no Bootstrap

**Arquivo:** `print/printerBootstrap.js:269-297`

```javascript
function noBoot(delayMs = 2500) {
  return new Promise((resolve) => {
    // CRITICAL: Warm print hot-path IMMEDIATELY
    setImmediate(async () => {
      const core = require("./escpos/impressoraCore");
      try {
        const warmOk = await core.warmPrintHotPath();
        log.debug({ warmMs, ok: warmOk }, "[PrinterBootstrap] Print hot-path aquecido");
      } catch (err) {
        log.warn({ err: err?.message }, "[PrinterBootstrap] Falha ao aquecer");
      }
    });
    
    // Continue with detection...
    setTimeout(async () => { /* detection */ }, delayMs);
  });
}
```

**Benefício:** `warmPrintHotPath()` executa IMEDIATAMENTE (via `setImmediate`), não espera `setTimeout`  
**Resultado:** escpos.Image.load() é cacheado ANTES de primeiro cupom

### 7. Invalidação de Cache Consolidada

**Arquivo:** `print/printerLogo.js:101-113`

- Função `invalidatePrintCache()` agora limpa TODOS os caches:
  - Disco: `LOGO_PRINT_CACHE`, `LOGO_PRINT_KEY`
  - Memória: `loInfoCache`, `loPrintCacheKeyMemory`
  - Escpos: `logoEscposImageCache` (impressoraCore)

**Uso:** Chamada automaticamente quando logo é alterada via API

## Timeline de Execução

### Antes (Sem Otimização)

```
Boot
  ↓ (warmup pode não rodar)
Primeira Impressão
  ├─ ler() fs.existsSync() x2      [2ms bloqueado]
  ├─ lerBuffer()                    [~1-50ms bloqueado]
  ├─ prepararArquivoEscpos()        [5-100ms bloqueado]
  │  └─ check cache KEY (readFileSync) [~10ms bloqueado]
  ├─ imprimirLogoCupomEscpos()      [start async path]
  │  └─ escpos.Image.load()         [109,000ms BLOQUEADO ← Defender!]
  └─ Total: ~109+ segundos ❌
```

### Depois (Otimizado)

```
Boot
  ├─ setImmediate(warmPrintHotPath)
  │  └─ escpos.Image.load()        [~500ms, NOW CACHED]
  ↓ (logo image cached in memory)

Primeira Impressão
  ├─ ler() [cache hit]              [<1ms ← memory cache]
  ├─ lerBuffer() [cache hit]        [<1ms ← logoBufferCache]
  ├─ prepararArquivoEscpos() [cache hit] [<5ms ← memory cache]
  ├─ imprimirLogoCupomEscpos()
  │  └─ escpos.Image.load() [cache hit] [<1ms ← logoEscposImageCache]
  └─ Total: ~800ms ✅

Impressões Subsequentes (<5s apart)
  └─ Total: ~300-500ms ✅
```

## Métricas Instrumentadas

Adicionados logs para validar cada otimização:

- `print.logo_ler_duration` — tempo de ler() [com cache]
- `print.logo_lerbuffer_duration` — tempo de lerBuffer() [com readMs breakdown]
- `print.prepararescpos_cached` — hit de cache KEY (memory ou disk)
- `print.prepararescpos_regenerated` — regeneração (sharpMs, writeMs breakdown)
- `print.escpos_image_load_duration` — Image.load() timing [CRÍTICO]
- `print.buffer_generation_timing` — gerarBuffer() total
- `print.rendercupomconteudo_total` — renderCupomConteudo() total
- `print.warm_ok` — warm-up concluído com sucesso
- `print.warm_slow` — warm-up levou >1s (warning)
- `print.warm_failed` — falha ao aquecer (não bloqueia)

## Casos de Teste Cobertos

1. **Primeira execução (sem cache):** Full pipeline, todos os timings medidos
2. **Execução com cache válido:** Verificar cache hits nas métricas
3. **Logo alterada:** Cache invalidado automaticamente via `invalidatePrintCache()`
4. **Boot com delay:** Garantir warm-up roda antes de cupom
5. **Boot sem delay (fast boot):** warm-up roda em parallel

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Logo alterada leva 5s para refletir | TTL = 5s é trade-off aceitável; evento raro |
| Memory leak em logoBufferCache | Buffer é pequeno (<2MB típico), OK em memória |
| Cache invalidation não dispara | Exportada função pública + chamada ao salvar |
| Boot warm-up falha silenciosamente | Log.warn com métrica clara para diagnóstico |
| Defender ainda bloqueia warm-up | warm-up roda com timeout via noBoot() |

## Rollback Plan

Se necessário reverter:

1. Remover cache de ler() — volta a sincronismo original
2. Remover cache de prepararArquivoEscpos() — volta a ler KEY toda vez
3. Remover setImmediate de warm-up — volta a setTimeout original

Todos os pontos são independentes e podem ser revertidos individualmente.

## Métricas Esperadas Pós-Implementação

### Warm-up (Boot)

- `print.warm_ok`: <1000ms (tipicamente 200-500ms)
- `print.warm_failed`: 0 (ou 1 se Defender muito agressivo)

### Primeira Impressão (Logo Já Aquecida)

- `print.logo_ler_duration`: <1ms (cache hit)
- `print.logo_lerbuffer_duration`: <1ms (cache hit)
- `print.prepararescpos_cached`: <5ms (memory cache)
- `print.escpos_image_load_duration`: <1ms (logoEscposImageCache hit)
- `print.buffer_generation_timing`: <1000ms total
- `print.rendercupomconteudo_total`: <900ms total

### Impressões Subsequentes (<5s apart)

- All timings: <200-400ms total (cache hits)

### Impressão Após 5+ segundos (cache expirado)

- `print.logo_ler_duration`: <10ms (disk check)
- Resto: <500ms (caches refrescados)

## Decisões Arquiteturais

1. **TTL simples em vez de invalidation reativa:** Mais simples, menos deps, suficiente para caso de uso
2. **Memory cache com TTL vs LRU:** Simples é melhor; logo é única chave
3. **setImmediate vs spawn worker:** Roda no mesmo contexto, suficiente para warm-up
4. **Manter fs.readFileSync() para logo:** Logo é crítica; async não justificado
5. **Não async refactor de Image.load():** Escopo fora deste ADR; cacheamento é suficiente

## Validação

Execute:

```bash
node test/performance-instrumentation.test.js
npm run test:print -- --grep "logo|gaveta"
```

Verifique logs:

```bash
grep "metric.*print\." logs/agent.log | jq '.metric, .loadMs // .bufferMs'
```

Esperado: totais <1500ms após warm-up.

## Próximas Otimizações (Futuro)

1. Async refactor de Image.load() via worker thread
2. Pré-compress logo em offline (formato otimizado)
3. Cache persistente entre reinicializações
4. Metrics dashboard com alertas automáticos

---

**Implementado por:** Engenharia de Performance  
**Validação:** Instrumentação completa com `performance.now()` em todos os pontos críticos
