$ErrorActionPreference = "Continue"
$src = "C:\build\pdv-agente\dist\app"
$dst = "C:\Program Files\Margin Engine\app"
$out = "C:\ProgramData\MarginEngine\src-patch\deploy-print-fix-result.txt"
function L($m) { Add-Content $out $m; Write-Host $m }
Remove-Item $out -ErrorAction SilentlyContinue
L ("START " + (Get-Date -Format o))
L ("IsAdmin=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

if (-not (Test-Path "$src\print\printerStationRoutes.js")) {
  L "MISSING_SRC"
  exit 2
}

# Stop service/process first so files unlock
try { Stop-Service "marginengine.exe" -Force -ErrorAction SilentlyContinue } catch {}
Get-Process marginengine,node -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $cmd = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.Id)).CommandLine
    if ($cmd -match "Margin Engine|pdv-agente|marginengine") {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
      L ("KILLED " + $_.Id)
    }
  } catch {}
}
Start-Sleep 2

# Mirror critical pieces
$items = @(
  "print\printerStationRoutes.js",
  "index.js",
  "print\caixaLayout.js",
  "scripts\e2e-print-pedido-smoke.js",
  "scripts\live-smoke-pedido.ps1"
)
foreach ($rel in $items) {
  $from = Join-Path $src $rel
  $to = Join-Path $dst $rel
  if (-not (Test-Path $from)) { L ("SKIP " + $rel); continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
  Copy-Item -LiteralPath $from -Destination $to -Force
  L ("COPIED " + $rel)
}

if (Test-Path "$src\frontend-dist\index.html") {
  robocopy "$src\frontend-dist" "$dst\frontend-dist" /MIR /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
  L ("FRONTEND_SYNC=" + $LASTEXITCODE)
}

$hasHeal = Select-String -Path "$dst\print\printerStationRoutes.js" -Pattern "healPartialRoutes" -Quiet
L ("HAS_HEAL=" + $hasHeal)

try { Start-Service "marginengine.exe" } catch {
  try { Restart-Service "marginengine.exe" -Force } catch {
    Start-Process "$dst\daemon\marginengine.exe"
  }
}
Start-Sleep 8
try { L ("SERVICE=" + (Get-Service "marginengine.exe").Status) } catch { L "SERVICE_UNKNOWN" }

# Health + authenticated pedido smoke
for ($i=0; $i -lt 20; $i++) {
  try {
    $h = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9100/health -TimeoutSec 3
    L ("HEALTH=" + $h.StatusCode)
    break
  } catch {
    Start-Sleep 1
    if ($i -eq 19) { L ("HEALTH_FAIL=" + $_.Exception.Message) }
  }
}

$cfg = Get-Content "C:\ProgramData\MarginEngine\agent\config.json" -Raw | ConvertFrom-Json
$token = [string]$cfg.agentToken
function PostPedido([string]$printType) {
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $obj = [ordered]@{
    printType=$printType; eventType="ORDER_CREATED"; orderNumber=("DEP-$($printType.ToUpper())-$ts");
    orderId=("dep-$printType-$ts"); jobId=("dep-job-$printType-$ts"); customerName="Deploy Smoke";
    customerPhone="11999990000"; total=12.5;
    items=@(@{code="1";name="Smoke deploy";quantity=1;unit="un"}); copies=1; naoFiscal=$true
  }
  if ($printType -eq "entrega") { $obj.deliveryAddress = "Rua Deploy 1" }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 6 -Compress))
  $headers = @{ "X-Agent-Token" = $token }
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Method POST -Uri http://127.0.0.1:9100/impressora/pedido -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 120
    L ("PRINT_$printType=OK " + $res.StatusCode)
    return $true
  } catch {
    $msg = $_.Exception.Message
    try { $r=$_.Exception.Response; if($r){ $sr=New-Object IO.StreamReader($r.GetResponseStream()); $b=$sr.ReadToEnd(); if($b){$msg=$b}}} catch {}
    L ("PRINT_$printType=FAIL " + $msg)
    return $false
  }
}

$ok1 = [bool](PostPedido "bar")
Start-Sleep 2
$ok2 = [bool](PostPedido "entrega")
L ("RESULT bar=$ok1 entrega=$ok2")
if ($hasHeal -and $ok1 -and $ok2) { L "DEPLOY_SMOKE_OK"; exit 0 }
L "DEPLOY_SMOKE_FAIL"
exit 1
