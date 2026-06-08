@echo off
chcp 65001 >nul
title PDV Margin Engine — Instalador

echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║       PDV Margin Engine — Instalador v4.0           ║
echo ╚══════════════════════════════════════════════════════╝
echo.

:: ── Verificar privilégios de administrador ────────────────────────────────────
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  ⚠  Este instalador precisa de permissão de Administrador.
    echo  ↑  Clique com botão direito em setup.bat e escolha
    echo     "Executar como administrador"
    echo.
    pause
    exit /b 1
)
echo  ✓ Rodando como Administrador

:: ── Verificar Node.js ─────────────────────────────────────────────────────────
echo.
echo  Verificando Node.js...

where node >nul 2>&1
if %errorLevel% neq 0 (
    goto :instalar_node
)

:: Verifica versão mínima (18)
for /f "tokens=1 delims=." %%v in ('node -e "process.stdout.write(process.version.slice(1))"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% lss 18 (
    echo  ✗ Node.js v%NODE_MAJOR% detectado — versão mínima é 18.
    goto :instalar_node
)

echo  ✓ Node.js detectado (v%NODE_MAJOR%.x) — OK
goto :instalar_deps

:instalar_node
echo.
echo  ℹ  Node.js não encontrado. Tentando instalar automaticamente...
echo.

:: Tenta via winget (Windows 10 1809+ / Windows 11)
where winget >nul 2>&1
if %errorLevel% equ 0 (
    echo  → Instalando Node.js 20 LTS via winget...
    winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    if %errorLevel% neq 0 goto :node_manual
    echo  ✓ Node.js instalado via winget.
    :: Recarrega PATH para pegar o node recém instalado
    call RefreshEnv.cmd >nul 2>&1
    set "PATH=%PATH%;C:\Program Files\nodejs"
    goto :instalar_deps
)

:: Fallback: baixa instalador .msi direto via PowerShell
:node_manual_download
echo  → winget não disponível. Baixando instalador do Node.js...
set NODE_MSI=%TEMP%\node-lts.msi
powershell -NoProfile -Command ^
    "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.14.0/node-v20.14.0-x64.msi' -OutFile '%NODE_MSI%' -UseBasicParsing"
if not exist "%NODE_MSI%" goto :node_manual
echo  → Executando instalador silencioso do Node.js...
msiexec /i "%NODE_MSI%" /qn ADDLOCAL=ALL
if %errorLevel% neq 0 goto :node_manual
echo  ✓ Node.js instalado com sucesso.
set "PATH=%PATH%;C:\Program Files\nodejs"
goto :instalar_deps

:node_manual
echo.
echo  ✗ Não foi possível instalar o Node.js automaticamente.
echo.
echo  ► Acesse https://nodejs.org e baixe o instalador LTS (recomendado).
echo  ► Após instalar, execute este setup.bat novamente.
echo.
pause
exit /b 1

:: ── Instalar dependências npm ─────────────────────────────────────────────────
:instalar_deps
echo.
echo  Verificando dependências npm...

if not exist "%~dp0node_modules" (
    echo  → Instalando dependências (pode demorar alguns minutos)...
    cd /d "%~dp0"
    call npm install --loglevel=error
    if %errorLevel% neq 0 (
        echo  ✗ Erro ao instalar dependências. Verifique sua conexão com a internet.
        pause
        exit /b 1
    )
    echo  ✓ Dependências instaladas.
) else (
    echo  ✓ Dependências já instaladas.
)

:: ── Criar .env se não existir ─────────────────────────────────────────────────
if not exist "%~dp0.env" (
    if exist "%~dp0.env.example" (
        copy "%~dp0.env.example" "%~dp0.env" >nul
        echo  ✓ Arquivo .env criado a partir do .env.example
    )
) else (
    echo  ✓ Arquivo .env já existe.
)

:: ── Criar pasta data/ ─────────────────────────────────────────────────────────
if not exist "%~dp0data" (
    mkdir "%~dp0data"
    echo  ✓ Pasta data\ criada.
)

:: ── Verificar frontend-dist ───────────────────────────────────────────────────
echo.
if not exist "%~dp0frontend-dist" (
    echo  ⚠  Pasta frontend-dist\ não encontrada.
    echo     O PDV precisará de acesso à internet para carregar o app.
    echo     Para instalar offline: copie a pasta dist\ do build do frontend
    echo     para cá com o nome frontend-dist\
) else (
    echo  ✓ frontend-dist encontrado — PDV funciona offline.
)

:: ── Instalar serviço Windows ──────────────────────────────────────────────────
echo.
echo  Instalando serviço Windows (inicia automaticamente com o Windows)...
cd /d "%~dp0"
node install-service.js
if %errorLevel% neq 0 (
    echo.
    echo  ✗ Falha ao instalar serviço. Verifique o erro acima.
    pause
    exit /b 1
)

echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║  ✓ Instalação concluída!                            ║
echo ║                                                      ║
echo ║  O PDV está disponível em:                          ║
echo ║  → http://localhost:9100                            ║
echo ║                                                      ║
echo ║  O serviço inicia automaticamente com o Windows.    ║
echo ╚══════════════════════════════════════════════════════╝
echo.
pause
