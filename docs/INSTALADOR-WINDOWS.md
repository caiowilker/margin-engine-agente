# Instalador Windows — PDV Agente v1.0

Documentação do empacotamento via Inno Setup (`pdv-agente-installer.iss` na raiz do monorepo ou em `agente-local/`).

## O que o wizard configura

| Tela | Campos |
|------|--------|
| Emissão fiscal | Sim (NFC-e/NF-e) ou Não (cupom interno — padrão) |
| Motor | **ACBrLib Pro** (padrão 1.0) ou **ACBr Monitor** (fallback TCP :9200) |
| Certificado | Caminho do `.pfx` A1 |
| Parâmetros SEFAZ | Senha do certificado, UF, ambiente (`homologacao` / `producao`), Id CSC, Token CSC |
| ACBrLib (só modo Lib) | Caminho da `ACBrNFe64.dll` (padrão: `{app}\app\acbrlib\lib\`) |
| Impressora | **ACBrPosPrinter** (padrão) ou ESC/POS nativo |
| Parâmetros impressora | Porta (`USB`, `COM1`, …), nome no spooler Windows (opcional) |

Com **ACBrLib**, o instalador grava `acbrlib/data/config/acbrlib.ini` e `data/acbrlib.ini`, atualiza `.env` e guarda senha/CSC no **cofre** (`fiscalSecrets`) com `__VAULT__` no INI.

Com **ACBrPosPrinter**, grava `.env` e `data/posprinter.ini` via `installer-apply-print-config.js`.

## Estrutura de build (`dist/`)

```
dist/
├── node/                      ← Node.js portátil x64
├── app/                       ← cópia de agente-local (sem node_modules, .env, data/)
│   ├── acbrlib/lib/           ← ACBrNFe64.dll + deps
│   ├── acbrlib/data/          ← Schemas, ACBrNFeServicos.ini
│   └── posprinter/lib/        ← ACBrPosPrinter64.dll + deps
├── acbrlib/                   ← overlay opcional (mesma árvore)
├── posprinter/                ← overlay opcional
└── lib/                       ← legado: copiado para app\acbrlib\lib\
```

## Passos para gerar o `.exe`

1. Sincronizar versão e copiar agente:
   ```bash
   # Exemplo — ajuste conforme seu script de release
   rsync -a --exclude node_modules --exclude data --exclude .env \
     agente-local/ dist/app/
   ```

2. Copiar Node portátil para `dist/node/`.

3. Garantir DLLs em `dist/app/acbrlib/lib/` e `dist/app/posprinter/lib/` (ou overlays em `dist/acbrlib`, `dist/posprinter`).

4. Copiar `pdv-agente-installer.iss` para a pasta de build e compilar no **Inno Setup 6**.

5. Saída: `output/PDV-Agente-Setup-1.0.0.exe`

## Pós-install

Ordem de execução:

1. `installer-apply-fiscal-config.js` — `.env`, cofre, `acbrlib.ini`, ProgramData
2. `installer-apply-print-config.js` — `.env`, `posprinter.ini`
3. `npm ci`, `rebuild better-sqlite3`, `manifest`, `predeploy`
4. `install-service.js` (se marcado)

Dados em `ProgramData\MarginEngine` **não** são removidos na desinstalação.

## Modo Lib vs Monitor (1.0)

| | ACBrLib (padrão) | Monitor (fallback) |
|---|------------------|-------------------|
| Pré-requisito | `acbrlib/lib/ACBrNFe64.dll` + deps | ACBr Monitor Pro :9200 |
| `.env` | `ACBR_DRIVER=lib` | `ACBR_DRIVER=monitor` |
| Config | `acbrlib/data/config/acbrlib.ini` | `acbr.ini` do Monitor |
| Segredos | Cofre + `__VAULT__` no INI | Cofre + `.env` paths |

**Não** use `ACBR_LIB_ALLOW_PARITY` nem `PRINTER_ALLOW_PARITY` em produção.

## Referências

- `docs/ACBRLIB-INTEGRACAO.md`
- `acbrlib/` + `homolog-acbrlib/` — homologação nativa ACBrLib
- `margin-fiscal/certification/etapa-b5-acbrlib-nativo-verificacao.md`
