# Instalador Windows — PDV Agente v1.0

Documentação do empacotamento via Inno Setup (`pdv-agente-installer.iss`).

## Filosofia do wizard (PC limpo)

O instalador é pensado para **caixa novo**, sem ACBr Monitor nem DLLs soltas no disco.

| O que o usuário vê | O que o instalador faz por baixo |
|--------------------|----------------------------------|
| Emitir NFC-e? Sim/Não | `EMISSAO_FISCAL` + certificado/CSC se Sim |
| Certificado `.pfx` + SEFAZ | Cofre + `acbrlib.ini` |
| Porta da impressora | `posprinter.ini` + `.env` |

**Não pergunta:**

- Caminho da `ACBrNFe64.dll` — usa `{app}\app\acbrlib\lib\` (empacotada no `.exe`)
- ACBrLib vs ACBr Monitor — padrão **sempre ACBrLib embutido**
- ACBrPosPrinter vs ESC/POS — padrão **sempre ACBrPosPrinter embutido**

Modos legados (Monitor TCP :9200, impressora ESC/POS nativa) ficam para **pós-instalação** via `.env` ou painel `http://localhost:9100` — cenário de suporte, não de primeira instalação.

## Telas do wizard

| Ordem | Tela | Quando aparece |
|-------|------|----------------|
| 1 | Emissão fiscal (Sim/Não) | Sempre |
| 2 | Certificado A1 (`.pfx`) | Só se emitir NFC-e |
| 3 | **Ambiente SEFAZ** (Homologação / Produção — marcar opção) | Só se emitir NFC-e |
| 4 | Parâmetros (senha, UF, CSC) | Só se emitir NFC-e |
| 5 | Impressora (porta opcional) | Sempre — vazio = **auto-detect** ACBr PosPrinter |

## Estrutura de build (`dist/`)

```
dist/
├── node/                      ← Node.js portátil x64
├── app/                       ← cópia de agente-local
│   ├── acbrlib/lib/           ← ACBrNFe64.dll + deps (OBRIGATÓRIO no .exe)
│   ├── acbrlib/data/          ← Schemas, ACBrNFeServicos.ini
│   ├── posprinter/lib/        ← ACBrPosPrinter64.dll + deps (OBRIGATÓRIO)
│   └── frontend-dist/         ← PDV offline (build com VITE_API_URL produção)
├── acbrlib/                   ← overlay opcional
└── posprinter/                ← overlay opcional
```

**Checklist antes de compilar:**

- `dist/app/acbrlib/lib/ACBrNFe64.dll` e `dist/app/posprinter/lib/ACBrPosPrinter64.dll` existem
- `dist/app/acbrlib/data/Schemas/` com centenas de `.xsd` (o `sync-windows-build.sh` falha se faltar)

> **Armadilha:** o rsync não pode usar `--exclude data` genérico — isso remove `acbrlib/data/Schemas` do pacote. Use `--exclude '/data'` (só a pasta `data/` na raiz do agente).

## Passos para gerar o `.exe`

1. Sincronizar: `npm run sync:windows-build` (WSL) ou `.\scripts\sync-windows-build.ps1` (Windows).
2. Node portátil em `C:\build\pdv-agente\dist\node\` (só na 1ª vez).
3. Validar: `.\validate-build.ps1`
4. Preparar + compilar: `.\prepare-build.ps1 -Compile`

Scripts canônicos no repo: `agente-local/build/windows/`

Build do front (automático no sync):

```bash
cd agente-local
./scripts/build-frontend-dist.sh production   # API: app.marginengine.com.br
```

Saída: `C:\build\pdv-agente\output\PDV-Agente-Setup-1.0.0.exe`

No PDV, o ambiente **SEFAZ** (homologação vs produção fiscal) aparece em faixa amarela no topo quando o agente está em homologação; badge “Produção” no header quando em produção.

## Pós-install

1. `installer-apply-fiscal-config.js` — `.env`, cofre, `acbrlib.ini`, ProgramData
2. `installer-apply-print-config.js` — `.env`, `posprinter.ini`
3. `npm ci`, `rebuild better-sqlite3`, `manifest`, `predeploy`
4. `install-service.js` (se marcado)
5. Abrir `http://localhost:9100` → ativar terminal com código do painel → login operador

## Modos avançados (suporte)

| Cenário | Ajuste manual no `.env` após instalar |
|---------|----------------------------------------|
| Cliente já usa ACBr Monitor Pro | `ACBR_DRIVER=monitor`, `ACBR_HOST=127.0.0.1`, `ACBR_PORT=9200` |
| Impressora só ESC/POS (sem DLL) | `PRINTER_PROVIDER=native` |
| Impressora de rede | Opcional — deixe vazio no wizard; auto-detect usa porta **9100** na LAN |

**Não** use `ACBR_LIB_ALLOW_PARITY` nem `PRINTER_ALLOW_PARITY` em produção.

## Referências

- `docs/ACBRLIB-INTEGRACAO.md`
- `docs/ACBRLIB-POSPRINTER.md`
- `docs/OPERACAO.md`
