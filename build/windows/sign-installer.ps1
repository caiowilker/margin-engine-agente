# Assina o instalador Margin Engine com signtool (opcional).
# Requer certificado de assinatura de código instalado ou variáveis de ambiente.
#
# Variáveis:
#   MARGIN_SIGN_PFX       — caminho do .pfx
#   MARGIN_SIGN_PASSWORD  — senha do certificado
#   MARGIN_SIGN_TIMESTAMP — URL timestamp (default: http://timestamp.digicert.com)
#
# Uso:
#   .\sign-installer.ps1
#   .\sign-installer.ps1 -ExePath "output\Margin-Engine-Setup-1.0.0.exe"
#Requires -Version 5.1
param(
    [string]$ExePath = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $ExePath) {
    $pkg = Get-Content (Join-Path $Root "dist\app\package.json") -Raw | ConvertFrom-Json
    $ExePath = Join-Path $Root "output\Margin-Engine-Setup-$($pkg.version).exe"
}

if (-not (Test-Path $ExePath)) {
    Write-Error "Instalador não encontrado: $ExePath`nCompile primeiro com prepare-build.ps1 -Compile"
}

$signtool = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe",
    "${env:ProgramFiles}\Windows Kits\10\bin\*\x64\signtool.exe"
) | Get-ChildItem -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1

if (-not $signtool) {
    Write-Warning "signtool.exe não encontrado — pule assinatura ou instale Windows SDK"
    exit 0
}

$pfx = $env:MARGIN_SIGN_PFX
$pass = $env:MARGIN_SIGN_PASSWORD
$ts = if ($env:MARGIN_SIGN_TIMESTAMP) { $env:MARGIN_SIGN_TIMESTAMP } else { "http://timestamp.digicert.com" }

if (-not $pfx -or -not (Test-Path $pfx)) {
    Write-Host ""
    Write-Host "Assinatura digital: PULADA (MARGIN_SIGN_PFX não configurado)"
    Write-Host "Para assinar em produção:"
    Write-Host "  `$env:MARGIN_SIGN_PFX = 'C:\certs\margin-engine.pfx'"
    Write-Host "  `$env:MARGIN_SIGN_PASSWORD = '***'"
    Write-Host "  .\sign-installer.ps1"
    Write-Host ""
    exit 0
}

Write-Host "==> Assinando $ExePath"
& $signtool.FullName sign /fd SHA256 /f $pfx /p $pass /tr $ts /td SHA256 /d "Margin Engine Setup" /du "https://marginengine.com.br" $ExePath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Verificando assinatura"
& $signtool.FullName verify /pa $ExePath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "OK — instalador assinado"
