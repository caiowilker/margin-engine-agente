# Deploy seguro: build -> instalacao (preserva .env, data, INIs)
# Uso (PowerShell como Administrador):
#   cd C:\build\pdv-agente
#   .\deploy-to-installed.ps1
#Requires -Version 5.1
param(
    [string]$Src = "C:\build\pdv-agente\dist\app",
    [string]$Dest = "C:\Program Files\PDV Margin Engine\app"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Src)) { throw "Build ausente: $Src — rode sync:windows-build" }
if (-not (Test-Path $Dest)) { throw "Instalacao ausente: $Dest" }

$bak = Join-Path $Dest (".backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force -Path $bak | Out-Null

Write-Host "==> Backup em $bak"
if (Test-Path (Join-Path $Dest ".env")) { Copy-Item (Join-Path $Dest ".env") (Join-Path $bak ".env") -Force }
if (Test-Path (Join-Path $Dest "data")) { Copy-Item (Join-Path $Dest "data") (Join-Path $bak "data") -Recurse -Force }
$ini = Join-Path $Dest "acbrlib\data\config\acbrlib.ini"
if (Test-Path $ini) {
    New-Item -ItemType Directory -Force -Path (Join-Path $bak "acbrlib-config") | Out-Null
    Copy-Item $ini (Join-Path $bak "acbrlib-config\acbrlib.ini") -Force
}

Write-Host "==> Sincronizando $Src -> $Dest"
$xd = @("data", "node_modules")
$xf = @(".env")
& robocopy $Src $Dest /MIR /NFL /NDL /NJH /NJS /NC /NS /NP /XD $xd /XF $xf | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy falhou com codigo $LASTEXITCODE" }

& robocopy (Join-Path $Src "frontend-dist") (Join-Path $Dest "frontend-dist") /MIR /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy frontend-dist falhou" }

$bakIni = Join-Path $bak "acbrlib-config\acbrlib.ini"
if (Test-Path $bakIni) {
    New-Item -ItemType Directory -Force -Path (Split-Path $ini) | Out-Null
    Copy-Item $bakIni $ini -Force
}

Write-Host ""
Write-Host "======================================================"
Write-Host "  Deploy concluido"
Write-Host "  Preservados: .env, data\, acbrlib.ini, node_modules"
Write-Host "  Backup: $bak"
Write-Host "  Reinicie o servico do agente."
Write-Host "======================================================"
