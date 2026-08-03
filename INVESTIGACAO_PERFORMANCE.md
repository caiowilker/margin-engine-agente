# Investigação de Desempenho — Bloqueio de ~120 segundos na Impressão

## Status

**Data:** 2026-08-03  
**Objetivo:** Transformar hipóteses em evidência mensurável

## Instrumentação Adicionada

Para medir EXATAMENTE onde o tempo está sendo gasto, adicionei logs com `performance.now()` em:

### 1. **Nível de Logo (printerLogo.js)**

```
ler()                        [3-10 ms esperado]
├─ lerMeta()
├─ fs.existsSync()
└─ resolveLogoPrintSize()

lerBuffer()                  [1-50 ms esperado, cache >99%]
├─ lerMeta()
├─ fs.existsSync()
└─ fs.readFileSync()         [metric: print.logo_lerbuffer_duration]

prepararArquivoEscpos()      [cached: <5ms | regenerado: 100-2000ms]
├─ sharp().resize().png()     [metric: sharpMs]
└─ fs.writeFileSync()         [metric: writeMs]
```

### 2. **Nível de Image Loading (impressoraCore.js)**

```
imprimirLogoCupomEscpos()                    [total time]
├─ ler()                                      [log output]
├─ prepararArquivoEscpos()                   [log output]
├─ escpos.Image.load()                       [⭐ PRIMARY SUSPECT]
│                                             [metric: print.escpos_image_load_duration]
│                                             [logged as WARN if > some threshold]
└─ printer.image()
    [metric: print.imprimirlogo_total]
```

### 3. **Nível de Render Completo (impressoraCore.js)**

```
renderCupomConteudo()                       [⭐ TOTAL TIME]
├─ imprimirLogoCupomEscpos()                [inside this]
├─ (todos os itens + pagamentos)
└─ [metric: print.rendercupomconteudo_total]

gerarBuffer() → renderCupomConteudo()       [outer wrapper]
  [metric: print.buffer_generation_timing]
  [logged at WARN level for visibility]
```

---

## O Que Você Verá nos Logs

### Cenário 1: Tudo OK (~1-2 segundos)

```json
[WARN] Buffer ESC/POS generation timing
{
  "bufferMs": 1250,
  "bytes": 4096,
  "metric": "print.buffer_generation_timing"
}

[INFO] rendercupomconteudo() TOTAL TIMING
{
  "totalRenderMs": 1200,
  "metric": "print.rendercupomconteudo_total"
}

[WARN] escpos.Image.load() TIMING
{
  "loadMs": 45,
  "metric": "print.escpos_image_load_duration"
}
```

**Conclusão:** Tudo rápido ✅ — não há bloqueio

---

### Cenário 2: Image.load() é o culpado (~109 segundos)

```json
[WARN] Buffer ESC/POS generation timing
{
  "bufferMs": 109450,
  "bytes": 4096,
  "metric": "print.buffer_generation_timing"
}

[INFO] rendercupomconteudo() TOTAL TIMING
{
  "totalRenderMs": 109400,
  "metric": "print.rendercupomconteudo_total"
}

[WARN] escpos.Image.load() TIMING
{
  "loadMs": 109321,
  "metric": "print.escpos_image_load_duration",
  "note": "This is the primary suspect for 100+ second delays"
}
```

**Conclusão:** `escpos.Image.load()` = 109.321s ✅ PROVA DIRETA

---

### Cenário 3: Sharp é o culpado (~107 segundos)

```json
[INFO] prepararArquivoEscpos() regenerated — timing breakdown
{
  "totalMs": 107823,
  "sharpMs": 107645,
  "writeMs": 12,
  "metric": "print.prepararescpos_regenerated"
}

[WARN] Buffer ESC/POS generation timing
{
  "bufferMs": 108100,
  "metric": "print.buffer_generation_timing"
}
```

**Conclusão:** `sharp().png().toFile()` = 107.645s ✅ PROVA DIRETA

---

### Cenário 4: Disco/Antivírus no readFileSync (~110 segundos)

```json
[DEBUG] lerBuffer() timing
{
  "totalMs": 110234,
  "readMs": 110187,
  "bytes": 2048576,
  "metric": "print.logo_lerbuffer_duration"
}

[WARN] escpos.Image.load() TIMING
{
  "loadMs": 20,
  "metric": "print.escpos_image_load_duration"
}
```

**Conclusão:** `fs.readFileSync()` = 110.187s ✅ PROVA DIRETA

---

## Como Ler os Logs

### Em LOG_LEVEL=DEBUG

```bash
tail -f logs/agent.log | grep "print\." | grep -E "duration|timing"
```

### JSON estruturado (se logger remapeia para JSON)

```bash
tail -f logs/agent.log \
  | jq 'select(.metric | startswith("print."))' \
  | jq '{metric, duration: .bufferMs // .loadMs // .sharpMs // .totalMs}'
```

### Métricas-chave a buscar

| Métrica | Esperado | Alarme | Causa Provável |
|---------|----------|--------|-----------------|
| `print.buffer_generation_timing` | <1500ms | >5000ms | `renderCupomConteudo()` ou algo dentro |
| `print.rendercupomconteudo_total` | <1400ms | >5000ms | Logo ou items |
| `print.escpos_image_load_duration` | <50ms | >1000ms | **⭐ Image.load()** |
| `print.prepararescpos_regenerated` | <2000ms | >10000ms | Sharp ou I/O |
| `print.logo_lerbuffer_duration` | <10ms | >500ms | `fs.readFileSync()` ou Defender |

---

## Próximos Passos

1. **Execute um cupom com logo** no PDV
2. **Colete os logs** (nível DEBUG ou INFO)
3. **Compare as timings**:
   - Se `escpos_image_load_duration` ≈ `buffer_generation_timing`, **Image.load é culpado**
   - Se `sharpMs` ≈ `buffer_generation_timing`, **Sharp é culpado**
   - Se `readMs` ≈ `buffer_generation_timing`, **I/O é culpado**
4. **Implemente fix conforme evidência**

---

## Instrumentação Implementada

✅ `printerLogo.js:ler()` — tempo total + breakdown  
✅ `printerLogo.js:lerBuffer()` — readFileSync timing  
✅ `printerLogo.js:prepararArquivoEscpos()` — sharp vs writeFile breakdown  
✅ `impressoraCore.js:imprimirLogoCupomEscpos()` — Image.load timing (WARN level)  
✅ `impressoraCore.js:renderCupomConteudo()` — total render timing  
✅ `impressoraCore.js:imprimirComGavetaOpcional()` — gerarBuffer total timing  

**Total:** 6 pontos de medição críticos

---

## Evidência Esperada

Depois de executar cupons com logo, você verá uma linha como:

```
[WARN] [ImpressoraCore] escpos.Image.load() TIMING — CRITICAL MEASUREMENT {"loadMs":X, ...}
```

Se `X ≈ 109000`, fechamos o diagnóstico.  
Se `X < 100`, continuamos procurando.

