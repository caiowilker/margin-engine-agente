# Prepara C:\build\pdv-agente antes de compilar o instalador Inno Setup
# Uso (PowerShell):
#   cd C:\build\pdv-agente
#   .\prepare-build.ps1
#   .\prepare-build.ps1 -Compile
#Requires -Version 5.1
param(
    [switch]$Compile,
    [switch]$SkipNpm
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$App = Join-Path $Root "dist\app"
$Node = Join-Path $Root "dist\node"
$Iss = Join-Path $Root "pdv-agente-installer.iss"
$OutputDir = Join-Path $Root "output"

function Assert-Path([string]$Path, [string]$Hint) {
    if (-not (Test-Path $Path)) {
        Write-Error "Ausente: $Path`n$Hint"
    }
}

function Count-Xsd([string]$Dir) {
    if (-not (Test-Path $Dir)) { return 0 }
    return @(Get-ChildItem -Path $Dir -Filter "*.xsd" -Recurse -File -ErrorAction SilentlyContinue).Count
}

Write-Host ""
Write-Host "======================================================"
Write-Host "  PDV Margin Engine - Preparar build Windows"
Write-Host "======================================================"
Write-Host ""

Assert-Path $App "Sincronize o repo: npm run sync:windows-build (WSL) ou .\scripts\sync-windows-build.ps1"
Assert-Path (Join-Path $Node "node.exe") "Copie Node.js portatil x64 para dist\node\ (ou extraia node.zip)"
Assert-Path (Join-Path $App "acbrlib\lib\ACBrNFe64.dll") "DLL fiscal em dist\app\acbrlib\lib\"
Assert-Path (Join-Path $App "posprinter\lib\ACBrPosPrinter64.dll") "DLL impressora em dist\app\posprinter\lib\"
Assert-Path (Join-Path $App "print\printerBootstrap.js") "printerBootstrap ausente - rode sync:windows-build"
Assert-Path (Join-Path $App "assets\margin-engine.ico") "Icone assets\margin-engine.ico - rode node scripts/build-installer-icon.js"
Assert-Path $Iss "Execute sync - copia pdv-agente-installer.iss para esta pasta"

$schemaCount = Count-Xsd (Join-Path $App "acbrlib\data\Schemas")
if ($schemaCount -lt 10) {
    Write-Error "Schemas XSD insuficientes ($schemaCount) em dist\app\acbrlib\data\Schemas - rode sync:windows-build"
}
Write-Host "[OK] Schemas XSD: $schemaCount arquivo(s)"

$pkg = Get-Content (Join-Path $App "package.json") -Raw | ConvertFrom-Json
$versionScript = Join-Path $App "scripts\sync-installer-version.js"
if (Test-Path $versionScript) {
    & node $versionScript $Iss
}
$issText = Get-Content $Iss -Raw
$expectedDefine = '#define MyAppVersion "' + $pkg.version + '"'
if ($issText -notmatch [regex]::Escape($expectedDefine)) {
    Write-Warning "MyAppVersion no .iss desatualizado - package.json = $($pkg.version)"
    Write-Host "      Ajuste manualmente ou rode sync para copiar o .iss do repo"
}

$frontIndex = Join-Path $App "frontend-dist\index.html"
if (Test-Path $frontIndex) {
    Write-Host "[OK] frontend-dist - PDV offline + /api-proxy em :9100"
} else {
    Write-Warning "frontend-dist ausente - rode sync com build do margin-engine-front"
}

if (-not $SkipNpm) {
    Push-Location $App
    Write-Host "==> npm ci --omit=dev"
    & (Join-Path $Node "npm.cmd") ci --omit=dev
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "==> npm rebuild better-sqlite3"
    & (Join-Path $Node "npm.cmd") rebuild better-sqlite3
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "==> npm run manifest"
    & (Join-Path $Node "npm.cmd") run manifest
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "==> npm run predeploy"
    & (Join-Path $Node "npm.cmd") run predeploy
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "predeploy reportou avisos - revise antes de distribuir o .exe"
    }
    Pop-Location
}

$inno = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

Write-Host ""
Write-Host "======================================================"
Write-Host "  Preparacao concluida (v$($pkg.version))"
Write-Host "======================================================"

if ($Compile) {
    if (-not $inno) {
        Write-Error "Inno Setup 6 (ISCC.exe) nao encontrado"
    }
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    Write-Host "==> Compilando instalador..."
    & $inno $Iss
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $exe = Join-Path $OutputDir "Margin-Engine-Setup-$($pkg.version).exe"
    if (-not (Test-Path $exe)) {
        $legacy = Join-Path $OutputDir "PDV-Agente-Setup-$($pkg.version).exe"
        if (Test-Path $legacy) { $exe = $legacy }
    }
    if (Test-Path $exe) {
        Write-Host ""
        Write-Host "OK - $exe"
        $signScript = Join-Path $Root "sign-installer.ps1"
        if (Test-Path $signScript) {
            & $signScript -ExePath $exe
        }
    }
} elseif ($inno) {
    Write-Host "  Compilar:"
    Write-Host "    .\prepare-build.ps1 -Compile"
    Write-Host "  ou:"
    Write-Host "    & `"$inno`" `"$Iss`""
    Write-Host "  Saida: output\Margin-Engine-Setup-$($pkg.version).exe"
} else {
    Write-Host "  Inno Setup 6 nao encontrado - instale ou abra pdv-agente-installer.iss no IDE"
}
Write-Host ""
