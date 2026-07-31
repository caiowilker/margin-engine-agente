# ACBrLibPosPrinter — Referência de Implementação

> Compilado a partir da documentação oficial
> ([ACBrLibPosPrinter](https://acbr.sourceforge.io/ACBrLib/ACBrLibPosPrinter1.html))
> e do código-fonte (`Projetos/ACBrLib/Fontes/PosPrinter/`, exports em `ACBrLibPosPrinter.lpr`).
>
> No agente: provider `acbr-posprinter` —
> `print/acbrPosPrinterRuntime.js`, `print/workers/acbrPosWorker.js`,
> catálogo FFI `print/acbrPosExports.js`.

---

## O que é

DLL/SO sobre o componente **ACBrPosPrinter**. Comunicação com impressoras
não fiscais ESC/POS (formatação, corte, QRCode, gaveta, CMC7, etc.) a partir
de qualquer linguagem que chame DLL/SO.

Windows (.dll) e Linux (.so), 32/64 bits, StdCall e Cdecl.
No agente Margin usamos **Cdecl 64-bit** (`ACBrPosPrinter64.dll`) via **koffi**.

---

## Fluxo oficial (ciclo de vida)

1. `POS_Inicializar(eArqConfig, eChaveCrypt)` — carrega a lib (+ INI opcional)
2. Configurar via `POS_ConfigGravarValor` / `POS_ConfigLer` / `POS_ConfigGravar`
3. `POS_Ativar` → `POS_InicializarPos` → impressão (`POS_Imprimir`, …)
4. `POS_Desativar` → `POS_Finalizar`

No agente: **sessão quente** (worker) — Inicializar+Ativar 1×; cada cupom só
`InicializarPos` + `Imprimir`. Timeout soft ~5s; hang → terminate do worker.

---

## Códigos de retorno

| Valor | Descrição |
|-------|-----------|
| 0 | Sucesso |
| -1 | Biblioteca não inicializada |
| -2 | Falha na finalização |
| -3 | INI com propriedade(s) inválida(s) |
| -5 | Arquivo INI não encontrado |
| -6 | Diretório do INI não encontrado |
| -10 | Erro genérico (ex.: Ativar / comunicação) |

Detalhe da mensagem: `POS_UltimoRetorno`.

---

## Catálogo dos 42 métodos × uso no agente

Legenda de uso: **hot** = caminho de cupom/sessão · **support** = API/diagnóstico ·
**unused** = bind opcional (se existir na DLL), sem chamada no PDV.

### 1. Núcleo / ciclo de vida e configuração

| Método | Assinatura (Pascal) | Uso | Notas no agente |
|--------|---------------------|-----|-----------------|
| `POS_Inicializar` | `(eArqConfig, eChaveCrypt): integer` | hot | Primeiro método |
| `POS_Finalizar` | `: integer` | hot | Teardown / kill worker |
| `POS_Inicializada` | — | unused | Bind opcional |
| `POS_Nome` | `(sNome; var esTamanho)` | support | Diagnóstico |
| `POS_Versao` | `(sVersao; var esTamanho)` | support | Diagnóstico |
| `POS_OpenSSLInfo` | `(sOpenSSLInfo; var esTamanho)` | unused | Bind opcional |
| `POS_UltimoRetorno` | — | hot | Após ret ≠ 0 |
| `POS_ConfigImportar` | — | unused | Assinatura best-effort |
| `POS_ConfigExportar` | — | unused | Assinatura best-effort |
| `POS_ConfigLer` | `(eArqConfig)` | support | |
| `POS_ConfigGravar` | `(eArqConfig)` | hot | Persiste INI após ConfigGravarValor |
| `POS_ConfigLerValor` | `(eSessao, eChave; sValor; var esTamanho)` | unused | |
| `POS_ConfigGravarValor` | `(eSessao, eChave, eValor)` | hot | Modelo, Porta, Device… |

### 2. Ativação

| Método | Uso | Notas |
|--------|-----|-------|
| `POS_Ativar` | hot | Uma vez por sessão; `-10` comum se spooler/RAW mal configurado |
| `POS_Desativar` | hot | Idle timeout / teardown |

### 3. Impressão

| Método | Assinatura | Uso | Notas |
|--------|------------|-----|-------|
| `POS_Imprimir` | `(eString; PulaLinha, DecodificarTags, CodificarPagina; Copias)` | hot | Tags ACBr (`<b>`, `</corte>`, QR…) |
| `POS_ImprimirLinha` | `(eString)` | support | |
| `POS_ImprimirCmd` | `(eComando)` | support | ESC/POS bruto |
| `POS_ImprimirTags` | — | unused | Lista tags na impressora |
| `POS_ImprimirImagemArquivo` | — | unused | BMP sem gravar na memória |
| `POS_ImprimirLogo` | — | support | KC1/KC2 + fator |
| `POS_ImprimirCheque` / `TextoCheque` | — | unused | Fora do escopo PDV |

### 4. Diversos

| Método | Uso | Notas |
|--------|-----|-------|
| `POS_TxRx` | unused | |
| `POS_Zerar` | support | Limpa buffers internos |
| `POS_InicializarPos` | hot | Antes de cada `Imprimir` na sessão quente |
| `POS_Reset` | support | |
| `POS_PularLinhas` | support | Também via tags |
| `POS_CortarPapel` | support | Também via `</corte>` no Imprimir |
| `POS_AbrirGaveta` | hot | |
| `POS_LerInfoImpressora` | support | **Não funciona em RAW** |
| `POS_LerStatusImpressora` | unused | Bits (`stSemPapel`, …) |
| `POS_LerStatusImpressoraFormatado` | support | Serial/TCP; RAW limitado |
| `POS_RetornarTags` | unused | |
| `POS_AcharPortas` | support | UI Detectar |
| `POS_GravarLogoArquivo` / `POS_ApagarLogo` | support / unused | BMP |
| `POS_LeituraCheque` / `LerCMC7` / `EjetarCheque` | unused | |
| `POS_PodeLerDaPorta` | support | Não chamar em RAW |
| `POS_LerCaracteristicas` | support | |

Assinaturas koffi: `print/acbrPosExports.js`, conferidas com
`ACBrLibPosPrinterST.pas` / `ACBrLibPosPrinter.lpr`. Se a DLL do pacote for
mais antiga e faltar um export opcional, o bind fica `null` e o agente segue
(caminho crítico = hot + required).

---

## Status bits (`POS_LerStatusImpressora`)

`stErro`, `stNaoSerial`, `stPoucoPapel`, `stSemPapel`, `stGavetaAberta`,
`stImprimindo`, `stOffLine`, `stTampaAberta`, `stErroLeitura`, `stSlip`,
`stMICR`, `stAguardandoSlip`, `stTOF`, `stBOF` — cada um um bit do valor.

---

## INI — seções relevantes

### [PosPrinter]

| Chave | Descrição |
|-------|-----------|
| Modelo | `0`=ppTexto, `1`=Epson, … — POS80 → `1` |
| Porta | `COM1`, `TCP:192.168.1.100:9100`, `RAW:Nome da Impressora` |
| PaginaDeCodigo | `2`=850, `5`=UTF8 |
| CortaPapel / TraduzirTags | `1` típico |
| ControlePorta | **`0` em RAW Windows** (obrigatório) |
| VerificarImpressora | `0` em produção RAW |

### [PosPrinter_Device] (produção RAW)

| Chave | Valor | Motivo |
|-------|-------|--------|
| BytesCount | `512` | Evita saturar spooler (~120s) |
| BytesInterval | `10` | ms entre blocos |
| TimeOut | `5` | s — alinhado ao soft timeout |

### [Principal]

| Chave | Produção |
|-------|----------|
| LogNivel | `0` |
| ArqLog | vazio |

Defaults: `print/posPrinterIniDefaults.js`.

---

## Observações de campo

- Pré-alocar buffers de saída; se truncar → `POS_UltimoRetorno`
- Status / `LerInfo` / `PodeLerDaPorta` — limitados ou inválidos em **RAW:**
- Logo: arquivo **BMP**
- TCP: `TCP:IP:PORTA` com pontos no IP (`192.168.1.50`, não `192168150`)
- Deps: `npm run check:posprinter-deps`
- Spooler Windows: “Imprimir diretamente na impressora”

---

## Integração no agente

| Variável | Descrição |
|----------|-----------|
| `PRINTER_PROVIDER` | `acbr-posprinter` (padrão) |
| `ACBR_POSPRINTER_LIB_PATH` | `ACBrPosPrinter64.dll` |
| `ACBR_POSPRINTER_INI` | padrão `data/posprinter.ini` |
| `ACBR_POS_WORKER` | `true` = FFI no worker (padrão) |
| `ACBR_POS_CALL_TIMEOUT_MS` | soft timeout (padrão 5000) |

Homologação: `.ai/CHECKLIST-IMPRESSORA-CAMPO.md`, `CHECKLIST-WINDOWS-PRINT.md`  
Tags: `print/acbrTags.js`, `print/cupomAcbrTags.js`
