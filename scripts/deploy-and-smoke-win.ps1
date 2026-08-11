$ErrorActionPreference = "Continue"
$src = "C:\build\pdv-agente\dist\app"
$dst = "C:\Program Files\Margin Engine\app"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output "IsAdmin=$isAdmin"

$files = @(
  "print\printerStationRoutes.js",
  "index.js",
  "scripts\e2e-print-pedido-smoke.js",
  "print\caixaLayout.js"
)
foreach ($rel in $files) {
  $from = Join-Path $src $rel
  $to = Join-Path $dst $rel
  if (-not (Test-Path $from)) { Write-Output "MISSING $from"; continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
  try {
    Copy-Item -LiteralPath $from -Destination $to -Force
    Write-Output "COPIED $rel"
  } catch {
    Write-Output "COPY_FAIL $rel :: $($_.Exception.Message)"
  }
}

# Sync frontend-dist if present (best effort)
$frontSrc = Join-Path $src "frontend-dist"
$frontDst = Join-Path $dst "frontend-dist"
if (Test-Path $frontSrc) {
  try {
    robocopy $frontSrc $frontDst /MIR /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    Write-Output "FRONTEND_SYNC exit=$LASTEXITCODE"
  } catch {
    Write-Output "FRONTEND_FAIL $($_.Exception.Message)"
  }
}

Write-Output "Restarting service..."
Restart-Service -Name "marginengine.exe" -Force
Start-Sleep -Seconds 6
$svc = Get-Service -Name "marginengine.exe"
Write-Output "Service=$($svc.Status)"

# Wait for listen
for ($i = 0; $i -lt 20; $i++) {
  try {
    $h = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:9100/health" -TimeoutSec 3
    Write-Output "HEALTH $($h.StatusCode)"
    break
  } catch {
    Start-Sleep -Seconds 1
    if ($i -eq 19) { Write-Output "HEALTH_FAIL $($_.Exception.Message)" }
  }
}

$routesJs = Join-Path $dst "print\printerStationRoutes.js"
$txt = Get-Content $routesJs -Raw
if ($txt -match "healPartialRoutes") { Write-Output "CODE_OK healPartialRoutes" } else { Write-Output "CODE_BAD no heal" }

# Heal routes via API
try {
  $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:9100/config/impressora/station-routes" -TimeoutSec 10
  Write-Output "ROUTES_GET $($r.StatusCode) $($r.Content)"
} catch {
  Write-Output "ROUTES_GET_FAIL $($_.Exception.Message)"
}

function Post-Pedido([string]$printType) {
  $body = @{
    printType = $printType
    eventType = "ORDER_CREATED"
    orderNumber = "SMOKE-$($printType.ToUpper())"
    orderId = "smoke-$printType-$(Get-Date -UFormat %s)"
    jobId = "smoke-job-$printType-$(Get-Date -UFormat %s)"
    customerName = "Smoke Test"
    customerPhone = "11999990000"
    deliveryAddress = if ($printType -eq "entrega") { "Rua Teste, 100" } else { $null }
    total = 25.5
    items = @(@{ code = "1"; name = "Item smoke"; quantity = 1; unit = "un" })
    copies = 1
    naoFiscal = $true
  } | ConvertTo-Json -Depth 5

  try {
    $res = Invoke-WebRequest -UseBasicParsing -Method POST -Uri "http://127.0.0.1:9100/impressora/pedido" -ContentType "application/json" -Body $body -TimeoutSec 60
    Write-Output "PRINT_$printType OK $($res.StatusCode) $($res.Content.Substring(0,[Math]::Min(200,$res.Content.Length)))"
    return $true
  } catch {
    $resp = $_.Exception.Response
    $msg = $_.Exception.Message
    if ($resp -ne $null) {
      try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $msg = $reader.ReadToEnd()
      } catch {}
    }
    Write-Output "PRINT_$printType FAIL $msg"
    if ($msg -match "sem impressora|ROUTE_MISSING") {
      Write-Output "SMOKE_BLOCKED_BY_ROUTE"
    }
    return $false
  }
}

$okBar = Post-Pedido "bar"
$okEnt = Post-Pedido "entrega"

if ($okBar -and $okEnt) {
  Write-Output "SMOKE_OK bar+entrega"
  exit 0
} else {
  Write-Output "SMOKE_FAIL"
  exit 1
}
