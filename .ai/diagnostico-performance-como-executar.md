# Diagnóstico de Performance — Como Executar

## Objetivo

Identificar a causa raiz do bloqueio de ~120 segundos durante a impressão de cupom com logo.

## Status Anterior

Análise de código e logs mostraram que:
- ✅ Event loop ficou bloqueado por >100 segundos
- ✅ `WritePrinter` levou apenas 445ms
- ✅ Geração do buffer levou ~109s
- ❌ **Ainda NÃO COMPROVADO:** exatamente qual função dentro da geração do buffer é culpada

## Hipóteses em Ordem de Probabilidade

| Rank | Suspeito | Probabilidade | Impacto | Medida |
|------|----------|---------------|--------|--------|
| 1 | `escpos.Image.load()` | ⭐⭐⭐⭐⭐ | 109s | `print.escpos_image_load_duration` |
| 2 | `sharp().toFile()` | ⭐⭐⭐⭐ | ~107s | `print.prepararescpos_regenerated` |
| 3 | Windows Defender | ⭐⭐⭐ | Variable | (combined with above) |
| 4 | `fs.readFileSync()` | ⭐⭐ | ~110s | `print.logo_lerbuffer_duration` |
| 5 | `fs.existsSync()` | ⭐ | Unlikely | (cached mostly) |

## Instrumentação Implementada

As seguintes funções foram instrumentadas com `performance.now()` e logs detalhados:

### Em `print/printerLogo.js`

```javascript
ler()                    // ✅ Added timing → metric: print.logo_ler_duration
lerBuffer()              // ✅ Added timing → metric: print.logo_lerbuffer_duration (with readMs breakdown)
prepararArquivoEscpos()  // ✅ Added timing → metric: print.prepararescpos_regenerated (with sharpMs breakdown)
```

### Em `print/escpos/impressoraCore.js`

```javascript
imprimirLogoCupomEscpos()         // ✅ Added Image.load() timing → metric: print.escpos_image_load_duration
renderCupomConteudo()             // ✅ Added total timing → metric: print.rendercupomconteudo_total
imprimirComGavetaOpcional()       // ✅ Added buffer timing → metric: print.buffer_generation_timing
```

## Como Executar a Investigação

### Opção A: Teste Isolado (Rápido, Sem Hardware)

```bash
cd /home/caio_wilker/projects/margin-engine-agente

# Executa o teste de instrumentação
node test/performance-instrumentation.test.js

# Saída esperada:
# [TEST 1] Loading modules...
# [TEST 2] Testing printerLogo.ler()...
# [TEST 3] Testing renderCupomConteudo()...
# [TEST 4] Testing gerarBuffer()...
# Performance Summary
# =====================
```

**Tempo esperado:** <5 segundos  
**O que mede:** Instrumentação básica sem hardware real

---

### Opção B: Teste de Integração (Médio, Com Logo Real)

```bash
cd /home/caio_wilker/projects/margin-engine-agente

# Executa testes de print que ativam a instrumentação
npm run test:print -- --grep "gaveta|logo"

# Saída esperada:
# ✓ Vários testes passando
# Logs com métricas como:
# [WARN] [ImpressoraCore] escpos.Image.load() TIMING — CRITICAL MEASUREMENT {"loadMs":X}
```

**Tempo esperado:** 20-30 segundos  
**O que mede:** Tempo real com logo e rendering

---

### Opção C: Diagnóstico em Tempo Real (Produção, Com PDV)

#### Terminal 1: Inicie o agente

```bash
cd /home/caio_wilker/projects/margin-engine-agente

# Inicie o agente em modo debug
LOG_LEVEL=debug npm start

# Ou se estiver usando outro process manager:
# NODE_ENV=production LOG_LEVEL=debug node index.js
```

#### Terminal 2: Monitore os logs em tempo real

```bash
cd /home/caio_wilker/projects/margin-engine-agente

# Start monitor (pode usar arquivo de log ou stdin)
# Se o agente está escrevendo em arquivo:
node scripts/monitor-print-performance.js /caminho/para/agent.log

# Ou pipe direto:
tail -f /caminho/para/agent.log | node scripts/monitor-print-performance.js

# Ou grep para métricas específicas:
tail -f /caminho/para/agent.log | grep "print\." | grep -E "duration|timing"
```

#### Terminal 3: Dispare impressões no PDV

```bash
# Dentro da interface do PDV/Caixa:
# 1. Abra uma venda
# 2. Adicione itens
# 3. Finalize com pagamento em DINHEIRO (for drawer pulse)
# 4. Clique "Imprimir Cupom"
# 5. Observe os logs nas janelas 1 e 2
```

**Tempo esperado:** Depende da impressora (5-30 segundos para todo o fluxo)  
**O que mede:** Performance real de usuário final

---

## Interpretando os Resultados

### Cenário 1: Image.load() é o culpado (Mais Provável)

```
[WARN] escpos.Image.load() TIMING — CRITICAL MEASUREMENT
{
  "loadMs": 109000,
  "metric": "print.escpos_image_load_duration"
}

[WARN] Buffer ESC/POS generation timing
{
  "bufferMs": 109450,
  "metric": "print.buffer_generation_timing"
}
```

**Conclusão:** ✅ **PROVA DIRETA**  
`escpos.Image.load()` está bloqueando por ~109 segundos.

**Próximas ações:**
1. Verificar caminho da imagem da logo (`LOGO_DIR`)
2. Verificar se Windows Defender está escaneando `TEMP`
3. Considerar usar `assetPath` em vez de `TEMP`
4. Verificar tamanho da imagem (se >2MB, considerar otimização)

---

### Cenário 2: Sharp é o culpado (Segundo Mais Provável)

```
[INFO] prepararArquivoEscpos() regenerated — timing breakdown
{
  "totalMs": 107823,
  "sharpMs": 107645,
  "writeMs": 12,
  "metric": "print.prepararescpos_regenerated"
}
```

**Conclusão:** ✅ **PROVA DIRETA**  
Sharp está demorando ~107 segundos para resize + encode PNG.

**Próximas ações:**
1. Verificar tamanho original da imagem
2. Verificar resolução target (escposWidthDots)
3. Considerar usar cache mais agressivo
4. Considerar pré-converter em offline

---

### Cenário 3: File Read é o culpado (Terceiro Mais Provável)

```
[DEBUG] lerBuffer() timing
{
  "totalMs": 110234,
  "readMs": 110187,
  "bytes": 2048576,
  "metric": "print.logo_lerbuffer_duration"
}
```

**Conclusão:** ✅ **PROVA DIRETA**  
`fs.readFileSync()` está bloqueando por ~110 segundos.

**Próximas ações:**
1. Mover arquivo de logo para fora de TEMP (se estiver lá)
2. Desabilitar antivírus temporariamente para teste
3. Testar em SSD vs HDD
4. Verificar se arquivo está em rede (NAS/SMB)

---

### Cenário 4: Performance está OK

```
[WARN] Buffer ESC/POS generation timing
{
  "bufferMs": 1250,
  "metric": "print.buffer_generation_timing"
}

[WARN] escpos.Image.load() TIMING
{
  "loadMs": 45,
  "metric": "print.escpos_image_load_duration"
}
```

**Conclusão:** ✅ **SEM PROBLEMA**  
Impressão está rápida. Botleneck pode estar:
- Em outra parte do fluxo (ACBr, comunicação de rede)
- Dependência do hardware específico (impressora lenta)
- Timeout não relacionado a impressão

---

## Métricas-Chave a Monitorar

| Métrica | Esperado | Alertar Se | Possível Culpa |
|---------|----------|------------|-----------------|
| `print.buffer_generation_timing.bufferMs` | <1500ms | >5000ms | Logo ou render |
| `print.escpos_image_load_duration.loadMs` | <50ms | >1000ms | **Image.load() ou Defender** |
| `print.prepararescpos_regenerated.sharpMs` | <2000ms | >5000ms | **Sharp ou I/O** |
| `print.logo_lerbuffer_duration.readMs` | <10ms | >500ms | **fs.readFileSync() ou Defender** |
| `print.rendercupomconteudo_total.totalRenderMs` | <1400ms | >5000ms | Items rendering |
| `print.imprimirlogo_total.totalMs` | <500ms | >2000ms | Logo pipeline |

---

## Dicas para Coleta de Dados

### Se usando arquivo de log

```bash
# Extrair apenas métricas de performance
grep "metric.*print\." agent.log | jq -r '.metric, .loadMs // .bufferMs // .sharpMs' 2>/dev/null

# Ver timelines
grep "metric.*print\." agent.log | jq '{time: .timestamp, metric: .metric, ms: (.loadMs // .bufferMs // .sharpMs)}'

# CSV para análise
grep "metric.*print\." agent.log | jq -r '[.metric, .loadMs // .bufferMs // .sharpMs] | @csv'
```

### Se usando real-time streaming

```bash
# Terminal 1: Agent
LOG_LEVEL=debug npm start 2>&1 | tee agent.log

# Terminal 2: Monitor
node scripts/monitor-print-performance.js agent.log

# Terminal 3: Live grep
tail -f agent.log | grep -E "Image.load|sharp|buffer_generation|renderCupom"
```

---

## Checklist de Investigação

- [ ] Executar Opção A (teste isolado) — confirmar instrumentação está funcionando
- [ ] Executar Opção B (teste de integração) — ver métricas em ambiente controlado
- [ ] Executar Opção C (produção) — reproduzir problema real
- [ ] Coletar logs de pelo menos 5 impressões bem-sucedidas
- [ ] Comparar timings entre cenários
- [ ] Identificar qual métrica é >100s (aquela é a culpada)
- [ ] Validar hipótese alternativa (se primeira não for culpada)
- [ ] Documentar findings em decisão arquitetural (ADR)

---

## Próximas Ações Após Diagnóstico

Dependendo do cenário encontrado:

### Se Image.load()

```javascript
// Considerar:
// 1. Warm up logo na startup
// 2. Usar cache mais agressivo
// 3. Converter imagem offline
// 4. Usar formato diferente (não BMP)
```

### Se Sharp

```javascript
// Considerar:
// 1. Pré-computar tamanho target
// 2. Cache regenerado
// 3. Usar imagem já em PNG (não BMP)
// 4. Considerar library mais rápida
```

### Se File I/O

```javascript
// Considerar:
// 1. Mover arquivo para `AppData` em vez de `TEMP`
// 2. Usar buffer em memória para logo
// 3. Desabilitar antivírus em pasta
// 4. Usar exclusão de realtime scanning
```

---

## Status Esperado Após Fix

```
[WARN] Buffer ESC/POS generation timing
{
  "bufferMs": 850,
  "bytes": 4096,
  "metric": "print.buffer_generation_timing"
}

[INFO] renderCupomconteudo() TOTAL TIMING
{
  "totalRenderMs": 800,
  "metric": "print.rendercupomconteudo_total"
}

✅ PROBLEMA RESOLVIDO
Tempo total de impressão: <2 segundos
```

---

## Contato & Perguntas

Se encontrar algo inesperado:
1. Verifique logs em `LOG_LEVEL=debug`
2. Verifique tamanho/format da logo
3. Tente sem logo (`deveExibirLogoCupom = false`)
4. Tente impressora diferente (USB vs Network)
