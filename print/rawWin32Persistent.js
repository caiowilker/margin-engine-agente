/**
 * Host PowerShell PERSISTENTE para RAW Win32.
 * Add-Type carrega UMA vez; jobs via stdin (JSON + base64).
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const log = require("../logger").child({ modulo: "raw_ps_host" });

let host = null;
let starting = null;

function hostWorkDir() {
  try {
    const { getDirectoryManager } = require("../runtime/directoryManager");
    const dm = getDirectoryManager();
    const dir = path.join(dm.dir("impressao"), "raw");
    dm.ensurePath(dir, "impressao/raw");
    return dir;
  } catch (_) {
    const dir = path.join(os.tmpdir(), "pdv-margin-raw");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

function buildHostScript(dllPath) {
  return `$ErrorActionPreference = 'Stop'
$asm = ${JSON.stringify(dllPath)}
if (-not (Test-Path -LiteralPath $asm)) { throw "DLL ausente: $asm" }
if (-not ("RawPrinterHelper" -as [type])) { Add-Type -Path $asm }
Write-Output "RAW_HOST_READY"
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq "") { continue }
  $swTotal = [System.Diagnostics.Stopwatch]::StartNew()
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $timings = [ordered]@{}
  function Mark([string]$name) {
    $timings[$name] = [int64]$sw.ElapsedMilliseconds
    $sw.Restart()
  }
  try {
    $req = $line | ConvertFrom-Json
    if ($req.op -eq "ping") {
      Write-Output "RAW_PONG"
      [Console]::Out.Flush()
      continue
    }
    $timings["AddType"] = 0
    $timings["backend"] = "persistent"
    $bytes = [Convert]::FromBase64String([string]$req.b64)
    $timings["bytes"] = $bytes.Length
    $timings["printer"] = [string]$req.printer
    Mark "Decode"
    $h = [IntPtr]::Zero
    if (-not [RawPrinterHelper]::OpenPrinter($req.printer, [ref]$h, [IntPtr]::Zero)) {
      throw "OpenPrinter falhou: $($req.printer)"
    }
    Mark "OpenPrinter"
    try {
      $di = New-Object RawPrinterHelper+DOCINFOA
      $di.pDocName = "PDV Cupom"
      $di.pDatatype = "RAW"
      if (-not [RawPrinterHelper]::StartDocPrinter($h, 1, $di)) { throw "StartDocPrinter falhou" }
      Mark "StartDocPrinter"
      try {
        if (-not [RawPrinterHelper]::StartPagePrinter($h)) { throw "StartPagePrinter falhou" }
        Mark "StartPagePrinter"
        $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $p, $bytes.Length)
        Mark "AllocCopy"
        $written = 0
        if (-not [RawPrinterHelper]::WritePrinter($h, $p, $bytes.Length, [ref]$written)) {
          throw "WritePrinter falhou"
        }
        $timings["written"] = [int64]$written
        Mark "WritePrinter"
        [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
        [RawPrinterHelper]::EndPagePrinter($h) | Out-Null
        Mark "EndPagePrinter"
      } finally {
        [RawPrinterHelper]::EndDocPrinter($h) | Out-Null
        Mark "EndDocPrinter"
      }
    } finally {
      [RawPrinterHelper]::ClosePrinter($h) | Out-Null
      Mark "ClosePrinter"
    }
    $timings["totalMs"] = [int64]$swTotal.ElapsedMilliseconds
    $json = ($timings | ConvertTo-Json -Compress)
    Write-Output ("RAW_TIMING_JSON:" + $json)
  } catch {
    Write-Output ("RAW_ERR:" + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
`;
}

function ensureHostScript(dllPath) {
  const dir = hostWorkDir();
  const scriptPath = path.join(dir, "pdv-margin-raw-host.ps1");
  const content = buildHostScript(dllPath);
  const ascii = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(content)
    ? content
    : content.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "-");
  let need = !fs.existsSync(scriptPath);
  if (!need) {
    try {
      if (fs.readFileSync(scriptPath, "utf8") !== "\uFEFF" + ascii) need = true;
    } catch (_) {
      need = true;
    }
  }
  if (need) fs.writeFileSync(scriptPath, "\uFEFF" + ascii, "utf8");
  return scriptPath;
}

function resolveDllPath(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  try {
    const core = require("./escpos/impressoraCore");
    const p = typeof core.rawHelperDllPath === "function" ? core.rawHelperDllPath() : null;
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  return path.join(hostWorkDir(), "RawPrinterHelper.dll");
}

async function ensureHost(dllPath) {
  if (host?.ready && host.child && !host.child.killed && host.child.exitCode == null) {
    return host;
  }
  if (starting) return starting;

  starting = (async () => {
    const dll = resolveDllPath(dllPath);
    if (!fs.existsSync(dll)) {
      const err = new Error("RawPrinterHelper.dll ausente para host persistente");
      err.code = "RAW_HELPER_MISSING";
      throw err;
    }
    if (host?.child) {
      try {
        host.child.kill();
      } catch (_) {}
      host = null;
    }

    const scriptPath = ensureHostScript(dll);
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );

    const state = {
      child,
      ready: false,
      dllPath: dll,
      queue: Promise.resolve(),
      buf: "",
      waiters: [],
    };

    const deliver = (line) => {
      const w = state.waiters.shift();
      if (w) w.resolve(line);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      state.buf += chunk;
      let idx;
      while ((idx = state.buf.indexOf("\n")) >= 0) {
        const line = state.buf.slice(0, idx).replace(/\r$/, "");
        state.buf = state.buf.slice(idx + 1);
        if (!state.ready && line.includes("RAW_HOST_READY")) {
          state.ready = true;
          continue;
        }
        if (line) deliver(line);
      }
    });

    child.stderr.on("data", (d) => {
      log.warn(
        { err: String(d).slice(0, 300), metric: "print.raw_ps_host_stderr" },
        "[RawPsHost] stderr",
      );
    });

    child.on("exit", (code, signal) => {
      log.warn(
        { code, signal, metric: "print.raw_ps_host_exit" },
        "[RawPsHost] saiu — recria no proximo job",
      );
      for (const w of state.waiters) w.reject(new Error("RAW PS host saiu"));
      state.waiters = [];
      if (host === state) host = null;
    });

    const readyTimeout = parseInt(process.env.PRINT_RAW_HOST_READY_MS || "15000", 10);
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (state.ready) {
          clearInterval(iv);
          resolve();
        } else if (Date.now() - t0 > readyTimeout) {
          clearInterval(iv);
          try {
            child.kill();
          } catch (_) {}
          reject(new Error("Timeout aguardando RAW_HOST_READY"));
        } else if (child.killed || child.exitCode != null) {
          clearInterval(iv);
          reject(new Error("RAW PS host morreu no boot"));
        }
      }, 20);
    });

    host = state;
    log.info({ dll, metric: "print.raw_ps_host_ready" }, "[RawPsHost] pronto (AddType 1x)");
    return host;
  })().finally(() => {
    starting = null;
  });

  return starting;
}

function readLine(state, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = state.waiters.indexOf(entry);
      if (idx >= 0) state.waiters.splice(idx, 1);
      reject(new Error("Timeout aguardando resposta do RAW PS host"));
    }, timeoutMs);
    const entry = {
      resolve: (line) => {
        clearTimeout(timer);
        resolve(line);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    };
    state.waiters.push(entry);
  });
}

async function writeRaw(printerName, buffer, opts = {}) {
  const state = await ensureHost(opts.dllPath);
  const timeoutMs =
    opts.timeoutMs ||
    parseInt(process.env.PRINTER_RAW_TIMEOUT_MS || "8000", 10) ||
    8000;

  const run = async () => {
    const payload =
      JSON.stringify({
        op: "print",
        printer: String(printerName),
        b64: Buffer.from(buffer).toString("base64"),
      }) + "\n";
    if (!state.child.stdin.writable) {
      throw new Error("RAW PS host stdin fechado");
    }
    state.child.stdin.write(payload);
    const line = await readLine(state, timeoutMs);
    if (line.startsWith("RAW_ERR:")) {
      const err = new Error(line.slice(8));
      err.code = "RAW_PS_HOST_ERR";
      throw err;
    }
    if (!line.startsWith("RAW_TIMING_JSON:")) {
      const err = new Error(`Resposta inesperada: ${line.slice(0, 120)}`);
      err.code = "RAW_PS_HOST_BAD_REPLY";
      throw err;
    }
    let timings = {};
    try {
      timings = JSON.parse(line.slice("RAW_TIMING_JSON:".length));
    } catch (_) {
      timings = { parseError: true };
    }
    timings.backend = "persistent";
    return { ok: true, backend: "persistent", timings };
  };

  const p = state.queue.then(run, run);
  state.queue = p.catch(() => {});
  return p;
}

async function warm(dllPath) {
  if (process.platform !== "win32") return false;
  try {
    await ensureHost(dllPath);
    return true;
  } catch (err) {
    log.warn({ err: err.message, metric: "print.raw_ps_host_warm_fail" }, "[RawPsHost] warm falhou");
    return false;
  }
}

function shutdown() {
  if (host?.child) {
    try {
      host.child.stdin.end();
      host.child.kill();
    } catch (_) {}
  }
  host = null;
}

function isReady() {
  return !!(host?.ready && host.child && host.child.exitCode == null);
}

module.exports = {
  writeRaw,
  warm,
  shutdown,
  isReady,
  ensureHost,
};
