# Validacao somente leitura - nao roda npm
# Uso: cd C:\build\pdv-agente && .\validate-build.ps1
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$App = Join-Path $Root "dist\app"

$checks = @(
    @{ Path = "dist\node\node.exe"; Hint = "Node portatil" },
    @{ Path = "dist\app\package.json"; Hint = "App sincronizado" },
    @{ Path = "dist\app\index.js"; Hint = "index.js" },
    @{ Path = "dist\app\apiProxy.js"; Hint = "api-proxy (login :9100)" },
    @{ Path = "dist\app\acbrlib\lib\ACBrNFe64.dll"; Hint = "ACBrLib NFe" },
    @{ Path = "dist\app\posprinter\lib\ACBrPosPrinter64.dll"; Hint = "ACBr PosPrinter" },
    @{ Path = "dist\app\print\printerBootstrap.js"; Hint = "printerBootstrap" },
    @{ Path = "dist\app\acbrlib\data\Schemas"; Hint = "Pasta Schemas" },
    @{ Path = "dist\app\frontend-dist\index.html"; Hint = "PDV offline" },
    @{ Path = "dist\app\frontend-dist\api-backend.json"; Hint = "api-backend.json" },
    @{ Path = "dist\app\node_modules\better-sqlite3\build\Release\better_sqlite3.node"; Hint = "better-sqlite3 nativo (rode prepare-build.ps1 sem -SkipNpm)" },
    @{ Path = "dist\app\assets\margin-engine.ico"; Hint = "Icone instalador" },
    @{ Path = "sign-installer.ps1"; Hint = "Assinatura opcional" },
    @{ Path = "pdv-agente-installer.iss"; Hint = "Script Inno Setup" },
    @{ Path = "prepare-build.ps1"; Hint = "prepare-build.ps1" },
    @{ Path = "compile-installer.ps1"; Hint = "compile-installer.ps1" },
    @{ Path = "LEIA-ME.md"; Hint = "LEIA-ME.md" }
)

$fail = 0
foreach ($c in $checks) {
    $full = Join-Path $Root $c.Path
    if (Test-Path $full) {
        Write-Host "[OK] $($c.Hint) - $($c.Path)"
    } else {
        Write-Host "[FALHA] $($c.Hint) - $($c.Path)"
        $fail++
    }
}

$xsd = @(Get-ChildItem (Join-Path $App "acbrlib\data\Schemas") -Filter "*.xsd" -Recurse -File -ErrorAction SilentlyContinue).Count
if ($xsd -ge 10) {
    Write-Host "[OK] Schemas XSD - $xsd arquivo(s)"
} else {
    Write-Host "[FALHA] Schemas XSD - $xsd (esperado >= 10)"
    $fail++
}

$indexHtml = Join-Path $App "frontend-dist\index.html"
$bundlePath = $null
if (Test-Path $indexHtml) {
    $entry = Select-String -Path $indexHtml -Pattern 'src="/assets/(index-[^"]+\.js)"' | Select-Object -First 1
    if ($entry -and $entry.Matches.Count -gt 0) {
        $bundlePath = Join-Path $App ("frontend-dist\assets\" + $entry.Matches[0].Groups[1].Value)
    }
}
if (-not $bundlePath) {
    $bundlePath = (Get-ChildItem (Join-Path $App "frontend-dist\assets\index-*.js") -File -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
if ($bundlePath -and (Test-Path $bundlePath) -and (Select-String -Path $bundlePath -Pattern "api-proxy" -Quiet)) {
    Write-Host "[OK] Frontend bundle - usa /api-proxy em :9100 ($([IO.Path]::GetFileName($bundlePath)))"
} else {
    Write-Host "[FALHA] Frontend bundle - api-proxy nao encontrado no JS"
    $fail++
}

if ($fail -gt 0) {
    Write-Error "$fail verificacao(oes) falharam - rode sync:windows-build antes de compilar"
}
Write-Host ""
Write-Host "Build pronto para prepare-build.ps1"
