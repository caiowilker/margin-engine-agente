# Compila pdv-agente-installer.iss (Inno Setup 6)
# Uso: cd C:\build\pdv-agente && .\compile-installer.ps1
#
# NÃO compile o .iss direto no Inno GUI sem prepare — precisa de
# vendor\node_modules.zip e vendor\schemas.zip (gerados abaixo).
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Root "prepare-build.ps1") -SkipNpm -Compile
