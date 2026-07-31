# Diagnóstico RAW Win32 — mede onde o tempo vai nesta máquina.
# Uso (PowerShell Admin opcional):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose-raw-print.ps1
#   powershell ... -File scripts\diagnose-raw-print.ps1 -PrinterName "POSPrinter POS80"
#
# Interpretação:
#   WritePrinter / EndDocPrinter >> 1000ms  → spooler/driver/USB (abaixo do agente)
#   OpenPrinter lento              → fila/handle preso / outro processo na porta
#   Tudo < 200ms                   → problema não é Win32 RAW nesta hora (teste de novo sob carga)

param(
  [string]$PrinterName = "POSPrinter POS80"
)

$ErrorActionPreference = "Stop"
$bytes = [Text.Encoding]::ASCII.GetBytes("TESTE RAW`n123456789`n`n`n`n`n")

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawDiagHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDatatype;
  }
  [DllImport("winspool.drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
}
'@

$timings = [ordered]@{}
$sw = [Diagnostics.Stopwatch]::StartNew()
$total = [Diagnostics.Stopwatch]::StartNew()
function Mark([string]$name) {
  $ms = [int64]$sw.ElapsedMilliseconds
  $timings[$name] = $ms
  Write-Host ("{0,-20} {1,8} ms" -f $name, $ms)
  $sw.Restart()
}

Write-Host "=== diagnose-raw-print ==="
Write-Host "Printer: $PrinterName"
Write-Host "Bytes:   $($bytes.Length)"
Write-Host ""

$h = [IntPtr]::Zero
if (-not [RawDiagHelper]::OpenPrinter($PrinterName, [ref]$h, [IntPtr]::Zero)) {
  throw "OpenPrinter falhou para '$PrinterName' (GetLastError=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}
Mark "OpenPrinter"
try {
  $di = New-Object RawDiagHelper+DOCINFOA
  $di.pDocName = "PDV Diagnose RAW"
  $di.pDatatype = "RAW"
  if (-not [RawDiagHelper]::StartDocPrinter($h, 1, $di)) { throw "StartDocPrinter falhou" }
  Mark "StartDocPrinter"
  try {
    if (-not [RawDiagHelper]::StartPagePrinter($h)) { throw "StartPagePrinter falhou" }
    Mark "StartPagePrinter"
    $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $p, $bytes.Length)
    Mark "AllocCopy"
    $written = 0
    if (-not [RawDiagHelper]::WritePrinter($h, $p, $bytes.Length, [ref]$written)) { throw "WritePrinter falhou" }
    Mark "WritePrinter"
    Write-Host ("{0,-20} {1,8}" -f "written", $written)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
    [RawDiagHelper]::EndPagePrinter($h) | Out-Null
    Mark "EndPagePrinter"
  } finally {
    [RawDiagHelper]::EndDocPrinter($h) | Out-Null
    Mark "EndDocPrinter"
  }
} finally {
  [RawDiagHelper]::ClosePrinter($h) | Out-Null
  Mark "ClosePrinter"
}

$timings["totalMs"] = [int64]$total.ElapsedMilliseconds
Write-Host ""
Write-Host ("TOTAL {0} ms" -f $timings["totalMs"])
Write-Host ("RAW_TIMING_JSON:" + ($timings | ConvertTo-Json -Compress))

$slow = $timings.GetEnumerator() | Where-Object { $_.Key -notin @("totalMs") } | Sort-Object Value -Descending | Select-Object -First 1
if ($slow) {
  Write-Host ""
  Write-Host (">>> Etapa mais lenta: {0} = {1} ms" -f $slow.Key, $slow.Value)
  if ($slow.Value -ge 2000 -and $slow.Key -in @("WritePrinter","EndDocPrinter")) {
    Write-Host ">>> Conclusao: atraso abaixo do agente (spooler/driver/USB). Nao e bug de logica do PDV."
  } elseif ($slow.Value -ge 2000 -and $slow.Key -eq "OpenPrinter") {
    Write-Host ">>> Conclusao: fila/handle preso — feche ACBr Monitor / 2a instancia / utilitario do fabricante."
  }
}
