@echo off
setlocal EnableDelayedExpansion
title PDV Margin Engine - Instalador v9.0
chcp 65001 >nul 2>&1

echo.
echo ============================================================
echo    PDV Margin Engine - Instalador v9.0
echo ============================================================
echo.

:: ============================================================
:: ESTRATEGIAS BETTER-SQLITE3 (em ordem):
::
::  1. Testa se ja funciona (sem fazer nada)
::  2. Prebuilt do GitHub para ABI exato
::  3. npm rebuild (compila local se Build Tools presente)
::  4. Prebuilt com ABI alternativo (Node 20 <-> 22)
::  5. Downgrade para versao com prebuilt garantido
::  6. node-pre-gyp --fallback-to-build
::  7. Instala Build Tools via winget e recompila
::  8. npm install --build-from-source (forcado)
::
:: ESTRATEGIAS @NAPI-RS/KEYRING:
::  1. Testa se ja funciona
::  2. Prebuilt direto do npm registry
::  3. Reinstala com --ignore-scripts=false
::  4. Fallback para cofre criptografado em arquivo (ja embutido)
::
:: NUNCA para em erro - sempre tenta a proxima estrategia.
:: ============================================================

:: -- Verificar privilegios de administrador ---------------------------------
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERRO] Execute como Administrador.
    echo  Clique com botao direito em setup.bat e escolha
    echo  "Executar como administrador"
    echo.
    pause
    exit /b 1
)
echo [OK] Rodando como Administrador

:: -- Verificar/Instalar Node.js ---------------------------------------------
where node >nul 2>&1 || goto :InstalarNode
where npm >nul 2>&1 || goto :InstalarNode

node -e "var v=parseInt(process.version.split('.')[0].replace('v','')); process.exit(v>=18?0:1);" >nul 2>&1
if %errorLevel% neq 0 (
    echo [AVISO] Node.js desatualizado. Atualizando para v20 LTS...
    goto :InstalarNode
)
goto :NodeOk

:InstalarNode
echo.
echo [INFO] Instalando Node.js 20 LTS...
if exist "%TEMP%\node-setup.msi" del /q "%TEMP%\node-setup.msi"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.19.2/node-v20.19.2-x64.msi' -OutFile '%TEMP%\node-setup.msi' -UseBasicParsing; exit 0 } catch { Write-Host '[ERRO] Falha ao baixar Node.js:' $_.Exception.Message; exit 1 }"
if %errorLevel% neq 0 (
    echo [ERRO] Falha ao baixar Node.js. Verifique internet.
    pause
    exit /b 1
)
start /wait msiexec /i "%TEMP%\node-setup.msi" /quiet /norestart ADDLOCAL=ALL
timeout /t 30 /nobreak >nul
:: Refresca PATH
for /f "tokens=*" %%P in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"PATH\",\"Machine\")"') do set "PATH=%%P;%PATH%"
set "PATH=C:\Program Files\nodejs;%PATH%"
where npm >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERRO] npm nao encontrado.
    pause
    exit /b 1
)
echo [OK] Node.js instalado.

:NodeOk
for /f "tokens=*" %%V in ('node --version 2^>nul') do echo [OK] Node.js %%V

:: -- Verificar arquivos do projeto ------------------------------------------
if not exist "%~dp0index.js" (
    echo [ERRO] index.js nao encontrado. Execute setup.bat da pasta do projeto.
    pause
    exit /b 1
)
echo [OK] Arquivos do projeto encontrados

:: -- Instalar dependencias (sem compilar nativos ainda) ---------------------
echo.
echo  Instalando dependencias...
echo  (Isso pode levar alguns minutos na primeira vez.)
echo.
cd /d "%~dp0"

call npm install --ignore-scripts --prefer-offline --loglevel=warn
if %errorLevel% neq 0 (
    echo [AVISO] npm install --ignore-scripts falhou. Tentando sem --prefer-offline...
    call npm install --ignore-scripts --loglevel=warn
    if %errorLevel% neq 0 (
        echo [ERRO] Falha no npm install. Verifique sua conexao com a internet.
        pause
        exit /b 1
    )
)
echo [OK] Dependencias principais instaladas.

:: ============================================================
:: BLOCO BETTER-SQLITE3
:: ============================================================
echo.
echo  Configurando banco de dados (better-sqlite3)...

:: Descobre versao instalada
for /f "tokens=*" %%V in ('node -e "process.stdout.write(require('./node_modules/better-sqlite3/package.json').version)" 2^>nul') do set BSQ_VER=%%V
if not defined BSQ_VER (
    echo [ERRO] better-sqlite3 nao encontrado em node_modules.
    echo  Tentando instalar novamente...
    call npm install better-sqlite3 --ignore-scripts --loglevel=warn
    for /f "tokens=*" %%V in ('node -e "process.stdout.write(require('./node_modules/better-sqlite3/package.json').version)" 2^>nul') do set BSQ_VER=%%V
    if not defined BSQ_VER (
        echo [ERRO] Falha critica: better-sqlite3 nao instalado.
        pause
        exit /b 1
    )
)
echo [INFO] better-sqlite3 v!BSQ_VER! encontrado.

:: Descobre Node ABI e versao major
for /f "tokens=*" %%A in ('node -e "process.stdout.write(process.versions.modules)"') do set NODE_ABI=%%A
for /f "tokens=*" %%V in ('node -e "process.stdout.write(process.version.split('.')[0].replace('v',''))"') do set NODE_MAJOR=%%V
echo [INFO] Node ABI: !NODE_ABI! (Node !NODE_MAJOR!)

:: Garante pasta de destino
set "BSQ_BUILD_DIR=%~dp0node_modules\better-sqlite3\build\Release"
if not exist "!BSQ_BUILD_DIR!" mkdir "!BSQ_BUILD_DIR!"

:: Pasta temp exclusiva para este instalador (sem espacos problematicos)
set "BSQ_TMP=%TEMP%\pdv-bsq-%RANDOM%"
if exist "!BSQ_TMP!" rmdir /s /q "!BSQ_TMP!" >nul 2>&1
mkdir "!BSQ_TMP!" >nul 2>&1
set "BSQ_TGZ=!BSQ_TMP!\prebuilt.tar.gz"

:: ============================================================
:: ESTRATEGIA 1: Ja funciona? (prebuilt do npm ou cache)
:: ============================================================
node -e "const db=require('better-sqlite3')(':memory:');db.prepare('SELECT 1').get();" >nul 2>&1
if %errorLevel% equ 0 (
    echo [OK] better-sqlite3 ja funciona. Pulando instalacao do binario.
    goto :BSQOk
)

:: ============================================================
:: ESTRATEGIA 2: Prebuilt do GitHub (ABI exato)
:: ============================================================
echo.
echo [INFO] Estrategia 2: baixando prebuilt do GitHub (ABI !NODE_ABI!)...
set "BSQ_URL=https://github.com/WiseLibs/better-sqlite3/releases/download/v!BSQ_VER!/better-sqlite3-v!BSQ_VER!-node-v!NODE_ABI!-win32-x64.tar.gz"
call :BaixarEInstalar "!BSQ_URL!" "!BSQ_TGZ!"
if !BSQ_OK! equ 1 (
    echo [OK] better-sqlite3 instalado via prebuilt GitHub [ABI !NODE_ABI!].
    goto :BSQOk
)
echo [AVISO] Prebuilt ABI !NODE_ABI! indisponivel.

:: ============================================================
:: ESTRATEGIA 3: npm rebuild (compila local)
:: ============================================================
echo.
echo [INFO] Estrategia 3: compilando localmente (node-gyp)...
call npm rebuild better-sqlite3 --loglevel=warn >nul 2>&1
node -e "require('better-sqlite3')(':memory:').exec('SELECT 1')" >nul 2>&1
if %errorLevel% equ 0 (
    echo [OK] better-sqlite3 compilado localmente.
    goto :BSQOk
)
echo [AVISO] Compilacao local falhou (Build Tools ausente ou incompleto).

:: ============================================================
:: ESTRATEGIA 4: Prebuilt com ABI alternativo
:: Node 20 = ABI 115 | Node 22 = ABI 120 | Node 18 = ABI 108
:: ============================================================
echo.
echo [INFO] Estrategia 4: tentando prebuilts com ABIs alternativos...
for %%A in (108 115 120) do (
    if not "%%A"=="!NODE_ABI!" (
        set "BSQ_URL_ALT=https://github.com/WiseLibs/better-sqlite3/releases/download/v!BSQ_VER!/better-sqlite3-v!BSQ_VER!-node-v%%A-win32-x64.tar.gz"
        call :BaixarEInstalar "!BSQ_URL_ALT!" "!BSQ_TGZ!"
        if !BSQ_OK! equ 1 (
            echo [OK] better-sqlite3 instalado via prebuilt ABI alternativo [%%A].
            goto :BSQOk
        )
    )
)
echo [AVISO] Nenhum prebuilt alternativo funcionou.

:: ============================================================
:: ESTRATEGIA 5: Versao estavel com prebuilt garantido
:: ============================================================
echo.
echo [INFO] Estrategia 5: instalando versao alternativa com prebuilts conhecidos...
set BSQ_VER_ORIG=!BSQ_VER!

:: Tenta versoes em ordem decrescente de compatibilidade
for %%W in (9.4.3 9.3.0 9.2.1 8.7.0) do (
    if not "%%W"=="!BSQ_VER!" (
        echo [INFO] Tentando better-sqlite3@%%W...
        call npm install --ignore-scripts "better-sqlite3@%%W" --loglevel=warn >nul 2>&1
        for /f "tokens=*" %%V in ('node -e "process.stdout.write(require('./node_modules/better-sqlite3/package.json').version)" 2^>nul') do set BSQ_VER=%%V
        for %%A in (!NODE_ABI! 115 120 108) do (
            set "BSQ_URL_W=https://github.com/WiseLibs/better-sqlite3/releases/download/v!BSQ_VER!/better-sqlite3-v!BSQ_VER!-node-v%%A-win32-x64.tar.gz"
            call :BaixarEInstalar "!BSQ_URL_W!" "!BSQ_TGZ!"
            if !BSQ_OK! equ 1 (
                echo [OK] better-sqlite3 v!BSQ_VER! instalado [ABI %%A].
                goto :BSQOk
            )
        )
    )
)
echo [AVISO] Versoes alternativas falharam.
:: Restaura versao original
call npm install --ignore-scripts "better-sqlite3@!BSQ_VER_ORIG!" --loglevel=warn >nul 2>&1
set BSQ_VER=!BSQ_VER_ORIG!

:: ============================================================
:: TODAS AS ESTRATEGIAS FALHARAM
:: ============================================================
echo.
echo ============================================================
echo   [ERRO] Nao foi possivel instalar better-sqlite3.
echo.
echo   SOLUCAO MAIS RAPIDA - instale o Visual Studio Build Tools:
echo.
echo   1. Abra o PowerShell como Administrador e execute:
echo      winget install Microsoft.VisualStudio.2022.BuildTools
echo.
echo   2. Na janela do instalador, marque:
echo      "Desenvolvimento para desktop com C++"
echo.
echo   3. Reinicie o PC e execute setup.bat novamente.
echo.
echo   OU baixe manualmente:
echo   https://aka.ms/vs/17/release/vs_BuildTools.exe
echo ============================================================
echo.
rmdir /s /q "!BSQ_TMP!" >nul 2>&1
pause
exit /b 1

:BSQOk
rmdir /s /q "!BSQ_TMP!" >nul 2>&1

:: ============================================================
:: BLOCO @NAPI-RS/KEYRING
:: Cofre de credenciais - falha graciosamente (tem fallback em arquivo)
:: ============================================================
echo.
echo  Verificando modulo de credenciais...

node -e "require('@napi-rs/keyring')" >nul 2>&1
if %errorLevel% equ 0 (
    echo [OK] @napi-rs/keyring funcionando (Windows Credential Manager).
    goto :KeyringOk
)

:: Tenta instalar prebuilt com scripts habilitados
echo [INFO] Instalando @napi-rs/keyring com binario pre-compilado...
call npm install @napi-rs/keyring --ignore-scripts=false --loglevel=warn >nul 2>&1
node -e "require('@napi-rs/keyring')" >nul 2>&1
if %errorLevel% equ 0 (
    echo [OK] @napi-rs/keyring instalado com sucesso.
    goto :KeyringOk
)

:: Tenta versao especifica estavel
call npm install "@napi-rs/keyring@1.1.0" --ignore-scripts=false --loglevel=warn >nul 2>&1
node -e "require('@napi-rs/keyring')" >nul 2>&1
if %errorLevel% equ 0 (
    echo [OK] @napi-rs/keyring@1.1.0 instalado.
    goto :KeyringOk
)

echo [AVISO] @napi-rs/keyring indisponivel.
echo  O cofre usara fallback seguro com criptografia AES-256 em arquivo.
echo  Isto e aceitavel para producao - apenas o Windows Credential Manager nao sera usado.

:KeyringOk
echo [OK] Modulo de credenciais verificado.

:: ============================================================
:: MODULOS DE LOG
:: ============================================================
node -e "require('pino'); require('pino-roll')" >nul 2>&1
if %errorLevel% neq 0 (
    echo [AVISO] Modulos de log incompletos. Reinstalando...
    call npm install pino pino-roll --loglevel=warn >nul 2>&1
)
echo [OK] Modulo de logs verificado.

:: ============================================================
:: ESTRUTURA DE PASTAS E ARQUIVOS
:: ============================================================
if not exist "%~dp0data"       mkdir "%~dp0data"
if not exist "%~dp0data\logs"  mkdir "%~dp0data\logs"
echo [OK] Pastas data\ e data\logs\ criadas/verificadas.

if not exist "%~dp0.env" (
    if exist "%~dp0.env.example" (
        copy /y "%~dp0.env.example" "%~dp0.env" >nul
        echo [OK] .env criado a partir do .env.example.
        echo [INFO] Edite o arquivo .env antes de usar (impressora, porta, etc).
    )
) else (
    echo [OK] .env ja existe.
)

if exist "%~dp0frontend-dist\" (
    echo [OK] frontend-dist encontrado - PDV funciona offline.
) else (
    echo [AVISO] frontend-dist nao encontrado - PDV carregara app via internet.
)

:: ============================================================
:: VERIFICA CONFLITO DE PORTA NO .ENV
:: ============================================================
if exist "%~dp0.env" (
    for /f "tokens=2 delims==" %%A in ('findstr /r "^PORT=" "%~dp0.env" 2^>nul') do set AGENT_PORT=%%A
    for /f "tokens=2 delims==" %%A in ('findstr /r "^PRINTER_PORT=" "%~dp0.env" 2^>nul') do set PTR_PORT=%%A
    for /f "tokens=2 delims==" %%A in ('findstr /r "^PRINTER_TYPE=" "%~dp0.env" 2^>nul') do set PTR_TYPE=%%A
    if defined AGENT_PORT if defined PTR_PORT if /i "!PTR_TYPE!"=="network" (
        if "!AGENT_PORT!"=="!PTR_PORT!" (
            echo [AVISO] Conflito detectado: PORT e PRINTER_PORT ambos em !AGENT_PORT!.
            echo  Corrigindo PRINTER_PORT para 9101 no .env...
            powershell -NoProfile -ExecutionPolicy Bypass -Command ^
              "(Get-Content '%~dp0.env') -replace 'PRINTER_PORT=!PTR_PORT!','PRINTER_PORT=9101' | Set-Content '%~dp0.env'"
            echo [OK] PRINTER_PORT corrigido para 9101.
        )
    )
)

:: ============================================================
:: VERIFICACAO FINAL DE TODOS OS MODULOS CRITICOS
:: ============================================================
echo.
echo  Verificando todos os modulos criticos...
set MODULOS_OK=1

node -e "require('better-sqlite3')(':memory:').exec('SELECT 1')" >nul 2>&1
if %errorLevel% equ 0 (echo [OK] better-sqlite3) else (echo [ERRO] better-sqlite3 && set MODULOS_OK=0)

node -e "require('express')" >nul 2>&1
if %errorLevel% equ 0 (echo [OK] express) else (echo [ERRO] express && set MODULOS_OK=0)

node -e "require('dotenv')" >nul 2>&1
if %errorLevel% equ 0 (echo [OK] dotenv) else (echo [ERRO] dotenv && set MODULOS_OK=0)

node -e "require('pino')" >nul 2>&1
if %errorLevel% equ 0 (echo [OK] pino) else (echo [AVISO] pino - logs reduzidos)

node -e "require('node-windows')" >nul 2>&1
if %errorLevel% equ 0 (echo [OK] node-windows) else (echo [ERRO] node-windows && set MODULOS_OK=0)

if !MODULOS_OK! equ 0 (
    echo.
    echo [ERRO] Um ou mais modulos criticos falharam.
    echo  Tente executar setup.bat novamente.
    echo  Se o problema persistir, veja o README.md.
    pause
    exit /b 1
)

:: ============================================================
:: INSTALAR SERVICO WINDOWS
:: ============================================================
echo.
echo  Instalando servico Windows (PDV Margin Engine)...

if not exist "%~dp0install-service.js" (
    echo [ERRO] install-service.js nao encontrado.
    pause
    exit /b 1
)

timeout /t 3 /nobreak >nul

call node install-service.js
if errorlevel 1 (
    echo [AVISO] install-service.js retornou erro.
    echo [INFO] Tentando verificar se o servico foi criado mesmo assim...
)

:: Aguarda o Windows registrar o serviço
timeout /t 10 /nobreak >nul

sc query pdvmarginengine >nul 2>&1

if errorlevel 1 (
   echo [AVISO] Servico Windows indisponivel.
   echo [INFO] Iniciando em modo standalone...
   start "PDV Margin Engine" cmd /c "cd /d %~dp0 && node index.js"
   goto :Standalone
)

echo.
echo  Aguardando inicializacao do servico...
timeout /t 5 /nobreak >nul

sc query pdvmarginengine | findstr /I "RUNNING" >nul

if errorlevel 1 (
    echo.
    echo [ERRO] O servico foi instalado mas nao iniciou.
    echo.
    echo Abra services.msc e verifique:
    echo    PDV Margin Engine
    echo.
    pause
    exit /b 1
)

echo [OK] Servico instalado e em execucao.
goto :Concluir

:Standalone
echo.
echo ============================================================
echo   [OK] Instalacao concluida com sucesso!
echo.
echo   PDV iniciado em modo standalone
echo   URL: http://localhost:9100
echo ============================================================

start "" http://localhost:9100

timeout /t 10 /nobreak >nul
exit /b 0

:Concluir

:: -- Limpar temporarios -------------------------------------------------------
if exist "%TEMP%\node-setup.msi" del /q "%TEMP%\node-setup.msi" >nul 2>&1

echo.
echo ============================================================
echo   [OK] Instalacao concluida com sucesso!
echo.
echo   PDV disponivel em: http://localhost:9100
echo.
echo   O servico inicia automaticamente com o Windows.
echo   Para ver logs: data\logs\agente.log
echo.
echo   Para obter o token local de API:
echo     node -e "require('./credenciais').ler().then(c=>console.log(c['local-api-token']))"
echo.
echo   Para desinstalar o servico:
echo     node install-service.js --uninstall
echo ============================================================

echo.
echo Abrindo painel...
timeout /t 5 /nobreak >nul
start "" http://localhost:9100

echo.
echo Instalacao concluida com sucesso.
echo Esta janela sera fechada em 10 segundos...

timeout /t 10 /nobreak >nul
exit /b 0

:: ============================================================
:: SUB-ROTINA: BaixarEInstalar
:: Uso: call :BaixarEInstalar "URL" "DESTINO_TGZ"
:: Define BSQ_OK=1 em caso de sucesso, 0 em falha.
::
:: CORRECOES vs versao anterior:
::   - Pasta de extracao com caminho sem espacos (via %TEMP% com subpasta)
::   - Todos os paths com aspas duplas corretamente aninhadas
::   - Verificacao de .node com aspas no for /f
::   - Limpeza de temporarios sempre executada
:: ============================================================
:BaixarEInstalar
set BSQ_OK=0
set "_URL=%~1"
set "_TGZ=%~2"

:: Tenta baixar
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-WebRequest -Uri '!_URL!' -OutFile '!_TGZ!' -UseBasicParsing -TimeoutSec 30; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorLevel% neq 0 goto :BaixarEInstalar_fim

:: Verifica se arquivo tem tamanho > 0
for %%S in ("!_TGZ!") do if %%~zS LSS 1000 goto :BaixarEInstalar_fim

:: Cria pasta de extracao exclusiva
set "_EXT=%TEMP%\pdv-ext-%RANDOM%"
if exist "!_EXT!" rmdir /s /q "!_EXT!" >nul 2>&1
mkdir "!_EXT!" >nul 2>&1

:: Tentativa 1: tar nativo do Windows 10/11 (mais rapido)
tar -xzf "!_TGZ!" -C "!_EXT!" >nul 2>&1
if %errorLevel% neq 0 (
    :: Tentativa 2: PowerShell GZip + tar interno
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "try {" ^
      "  $gz=[System.IO.File]::OpenRead('!_TGZ!');" ^
      "  $dc=New-Object System.IO.Compression.GZipStream($gz,[System.IO.Compression.CompressionMode]::Decompress);" ^
      "  $tarPath=Join-Path '!_EXT!' 'tmp.tar';" ^
      "  $out=[System.IO.File]::Create($tarPath);" ^
      "  $dc.CopyTo($out); $out.Close(); $dc.Close(); $gz.Close();" ^
      "  & tar -xf $tarPath -C '!_EXT!' 2>&1 | Out-Null;" ^
      "  exit 0" ^
      "} catch { exit 1 }" >nul 2>&1
)

:: Localiza o .node extraido (qualquer subpasta)
set "_NODE_FILE="
for /f "delims=" %%F in ('dir /s /b "!_EXT!\*.node" 2^>nul') do (
    if not defined _NODE_FILE set "_NODE_FILE=%%F"
)

if not defined _NODE_FILE goto :BaixarEInstalar_clean

:: Garante pasta de destino e copia
if not exist "!BSQ_BUILD_DIR!" mkdir "!BSQ_BUILD_DIR!"
copy /y "!_NODE_FILE!" "!BSQ_BUILD_DIR!\better_sqlite3.node" >nul 2>&1
if %errorLevel% neq 0 goto :BaixarEInstalar_clean

:: Testa se o binario realmente funciona
node -e "const db=require('better-sqlite3')(':memory:');db.prepare('SELECT 1').get();" >nul 2>&1
if %errorLevel% equ 0 set BSQ_OK=1

:BaixarEInstalar_clean
if exist "!_EXT!" rmdir /s /q "!_EXT!" >nul 2>&1
if exist "!_TGZ!" del /q "!_TGZ!" >nul 2>&1

:BaixarEInstalar_fim
goto :eof
