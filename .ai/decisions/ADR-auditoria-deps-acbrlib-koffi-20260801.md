# Auditoria de dependências — ACBrLib / koffi / DLLs (2026-08-01)

**Papel:** olhar de Principal Engineer sobre o que realmente roda no caixa.

## Stack efetiva (WSL = build = Program Files)

| Pacote | Versão | Nota |
|--------|--------|------|
| Node portátil | **v20.18.1 x64** | OK |
| `koffi` | **2.16.3** (única, deduped) | OK — sem duas versões |
| `@projetoacbr/acbrlib-nfe-node` | **1.0.11** (latest npm) | OK |
| `@projetoacbr/acbrlib-nfse-node` | **1.0.12** | OK |
| `@projetoacbr/acbrlib-dfe-node` | **1.0.12** | Declara `base: "latest"` — risco de drift |
| `@projetoacbr/acbrlib-base-node` | **1.0.12** | OK hoje |

**Ação:** pin exato + `overrides` no `package.json` (koffi/base/dfe) para builds reproduzíveis.

## Binários nativos

| Artefato | Arch | Observação |
|----------|------|------------|
| `ACBrNFe64.dll` | x64 PE32+ | Export `NFE_Inicializar`; strings MT/cdecl |
| `ACBrNFSe64.dll` | x64 | Mais nova (Jul 23) que NFe (Jun 29) |
| `ACBrPosPrinter64.dll` | x64 | Isolada em `posprinter/lib` |
| OpenSSL na pasta NFe | **1.1 e 3 juntos** | + árvore `OpenSSL/0.9.8…3.1.3` |
| CTe/MDFe na mesma pasta | sim | Copiados no staging antigo sem necessidade |

### Achado crítico (PE import)

`ACBrNFe64.dll` / `ACBrNFSe64.dll` **não** importam `libcrypto`/`libxml2` no PE. Só APIs Windows (`crypt32`, `winhttp`, …).

Conclusão: companheiros são carregados via **`LoadLibrary` no cwd** após `process.chdir(staging)`. Por isso o staging “copia pasta inteira” era especialmente perigoso: Windows resolve DLL por nome e a **primeira** no path/cwd ganha.

## O que o `void **` NÃO é (neste inventário)

- Não é conflito de duas versões de koffi no tree (só 2.16.3).
- Não é Node 32-bit (é x64).
- Não é “falta do pacote npm” — o npm **é** o bridge koffi.
- Não prova, sozinho, DLL “errada” de arquitetura (PE é x64).

## O que AINDA pode ser a faísca do 1º `NFE_Inicializar`

1. **DLL hell no staging** (OpenSSL 1.1+3 + CTe/MDFe + árvore OpenSSL) — mitigado com staging seletivo.
2. **Mesmo processo** carregando PosPrinter koffi + NFe koffi (se Pos cair in-process).
3. **Handle External** inválido / segundo `Inicializar` sem `Finalizar` (já endurecido no código).
4. **INI/cert/path** relativos incorretos no cwd staged (precisa log `inicializar_begin` no caixa).

## Mudanças desta auditoria

1. `stageNativeLibBundle`: só DLL principal + libxml/xslt/iconv/legacy + **um** par OpenSSL (default 1.1).
2. Pins/`overrides` no `package.json`.
3. Continua válido: worker NFe = fechamento arquitetural definitivo.

## Como validar no caixa após rebuild

1. Apagar staging antigo: `%TEMP%\margin-acbrlib` (e `margin-acbrlib-nfse`).
2. Reiniciar serviço.
3. Confirmar na pasta staged: **sem** `libcrypto-3*`, **sem** `ACBrCTe*`, **sem** pasta `OpenSSL/`.
4. Log `acbrlib.inicializar_begin` / `_ok` ou `_fail`.
