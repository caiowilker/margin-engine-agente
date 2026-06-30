# Sincroniza agente-local → C:\build\pdv-agente (Windows nativo)
# Uso: .\scripts\sync-windows-build.ps1
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$AgentRoot = Split-Path -Parent $PSScriptRoot
$BuildRoot = if ($env:BUILD_ROOT) { $env:BUILD_ROOT } else { "C:\build\pdv-agente" }
$FrontRoot = if ($env:FRONT_ROOT) { $env:FRONT_ROOT } else { Join-Path (Split-Path -Parent $AgentRoot) "margin-engine-front" }
$AppDest = Join-Path $BuildRoot "dist\app"

if (-not (Test-Path $BuildRoot)) {
    Write-Error "Pasta de build não encontrada: $BuildRoot"
}

New-Item -ItemType Directory -Force -Path $AppDest | Out-Null

Write-Host "==> Gerando manifest.json..."
Push-Location $AgentRoot
& npm run manifest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Pop-Location

$ExcludeDirs = @(
    "node_modules", "data", "daemon", ".git", ".ai", ".github",
    "test", "homolog-acbrlib", "frontend-dist", "C:\ProgramData"
)
$ExcludeFiles = @(".env", "*.log", "RESULTADO-*.md")

function Sync-Tree([string]$Source, [string]$Dest) {
    if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
    $robocopyArgs = @(
        $Source, $Dest,
        "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP"
    )
    foreach ($d in $ExcludeDirs) { $robocopyArgs += "/XD"; $robocopyArgs += $d }
    foreach ($f in $ExcludeFiles) { $robocopyArgs += "/XF"; $robocopyArgs += $f }
    & robocopy @robocopyArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy falhou com código $LASTEXITCODE" }
}

Write-Host "==> Sincronizando agente → $AppDest"
Sync-Tree -Source $AgentRoot -Dest $AppDest

Copy-Item -Force (Join-Path $AgentRoot "pdv-agente-installer.iss") (Join-Path $BuildRoot "pdv-agente-installer.iss")
Copy-Item -Force (Join-Path $AgentRoot "pdv-agente-installer.iss") (Join-Path $AppDest "pdv-agente-installer.iss")

$frontIndex = Join-Path $FrontRoot "dist\index.html"
if (Test-Path $frontIndex) {
    Write-Host "==> Sincronizando frontend-dist"
    $fd = Join-Path $AppDest "frontend-dist"
    Sync-Tree -Source (Join-Path $FrontRoot "dist") -Dest $fd
} else {
    Write-Warning "frontend-dist não atualizado — rode npm run build no margin-engine-front."
}

$pkg = Get-Content (Join-Path $AppDest "package.json") -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "OK — build sincronizado (v$($pkg.version))"
Write-Host "Próximo: cd C:\build\pdv-agente && .\prepare-build.ps1"
