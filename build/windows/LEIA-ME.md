# Build Windows — PDV Margin Engine Agente

Pasta oficial de empacotamento: **`C:\build\pdv-agente`**

Os scripts desta pasta são copiados automaticamente pelo `sync:windows-build` a partir do repositório `agente-local/build/windows/`.

## Estrutura

```
C:\build\pdv-agente\
├── pdv-agente-installer.iss     ← Inno Setup 6
├── prepare-build.ps1            ← valida + npm ci + manifest + predeploy
├── compile-installer.ps1        ← prepare + compila .exe
├── validate-build.ps1           ← só checagens (rápido)
├── LEIA-ME.md
├── output\                      ← Margin-Engine-Setup-1.0.0.exe
└── dist\
    ├── node\                    ← Node.js portátil x64
    └── app\                     ← cópia agente-local
        ├── acbrlib\
        │   ├── lib\             ← ACBrNFe64.dll + deps
        │   └── data\Schemas\    ← 201+ XSD (obrigatório)
        ├── posprinter\lib\      ← ACBrPosPrinter64.dll + deps
        ├── frontend-dist\       ← PDV offline (/api-proxy em :9100)
        └── print\printerBootstrap.js
```

## Fluxo completo (recomendado)

### 1. Sincronizar do repositório

**WSL** (na pasta `agente-local`):

```bash
npm run sync:windows-build
```

**Windows** (PowerShell no `agente-local`):

```powershell
.\scripts\sync-windows-build.ps1
```

Isso:

- Gera `manifest.json`
- Copia o agente para `dist\app\` (preserva `acbrlib\data\Schemas`)
- Builda e copia `frontend-dist` (produção)
- Copia `.iss` e scripts desta pasta
- **Falha** se faltar XSDs ou DLLs críticas

### 2. Node portátil (só na 1ª vez)

Se `dist\node\node.exe` não existir:

- Extraia Node x64 LTS em `dist\node\`, ou
- Use o `node.zip` já na pasta do build

### 3. Validar

```powershell
cd C:\build\pdv-agente
.\validate-build.ps1
```

### 4. Preparar dependências nativas

```powershell
.\prepare-build.ps1
```

### 5. Gerar o instalador

```powershell
.\prepare-build.ps1 -Compile
# ou
.\compile-installer.ps1
```

Saída: `output\Margin-Engine-Setup-<versão>.exe`

### 7. Assinatura digital (produção, opcional)

```powershell
$env:MARGIN_SIGN_PFX = "C:\certs\margin-engine.pfx"
$env:MARGIN_SIGN_PASSWORD = "***"
.\sign-installer.ps1
```

### 8. Atualizar instalação existente (sem perder .env / data)

PowerShell **como Administrador**:

```powershell
.\deploy-to-installed.ps1
```

Preserva: `.env`, `data\`, `acbrlib.ini`, `node_modules` da instalação.

## O que o instalador inclui (v1.0)

| Componente | Automático no .exe |
|------------|-------------------|
| ACBrLib NFe + schemas XSD | Sim |
| ACBr PosPrinter | Sim |
| PDV offline (frontend-dist) | Sim |
| Impressora | Auto-detect (porta vazia no wizard) |
| Certificado / CSC | Só se marcar emissão fiscal no wizard |

## Checklist antes de distribuir

- [ ] `npm run auditoria:hardening` (repo)
- [ ] `validate-build.ps1` sem falhas
- [ ] `prepare-build.ps1 -Compile` — instalador gerado
- [ ] `sign-installer.ps1` (se certificado disponível)
- [ ] Testar `.exe` em VM Windows limpa
- [ ] `npm run homolog:agente:live` após instalação
- [ ] Preflight NFC-e OK após certificado
- [ ] Impressora detectada no painel diagnóstico

## Referências no repo

- `agente-local/docs/INSTALADOR-WINDOWS.md`
- `agente-local/docs/ACBRLIB-INTEGRACAO.md`
- `agente-local/docs/ACBRLIB-POSPRINTER.md`
