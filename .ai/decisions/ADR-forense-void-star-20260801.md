# Auditoria forense — void** / soft-abandon / @projetoacbr

**Data:** 2026-08-01  
**Objetivo:** separar fato comprovado de hipótese.

## 1. O que está COMPROVADO no código

### 1.1 Wrapper oficial chama Finalizar no dispose

Em `@projetoacbr/acbrlib-base-node` (`dist/src/index.js`):

- `[Symbol.dispose]` → `destroy()` → se `isHandleInitialized` → `finalizar()`
- `finalizar()` → `getHandle()` → `koffi.decode(this.handle, 'void *')` → `NFE_Finalizar`
- Comentário oficial no próprio pacote: liberar memória mais de uma vez **corrompe o heap**

### 1.2 Nós introduzimos dispose no soft-abandon (regressão)

Commit `3e77644` (P0 koffi) adicionou no soft path:

```js
inst[Symbol.dispose]()
```

ao mesmo tempo em que o log dizia *"Sessão abandonada sem Finalizar"* — **contradição**: dispose **é** Finalizar.

Antes desse commit, soft-abandon só droparia a referência (comportamento correto).

### 1.3 Logs do caixa batem com processo já envenenado

Sequência observada:

1. `Soft-dead liberado — nova Inicializar permitida`
2. `Soft-dead — retry único` com `Unexpected External value, expected void **`
3. `testar() retry falhou` com o mesmo `void **`

Interpretação sólida: após soft-abandon + dispose/Finalizar em handle ruim, **nova sessão no mesmo processo Node continua falhando**. Isso **não** é SEFAZ, **não** é emissão desligada, **não** é motor “OK” no Diagnóstico como prova de saúde nativa.

### 1.4 Diagnóstico “Motor OK” + DEGRADADO não contradiz

Motor OK pode refletir flags de emissão/driver; `void **` é falha FFI. DEGRADADO é memória sticky pós-koffi. Coexistem.

## 2. O que NÃO está 100% provado

### 2.1 Dispose NÃO é necessariamente a *primeira* causa do void**

A *primeira* ocorrência de `void **` pode vir de:

| Hipótese | Evidência |
|----------|-----------|
| Uso de handle já morto em `statusServico` / método | Compatível com logs; comum após Finalizar parcial |
| `Finalizar` saudável + `Inicializar` com handle/DLL inconsistente | Possível (idle Finalizar antigo; config_refresh) |
| Overwrite de DLL no staging com lib carregada | Mitigado por `dllPinned`; ainda risco residual |
| `koffi.load` repetido a cada `new LibClass` | Bridge oficial carrega a DLL no construtor; possível pressão no Windows |
| `process.chdir` cruzado Pos/NFe | Mitigado (worker + guarda); não explica sozinho o log atual |

**Conclusão:** dispose no soft-abandon é **causa comprovada de envenenamento / não-recuperação**. A faísca inicial do primeiro `void **` pode ser outra — mas o dispose **garantia** que o processo não se recuperava.

### 2.2 Log “retry único” imprime o erro da *primeira* falha

Em `runNativeOpWithRetry`, o `err` do warn de retry é o erro anterior, não o do segundo `runOnce`. A prova de que o *retry* também falhou é o log `testar() retry falhou` / segunda exceção — esse sim confirma falha na segunda tentativa.

## 3. Correções que são corretas (e por quê)

| Correção | Por que é certa |
|----------|-----------------|
| Remover `Symbol.dispose` do soft-abandon | Alinha com a intenção “sem Finalizar” e com o aviso do pacote oficial |
| Não marcar soft-dead sem sessão ativa | Evita brick falso por preflight/watchdog |
| Auto-recycle do processo após retry `void **` | Única recuperação confiável quando o heap koffi/DLL já corrompeu |
| Idle Finalizar off por padrão | Reduz Finalizar/Inicializar desnecessário (fonte clássica de churn) |
| Não martelar StatusServico com processo poisoned | Evita cascata Diagnóstico → mais void** → EPEC falso |

## 4. Veredito de engenharia

- **Certeza alta (quase certeza):** soft-abandon com `Symbol.dispose` era **bug real** e **piorava** o caixa até ficar irrecuperável sem restart.
- **Certeza alta:** o sintoma atual (`void **` + DEGRADADO + FALHA_TEMPORARIA) é ** falha nativa koffi**, não configuração fiscal “desligada”.
- **Certeza média:** a faísca *inicial* do primeiro `void **` pode ser Finalizar/uso de handle morto / churn de sessão — por isso recycle + sessão quente + sem dispose.
- **Operação obrigatória:** deploy do hotfix `09b1592`/`e6519aa` + **restart limpo do serviço**. Processo já envenenado **não** se cura com “Atualizar” no Diagnóstico.

## 5. Como validar no caixa (prova objetiva)

1. Deploy + restart do serviço.
2. Emitir NFC-e homolog **uma vez**.
3. Nos logs, **não** deve aparecer `Symbol.dispose` / “abandonada” seguida de `void **` em loop.
4. Se aparecer `void **` de novo: deve aparecer `Reciclando processo` e o serviço sobe sozinho em ~2–3s; segunda emissão após recycle deve passar.
5. Se após recycle limpo a **primeira** emissão (sem soft-abandon prévio) já der `void **`, aí a faísca inicial é outra (DLL/path/cert/chdir) — abrir pacote de diagnóstico com o trecho completo desde o boot.
