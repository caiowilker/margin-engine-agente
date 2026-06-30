# Homologação ACBrLib — driver de produção

Valida o **acbrLibDriver.js** (pipeline real do agente) com a DLL compilada em `acbrlib/`.

## O que testa

| Etapa | Método produção |
|-------|-----------------|
| Diagnóstico | `testarLibDetalhe()` |
| Status SEFAZ | `statusServico()` |
| Emissão NFC-e | `emitirNfce()` via `montarIniLib` (sem `documentIni`) |
| PDF DANFC-e | `gerarPdfDanfce()` |
| Consulta | `consultarChave()` |

## Executar

```bash
cd agente-local
bash scripts/run-homolog-acbrlib-producao.sh
```

Windows PowerShell (na pasta `agente-local`):

```powershell
$env:ACBR_LIB_PATH = "acbrlib\lib\ACBrNFe64.dll"
$env:ACBR_LIB_INI = "acbrlib\data\config\acbrlib.ini"
$env:EMISSAO_FISCAL = "true"
node scripts\homolog-acbrlib-producao.js
```

Paths relativos resolvem a partir da raiz do agente (`agente-local`).

**Node Windows + pasta UNC (`\\wsl.localhost\...`):** o script desativa sqlite local e usa `%LOCALAPPDATA%\MarginEngine-homolog` como dados.

DLL Pro compilada: se exigir licença, `$env:ACBR_LIB_CRYPT_KEY = "sua-chave"`.

## Pré-requisitos

DLL em `acbrlib/lib/`, certificado A1 homologação, schemas e `acbrlib/data/config/acbrlib.ini`.

## Resultado

Arquivo gerado na raiz do agente: `RESULTADO-HOMOLOG-PRODUCAO.md`

Numeração auto-incrementada em `.last-numero` (evita cStat 539).
