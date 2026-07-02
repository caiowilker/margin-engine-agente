# Sincroniza agente-local → C:\build\pdv-agente (Windows nativo)
# Uso: .\scripts\sync-windows-build.ps1
#Requires -Version 5.1
param(
    [string]$BuildRoot = $(if ($env:BUILD_ROOT) { $env:BUILD_ROOT } else { "C:\build\pdv-agente" }),
    [string]$FrontRoot = $(if ($env:FRONT_ROOT) { $env:FRONT_ROOT } else { "" }),
    [switch]$SkipFrontBuild
)

$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $PSScriptRoot
if (-not $FrontRoot) {
    $FrontRoot = Join-Path (Split-Path -Parent $AgentRoot) "margin-engine-front"
}
$AppDest = Join-Path $BuildRoot "dist\app"
$WinScripts = Join-Path $AgentRoot "build\windows"

New-Item -ItemType Directory -Force -Path $BuildRoot, $AppDest, (Join-Path $BuildRoot "output") | Out-Null

Write-Host "==> Build root: $BuildRoot"
Write-Host "==> Verificando alinhamento de versão release..."
node (Join-Path $AgentRoot "scripts\check-release-alignment.js")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Gerando manifest.json..."
Push-Location $AgentRoot
& npm run manifest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Pop-Location

Write-Host "==> Sincronizando versão do instalador..."
node (Join-Path $AgentRoot "scripts\sync-installer-version.js")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Gerando ícone do instalador..."
node (Join-Path $AgentRoot "scripts\build-installer-icon.js")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Copy-Item -Force (Join-Path $AgentRoot "assets\margin-engine.ico") (Join-Path $BuildRoot "assets\margin-engine.ico") -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $BuildRoot "assets") | Out-Null
if (Test-Path (Join-Path $AgentRoot "assets\margin-engine.ico")) {
  Copy-Item -Force (Join-Path $AgentRoot "assets\margin-engine.ico") (Join-Path $BuildRoot "assets\margin-engine.ico")
}

function Sync-Tree([string]$Source, [string]$Dest, [string[]]$ExcludeDirNames, [string[]]$ExcludeFileGlobs) {
    if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
    $args = @($Source, $Dest, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP")
    foreach ($d in $ExcludeDirNames) { $args += "/XD"; $args += $d }
    foreach ($f in $ExcludeFileGlobs) { $args += "/XF"; $args += $f }
    & robocopy @args | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy falhou com código $LASTEXITCODE" }
}

# /XD data — relativo à raiz do Source — NÃO remove acbrlib\data
$ExcludeDirs = @(
    "node_modules", "data", "daemon", ".git", ".ai", ".github",
    "test", "homolog-acbrlib", "frontend-dist"
)
$ExcludeFiles = @(".env", "*.log", "RESULTADO-*.md")

Write-Host "==> Sincronizando agente → $AppDest"
Sync-Tree -Source $AgentRoot -Dest $AppDest -ExcludeDirNames $ExcludeDirs -ExcludeFileGlobs $ExcludeFiles

Write-Host "==> Copiando scripts de build"
Copy-Item -Force (Join-Path $AgentRoot "pdv-agente-installer.iss") (Join-Path $BuildRoot "pdv-agente-installer.iss")
Copy-Item -Force (Join-Path $AgentRoot "LICENSE.txt") (Join-Path $BuildRoot "LICENSE.txt")
foreach ($f in @("prepare-build.ps1", "compile-installer.ps1", "validate-build.ps1", "deploy-to-installed.ps1", "sign-installer.ps1", "LEIA-ME.md")) {
    $src = Join-Path $WinScripts $f
    if (Test-Path $src) { Copy-Item -Force $src (Join-Path $BuildRoot $f) }
}
Copy-Item -Force (Join-Path $AgentRoot "docs\INSTALADOR-WINDOWS.md") (Join-Path $BuildRoot "LEIA-ME-INSTALADOR.md")

if (-not $SkipFrontBuild) {
    $buildScript = Join-Path $AgentRoot "scripts\build-frontend-dist.sh"
    if (Test-Path $buildScript) {
        Write-Host "==> Build frontend-dist (bash/WSL)"
        $env:FRONT_ROOT = $FrontRoot
        $env:TARGET = Join-Path $AgentRoot "frontend-dist"
        bash $buildScript production
    }
    $fdSrc = Join-Path $AgentRoot "frontend-dist"
    if (Test-Path (Join-Path $fdSrc "index.html")) {
        Write-Host "==> Copiando frontend-dist"
        Sync-Tree -Source $fdSrc -Dest (Join-Path $AppDest "frontend-dist") -ExcludeDirNames @() -ExcludeFileGlobs @()
    } else {
        Write-Warning "frontend-dist ausente"
    }
}

$fail = 0
function Require([string]$Path, [string]$Label) {
    if (Test-Path $Path) { Write-Host "OK — $Label" }
    else { Write-Host "ERRO — $Label : $Path"; $script:fail++ }
}

Require (Join-Path $AppDest "acbrlib\lib\ACBrNFe64.dll") "ACBrNFe64.dll"
Require (Join-Path $AppDest "posprinter\lib\ACBrPosPrinter64.dll") "ACBrPosPrinter64.dll"
Require (Join-Path $AppDest "print\printerBootstrap.js") "printerBootstrap"

$xsd = @(Get-ChildItem (Join-Path $AppDest "acbrlib\data\Schemas") -Filter "*.xsd" -Recurse -File -ErrorAction SilentlyContinue).Count
if ($xsd -ge 10) { Write-Host "OK — schemas XSD: $xsd" }
else { Write-Host "ERRO — schemas XSD: $xsd"; $fail++ }

if (Test-Path (Join-Path $AppDest "frontend-dist\index.html")) { Write-Host "OK — frontend-dist" }
else { Write-Warning "frontend-dist ausente" }

if (Test-Path (Join-Path $BuildRoot "dist\node\node.exe")) { Write-Host "OK — Node portátil" }
else { Write-Warning "dist\node\node.exe ausente" }

if ($fail -gt 0) { exit 1 }

$pkg = Get-Content (Join-Path $AppDest "package.json") -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "======================================================"
Write-Host "  Sync concluído — v$($pkg.version)"
Write-Host "  cd $BuildRoot"
Write-Host "  .\validate-build.ps1"
Write-Host "  .\prepare-build.ps1 -Compile"
Write-Host "======================================================"
