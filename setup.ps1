# PDV Margin Engine - Instalador Windows
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Write-Step([string]$Message) { Write-Host "  $Message" }
function Write-Ok([string]$Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "  [AVISO] $Message" -ForegroundColor Yellow }
function Write-Err([string]$Message) { Write-Host "  [ERRO] $Message" -ForegroundColor Red }

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Refresh-NodePath {
    $nodeDir = "${env:ProgramFiles}\nodejs"
    if (Test-Path $nodeDir) {
        if ($env:Path -notlike "*$nodeDir*") {
            $env:Path = "$env:Path;$nodeDir"
        }
    }
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($machinePath) { $env:Path = "$machinePath;$userPath" }
}

function Get-NodeMajor {
    Refresh-NodePath
    try {
        $version = (& node -e "process.stdout.write(process.version.slice(1))" 2>$null)
        if ($version) { return [int]($version.Split(".")[0]) }
    } catch {}
    return 0
}

function Install-NodeViaWinget {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return $false }
    Write-Step "Instalando Node.js 20 LTS via winget..."
    & winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { return $false }
    Start-Sleep -Seconds 3
    Refresh-NodePath
    return (Get-NodeMajor -ge 18)
}

function Install-NodeViaMsi {
    $nodeVersion = "20.18.1"
    $msiUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-x64.msi"
    $msiPath = Join-Path $env:TEMP "node-lts-$nodeVersion.msi"

    Write-Step "Baixando Node.js $nodeVersion..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
    } catch {
        Write-Err "Falha ao baixar Node.js. Verifique a conexao com a internet."
        Write-Err $_.Exception.Message
        return $false
    }

    if (-not (Test-Path $msiPath)) {
        Write-Err "Arquivo MSI do Node.js nao foi baixado."
        return $false
    }

    Write-Step "Executando instalador silencioso do Node.js..."
    $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$msiPath`" /qn ADDLOCAL=ALL" -Wait -PassThru
    Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) { return $false }

    Start-Sleep -Seconds 3
    Refresh-NodePath
    return (Get-NodeMajor -ge 18)
}

function Ensure-Node {
    $major = Get-NodeMajor
    if ($major -ge 18) {
        Write-Ok "Node.js v$major detectado"
        return
    }

    if ($major -gt 0) {
        Write-Warn "Node.js v$major detectado. Versao minima: 18."
    } else {
        Write-Warn "Node.js nao encontrado."
    }

    if (Install-NodeViaWinget) {
        Write-Ok "Node.js instalado via winget"
        return
    }

    if (Install-NodeViaMsi) {
        Write-Ok "Node.js instalado via instalador MSI"
        return
    }

    Write-Err "Nao foi possivel instalar o Node.js automaticamente."
    Write-Host ""
    Write-Host "  Instale manualmente em https://nodejs.org (versao LTS 18+)"
    Write-Host "  Depois execute setup.bat novamente como Administrador."
    exit 1
}

function Ensure-NpmDependencies {
    $nodeModules = Join-Path $Root "node_modules"
    if (Test-Path $nodeModules) {
        Write-Ok "Dependencias npm ja instaladas"
        return
    }

    Write-Step "Instalando dependencias npm (pode demorar alguns minutos)..."
    & npm install --loglevel=error
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Erro ao instalar dependencias npm. Verifique internet e permissoes."
        exit 1
    }
    Write-Ok "Dependencias instaladas"
}

function Ensure-EnvFile {
    $envFile = Join-Path $Root ".env"
    $envExample = Join-Path $Root ".env.example"
    if (Test-Path $envFile) {
        Write-Ok "Arquivo .env ja existe"
        return
    }
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Ok ".env criado a partir do .env.example"
    }
}

function Fix-PrinterPortConflict {
    # PORT (agente HTTP) e PRINTER_PORT (socket da impressora na LAN) sao independentes.
    # Nao alterar PRINTER_PORT automaticamente; use auto-detect via printerBootstrap.
}

function Ensure-DataDir {
    $dataDir = Join-Path $Root "data"
    if (-not (Test-Path $dataDir)) {
        New-Item -ItemType Directory -Path $dataDir | Out-Null
        Write-Ok "Pasta data\ criada"
    }
}

function Test-FrontendDist {
    $dist = Join-Path $Root "frontend-dist"
    if (Test-Path $dist) {
        Write-Ok "frontend-dist encontrado - PDV funciona offline"
    } else {
        Write-Warn "Pasta frontend-dist\ nao encontrada."
        Write-Warn "O PDV precisara de internet para carregar o app."
    }
}

function Install-WindowsService {
    Write-Step "Instalando servico Windows..."
    & node (Join-Path $Root "install-service.js")
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Falha ao instalar o servico. Veja o erro acima."
        exit 1
    }
}

Write-Host ""
Write-Host "======================================================"
Write-Host "       PDV Margin Engine - Instalador v5.0"
Write-Host "======================================================"
Write-Host ""

if (-not (Test-IsAdmin)) {
    Write-Err "Execute setup.bat como Administrador."
    Write-Host "  Clique com botao direito em setup.bat -> Executar como administrador"
    exit 1
}
Write-Ok "Executando como Administrador"

Ensure-Node
Ensure-NpmDependencies
Ensure-EnvFile
Fix-PrinterPortConflict
Ensure-DataDir
Test-FrontendDist
Install-WindowsService

Write-Host ""
Write-Host "======================================================"
Write-Host "  Instalacao concluida!"
Write-Host "  PDV disponivel em: http://localhost:9100"
Write-Host "  O servico inicia automaticamente com o Windows."
Write-Host "======================================================"
Write-Host ""
