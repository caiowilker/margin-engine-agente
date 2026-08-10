# Elgin i9 — barcode "?" → fix 1.0.8

## Causa raiz (confirmada em hex)

`node_modules/escpos/utils.js` `codeLength()`:

```js
Buffer.from((str.length).toString(16), 'hex')  // len=7 → "7" → buffer VAZIO
```

Pacote **errado** enviado (VAS01):

```
1D 6B 49 7B 42 56 41 53 30 31 00
         ^^
         `{` lido como n=123 → firmware Elgin imprime "?"
```

Pacote **correto** (manual Elgin i9 Function B CODE128 m=73):

```
1D 6B 49 07 7B 42 56 41 53 30 31
         ^^ n=7 = len("{BVAS01}")
```

## No PC da loja (aceitação física)

1. Atualizar agente **1.0.8** e reiniciar.
2. Configurações → Impressora → dialeto **Elgin (i7/i9)** → Salvar.
3. **Testar código de barras** → olhe o papel:
   - Barras legíveis → **Sim — barras OK**
   - Ainda "?" → **Não** (sistema troca dialeto e reimprime; use leitor para validar)
4. Imprimir comprovante de vasilhame real (VAS…) e escanear com leitor.
5. Repetir em ≥2 outras térmicas (Bematech MP-4200, Daruma DR800) com o dialeto correspondente.

## Evidência automatizada

`node --test test/barcode-dialect.test.js` — hex Elgin vs bug escpos.
