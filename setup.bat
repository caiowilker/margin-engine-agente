@echo off
chcp 437 >nul
title PDV Margin Engine - Instalador v6.0

echo.
echo ============================================================
echo    PDV Margin Engine - Instalador v6.0
echo ============================================================
echo.

:: -- Verificar privilegios de administrador ----------------------------------
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERRO] Este instalador precisa de permissao de Administrador.
    echo.
    echo  Feche esta janela, clique com botao direito em setup.bat
    echo  e escolha "Executar como administrador"
    echo.
    pause
    exit /b 1
)
echo [OK] Rodando como Administrador

:: -- Verificar e instalar Node.js -------------------------------------------
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo [AVISO] Node.js nao encontrado. Baixando e instalando automaticamente...
    echo         Aguarde, isso pode levar alguns minutos.
    echo.

    :: Baixa o instalador LTS via PowerShell
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.19.2/node-v20.19.2-x64.msi' -OutFile '%TEMP%\node-setup.msi' -UseBasicParsing"

    if not exist "%TEMP%\node-setup.msi" (
        echo [ERRO] Falha ao baixar o Node.js.
        echo  Verifique sua conexao com a internet e tente novamente.
        echo  Ou baixe manualmente em: https://nodejs.org
        pause
        exit /b 1
    )

    echo  Instalando Node.js (instalacao silenciosa)...
    msiexec /i "%TEMP%\node-setup.msi" /quiet /norestart ADDLOCAL=ALL

    :: Atualiza o PATH da sessao atual para encontrar o node recem instalado
    set "PATH=%PATH%;C:\Program Files\nodejs"

    :: Aguarda instalacao finalizar
    timeout /t 5 /nobreak >nul

    where node >nul 2>&1
    if %errorLevel% neq 0 (
        echo [ERRO] Instalacao do Node.js falhou ou PATH nao foi atualizado.
        echo  Reinicie o computador e execute este instalador novamente.
        pause
        exit /b 1
    )
    echo [OK] Node.js instalado com sucesso
) else (
    :: Verifica versao minima (18+)
    node -e "var v=parseInt(process.version.slice(1));if(v<18){process.exit(1)}" >nul 2>&1
    if %errorLevel% neq 0 (
        echo [AVISO] Node.js desatualizado detectado. Atualizando para LTS...
        powershell -NoProfile -ExecutionPolicy Bypass -Command ^
          "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.19.2/node-v20.19.2-x64.msi' -OutFile '%TEMP%\node-setup.msi' -UseBasicParsing"
        msiexec /i "%TEMP%\node-setup.msi" /quiet /norestart ADDLOCAL=ALL
        set "PATH=%PATH%;C:\Program Files\nodejs"
        timeout /t 5 /nobreak >nul
        echo [OK] Node.js atualizado
    )
)

for /f %%V in ('node --version 2^>nul') do echo [OK] Node.js %%V pronto

:: -- Verificar se os arquivos do projeto estao presentes --------------------
if not exist "%~dp0index.js" (
    echo.
    echo [ERRO] index.js nao encontrado na mesma pasta que setup.bat
    echo  Certifique-se de que todos os arquivos do projeto estao juntos.
    echo.
    pause
    exit /b 1
)
echo [OK] Arquivos do projeto encontrados

:: -- Instalar dependencias npm -----------------------------------------------
echo.
echo  Instalando dependencias (npm install)...
echo  Isso pode levar alguns minutos na primeira vez.
echo.
cd /d "%~dp0"
call npm install --loglevel=error
if %errorLevel% neq 0 (
    echo.
    echo [ERRO] Falha ao instalar dependencias.
    echo  Verifique sua conexao com a internet e tente novamente.
    echo.
    pause
    exit /b 1
)
echo [OK] Dependencias instaladas

:: -- Criar pastas necessarias ------------------------------------------------
if not exist "%~dp0data" mkdir "%~dp0data"
if not exist "%~dp0data\logs" mkdir "%~dp0data\logs"
echo [OK] Pastas data\ e data\logs\ verificadas

:: -- Criar .env a partir do .env.example se nao existir ---------------------
if not exist "%~dp0.env" (
    if exist "%~dp0.env.example" (
        copy /y "%~dp0.env.example" "%~dp0.env" >nul
        echo [OK] .env criado a partir do .env.example
        echo.
        echo [AVISO] Edite o arquivo .env na pasta do projeto
        echo         antes de iniciar o PDV pela primeira vez.
        echo         Arquivo: %~dp0.env
    ) else (
        echo [AVISO] .env.example nao encontrado - crie o arquivo .env manualmente
    )
) else (
    echo [OK] .env ja existe - mantido sem alteracao
)

:: -- Verificar frontend-dist -------------------------------------------------
if exist "%~dp0frontend-dist\" (
    echo [OK] frontend-dist encontrado - PDV funciona offline
) else (
    echo [AVISO] frontend-dist nao encontrado - PDV precisara de internet para o app
)

:: -- Instalar o servico Windows ----------------------------------------------
echo.
echo  Instalando servico Windows...
node "%~dp0install-service.js"
if %errorLevel% neq 0 (
    echo.
    echo [ERRO] Falha ao instalar o servico Windows.
    echo  Verifique as mensagens acima e tente novamente.
    echo.
    pause
    exit /b 1
)

:: -- Limpar instalador temporario -------------------------------------------
if exist "%TEMP%\node-setup.msi" del /q "%TEMP%\node-setup.msi" >nul 2>&1

:: -- Conclusao ---------------------------------------------------------------
echo.
echo ============================================================
echo   [OK] Instalacao concluida!
echo.
echo   O agente PDV esta rodando como servico Windows.
echo   Acesse: http://localhost:9100
echo.
echo   Para desinstalar o servico:
echo     node install-service.js --uninstall
echo.
echo   Para ver logs:
echo     data\logs\agente.log
echo ============================================================
echo.
pause
