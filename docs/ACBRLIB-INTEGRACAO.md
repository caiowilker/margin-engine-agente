# ACBrLib — Integração nativa no agente

## Como o driver integra com a ACBrLib

O `acbrLibDriver.js` usa o pacote oficial **`@projetoacbr/acbrlib-nfe-node`**, que encapsula **FFI via koffi** contra a biblioteca nativa C:

| Camada | Tecnologia |
|--------|------------|
| Node.js | `acbrLibDriver.js` + `acbrLibRuntime.js` |
| Wrapper oficial | `ACBrLibNFeMT` (`@projetoacbr/acbrlib-nfe-node`) |
| FFI | `koffi` |
| Nativo | `libacbrnfe64.so` (Linux MT) ou `ACBrNFe64.dll` (Windows MT) |

### Sequência nativa (emissão)

```javascript
inst.inicializar();
applyNativeRuntimeConfig(inst, runtime); // PathSchemas, cert, SSL, CSC
inst.limparLista();
inst.carregarINI(iniPath);
inst.assinar();
inst.validar();
const resposta = inst.enviar(1, false, true, false);
inst.finalizar();
```

Equivalente à sequência Monitor: `CriarEnviarNFe(ini)` → assinar → enviar SEFAZ.

**Não usa processo filho.** Mutex `withAcbrLock` serializa chamadas FFI.

---

## WSL + Windows (importante)

| Problema | Sintoma | Solução |
|----------|---------|---------|
| Paths UNC do WSL | `XmlNode não pode ser nulo` no `CarregarINI` | `acbrLibRuntime.prepareNativeRuntime()` copia para `%TEMP%\margin-acbrlib` |
| cwd incorreto | Mesmo erro ou DLL não acha deps | `withNativeLibSession()` faz `chdir` na pasta da DLL |
| CSC só em `[NFCe]` | cStat 462 (CSC QR-Code) | `applyNativeRuntimeConfig` grava `IdCSC`/`CSC` em `[NFe]` |

Homolog validado: `agente-local/acbrlib/` + `scripts/homolog-acbrlib-producao.js` — ver `RESULTADO-HOMOLOG-PRODUCAO.md`.

Executar no WSL:

```bash
cd agente-local
bash scripts/run-homolog-acbrlib-producao.sh
```

---

## Modos de operação

| Modo | Condição | Comportamento |
|------|----------|---------------|
| **native** | `ACBR_LIB_PATH` aponta para `.so`/`.dll` existente | Emissão real via `ACBrLibNFeMT` |
| **parity** | `ACBR_LIB_ALLOW_PARITY=true` **sem** DLL | Fallback Monitor TCP — **apenas dev/CI** |
| **unconfigured** | Sem DLL e sem `ALLOW_PARITY` | `emitir` falha com erro explícito |

---

## Configuração para emissão nativa real

### 1. Obter biblioteca nativa ACBrLib MT

- [ACBrLib PRO](https://www.projetoacbr.com.br/forum/files/category/36-acbrlib-pro/)
- [ACBrLib DEMO](https://www.projetoacbr.com.br/forum/files/category/63-acbrlib-demo/) (homologação)

Linux: versão **Console MT** (`libacbrnfe64.so`).  
Windows/WSL: `ACBrNFe64.dll` + deps (`libxml2.dll`, `libssl`, etc.).

### 2. Configurar agente

```bash
cp templates/acbrlib.ini.template data/acbrlib.ini
# Editar certificado, CSC, IdCSC, UF, Ambiente=2

mkdir -p lib schemas/NFe
cp /caminho/ACBrNFe64.dll lib/
cp /caminho/Schemas/NFe/* schemas/NFe/
cp /caminho/ACBrNFeServicos.ini data/

export ACBR_DRIVER=lib
export ACBR_LIB_PATH=/caminho/agente-local/lib/ACBrNFe64.dll
export ACBR_LIB_INI=/caminho/agente-local/data/acbrlib.ini
# NÃO definir ACBR_LIB_ALLOW_PARITY em produção/homolog rollout
```

### 3. Teste de emissão

```bash
cd agente-local
npm run homolog:acbrlib
# ou: node scripts/homolog-acbrlib-producao.js (Windows, na pasta agente-local)
```

Logs esperados em modo nativo:

```
[ACBrLib] Emissão NATIVA — NFE_Inicializar
[ACBrLib] NFE_Inicializar OK
[ACBrLib] NFE_CarregarINI OK
[ACBrLib] NFE_Assinar OK
[ACBrLib] NFE_Validar OK
[ACBrLib] NFE_Enviar retorno
[ACBrLib] Emissão NATIVA concluída
```

---

## Critério de rollout

Antes de ativar `fiscal.acbr_lib` em produção:

1. `getDriverInfo().mode === "native"`
2. Emissão homologação retorna **chave 44 dígitos** e **protocolo** reais da SEFAZ
3. Logs contêm `Emissão NATIVA` (não `MODO PARIDADE`)
4. `ACBR_LIB_ALLOW_PARITY` **desligado**
5. Evidência: `margin-fiscal/certification/etapa-b5-acbrlib-nativo-verificacao.md`

---

## Paridade Lib vs Monitor (1.0)

| Capacidade | Monitor | ACBrLib |
|------------|---------|---------|
| Emissão NFC-e / NF-e | TCP `CriarEnviarNFe` | FFI `NFE_Enviar` |
| Montagem INI sem `documentIni` | `montarIniNfce/Nfe` | `montarIniLib()` local — **sem fallback silencioso** |
| Validação pós-envio | `enrichParsePosEmissaoAsync` + `assertAutorizada` | Mesma pipeline após parse nativo |
| Retry cStat 539 (duplicidade) | Sim | Sim (`emitirDocumentoLib`) |
| Cancelamento / inutilização / evento | TCP | Nativo ou parity; hint `acbrDriver: "lib"` em todo fluxo |
| PDF DANFC-e / DANFE | `GerarPDF` Monitor | `NFE_SalvarPDF` + `PathPDF` + scan `saida/pdf/xml` |
| `testar()` | boolean | boolean (`testarLib`) + `testarLibDetalhe()` para diagnóstico |
| Consulta chave | TCP | `GET /fiscal/lib/consultar/:chave` + nativo |

Rotas dedicadas Lib (`acbrDriver: "lib"` injetado automaticamente):

- `POST /fiscal/lib/emitir`, `/emitir-nfe`, `/cancelar`, `/inutilizar`
- `GET /fiscal/lib/consultar/:chave`

Testes CI: `npm run test:agent-fiscal` inclui `test/acbr-lib-solid.test.js`.

---

## Evidência Onda B.5 (2026-06-27)

| Item | Status |
|------|--------|
| Paridade semântica Java (30 MFCS) | OK |
| Demo nativo cStat 100 | OK |
| Chave + protocolo SEFAZ homolog MG | OK |
| Driver agente com runtime WSL | OK |
