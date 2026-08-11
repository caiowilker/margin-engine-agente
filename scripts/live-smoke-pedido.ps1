$ErrorActionPreference = "Continue"
$log = "C:\build\pdv-agente\live-smoke.log"
function L([string]$m) { Add-Content -Path $log -Value $m }

Remove-Item $log -ErrorAction SilentlyContinue
L ("START " + (Get-Date -Format o))

$cfgPath = "C:\ProgramData\MarginEngine\agent\config.json"
if (-not (Test-Path $cfgPath)) { L "NO_CONFIG"; exit 2 }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$token = [string]$cfg.agentToken
if (-not $token) { L "NO_TOKEN"; exit 2 }
L ("TOKEN_LEN=" + $token.Length)

try {
  $h = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9100/health -TimeoutSec 8
  L ("HEALTH " + $h.StatusCode)
} catch {
  L ("HEALTH_FAIL " + $_.Exception.Message)
  exit 2
}

try {
  $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9100/config/impressora/station-routes -TimeoutSec 8
  L ("ROUTES " + $r.Content)
} catch {
  L ("ROUTES_FAIL " + $_.Exception.Message)
}

function PostPedido([string]$printType) {
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $obj = [ordered]@{
    printType = $printType
    eventType = "ORDER_CREATED"
    orderNumber = ("LIVE-" + $printType.ToUpper() + "-" + $ts)
    orderId = ("live-" + $printType + "-" + $ts)
    jobId = ("live-job-" + $printType + "-" + $ts)
    customerName = "Teste Live"
    customerPhone = "11999990000"
    total = 19.9
    items = @(@{ code = "1"; name = "Item live smoke"; quantity = 1; unit = "un" })
    copies = 1
    naoFiscal = $true
  }
  if ($printType -eq "entrega") { $obj["deliveryAddress"] = "Rua Live, 123" }
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $headers = @{ "X-Agent-Token" = $token }
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Method POST -Uri "http://127.0.0.1:9100/impressora/pedido" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 90
    $snippet = $res.Content
    if ($snippet.Length -gt 300) { $snippet = $snippet.Substring(0, 300) }
    L ("PRINT_" + $printType + " OK status=" + $res.StatusCode + " body=" + $snippet)
    return $true
  } catch {
    $msg = $_.Exception.Message
    $status = $null
    try {
      $resp = $_.Exception.Response
      if ($resp) {
        $status = [int]$resp.StatusCode
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $b = $sr.ReadToEnd()
        if ($b) { $msg = $b }
      }
    } catch {}
    L ("PRINT_" + $printType + " FAIL status=" + $status + " msg=" + $msg)
    return $false
  }
}

$okBar = [bool](PostPedido "bar")
$okEnt = [bool](PostPedido "entrega")
L ("RESULT bar=" + $okBar + " entrega=" + $okEnt)
if ($okBar -and $okEnt) { L "SMOKE_OK"; exit 0 }
L "SMOKE_FAIL"
exit 1
