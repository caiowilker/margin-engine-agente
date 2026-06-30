# ACBrLibPosPrinter — Referência de Implementação

> Fonte: https://acbr.sourceforge.io/ACBrLib/ACBrLibPosPrinter1.html  
> Copyright © 2018-2025 ACBr - Automação Comercial Brasil

No agente Margin Engine, o provider oficial é `acbr-posprinter` (`print/acbrPosPrinterRuntime.js` + `print/drivers/acbrPosPrinterProvider.js`).

---

## O que é a ACBrLibPosPrinter?

Biblioteca (DLL/SO) do componente **ACBrPosPrinter** do Projeto ACBr. Comunicação direta com impressoras **EscPos**: fontes, formatação, corte, QR Code, logotipo, CMC7, gaveta, etc.

---

## Como usar (sequência oficial)

1. Instalar/copiar a ACBrLib conforme documentação do Projeto ACBr
2. Configurar o INI (`data/posprinter.ini` no agente)
3. `POS_Inicializar(eArqConfig, eChaveCrypt)`
4. `POS_Ativar()`
5. `POS_InicializarPos()` → imprimir (`POS_Imprimir` / `POS_ImprimirLinha`)
6. `POS_CortarPapel` / `POS_PularLinhas` conforme layout
7. `POS_Desativar()` → `POS_Finalizar()`

---

## Convenções de parâmetros

- Strings entre aspas duplas; aspas internas duplicadas; quebra de linha longa com `|`
- Numéricos sem aspas, decimal com `.`
- Booleano: `1` = true, `0` = false

---

## Códigos de retorno globais

| Valor | Descrição |
|-------|-----------|
| 0 | Sucesso |
| -1 | Biblioteca não inicializada |
| -2 | Falha na finalização |
| -3 | INI com propriedade(s) inválida(s) |
| -5 | Arquivo INI não encontrado |
| -6 | Diretório do INI não encontrado |
| -10 | Erro genérico |

---

## Métodos principais (resumo)

| Método | Uso |
|--------|-----|
| `POS_Inicializar` | Obrigatório antes de qualquer chamada |
| `POS_Finalizar` | Encerra a lib |
| `POS_Ativar` / `POS_Desativar` | Abre/fecha conexão com a impressora |
| `POS_InicializarPos` | Prepara buffer de impressão |
| `POS_Zerar` | Limpa buffer |
| `POS_Imprimir` | Texto + tags ACBr |
| `POS_ImprimirLinha` | Uma linha simples |
| `POS_CortarPapel(Parcial)` | Guilhotina (`1` parcial, `0` total) |
| `POS_AbrirGaveta` | Gaveta de dinheiro |
| `POS_LerStatusImpressoraFormatado` | Status legível (`0\|0\|0\|...`) — serial/USB/TCP |
| `POS_AcharPortas` | Lista portas do sistema |
| `POS_GravarLogoArquivo` / `POS_ImprimirLogo` | Logo BMP na memória da impressora |
| `POS_UltimoRetorno` | Mensagem quando buffer de saída é pequeno |

Métodos de configuração seguem o padrão ACBrLib: `POS_ConfigLer`, `POS_ConfigGravar`, `POS_ConfigGravarValor`, `POS_Nome`, `POS_Versao`.

---

## INI — seções relevantes

### [PosPrinter]

| Chave | Descrição |
|-------|-----------|
| Modelo | Protocolo: `0`=ppTexto, `1`=Epson, `2`=Bematech, `3`=Daruma, … |
| Porta | `COM1`, `TCP:192.168.1.100:9100`, `RAW:Nome da Impressora` |
| PaginaDeCodigo | `2`=850 (padrão), `5`=UTF8 |
| ColunasFonteNormal | Colunas modo normal |
| CortaPapel | `1` = cortar ao usar tag `</corte>` |
| TraduzirTags | `1` = decodificar tags ACBr |

### [PosPrinter_QRCode] / [PosPrinter_Barras] / [PosPrinter_Logo] / [PosPrinter_Gaveta]

Ver documentação oficial para QR, código de barras, KC1/KC2 do logo e tempos da gaveta.

---

## Fluxo básico de impressão

```
POS_Inicializar("posprinter.ini", "")
POS_Ativar()
POS_InicializarPos()
POS_Imprimir("...", 1, 1, 1, 1)
POS_PularLinhas(3)
POS_CortarPapel(0)
POS_Desativar()
POS_Finalizar()
```

---

## Observações importantes

- Pré-alocar strings de retorno e passar tamanho; se truncar, usar `POS_UltimoRetorno`
- `POS_LerInfoImpressora` **não funciona** em comunicação RAW
- Status (`POS_LerStatusImpressora*`) apenas em serial, USB-serial e TCP/IP
- Logo para gravação na memória: arquivo **BMP**
- Porta TCP direta: `TCP:IP:PORTA` (sem spool Windows)
- Porta RAW: `RAW:Nome da impressora instalada`

---

## Integração no agente

| Variável | Descrição |
|----------|-----------|
| `PRINTER_PROVIDER` | `acbr-posprinter` (padrão) |
| `ACBR_POSPRINTER_LIB_PATH` | Caminho da `ACBrPosPrinter64.dll` |
| `ACBR_POSPRINTER_INI` | INI (padrão: `data/posprinter.ini`) |
| `PRINTER_ALLOW_PARITY` | `true` = fallback ESC/POS legado (só dev/CI) |

Homologação Windows: `CHECKLIST-WINDOWS-PRINT.md`  
Tags de cupom: `print/acbrTags.js`, `print/cupomAcbrTags.js`
