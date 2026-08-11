@echo off
:: Atualiza o Agente instalado com o build de C:\build\pdv-agente e testa bar+entrega.
:: Clique com o botao direito > Executar como administrador
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-print-fix-elevated.ps1"
echo.
echo Log: C:\ProgramData\MarginEngine\src-patch\deploy-print-fix-result.txt
pause
