# Compila pdv-agente-installer.iss (Inno Setup 6)
# Uso: cd C:\build\pdv-agente && .\compile-installer.ps1
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Root "prepare-build.ps1") -SkipNpm -Compile
