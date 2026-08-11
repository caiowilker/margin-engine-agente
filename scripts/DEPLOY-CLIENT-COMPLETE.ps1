# Deploy completo do PDV no cliente (Program Files) + smoke.
# Rodar elevado (Administrador). Fonte: C:\build\pdv-agente\dist\app
$ErrorActionPreference = "Continue"
$log = "C:\build\pdv-agente\DEPLOY-CLIENT-COMPLETE.log"
function L([string]$m) { Add-Content -Path $log -Value $m; Write-Output $m }
Remove-Item $log -ErrorAction SilentlyContinue
L ("START " + (Get-Date -Format o))
L ("IsAdmin=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

$src = "C:\build\pdv-agente\dist\app"
$dst = "C:\Program Files\Margin Engine\app"
$cfgPath = "C:\ProgramData\MarginEngine\agent\config.json"

if (-not (Test-Path $src)) { L "NO_SRC"; exit 2 }
if (-not (Test-Path $dst)) { L "NO_DST"; exit 2 }

# 1) Heal backendUrl (IP WSL/LAN morto → produção)
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    $url = [string]$cfg.backendUrl
    L ("BACKEND_BEFORE=" + $url)
    if ($url -match '172\.(1[6-9]|2\d|3[0-1])\.' -or $url -match '^http://10\.' -or $url -match '^http://192\.168\.') {
      $cfg.backendUrl = "https://api.marginengine.com.br"
      ($cfg | ConvertTo-Json -Depth 8) | Set-Content -Path $cfgPath -Encoding UTF8
      L "BACKEND_HEALED=https://api.marginengine.com.br"
    }
  } catch {
    L ("CFG_FAIL " + $_.Exception.Message)
  }
}

# 2) Stop service
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
Start-Sleep 3

# 3) Mirror critical runtime + frontend
$files = @(
  "apiProxy.js",
  "index.js",
  "print\printerStationRoutes.js",
  "print\caixaLayout.js",
  "package.json",
  "manifest.json"
)
foreach ($rel in $files) {
  $from = Join-Path $src $rel
  $to = Join-Path $dst $rel
  if (-not (Test-Path $from)) { L ("SKIP " + $rel); continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
  Copy-Item -Force $from $to
  L ("COPIED " + $rel)
}
robocopy (Join-Path $src "frontend-dist") (Join-Path $dst "frontend-dist") /MIR /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
L ("ROBOCOPY_FRONTEND=" + $LASTEXITCODE)

# 4) Start
Start-Service -Name "marginengine.exe" -ErrorAction SilentlyContinue
Start-Sleep 8
try {
  $h = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9100/health -TimeoutSec 12
  L ("HEALTH " + $h.StatusCode)
} catch {
  L ("HEALTH_FAIL " + $_.Exception.Message)
  exit 3
}

# 5) Proxy must hit production
try {
  $p = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9100/api-proxy/actuator/health -TimeoutSec 15
  L ("PROXY " + $p.StatusCode)
  if ($p.StatusCode -ne 200) { L "PROXY_NOT_200"; exit 4 }
} catch {
  L ("PROXY_FAIL " + $_.Exception.Message)
  exit 4
}

# 6) Smoke bar + entrega via agente
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$token = [string]$cfg.agentToken
if (-not $token) { L "NO_TOKEN"; exit 5 }
function PostPedido([string]$printType) {
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $obj = [ordered]@{
    printType = $printType
    eventType = "ORDER_CREATED"
    orderNumber = ("SMOKE-" + $printType.ToUpper() + "-" + $ts)
    orderId = ("smoke-" + $printType + "-" + $ts)
    jobId = ("smoke-job-" + $printType + "-" + $ts)
    customerName = "Smoke Deploy"
    total = 9.9
    items = @(@{ code = "1"; name = ("Item " + $printType); quantity = 1; unit = "un" })
    copies = 1
    naoFiscal = $true
    idempotencyKey = ("smoke-deploy:" + $printType + ":" + $ts)
  }
  if ($printType -eq "entrega") {
    $obj["eventType"] = "ORDER_READY"
    $obj["deliveryAddress"] = "Rua Smoke, 1"
  }
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  $headers = @{ "X-Agent-Token" = $token }
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Method POST -Uri "http://127.0.0.1:9100/impressora/pedido" -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 90
    L ("PRINT_" + $printType + " " + $res.StatusCode)
    return $true
  } catch {
    L ("PRINT_" + $printType + "_FAIL " + $_.Exception.Message)
    return $false
  }
}

$okC = [bool](PostPedido "cozinha")
$okB = [bool](PostPedido "bar")
$okE = [bool](PostPedido "entrega")
L ("RESULT cozinha=$okC bar=$okB entrega=$okE")

# Markers in frontend
$hasPreparo = Select-String -Path "$dst\frontend-dist\assets\*.js" -Pattern "imprimirPreparoAutomatico|cozinha-auto|bar-auto" -List -ErrorAction SilentlyContinue | Select-Object -First 1
$hasEntrega = Select-String -Path "$dst\frontend-dist\assets\*.js" -Pattern "entrega-auto|imprimirEntregaAutomatica" -List -ErrorAction SilentlyContinue | Select-Object -First 1
$hasProxy = Select-String -Path "$dst\apiProxy.js" -Pattern "isPrivateLanHostname" -List -ErrorAction SilentlyContinue
if ($hasPreparo) { L "HAS_PREPARO_AUTO" } else { L "MISSING_PREPARO_AUTO" }
if ($hasEntrega) { L "HAS_ENTREGA_AUTO" } else { L "MISSING_ENTREGA_AUTO" }
if ($hasProxy) { L "HAS_PROXY_LAN_HEAL" } else { L "MISSING_PROXY_LAN_HEAL" }

if ($okC -and $okB -and $okE -and $hasPreparo -and $hasEntrega -and $hasProxy) {
  L "DEPLOY_OK"
  exit 0
}
L "DEPLOY_FAIL"
exit 1
