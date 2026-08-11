$ErrorActionPreference = "Continue"
Write-Output "=== CONFIG ==="
Get-Content "C:\ProgramData\MarginEngine\agent\config.json" -Raw
Write-Output "=== PROXY ==="
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:9100/api-proxy/actuator/health" -UseBasicParsing -TimeoutSec 10
  Write-Output ("PROXY_OK " + $r.StatusCode + " " + $r.Content.Substring(0, [Math]::Min(120, $r.Content.Length)))
} catch {
  Write-Output ("PROXY_FAIL " + $_.Exception.Message)
}
Write-Output "=== AGENT HEALTH ==="
try {
  $h = Invoke-WebRequest -Uri "http://127.0.0.1:9100/health" -UseBasicParsing -TimeoutSec 8
  Write-Output ("AGENT_OK " + $h.StatusCode)
} catch {
  Write-Output ("AGENT_FAIL " + $_.Exception.Message)
}
Write-Output "=== SMOKE BAR+ENTREGA ==="
$script = Join-Path $PSScriptRoot "live-smoke-pedido.ps1"
if (Test-Path $script) {
  & $script
} else {
  Write-Output "NO_SMOKE_SCRIPT"
}
