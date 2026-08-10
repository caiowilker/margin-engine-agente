// ============================================================
// PDV Margin Engine — Modulo Impressora Termica v5.0
//
// v5.0 — Auto-detect robusto (Windows + USB + Rede)
//   - Modo auto (padrao): tenta Windows spooler, rede TCP e USB
//   - Windows spooler RAW funciona como servico (LocalSystem)
//   - Detecta impressoras termicas por nome/porta
//   - Fallback em cadeia com cache de 30s
//   - Endpoints /impressora/listar e /impressora/detectar
// ============================================================

require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { execFile } = require("child_process");
const { killProcessTree } = require("../winProcessKill");

const log = require("../../logger").child({ modulo: "impressora_core" });
const escpos = require("escpos");
const escposCommands = require("escpos/commands");

/**
 * PATCH CRÍTICO — escpos@3.0.0-alpha.6 Printer.prototype.image
 *
 * Evidência (node_modules/escpos/index.js):
 *   bitmap.data.forEach(async (line) => {
 *     ...
 *     await new Promise((r) => setTimeout(r, 200)); // 200ms POR LINHA
 *   });
 *   return this.lineSpace();
 *
 * Problemas comprovados:
 * 1) forEach+async NÃO aguarda → Promise resolve em ~0ms, mas o API antigo
 *    usava callback que NUNCA é chamado (assinatura async (image, density)).
 *    imprimirLogoCupomEscpos envolvia callback → Promise pendente (hang).
 * 2) Se a espera for sequencial (for…of / versão antiga), altura≈720px /
 *    density 24 = 30 linhas × 200ms = 6000ms — casa com o pico de ~6,6s.
 * 3) Delay é para Serial física; MemoryDevice (gerarBuffer) NÃO precisa.
 *
 * Correção: escrita síncrona do bitmap, sem setTimeout, Promise+callback.
 */
(function patchEscposImageNoDelay() {
  const Image = escpos.Image;
  const _ = escposCommands;
  escpos.Printer.prototype.image = function patchedImage(image, density, callback) {
    if (typeof density === "function") {
      callback = density;
      density = "d24";
    }
    density = density || "d24";
    if (!(image instanceof Image)) {
      const err = new TypeError("Only escpos.Image supported");
      if (typeof callback === "function") {
        callback(err);
        return this;
      }
      return Promise.reject(err);
    }
    const n = !!~["d8", "s8"].indexOf(density) ? 1 : 3;
    const header = _.BITMAP_FORMAT["BITMAP_" + density.toUpperCase()];
    const bitmap = image.toBitmap(n * 8);
    this.lineSpace(0);
    for (let y = 0; y < bitmap.data.length; y++) {
      const line = bitmap.data[y];
      this.buffer.write(header);
      this.buffer.writeUInt16LE(line.length / n);
      this.buffer.write(line);
      this.buffer.write(_.EOL);
    }
    this.lineSpace();
    if (typeof callback === "function") {
      callback(null, this);
      return this;
    }
    return Promise.resolve(this);
  };
})();

let escposUSB;
let escposNetwork;
try {
  escposUSB = require("escpos-usb");
  escpos.USB = escposUSB;
} catch (_) {}
try {
  escposNetwork = require("escpos-network");
  escpos.Network = escposNetwork;
} catch (_) {}

const IS_WIN = process.platform === "win32";

/** Lê env dinamicamente — após Salvar no painel o processo NÃO reinicia. */
function printerType() {
  return (process.env.PRINTER_TYPE || "auto")
    .toLowerCase()
    .replace(/^winusb$/, "windows");
}
function printerHost() {
  const h = (process.env.PRINTER_HOST || "").trim();
  if (!h) return "";
  try {
    const { isValidTcpHost } = require("../printerModelMap");
    if (!isValidTcpHost(h)) return "";
  } catch (_) {
    if (/^\d+$/.test(h) && !h.includes(".")) return "";
  }
  return h;
}
function printerPortNum() {
  return parseInt(process.env.PRINTER_PORT || "9100", 10) || 9100;
}
function printerName() {
  return (process.env.PRINTER_NAME || "").trim();
}
function printerPath() {
  return (process.env.PRINTER_PATH || "").trim();
}

const TERMICA_RX =
  /elgin|bematech|daruma|tanca|jetway|thermal|tm-|mp-|i9|i7|pos\s*80|pos80|posprinter|cupom|nfce|receipt|termica|tm-t|tm-m|zebra|argox|godex|l42|zt\d|zd\d|gk\d|gc\d|gx\d|os\s*214|os214/i;
/** Jato/laser — ESC/POS RAW trava spooler ~2min e derruba o agente. */
const NAO_TERMICA_RX =
  /l4260|l3250|l3210|l1250|l3150|l4150|l5290|inkjet|deskjet|officejet|laserjet|ecosys|brother\s*hl|dcp-|mfc-|et-2|et-2[78]|workforce|stylus|pixma|onenote|microsoft\s*print\s*to\s*pdf|fax|xps|onenote|send\s*to\s*onenote|pdf|microsoft\s*xps|anydesk|snagit|adobe\s*pdf/i;

const REDE_PORTAS = [9100, 9101, 515];
/** Win10 Get-Printer é mais lento/instável — cache maior reduz oscilação no poll do PDV. */
const CACHE_TTL_MS = parseInt(process.env.PRINTER_WIN_LIST_CACHE_MS || "90000", 10);
const AGENT_PORT = parseInt(process.env.PORT || "9100", 10);
const IMPRIMIR_QR_NFCE =
  (process.env.IMPRIMIR_QR_NFCE ?? "true").toLowerCase() !== "false";
function qrNfceModuleSize() {
  const env = parseInt(process.env.IMPRIMIR_QR_NFCE_SIZE || "", 10);
  if (Number.isFinite(env) && env >= 3 && env <= 8) return env;
  try {
    return require("../thermalCols").suggestQrModuleSize();
  } catch {
    return 6;
  }
}

const { portalConsultaDocumento, isNfceModelo65, tituloCupomFiscal, tituloBlocoDocumentoFiscal, linhaNumeroSerieDocumento } = require("../../documentosFiscais");
const { normalizarCupomPayload, resolverQrCodeNfce, deveRelaxarQr } = require("../cupomValidate");

let cacheDescoberta = null;
let cacheDescobertaEm = 0;
let cacheImpressoraEscolhida = null;
let ultimaImpressoraUsada = null;
let printLock = Promise.resolve();
/** Cache em memória — raster ESC/POS pronto (rawBytes). Hot path NUNCA Image.load/toBitmap. */
let logoEscposImageCache = { key: null, image: null, rawBytes: null, paintedAt: 0 };

/** Single-flight warm — evita sharp/Add-Type competindo com o cupom. */
let _warmHotPathInflight = null;
let _warmGeneration = 0;
let _logoWarmScheduled = false;

/** Cache processo — hot path NÃO faz readFileSync/writeFileSync do .ps1 a cada cupom. */
let rawScriptCache = null;
let rawTmpFallbackWarned = false;

/**
 * Workdir RAW fora de C:\\Windows\\TEMP (LocalSystem + Defender costuma
 * segurar writeFileSync ~90–120s e congelar o event loop do agente).
 * Preferência: ProgramData\\MarginEngine\\impressao\\raw
 */
function rawWorkDir() {
  try {
    const { getDirectoryManager } = require("../../runtime/directoryManager");
    const dm = getDirectoryManager();
    const dir = path.join(dm.dir("impressao"), "raw");
    dm.ensurePath(dir, "impressao/raw");
    return dir;
  } catch (_) {
    const dir = path.join(os.tmpdir(), "pdv-margin-raw");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    if (!rawTmpFallbackWarned) {
      rawTmpFallbackWarned = true;
      log.warn(
        { dir, metric: "print.raw_workdir_tmpdir_fallback" },
        "[ImpressoraCore] Workdir RAW caiu em tmpdir — risco de lag por antivírus",
      );
    }
    return dir;
  }
}

function rawHelperDllPath() {
  return path.join(rawWorkDir(), "RawPrinterHelper.dll");
}

function rawPrintScriptPath() {
  return path.join(rawWorkDir(), "pdv-margin-raw-print.ps1");
}

function buildRawPrintScriptContent(dllPath) {
  return `$ErrorActionPreference = 'Stop'
$cfg = Get-Content -Raw $args[0] | ConvertFrom-Json
$bytes = [System.IO.File]::ReadAllBytes($cfg.file)
$timings = [ordered]@{
  bytes = $bytes.Length
  printer = [string]$cfg.printer
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$total = [System.Diagnostics.Stopwatch]::StartNew()
function Mark([string]$name) {
  $timings[$name] = [int64]$sw.ElapsedMilliseconds
  $sw.Restart()
}
$asm = ${JSON.stringify(dllPath)}
if (-not ("RawPrinterHelper" -as [type])) {
  if (-not (Test-Path -LiteralPath $asm)) {
    throw "RawPrinterHelper.dll ausente - aquecimento em andamento (nao compilar no cupom)"
  }
  Add-Type -Path $asm
}
Mark 'AddType'
$h = [IntPtr]::Zero
if (-not [RawPrinterHelper]::OpenPrinter($cfg.printer, [ref]$h, [IntPtr]::Zero)) {
  throw "Nao foi possivel abrir a impressora: $($cfg.printer)"
}
Mark 'OpenPrinter'
try {
  $di = New-Object RawPrinterHelper+DOCINFOA
  $di.pDocName = "PDV Cupom"
  $di.pDatatype = "RAW"
  if (-not [RawPrinterHelper]::StartDocPrinter($h, 1, $di)) { throw "StartDocPrinter falhou" }
  Mark 'StartDocPrinter'
  try {
    if (-not [RawPrinterHelper]::StartPagePrinter($h)) { throw "StartPagePrinter falhou" }
    Mark 'StartPagePrinter'
    $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $p, $bytes.Length)
    Mark 'AllocCopy'
    $written = 0
    if (-not [RawPrinterHelper]::WritePrinter($h, $p, $bytes.Length, [ref]$written)) { throw "WritePrinter falhou" }
    $timings['written'] = [int64]$written
    Mark 'WritePrinter'
    [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
    [RawPrinterHelper]::EndPagePrinter($h) | Out-Null
    Mark 'EndPagePrinter'
  } finally {
    [RawPrinterHelper]::EndDocPrinter($h) | Out-Null
    Mark 'EndDocPrinter'
  }
} finally {
  [RawPrinterHelper]::ClosePrinter($h) | Out-Null
  Mark 'ClosePrinter'
}
$timings['totalMs'] = [int64]$total.ElapsedMilliseconds
$json = ($timings | ConvertTo-Json -Compress)
Write-Output ("RAW_TIMING_JSON:" + $json)
Remove-Item $cfg.file -Force -ErrorAction SilentlyContinue
`;
}

/**
 * Garante script PowerShell no workdir ProgramData.
 * Após a 1ª vez no processo, retorna cache em memória (zero I/O sync no cupom).
 * Regrava se o conteúdo mudou (ex.: proibir Add-Type no cupom).
 */
function ensureRawPrintScript() {
  if (!IS_WIN) return null;
  if (rawScriptCache) return rawScriptCache;
  try {
    const dir = rawWorkDir();
    const scriptPath = rawPrintScriptPath();
    const dllPath = rawHelperDllPath();
    const content = buildRawPrintScriptContent(dllPath);
    let needWrite = !fs.existsSync(scriptPath);
    if (!needWrite) {
      try {
        const existing = fs.readFileSync(scriptPath, "utf8");
        // Marcador de versão — evita Add-Type inline no hot path (AV 15–20s).
        if (!existing.includes("nao compilar no cupom") || existing !== content) {
          needWrite = true;
        }
      } catch (_) {
        needWrite = true;
      }
    }
    if (needWrite) {
      // ASCII-only + UTF-8 BOM: Windows PowerShell 5.1 sem BOM quebra em dash Unicode
      // (ParserError no throw) e mata TODA impressão RAW de venda.
      const ascii =
        /^[\x09\x0a\x0d\x20-\x7e]*$/.test(content)
          ? content
          : content.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "-");
      fs.writeFileSync(scriptPath, "\uFEFF" + ascii, "utf8");
    }
    rawScriptCache = { dir, scriptPath, dllPath };
    return rawScriptCache;
  } catch (err) {
    log.warn(
      { err: err?.message, metric: "print.raw_script_ensure_fail" },
      "[ImpressoraCore] Falha ao garantir script RAW",
    );
    return null;
  }
}

function resetRawScriptCacheForTests() {
  rawScriptCache = null;
  rawTmpFallbackWarned = false;
}

if (IS_WIN) {
  try {
    ensureRawPrintScript();
  } catch (_) {}
}

/** Pré-compila RawPrinterHelper.dll (fire-and-forget) — cupons seguintes sem AddType lento. */
function warmRawWin32Helper() {
  if (!IS_WIN) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // AV/TEMP neste parque: Add-Type pode levar 15–20s. Não bloquear boot/fila.
    const hardCapMs = parseInt(process.env.PRINT_RAW_WARM_TIMEOUT_MS || "5000", 10);
    const capTimer = setTimeout(() => {
      log.warn(
        { hardCapMs, metric: "print.raw_helper_warm_timeout" },
        "[ImpressoraCore] warm RawPrinterHelper excedeu orçamento — segue sem bloquear",
      );
      finish(false);
    }, Math.max(1000, hardCapMs));
    try {
      ensureRawPrintScript();
      const dllPath = rawHelperDllPath();
      if (fs.existsSync(dllPath)) {
        clearTimeout(capTimer);
        finish(true);
        return;
      }
      fs.mkdirSync(path.dirname(dllPath), { recursive: true });
      const child = execFile(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `$asm=${JSON.stringify(dllPath)}; if (Test-Path -LiteralPath $asm) { exit 0 }; $dir=Split-Path -Parent $asm; New-Item -ItemType Directory -Force -Path $dir | Out-Null; Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class RawPrinterHelper {
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
'@ -OutputAssembly $asm`,
        ],
        { windowsHide: true, timeout: Math.max(1000, hardCapMs) },
        (err) => {
          clearTimeout(capTimer);
          if (err) {
            log.debug({ err: err.message }, "[ImpressoraCore] warm RawPrinterHelper falhou");
            finish(false);
          } else {
            log.info(
              { dll: dllPath, metric: "print.raw_helper_warm" },
              "[ImpressoraCore] RawPrinterHelper.dll pré-compilada",
            );
            finish(true);
          }
        },
      );
      child.on("error", () => {
        clearTimeout(capTimer);
        finish(false);
      });
    } catch (_) {
      clearTimeout(capTimer);
      finish(false);
    }
  });
}

function parseRawTimingFromStdout(stdout) {
  const text = String(stdout || "");
  const m = /RAW_TIMING_JSON:(\{[\s\S]*\})/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

function logRawWin32Timing(timings, meta = {}) {
  if (!timings || typeof timings !== "object") return;
  const steps = [
    "AddType",
    "OpenPrinter",
    "StartDocPrinter",
    "StartPagePrinter",
    "AllocCopy",
    "WritePrinter",
    "EndPagePrinter",
    "EndDocPrinter",
    "ClosePrinter",
  ];
  let slowest = null;
  let slowestMs = -1;
  for (const k of steps) {
    const ms = Number(timings[k]);
    if (Number.isFinite(ms) && ms > slowestMs) {
      slowestMs = ms;
      slowest = k;
    }
  }
  const payload = {
    metric: "print.raw_win32_timing",
    ...timings,
    slowest,
    slowestMs,
    ...meta,
  };
  const level = slowestMs >= 2000 ? "warn" : "info";
  log[level](
    payload,
    `[ImpressoraCore] RAW Win32 timing — slowest=${slowest || "?"} ${slowestMs}ms total=${timings.totalMs || "?"}ms`,
  );
}

function printCoreLockWaitMs() {
  return Math.max(
    500,
    parseInt(process.env.PRINT_CORE_LOCK_WAIT_MS || "4000", 10) || 4000,
  );
}

/**
 * Serializa impressões nativas. Se a fila interna exceder o orçamento,
 * falha sem disparar segundo envio físico (anti-dupla / anti-hang ~2min).
 */
function comLockImpressao(fn) {
  const waitMs = printCoreLockWaitMs();
  const tEnter = Date.now();
  const run = printLock.then(async () => {
    const waitedMs = Date.now() - tEnter;
    if (waitedMs > waitMs) {
      const err = new Error(
        `Timeout aguardando fila de impressão (${waitMs}ms; esperou ${waitedMs}ms)`,
      );
      err.code = "PRINT_LOCK_WAIT_TIMEOUT";
      err.printTimedOut = true;
      log.warn(
        { waitedMs, waitMs, metric: "print.core_lock_wait_timeout" },
        "[ImpressoraCore] Lock interno esgotado — sem envio",
      );
      throw err;
    }
    if (waitedMs > 200) {
      log.info(
        { waitedMs, metric: "print.core_lock_wait" },
        "[ImpressoraCore] Esperou lock interno de impressão",
      );
    }
    return fn();
  });
  printLock = run.catch(() => {});
  return run;
}

// ── Device em memoria (gera buffer ESC/POS) ───────────────────────────────────
class MemoryDevice {
  constructor() {
    this._chunks = [];
    this.buffer = Buffer.alloc(0);
    this._open = false;
  }

  open(cb) {
    this._open = true;
    this._chunks = [];
    this.buffer = Buffer.alloc(0);
    cb(null);
  }

  write(data, cb) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this._chunks.push(chunk);
    if (cb) cb(null);
  }

  /** Consolida chunks uma vez — evita Buffer.concat O(n²) por write no cupom. */
  getBuffer() {
    if (this._chunks.length === 0) {
      this.buffer = Buffer.alloc(0);
      return this.buffer;
    }
    if (this._chunks.length === 1) {
      this.buffer = this._chunks[0];
      return this.buffer;
    }
    this.buffer = Buffer.concat(this._chunks);
    this._chunks = [this.buffer];
    return this.buffer;
  }

  close(cb) {
    this._open = false;
    this.getBuffer();
    if (cb) cb(null);
  }
}

function gerarBuffer(renderFn) {
  return new Promise((resolve, reject) => {
    const device = new MemoryDevice();
    device.open((err) => {
      if (err) return reject(err);
      const printer = new escpos.Printer(device, { encoding: "CP860" });
      const finalizar = () => {
        const done = () =>
          device.close(() => resolve(device.getBuffer()));
        if (typeof printer.close === "function") {
          printer.close(done);
        } else {
          done();
        }
      };
      try {
        const outcome = renderFn(printer);
        if (outcome && typeof outcome.then === "function") {
          outcome.then(finalizar).catch((e) => {
            try {
              device.close();
            } catch (_) {}
            reject(e);
          });
        } else {
          finalizar();
        }
      } catch (e) {
        try {
          device.close();
        } catch (_) {}
        reject(e);
      }
    });
  });
}

// ── Listar impressoras Windows ────────────────────────────────────────────────
function listarPrintersTimeoutMs() {
  return parseInt(process.env.PRINTER_LIST_TIMEOUT_MS || "5000", 10) || 5000;
}
function rawPrintTimeoutMs() {
  return parseInt(process.env.PRINTER_RAW_TIMEOUT_MS || "4000", 10) || 4000;
}
/** Após soft kill: segura o Promise (e physicalLock) até filho morrer ou este teto. */
function rawKillHoldMs() {
  return Math.max(
    1000,
    parseInt(process.env.PRINTER_RAW_KILL_HOLD_MS || "4000", 10) || 4000,
  );
}

function makeRawTimeoutError(nomeImpressora) {
  const err = new Error(
    `RAW Windows timeout (${rawPrintTimeoutMs()}ms): ${nomeImpressora}`,
  );
  err.code = "RAW_PRINT_TIMEOUT";
  err.printTimedOut = true;
  return err;
}
let printersWinCache = { list: [], at: 0 };
let printersWinInflight = null;

/**
 * Lista impressoras Windows sem congelar o event loop.
 * Single-flight + cache 30s — Get-Printer via execFile (nunca execFileSync).
 * Sob impressão / physicalLock: só cache (evita taskkill competindo com RAW/USB).
 */
function listagemWindowsBloqueada() {
  try {
    const pjs = require("../printJobService");
    if (typeof pjs.impressaoEmAndamento === "function" && pjs.impressaoEmAndamento()) {
      return true;
    }
  } catch (_) {}
  try {
    const physical = require("../../runtime/physicalResourceLock");
    const map = require("../../runtime/physicalResourceMap");
    if (physical.isHeld(map.resolvePosprinterKey())) return true;
  } catch (_) {}
  try {
    const { physicalSendAbandonedInFlight } = require("../printExecutor");
    if (
      typeof physicalSendAbandonedInFlight === "function" &&
      physicalSendAbandonedInFlight()
    ) {
      return true;
    }
  } catch (_) {}
  return false;
}

function listarImpressorasWindowsAsync(force = false) {
  if (!IS_WIN) return Promise.resolve([]);
  // Sempre respeitar lock — force=true durante RAW compete com spooler (hang).
  if (listagemWindowsBloqueada()) {
    return Promise.resolve(printersWinCache.list);
  }
  const agora = Date.now();
  if (
    !force &&
    printersWinCache.at > 0 &&
    agora - printersWinCache.at < CACHE_TTL_MS
  ) {
    return Promise.resolve(printersWinCache.list);
  }
  if (printersWinInflight) return printersWinInflight;

  printersWinInflight = new Promise((resolve) => {
    let settled = false;
    const finish = (list) => {
      if (settled) return;
      settled = true;
      printersWinInflight = null;
      clearTimeout(softKill);
      clearTimeout(hardKill);
      resolve(list);
    };

    const child = execFile(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-Printer | Select-Object Name,PortName,DriverName,Default | ConvertTo-Json -Compress",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
      (err, raw) => {
        if (settled) return;
        if (err) {
          return finish(printersWinCache.list);
        }
        try {
          const parsed = JSON.parse(raw || "[]");
          const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
          printersWinCache = { list, at: Date.now() };
          finish(list);
        } catch (_) {
          finish(printersWinCache.list);
        }
      },
    );

    const softKill = setTimeout(() => {
      void killProcessTree(child.pid, {
        reason: "list_printers_soft",
        metric: "print.list_printers_taskkill",
      });
      try {
        child.kill();
      } catch (_) {}
      finish(printersWinCache.list);
    }, listarPrintersTimeoutMs());
    const hardKill = setTimeout(() => {
      void killProcessTree(child.pid, {
        reason: "list_printers_hard",
        metric: "print.list_printers_taskkill",
      });
    }, listarPrintersTimeoutMs() + 1500);
  });
  return printersWinInflight;
}

/** Somente cache — nunca bloqueia. Usado em listar() síncrono. */
function listarImpressorasWindowsCached() {
  return printersWinCache.list;
}

/** @deprecated use listarImpressorasWindowsAsync — sync só devolve cache */
function listarImpressorasWindows() {
  return listarImpressorasWindowsCached();
}

/** Porta ACBr persistida válida (INI = SSOT). */
function resolverPortaAcbrConfigurada() {
  try {
    const { portaAcbrValida } = require("../printerModelMap");
    const porta = String(
      require("../printerLocalConfig").ler()?.porta ||
        process.env.PRINTER_PORTA ||
        "",
    ).trim();
    if (portaAcbrValida(porta)) return porta;
  } catch (_) {
    /* ignore */
  }
  return null;
}

/** Nome Windows da porta RAW configurada (PRINTER_PORTA / local config). */
function resolverNomeRawConfigurado() {
  const porta = resolverPortaAcbrConfigurada();
  if (porta) {
    const m = /^RAW:(.+)$/i.exec(porta);
    if (m && m[1].trim()) return m[1].trim();
    return null; // TCP/COM configurado — não misturar com RAW genérico
  }
  if (printerName()) return printerName();
  return null;
}

function invalidateDiscoveryCache() {
  cacheDescoberta = null;
  cacheDescobertaEm = 0;
  cacheImpressoraEscolhida = null;
}

/** Pré-aquece DLL Win32 + logo ESC/POS — cupom seguinte perto de instantâneo. */
function isPrintHotPathReady() {
  if (IS_WIN) {
    try {
      if (!fs.existsSync(rawHelperDllPath())) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

function isWarmHotPathInFlight() {
  return !!_warmHotPathInflight;
}

function impressaoEmAndamentoLocal() {
  try {
    const pjs = require("../printJobService");
    if (typeof pjs.impressaoEmAndamento === "function" && pjs.impressaoEmAndamento()) {
      return true;
    }
  } catch (_) {}
  try {
    const physical = require("../../runtime/physicalResourceLock");
    const map = require("../../runtime/physicalResourceMap");
    if (physical.isHeld(map.resolvePosprinterKey())) return true;
  } catch (_) {}
  return false;
}

function scheduleLogoWarmOnce() {
  if (_logoWarmScheduled || _warmHotPathInflight) return;
  if (impressaoEmAndamentoLocal()) return;
  _logoWarmScheduled = true;
  setImmediate(() => {
    _logoWarmScheduled = false;
    if (impressaoEmAndamentoLocal()) return;
    warmPrintHotPath().catch(() => {});
  });
}

async function warmPrintHotPath(opts = {}) {
  if (_warmHotPathInflight) return _warmHotPathInflight;
  if (!opts.force && impressaoEmAndamentoLocal()) {
    return { rawHelper: false, logo: false, skipped: "printing" };
  }
  if (!opts.force && isPrintHotPathReady() && logoEscposImageCache.rawBytes) {
    // Ainda aquece host persistente / koffi se ainda não estiver pronto
    if (process.platform === "win32") {
      setImmediate(() => {
        try {
          require("../rawWinspoolNative").isAvailable();
        } catch (_) {}
        require("../rawWin32Persistent")
          .warm(rawHelperDllPath())
          .catch(() => {});
      });
    }
    return { rawHelper: true, logo: true, skipped: "already_warm" };
  }

  const gen = ++_warmGeneration;
  const out = { rawHelper: false, logo: false, koffi: false, persistent: false };
  const budgetMs = parseInt(
    process.env.PRINT_HOTPATH_WARM_BUDGET_MS ||
      process.env.PRINT_RAW_WARM_TIMEOUT_MS ||
      "5000",
    10,
  );

  const work = Promise.all([
    warmRawWin32Helper()
      .then((v) => {
        if (gen === _warmGeneration) out.rawHelper = !!v;
      })
      .catch(() => {}),
    Promise.resolve()
      .then(() => {
        if (process.platform !== "win32") return false;
        try {
          return require("../rawWinspoolNative").isAvailable();
        } catch (_) {
          return false;
        }
      })
      .then((v) => {
        if (gen === _warmGeneration) out.koffi = !!v;
      })
      .catch(() => {}),
    Promise.resolve()
      .then(async () => {
        if (process.platform !== "win32") return false;
        // Host persistente: AddType 1x antes do 1º cupom
        return require("../rawWin32Persistent").warm(rawHelperDllPath());
      })
      .then((v) => {
        if (gen === _warmGeneration) out.persistent = !!v;
      })
      .catch(() => {}),
    Promise.resolve()
      .then(() => {
        // Não iniciar sharp se o cupom já pegou a impressora.
        if (impressaoEmAndamentoLocal()) return false;
        return require("../printerLogo").warmLogoEscpos();
      })
      .then((v) => {
        if (gen === _warmGeneration) out.logo = !!v;
      })
      .catch(() => {}),
  ]);

  _warmHotPathInflight = Promise.race([
    work,
    new Promise((r) => setTimeout(r, Math.max(1000, budgetMs))),
  ])
    .then(() => {
      if (out.rawHelper || out.logo || out.koffi || out.persistent) {
        log.info({ ...out, metric: "print.hot_path_warm" }, "[ImpressoraCore] Hot-path aquecido");
      }
      return out;
    })
    .finally(() => {
      _warmHotPathInflight = null;
    });

  return _warmHotPathInflight;
}

function escolherImpressoraWindows(lista) {
  if (!lista.length) return null;

  const usaveis = lista.filter(
    (p) => !pareceNaoTermica(p.Name || "") && !pareceNaoTermica(p.DriverName || ""),
  );

  // 1. Busca por nome exato ou parcial (PRINTER_NAME) — só se não for jato/virtual
  if (printerName()) {
    const pool = usaveis.length ? usaveis : lista;
    const exata = pool.find(
      (p) => p.Name && p.Name.toLowerCase() === printerName().toLowerCase(),
    );
    if (exata && !pareceNaoTermica(exata.Name)) return exata;
    const parcial = pool.find(
      (p) =>
        p.Name && p.Name.toLowerCase().includes(printerName().toLowerCase()),
    );
    if (parcial && !pareceNaoTermica(parcial.Name)) return parcial;
  }

  // 2. Busca pela porta física (PRINTER_PATH: USB001, USB002, COM3...)
  if (printerPath()) {
    const porta = usaveis.find(
      (p) =>
        p.PortName && p.PortName.toLowerCase() === printerPath().toLowerCase(),
    );
    if (porta) return porta;
  }

  // Só térmicas reais — NÃO promover L4260/OneNote/PDF via PortName USB/WSD
  const termicas = usaveis.filter(
    (p) =>
      TERMICA_RX.test(p.Name || "") || TERMICA_RX.test(p.DriverName || ""),
  );
  if (termicas.length) return termicas[0];

  const padrao = usaveis.find((p) => p.Default);
  if (padrao && TERMICA_RX.test(padrao.Name || "")) return padrao;

  // Sem térmica: não inventar porta (evita gravar OneNote/L4260 e derrubar o agente)
  return null;
}

function pareceNaoTermica(nome) {
  const n = String(nome || "");
  if (!n) return false;
  if (TERMICA_RX.test(n)) return false;
  return NAO_TERMICA_RX.test(n);
}

function assertPortaTermicaOuFalhar(nomeImpressora) {
  if (!pareceNaoTermica(nomeImpressora)) return;
  const err = new Error(
    `Impressora "${nomeImpressora}" não é térmica ESC/POS (jato/laser). ` +
      `Configure a POS80/térmica neste PC ou use TCP:IP:9100. ` +
      `Enviar RAW nesta impressora trava o spooler (~2 min) e deixa o agente Offline.`,
  );
  err.code = "PRINTER_NOT_THERMAL";
  err.permanente = true;
  throw err;
}

/**
 * Envia bytes RAW via spooler Windows.
 * IMPORTANTE: async (execFile) — execFileSync bloqueava o event loop do agente
 * quando WritePrinter/spooler demorava (sintoma: cupom ~140s + AbortError no front).
 * Sob physicalLock (mesma key da PosPrinter) — mesmo cabo USB/spooler.
 */
function physicalLockWaitMs() {
  return Math.max(
    500,
    parseInt(process.env.PRINT_PHYSICAL_LOCK_WAIT_MS || "4000", 10) || 4000,
  );
}

function enviarRawWindows(nomeImpressora, buffer) {
  const physical = require("../../runtime/physicalResourceLock");
  const map = require("../../runtime/physicalResourceMap");
  return physical.run(
    map.resolvePosprinterKey(),
    () => enviarRawWindowsUnlocked(nomeImpressora, buffer),
    "native-raw",
    { waitMs: physicalLockWaitMs() },
  );
}

/** Backend RAW: koffi (preferido) | persistent | spawn (legado). */
function resolveRawBackend() {
  const v = String(process.env.PRINT_RAW_BACKEND || "auto").toLowerCase();
  if (v === "koffi" || v === "native") return "koffi";
  if (v === "persistent" || v === "host" || v === "ps-host") return "persistent";
  if (v === "spawn" || v === "powershell" || v === "legacy") return "spawn";
  return "auto";
}

/**
 * Fast path: WinSpool in-process (koffi) ou PowerShell persistente.
 * Elimina spawn + AddType por cupom (causa dos 0.8–3.7s em produção).
 * @returns {Promise<object|null>} null = caller deve usar spawn legado
 */
async function enviarRawWindowsFast(nomeImpressora, buffer) {
  const mode = resolveRawBackend();
  if (mode === "spawn") return null;

  const phaseT0 = Date.now();
  const tryKoffi = mode === "koffi" || mode === "auto";
  const tryPersistent = mode === "persistent" || mode === "auto";

  if (tryKoffi) {
    try {
      const native = require("../rawWinspoolNative");
      if (native.isAvailable()) {
        const tSend = Date.now();
        const result = native.writeRaw(nomeImpressora, buffer);
        const sendMs = Date.now() - tSend;
        logRawWin32Timing(result.timings, {
          printer: nomeImpressora,
          killed: false,
          err: null,
          stderr: null,
        });
        log.info(
          {
            metric: "print.raw_phase",
            backend: "koffi",
            printer: nomeImpressora,
            writeTmpMs: 0,
            preSpawnMs: Date.now() - phaseT0,
            sendMs,
            bytes: buffer.length,
            totalMs: result.timings?.totalMs,
          },
          "[ImpressoraCore] RAW koffi WinSpool (sem PowerShell)",
        );
        if (sendMs > 200) {
          log.warn(
            {
              metric: "print.raw_stage_slow",
              stage: "koffi_send",
              sendMs,
              thresholdMs: 200,
              printer: nomeImpressora,
            },
            "[ImpressoraCore] RAW etapa >200ms",
          );
        }
        return { ok: true, backend: "koffi", timings: result.timings, sendMs };
      }
    } catch (err) {
      if (mode === "koffi") throw err;
      log.warn(
        {
          err: err.message,
          code: err.code,
          metric: "print.raw_koffi_fallback",
        },
        "[ImpressoraCore] koffi falhou — tentando host persistente",
      );
    }
  }

  if (tryPersistent) {
    try {
      const paths = ensureRawPrintScript();
      const dllPath = paths?.dllPath || rawHelperDllPath();
      const host = require("../rawWin32Persistent");
      const tSend = Date.now();
      const result = await host.writeRaw(nomeImpressora, buffer, {
        dllPath,
        timeoutMs: rawPrintTimeoutMs(),
      });
      const sendMs = Date.now() - tSend;
      if (result.timings) {
        logRawWin32Timing(result.timings, {
          printer: nomeImpressora,
          killed: false,
          err: null,
          stderr: null,
        });
      }
      log.info(
        {
          metric: "print.raw_phase",
          backend: "persistent",
          printer: nomeImpressora,
          writeTmpMs: 0,
          preSpawnMs: Date.now() - phaseT0,
          sendMs,
          bytes: buffer.length,
          addTypeMs: result.timings?.AddType ?? 0,
          totalMs: result.timings?.totalMs,
        },
        "[ImpressoraCore] RAW PowerShell persistente (AddType 1x)",
      );
      if ((result.timings?.AddType || 0) > 50) {
        log.warn(
          {
            metric: "print.raw_addtype_unexpected",
            addTypeMs: result.timings.AddType,
            note: "Host deveria ter AddType=0 apos warm",
          },
          "[ImpressoraCore] AddType lento no host persistente",
        );
      }
      return { ok: true, backend: "persistent", timings: result.timings, sendMs };
    } catch (err) {
      if (mode === "persistent") throw err;
      log.warn(
        {
          err: err.message,
          code: err.code,
          metric: "print.raw_persistent_fallback",
        },
        "[ImpressoraCore] host persistente falhou — spawn legado",
      );
    }
  }

  return null;
}

async function enviarRawWindowsUnlocked(nomeImpressora, buffer) {
  assertPortaTermicaOuFalhar(nomeImpressora);

  const fast = await enviarRawWindowsFast(nomeImpressora, buffer);
  if (fast) return true;

  // ── Legado: spawn PowerShell por job (lento — só fallback) ──
  const phaseT0 = Date.now();
  const paths = ensureRawPrintScript();
  const workDir = paths?.dir || rawWorkDir();
  const scriptPath = paths?.scriptPath || rawPrintScriptPath();
  const dllPath = paths?.dllPath || rawHelperDllPath();

  // Nunca Add-Type no PowerShell do cupom — se DLL faltar, tenta warm curto e falha rápido.
  if (IS_WIN && dllPath && !fs.existsSync(dllPath)) {
    log.warn(
      { dllPath, metric: "print.raw_dll_missing_before_send" },
      "[ImpressoraCore] RawPrinterHelper.dll ausente — warm curto antes do envio",
    );
    await Promise.race([
      warmRawWin32Helper(),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (!fs.existsSync(dllPath)) {
      const err = new Error(
        "RawPrinterHelper.dll ausente — aquecimento incompleto (AV/TEMP). Tente novamente em alguns segundos.",
      );
      err.code = "RAW_HELPER_MISSING";
      err.retryable = true;
      // Continua warm em background para o próximo job da fila.
      setImmediate(() => {
        warmRawWin32Helper().catch(() => {});
      });
      throw err;
    }
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpBin = path.join(workDir, `pdv-print-${id}.bin`);
  const tmpCfg = path.join(workDir, `pdv-print-${id}.json`);

  // Async — nunca writeFileSync no hot path (Defender em TEMP congelava ~112s).
  const tWrite = Date.now();
  await fs.promises.writeFile(tmpBin, buffer);
  await fs.promises.writeFile(
    tmpCfg,
    JSON.stringify({ printer: nomeImpressora, file: tmpBin }),
    "utf8",
  );
  const writeTmpMs = Date.now() - tWrite;
  if (writeTmpMs > 500) {
    log.warn(
      {
        writeTmpMs,
        workDir,
        bytes: buffer.length,
        metric: "print.raw_tmp_write_slow",
      },
      "[ImpressoraCore] Escrita tmp RAW lenta — verifique antivírus em ProgramData/impressao",
    );
  }

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let settled = false;
    let killRequested = false;
    let lastKill = null;
    let childExited = false;
    let filesCleaned = false;
    let softKill;
    let hardKill;
    let holdKill;
    let leakGuard;

    const cleanupFiles = () => {
      if (filesCleaned) return;
      filesCleaned = true;
      // Async — unlinkSync sob AV congelava o event loop após cada cupom.
      void fs.promises.unlink(tmpCfg).catch(() => {});
      void fs.promises.unlink(tmpBin).catch(() => {});
    };

    const clearKillTimers = () => {
      clearTimeout(softKill);
      clearTimeout(hardKill);
      clearTimeout(holdKill);
    };

    /**
     * Libera a Promise (e o physicalLock externo) só quando seguro o bastante:
     * filho saiu, kill confirmou morte do wrapper, ou teto KILL_HOLD esgotou.
     */
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearKillTimers();
      clearTimeout(leakGuard);
      cleanupFiles();
      fn(val);
    };

    const finishTimeout = () => finish(reject, makeRawTimeoutError(nomeImpressora));

    /**
     * P2a: mata wrapper com confirmação. Soft timeout NÃO rejeita na hora —
     * senão o physicalLock libera com WritePrinter/spooler ainda ativos.
     */
    const requestKill = (reason) => {
      killRequested = true;
      const pid = child.pid;
      try {
        child.kill();
      } catch (_) {}
      void killProcessTree(pid, {
        reason,
        metric: "print.taskkill_attempt",
      }).then((result) => {
        lastKill = result;
        if (result.stillAlive) {
          log.error(
            {
              metric: "print.taskkill_still_alive",
              pid,
              reason,
              printer: nomeImpressora,
              durationMs: Date.now() - t0,
            },
            "[ImpressoraCore] RAW — PowerShell ainda vivo após taskkill",
          );
          return;
        }
        // Wrapper morto: libera lock cedo (spooler pode continuar drenando sozinho).
        if (!settled && !childExited) {
          log.warn(
            {
              metric: "print.raw_kill_confirmed_release",
              reason,
              pid,
              durationMs: Date.now() - t0,
              printer: nomeImpressora,
              holdMs: rawKillHoldMs(),
              note: "wrapper morto — libera physicalLock; papel tardio ainda possível via spooler",
            },
            "[ImpressoraCore] RAW kill confirmado — liberando Promise/lock",
          );
          finishTimeout();
        }
      });
    };

    log.warn(
      {
        metric: "print.raw_phase",
        backend: "spawn",
        printer: nomeImpressora,
        workDir,
        writeTmpMs,
        preSpawnMs: Date.now() - phaseT0,
        bytes: buffer.length,
        note: "LEGADO — spawn PowerShell por job (lento); preferir koffi/persistent",
      },
      "[ImpressoraCore] RAW spawn PowerShell (fallback legado)",
    );

    const child = execFile(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        tmpCfg,
      ],
      { windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        const timings = parseRawTimingFromStdout(stdout);
        if (timings) {
          logRawWin32Timing(timings, {
            printer: nomeImpressora,
            killed: killRequested,
            err: err ? String(err.message || err).slice(0, 200) : null,
            stderr: stderr ? String(stderr).slice(0, 300) : null,
          });
        }
        // Callback de conclusão; 'exit' cuida de métricas/finish principal.
        if (settled) return;
        if (!err && !killRequested) {
          finish(resolve, true);
          return;
        }
        if (err && !killRequested) {
          const timedOut =
            err.killed ||
            /SIGKILL|SIGTERM|ETIMEDOUT|timeout|taskkill/i.test(
              String(err.signal || "") + String(err.message || ""),
            );
          if (timedOut) return finishTimeout();
          return finish(
            reject,
            new Error(`RAW Windows falhou: ${err.message}`),
          );
        }
        // killRequested: finishTimeout via exit / kill confirm / hold
      },
    );

    child.on("exit", (code, signal) => {
      childExited = true;
      clearTimeout(leakGuard);
      const durationMs = Date.now() - t0;
      const late =
        killRequested && durationMs > rawPrintTimeoutMs() + 500;
      const level = late ? "warn" : "info";
      log[level](
        {
          metric: "print.child_exit",
          code,
          signal: signal || null,
          wasKilled: killRequested,
          killConfirmedDead: lastKill ? lastKill.confirmedDead : null,
          killStillAliveAtAttempt: lastKill ? lastKill.stillAlive : null,
          durationMs,
          settledAlready: settled,
          late,
          printer: nomeImpressora,
          note: late
            ? "wrapper saiu após kill — spooler/driver pode ter drenado sozinho (papel tardio)"
            : undefined,
        },
        late
          ? "[ImpressoraCore] RAW child_exit tardio após kill"
          : "[ImpressoraCore] RAW child_exit",
      );
      if (settled) {
        cleanupFiles();
        return;
      }
      if (killRequested) {
        finishTimeout();
      }
      // Sem kill: o callback do execFile resolve/rejeita com a mensagem correta.
    });

    // Soft: inicia kill; NÃO rejeita ainda (segura physicalLock).
    softKill = setTimeout(() => {
      requestKill("raw_soft_timeout");
      // Teto: se filho/kill não confirmarem, libera lock para não travar a fila para sempre.
      holdKill = setTimeout(() => {
        if (settled) return;
        log.error(
          {
            metric: "print.raw_kill_hold_expired",
            printer: nomeImpressora,
            holdMs: rawKillHoldMs(),
            durationMs: Date.now() - t0,
            childExited,
            killConfirmedDead: lastKill ? lastKill.confirmedDead : null,
            note: "Liberando lock no teto — verifique USB/driver/spooler nesta máquina",
          },
          "[ImpressoraCore] RAW kill-hold esgotado — liberando Promise/lock",
        );
        finishTimeout();
      }, rawKillHoldMs());
    }, rawPrintTimeoutMs());

    // Segundo taskkill se soft não matou ainda (finish do soft NÃO cancela isto).
    hardKill = setTimeout(() => {
      if (childExited || settled) return;
      requestKill("raw_hard_timeout");
    }, rawPrintTimeoutMs() + 1500);

    leakGuard = setTimeout(() => {
      cleanupFiles();
    }, Math.max(90_000, rawPrintTimeoutMs() + rawKillHoldMs() + 30_000));
  });
}

function enviarRede(host, port, buffer, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {}
      fn(val);
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => {
      socket.write(buffer, (err) => {
        if (err) return finish(reject, err);
        socket.end();
        finish(resolve, true);
      });
    });
    socket.on("error", (err) =>
      finish(reject, new Error(`Rede ${host}:${port} — ${err.message}`)),
    );
    socket.on("timeout", () =>
      finish(reject, new Error(`Rede ${host}:${port} — timeout`)),
    );
  });
}

function testarRede(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => {
      done = true;
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      if (!done) resolve(false);
    });
    socket.on("timeout", () => {
      if (!done) resolve(false);
    });
  });
}

function extrairIpPorta(portName) {
  if (!portName) return null;
  const ipMatch = portName.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (!ipMatch) return null;
  return ipMatch[1];
}

async function obterHostsRede() {
  const hosts = [];
  if (printerHost()) hosts.push(printerHost());

  const lista = await listarImpressorasWindowsAsync();
  for (const p of lista) {
    const ip = extrairIpPorta(p.PortName);
    if (ip) hosts.push(ip);
  }

  // Nunca escaneia localhost — seria o proprio agente na porta 9100
  return [...new Set(hosts.filter(Boolean))];
}

async function detectarRede() {
  const hosts = await obterHostsRede();
  if (!hosts.length) return null;

  const portas = [
    ...new Set(
      [printerPortNum(), ...REDE_PORTAS].filter(
        (p) => p && !Number.isNaN(p) && p !== AGENT_PORT,
      ),
    ),
  ];

  for (const host of hosts) {
    for (const port of portas) {
      if (await testarRede(host, port, 1500)) {
        return {
          metodo: "network",
          host,
          porta: port,
          nome: `${host}:${port}`,
        };
      }
    }
  }
  return null;
}

function detectarUsb() {
  if (!escposUSB) return null;
  try {
    const devices = escpos.USB.findPrinter();
    if (!devices || !devices.length) return null;
    return {
      metodo: "usb",
      dispositivos: devices.length,
      nome: printerName() || `USB (${devices.length} dispositivo(s))`,
    };
  } catch (_) {
    return null;
  }
}

async function detectarWindows(force = false) {
  const lista = await listarImpressorasWindowsAsync(force);
  const escolhida = escolherImpressoraWindows(lista);
  if (!escolhida) return null;
  return {
    metodo: "windows",
    nome: escolhida.Name,
    porta: escolhida.PortName,
    driver: escolhida.DriverName,
    padrao: !!escolhida.Default,
    candidatos: lista.length,
  };
}

async function detectarImpressora(force = false) {
  const agora = Date.now();
  if (
    !force &&
    cacheImpressoraEscolhida &&
    agora - cacheImpressoraEscolhida.em < CACHE_TTL_MS
  ) {
    return cacheImpressoraEscolhida.resultado;
  }
  if (!force && cacheDescoberta && agora - cacheDescobertaEm < CACHE_TTL_MS) {
    return cacheDescoberta;
  }

  // SSOT: se já há porta válida salva, não redescobrir (evita host de teste / scan lento)
  if (!force) {
    const portaCfg = resolverPortaAcbrConfigurada();
    if (portaCfg) {
      const { parsePortaTcp } = require("../printerModelMap");
      const tcp = parsePortaTcp(portaCfg);
      let escolhida = null;
      if (tcp) {
        escolhida = {
          metodo: "network",
          host: tcp.host,
          porta: tcp.port,
          nome: `${tcp.host}:${tcp.port}`,
        };
      } else {
        const raw = /^RAW:(.+)$/i.exec(portaCfg);
        if (raw) {
          escolhida = {
            metodo: "windows",
            nome: raw[1].trim(),
            porta: portaCfg,
          };
        } else if (/^COM\d/i.test(portaCfg)) {
          escolhida = { metodo: "serial", nome: portaCfg, porta: portaCfg };
        }
      }
      if (escolhida) {
        const resultado = {
          ok: true,
          tipoConfigurado: printerType(),
          impressora: escolhida,
          candidatos: [escolhida],
          ultimaUsada: ultimaImpressoraUsada,
          plataforma: process.platform,
          fromSavedConfig: true,
        };
        cacheDescoberta = resultado;
        cacheDescobertaEm = agora;
        cacheImpressoraEscolhida = { em: agora, resultado };
        return resultado;
      }
    }
  }

  const candidatos = [];
  const win = await detectarWindows(force);
  if (win) candidatos.push(win);
  const usb = detectarUsb();
  if (usb) candidatos.push(usb);
  // Com RAW/TCP configurado, não gasta tempo em scan de rede na descoberta
  const rede =
    resolverPortaAcbrConfigurada() || resolverNomeRawConfigurado()
      ? null
      : await detectarRede();
  if (rede) candidatos.push(rede);

  let escolhida = null;
  if (printerType() === "windows" && win) escolhida = win;
  else if (printerType() === "usb" && usb) escolhida = usb;
  else if (printerType() === "network" && rede) escolhida = rede;
  else if (printerType() === "network" && printerHost()) {
    const port = Number(printerPortNum()) || 9100;
    if (await testarRede(printerHost(), port, 1500)) {
      escolhida = {
        metodo: "network",
        host: printerHost(),
        porta: port,
        nome: `${printerHost()}:${port}`,
      };
    }
  } else if (printerType() === "auto") {
    const portaAcbr = String(process.env.PRINTER_PORTA || "").trim();
    const prefereWindows =
      !!printerName() ||
      /^RAW:/i.test(portaAcbr) ||
      (process.env.PRINTER_PROVIDER || "").toLowerCase().includes("acbr");
    if (prefereWindows && win) escolhida = win;
    else if (rede) escolhida = rede;
    else if (win) escolhida = win;
    else if (usb) escolhida = usb;
  } else if (IS_WIN && win) escolhida = win;
  else if (rede) escolhida = rede;
  else if (usb) escolhida = usb;
  else if (win) escolhida = win;

  const resultado = {
    ok: !!escolhida,
    tipoConfigurado: printerType(),
    impressora: escolhida,
    candidatos,
    ultimaUsada: ultimaImpressoraUsada,
    plataforma: process.platform,
  };

  cacheDescoberta = resultado;
  cacheDescobertaEm = agora;
  if (escolhida) {
    cacheImpressoraEscolhida = { em: agora, resultado };
  }
  return resultado;
}

async function enviarBuffer(buffer) {
  const erros = [];
  const tentativas = [];

  const add = (metodo, fn) => tentativas.push({ metodo, fn });

  let stationOverride = null;
  try {
    stationOverride = require("../printerStationRoutes").getPortaOverride();
  } catch (_) {
    /* ignore */
  }

  const { parsePortaTcp, portaAcbrValida } = require("../printerModelMap");
  const portaCfg =
    stationOverride && portaAcbrValida(stationOverride)
      ? null
      : resolverPortaAcbrConfigurada();
  const tcpCfg = portaCfg ? parsePortaTcp(portaCfg) : null;
  const rawConfigurado = tcpCfg ? null : resolverNomeRawConfigurado();

  if (stationOverride && /^TCP:/i.test(stationOverride)) {
    const tcp = parsePortaTcp(stationOverride);
    if (tcp) {
      add("network-station", async () => {
        await enviarRede(tcp.host, tcp.port, buffer);
        ultimaImpressoraUsada = { metodo: "network", host: tcp.host, porta: tcp.port };
      });
    }
  } else if (stationOverride && /^RAW:/i.test(stationOverride) && process.platform === "win32") {
    const nome = stationOverride.replace(/^RAW:/i, "").trim();
    if (nome) {
      add("windows-station", async () => {
        await enviarRawWindows(nome, buffer);
        ultimaImpressoraUsada = { metodo: "windows", nome };
      });
    }
  } else if (tcpCfg) {
    // SSOT: porta TCP salva no painel — só esta, sem scan / host de teste antigo
    add("network-config", async () => {
      await enviarRede(tcpCfg.host, tcpCfg.port, buffer);
      ultimaImpressoraUsada = {
        metodo: "network",
        host: tcpCfg.host,
        porta: tcpCfg.port,
      };
    });
  } else if (rawConfigurado && IS_WIN) {
    // SSOT: porta RAW salva — sem Get-Printer / scan de rede
    add("windows-raw-config", async () => {
      await enviarRawWindows(rawConfigurado, buffer);
      ultimaImpressoraUsada = { metodo: "windows", nome: rawConfigurado };
    });
  }

  const tipo = printerType();
  const configOnlyPath = !!(
    (tcpCfg || (rawConfigurado && IS_WIN)) &&
    !stationOverride
  );

  if (!configOnlyPath && (tipo === "windows" || tipo === "auto")) {
    add("windows", async () => {
      const win =
        cacheImpressoraEscolhida?.resultado?.impressora?.metodo === "windows"
          ? cacheImpressoraEscolhida.resultado.impressora
          : await detectarWindows();
      if (!win) throw new Error("Nenhuma impressora Windows encontrada.");
      await enviarRawWindows(win.nome, buffer);
      ultimaImpressoraUsada = { metodo: "windows", nome: win.nome };
    });
  }

  if (!configOnlyPath && (tipo === "network" || tipo === "auto")) {
    add("network", async () => {
      let rede =
        cacheImpressoraEscolhida?.resultado?.impressora?.metodo === "network"
          ? cacheImpressoraEscolhida.resultado.impressora
          : null;
      const host = printerHost();
      if (!rede && host) {
        const port = printerPortNum();
        if (await testarRede(host, port, 1500)) {
          rede = { host, porta: port };
        }
      }
      if (!rede && (tipo === "network" || tipo === "auto")) {
        if (!rawConfigurado) {
          rede = await detectarRede();
        }
      }
      if (!rede) throw new Error("Impressora de rede inacessivel.");
      await enviarRede(rede.host, rede.porta || rede.port, buffer);
      ultimaImpressoraUsada = {
        metodo: "network",
        host: rede.host,
        porta: rede.porta || rede.port,
      };
    });
  }

  if (!configOnlyPath && (tipo === "usb" || tipo === "auto")) {
    add(
      "usb",
      () =>
        new Promise((resolve, reject) => {
          if (!escposUSB) return reject(new Error("escpos-usb nao instalado."));
          const devices = escpos.USB.findPrinter();
          if (!devices || !devices.length)
            return reject(new Error("Nenhuma impressora USB encontrada."));
          const device = new escpos.USB(devices[0]);
          device.open((err) => {
            if (err) return reject(err);
            device.write(buffer, (wErr) => {
              device.close(() => {
                if (wErr) return reject(wErr);
                ultimaImpressoraUsada = { metodo: "usb" };
                resolve(true);
              });
            });
          });
        }),
    );
  }

  // Porta salva no painel: não varrer rede/USB (host de teste antigo = minutos).
  // Default strict=true — falha rápido se a porta escolhida não responder.
  const rawStrict =
    String(process.env.PRINT_RAW_STRICT || "true").toLowerCase() !== "false";

  const ordemBase = configOnlyPath
    ? tcpCfg
      ? []
      : rawStrict
        ? []
        : ["windows"]
    : tipo === "windows"
      ? ["windows"]
      : tipo === "network"
        ? ["network", "windows", "usb"]
        : tipo === "usb"
          ? ["usb", "windows", "network"]
          : IS_WIN
            ? ["windows", "network", "usb"]
            : ["usb", "network", "windows"];

  const ordem = [
    "network-station",
    "windows-station",
    "network-config",
    "windows-raw-config",
    ...ordemBase,
  ];

  for (const metodo of ordem) {
    const t = tentativas.find((x) => x.metodo === metodo);
    if (!t) continue;
    try {
      await t.fn();
      return { ok: true, metodo, ultima: ultimaImpressoraUsada };
    } catch (err) {
      erros.push(`${metodo}: ${err.message}`);
      if (metodo === "network-station" || metodo === "windows-station") {
        throw new Error(
          `Impressora da estação indisponível (${metodo}).\n` +
            erros.map((e) => `  - ${e}`).join("\n"),
        );
      }
      if (metodo === "network-config") {
        throw new Error(
          `Porta TCP salva falhou: ${err.message}. Verifique IP/porta em Configuração → Impressão.`,
        );
      }
      if (metodo === "windows-raw-config") {
        if (rawStrict) {
          throw new Error(
            `RAW configurado falhou (PRINT_RAW_STRICT): ${err.message}`,
          );
        }
        console.warn(
          "[Impressora] RAW configurado falhou — rediscovery Windows (sem scan rede/USB):",
          err.message,
        );
        continue;
      }
    }
  }

  throw new Error(
    "Nenhuma impressora disponivel.\n" +
      erros.map((e) => `  - ${e}`).join("\n") +
      "\nDica: salve a impressora correta em Configuração → Impressão (RAW ou TCP com IP com pontos).",
  );
}

async function imprimirRender(renderFn) {
  return comLockImpressao(async () => {
    const buffer = await gerarBuffer(renderFn);
    return enviarBuffer(buffer);
  });
}

const { toThermalText, toThermalDoc } = require("../../thermalText");

function tx(value) {
  return toThermalText(value);
}

/** Monta linha de endereço sem duplicar bairro/número (endereco legado já vem completo). */
function formatarLinhaEnderecoEmpresa(empresa) {
  const e = empresa || {};
  const logradouro = (e.logradouro || "").trim();
  if (logradouro) {
    return [logradouro, e.numero, e.bairro]
      .filter((p) => p != null && String(p).trim())
      .map(tx)
      .join(", ");
  }
  const enderecoLegado = (e.endereco || "").trim();
  if (enderecoLegado) return tx(enderecoLegado);
  return "";
}

// ── Helpers de layout ─────────────────────────────────────────────────────────
function helpers() {
  const largura = getThermalCols();
  const linha = (txt) => txt.padEnd(largura, " ").slice(0, largura);
  const sep = () => "-".repeat(largura);
  const centroFn = (txt) => {
    const pad = Math.max(0, Math.floor((largura - txt.length) / 2));
    return " ".repeat(pad) + txt;
  };
  const moeda = (v) =>
    `R$ ${Number(v || 0)
      .toFixed(2)
      .replace(".", ",")}`;
  const direita = (esq, dir) => {
    const espaco = Math.max(1, largura - esq.length - dir.length);
    return esq + " ".repeat(espaco) + dir;
  };
  const fmt = (v) =>
    "R$ " +
    Number(v).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  return { largura, linha, sep, centro: centroFn, moeda, direita, fmt };
}

// ── Formatadores locais (cols dinâmicos 58/80mm) ─────────────────────────────
const {
  getThermalCols,
  sepEq: thermalSepEq,
  sepDash: thermalSepDash,
  col2: thermalCol2,
  formatChaveLines,
  buildCupomItemLines,
  buildCupomItemHeader,
} = require("../thermalCols");

function col2(esq, dir, total = getThermalCols()) {
  return thermalCol2(esq, dir, total);
}
function centro(txt, total = getThermalCols()) {
  const t = String(txt).slice(0, total);
  const pad = Math.max(0, Math.floor((total - t.length) / 2));
  return " ".repeat(pad) + t;
}
function fmtR$(v) {
  return (
    "R$ " +
    Number(v || 0).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
function sepEq() {
  return thermalSepEq(getThermalCols());
}
function sepDash() {
  return thermalSepDash(getThermalCols());
}

// ── QR Code ESC/POS padrão (GS ( k) ──────────────────────────────────────────
// A lib escpos usa comandos proprietários (GS Z / ESC Z) no printer.qrcode(),
// que só existem em algumas controladoras chinesas. Impressoras Epson-compatíveis
// (Epson, Elgin, Bematech, Daruma, Tanca, POS-80 genéricas) ignoram esses bytes
// e imprimem o conteúdo do QR — a URL da NFC-e — como texto puro no cupom.
// A sequência correta e universal é GS ( k (Funções 165/167/169/180/181),
// a mesma usada por ACBr, python-escpos e escpos-php.
const QR_ESCPOS_MODE = (process.env.PRINTER_QR_ESCPOS_MODE || "gs_k").toLowerCase();
const QR_GS_K_NIVEIS = { L: 48, M: 49, Q: 50, H: 51 };
// Capacidade máxima QR modo byte (versão 40, nível M) — acima disso só raster
const QR_GS_K_MAX_BYTES = 2331;

/** Monta a sequência GS ( k completa (modelo 2, byte-safe, sem iconv). */
function bytesQrGsK(conteudo, opts = {}) {
  const { resolveQrPrintOpts } = require("../cupomLayoutShared");
  const data = Buffer.from(String(conteudo), "utf8");
  const q = resolveQrPrintOpts(opts);
  const moduleSize = q.moduleSize;
  const nivel = QR_GS_K_NIVEIS[q.errorLevel] ?? QR_GS_K_NIVEIS.M;
  const storeLen = data.length + 3;
  return Buffer.concat([
    // Fn 165 — seleciona QR modelo 2
    Buffer.from([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    // Fn 167 — tamanho do módulo (1–16 dots)
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize]),
    // Fn 169 — nível de correção de erro
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, nivel]),
    // Fn 180 — armazena os dados do símbolo (pL/pH = len + 3, little-endian)
    Buffer.from([0x1d, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, 0x30]),
    data,
    // Fn 181 — imprime o símbolo armazenado
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
  ]);
}

function promisificarQrImage(printer, conteudo, options) {
  return new Promise((resolve, reject) => {
    printer.qrimage(conteudo, options, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Imprime QR (NFC-e/PIX): GS ( k padrão com fallback raster assíncrono. */
async function imprimirQrNfce(printer, conteudo) {
  const texto = String(conteudo || "").trim();
  if (!texto) return;
  const usarRaster =
    QR_ESCPOS_MODE === "raster" ||
    Buffer.byteLength(texto, "utf8") > QR_GS_K_MAX_BYTES;
  if (!usarRaster) {
    try {
      printer.align("ct").feed(1);
      // Bytes crus via raw() — bypass do iconv/encoding do driver
      printer.raw(bytesQrGsK(texto));
      printer.feed(2);
      return;
    } catch (err) {
      console.warn(
        "[Impressora] QR GS(k) falhou, tentando raster:",
        err.message,
      );
    }
  }
  await promisificarQrImage(printer, texto, {
    type: "png",
    mode: "dhdw",
    size: 4,
  });
  printer.align("ct").feed(2);
}

function formatarChaveNfe(chave) {
  const digits = String(chave || "").replace(/\D/g, "");
  if (!digits) return [];
  if (digits.length !== 44) return [digits];
  const grupos = [];
  for (let i = 0; i < 44; i += 4) {
    grupos.push(digits.slice(i, i + 4));
  }
  return grupos;
}

// ── Layout do cupom ───────────────────────────────────────────────────────────
//
// Estratégia visual e emocional:
//
//  ┌ CABEÇALHO ──────────────────────────────────────┐
//  │  Nome da loja  GRANDE + BOLD  → âncora de marca │
//  │  CNPJ / endereço / telefone   → credibilidade   │
//  └─────────────────────────────────────────────────┘
//  ┌ IDENTIFICAÇÃO ──────────────────────────────────┐
//  │  Nro | Data | Hora | Operador | Cliente / CPF   │
//  └─────────────────────────────────────────────────┘
//  ┌ ITENS ──────────────────────────────────────────┐
//  │  00 NOME DO PRODUTO              R$ 00,00        │
//  │     2 un × R$ 00,00                              │
//  │  Produto por peso:                               │
//  │     0,250 kg × R$ 00,00/kg      R$ 00,00        │
//  └─────────────────────────────────────────────────┘
//  ┌ TOTAIS ─────────────────────────────────────────┐
//  │  Subtotal:                      R$ 000,00        │
//  │  Desconto:                    - R$ 000,00        │
//  ╠══════════════════════════════════════════════════╣
//  │  TOTAL:         R$ 000,00   ← FONTE DUPLA BOLD  │   ← momento emocional
//  ╠══════════════════════════════════════════════════╣
//  │  Pagamento: DINHEIRO                             │
//  │  Recebido:                      R$ 000,00        │
//  │  TROCO:         R$ 00,00    ← bold, satisfação  │
//  └─────────────────────────────────────────────────┘
//  ┌ RODAPÉ ─────────────────────────────────────────┐
//  │  Obrigado pela preferencia! Volte sempre!        │
//  │  PDV Margin Engine                               │
//  └─────────────────────────────────────────────────┘
//
function renderCupom(printer, payload) {
  return renderCupomConteudo(printer, payload);
}

async function imprimirLogoCupomEscpos(printer, payload) {
  const t0 = performance.now();
  const phases = { paintMs: 0, cacheHit: false, skipped: null };
  try {
    const printerLogo = require("../printerLogo");
    // Hot path: só toggle em memória — NUNCA ler()/BMP/sharp/Image.load/toBitmap.
    if (!printerLogo.exibirLogoCupomHabilitado(payload)) {
      phases.skipped = "toggle_or_missing";
      return;
    }
    if (!logoEscposImageCache.rawBytes) {
      phases.skipped = "cache_miss";
      log.warn(
        {
          metric: "print.logo_hotpath_cache_miss",
          note: "Logo omitida neste cupom — aquecimento em background (sem bloquear salão)",
        },
        "[ImpressoraCore] Logo cache frio — cupom segue sem imagem",
      );
      scheduleLogoWarmOnce();
      return;
    }

    phases.cacheHit = true;
    const tPaint = performance.now();
    printer.raw(logoEscposImageCache.rawBytes);
    phases.paintMs = performance.now() - tPaint;
    logoEscposImageCache.paintedAt = Date.now();

    const totalMs = performance.now() - t0;
    log.info(
      {
        totalMs,
        ...phases,
        bytes: logoEscposImageCache.rawBytes.length,
        metric: "print.imprimirlogo_total",
      },
      "[ImpressoraCore] imprimirLogoCupomEscpos() total timing",
    );
    if (totalMs > 50) {
      log.warn(
        { totalMs, ...phases, metric: "print.imprimirlogo_slow" },
        "[ImpressoraCore] Logo ESC/POS acima do orçamento (50ms)",
      );
    }
  } catch (err) {
    log.warn(
      {
        err: err?.message,
        phases,
        metric: "print.imprimirlogo_error",
      },
      "[ImpressoraCore] Logo omitida — cupom segue sem imagem",
    );
  }
}

async function renderCupomConteudo(printer, payload) {
  const t0RenderCupom = performance.now();
  const phases = { logoMs: 0, bodyMs: 0 };
  const COLS = getThermalCols();
  const empresa = payload.empresa || {};
  const itens = payload.itens || [];
  const isFiscal =
    !payload.naoFiscal &&
    !payload.cupomSemFiscal &&
    !!(payload.chaveNfe && String(payload.chaveNfe).trim());
  const isOffline = payload.origem === "offline";
  const isLocalSync = payload.origem === "local";

  const {
    FOOTER,
    bannersStatusCupom,
    applyEscposCut,
    seriePadraoCupom,
    imprimirBarcodesEscpos,
  } = require("../cupomLayoutShared");

  const LABEL_PGTO = {
    dinheiro: "DINHEIRO",
    pix: "PIX",
    debito: "CARTAO DEBITO",
    credito: "CARTAO CREDITO",
    fiado: "FIADO",
    voucher: "VOUCHER",
  };

  // ── 1. Cabeçalho — tudo centralizado ────────────────────────────────────────
  printer.font("a").align("ct");

  const tLogo = performance.now();
  await imprimirLogoCupomEscpos(printer, payload);
  phases.logoMs = performance.now() - tLogo;
  const tBody = performance.now();

  if (require("../segundaVia").deveExibirBannerSegundaVia(payload)) {
    printer.style("b").size(1, 1).text("*** SEGUNDA VIA ***").style("normal").size(0, 0);
    printer.feed(1);
    printer.text(sepDash());
    printer.feed(1);
  }

  // Nome da loja em negrito + tamanho ampliado (paridade fechamento de caixa)
  const nomeEmpresa = tx(
    (
      empresa.nomeFantasia ||
      empresa.razaoSocial ||
      "ESTABELECIMENTO"
    ).toUpperCase(),
  );
  printer
    .style("b")
    .size(1, 1)
    .text(nomeEmpresa)
    .style("normal")
    .size(0, 0);

  const fantasia = String(empresa.nomeFantasia || "").trim();
  const razao = String(empresa.razaoSocial || "").trim();
  if (razao && fantasia && fantasia.toUpperCase() !== razao.toUpperCase()) {
    printer.text(tx(razao));
  }
  if (empresa.cnpj) printer.text("CNPJ: " + toThermalDoc(empresa.cnpj));
  const linhaEndereco = formatarLinhaEnderecoEmpresa(empresa);
  if (linhaEndereco) printer.text(linhaEndereco.slice(0, COLS));
  if (empresa.cidade)
    printer.text(
      tx(`${empresa.cidade}${empresa.uf ? " - " + empresa.uf : ""}`).slice(
        0,
        COLS,
      ),
    );
  if (empresa.telefone) printer.text("Tel: " + toThermalDoc(empresa.telefone));

  // ── 2. Título do cupom — centralizado entre separadores duplos ──────────────
  printer.align("lt").text(sepEq());
  printer.align("ct").style("b");
  printer.text(isFiscal ? tituloCupomFiscal(payload.chaveNfe) : "CUPOM NAO FISCAL");
  printer.style("normal");
  for (const banner of bannersStatusCupom(payload)) {
    printer.align("ct").style("b").text(banner).style("normal");
  }
  printer.align("lt").text(sepEq());

  // ── 3. Identificação — alinhada col2 (esq:dir) ──────────────────────────────
  const dtVenda = new Date(payload.emitidoEm || Date.now());
  const dataStr = dtVenda.toLocaleDateString("pt-BR");
  const horaStr = dtVenda.toLocaleTimeString("pt-BR");

  printer.align("lt");
  printer.text(col2("Nro:", payload.numeroVenda || ""));
  printer.text(col2("Data:", dataStr + "  " + horaStr));
  if (payload.operador) printer.text(col2("Operador:", tx(payload.operador)));
  if (payload.nomeCliente && payload.nomeCliente !== "Consumidor")
    printer.text(col2("Cliente:", tx(payload.nomeCliente).slice(0, 28)));
  if (payload.cpfCliente) printer.text(col2("CPF:", toThermalDoc(payload.cpfCliente)));
  if (payload.cnpjCliente)
    printer.text(col2("CNPJ:", toThermalDoc(payload.cnpjCliente)));

  // ── 4. Itens ─────────────────────────────────────────────────────────────────
  printer.text(sepDash());
  printer.text(buildCupomItemHeader(COLS));
  printer.text(sepDash());

  itens.forEach((item, idx) => {
    const nome = tx(String(item.nome || item.codigo || "Item"));
    const total = item.total ?? item.precoUnitario * item.quantidade;
    const valUnit = Number(item.precoUnitario).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const valTotal = Number(total).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const fUnit = fmtR$(item.precoUnitario);

    for (const line of buildCupomItemLines({
      cols: COLS,
      idx,
      nome,
      valUnit,
      valTotal,
    })) {
      printer.text(line);
    }

    if (item.porPeso) {
      const kg = Number(item.quantidade).toLocaleString("pt-BR", {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      });
      printer.text(`   ${kg} kg x ${fUnit}/kg`);
    } else {
      const qtd = Number(item.quantidade);
      if (qtd > 1) printer.text(`   ${qtd} un x ${fUnit}`);
    }
  });

  // ── 5. Totais ────────────────────────────────────────────────────────────────
  const desconto = Number(payload.desconto || 0);
  const totalFinal = Number(payload.total || 0);
  const subtotal = totalFinal + desconto;
  const valorRecebido = Number(payload.valorRecebido || 0);
  const troco = Number(
    payload.troco ??
      (valorRecebido > totalFinal ? valorRecebido - totalFinal : 0),
  );

  printer.align("lt").text(sepDash());

  if (desconto > 0) {
    printer.text(col2("Subtotal:", fmtR$(subtotal)));
    printer
      .style("b")
      .text(col2("Desconto:", "- " + fmtR$(desconto)))
      .style("normal");
  }

  // ── TOTAL — destaque com bold, tamanho normal para respeitar largura do papel ─
  // size(0,0) = tamanho padrão — evita quebra de linha em papel estreito (58/80 mm)
  // O destaque visual vem do bold + separadores ===
  printer.text(sepEq());
  const totalStr = "TOTAL: " + fmtR$(totalFinal);
  printer.align("ct").style("b").size(0, 0).text(totalStr).style("normal");
  printer.align("lt").text(sepEq());

  // ── Pagamento ────────────────────────────────────────────────────────────────
  const pagamentosCupom =
    Array.isArray(payload.pagamentos) && payload.pagamentos.length > 0
      ? payload.pagamentos
      : [
          {
            forma: payload.formaPagamento || "dinheiro",
            valor: valorRecebido > 0 ? valorRecebido : totalFinal,
            troco,
          },
        ];

  for (const pg of pagamentosCupom) {
    const formaLabel =
      LABEL_PGTO[pg.forma] || (pg.forma || "").toUpperCase();
    const aplicado = Number(pg.valor || 0) - Number(pg.troco || 0);
    if (formaLabel) {
      printer.text(col2("Pagamento:", `${formaLabel} ${fmtR$(aplicado)}`));
    }
    if (pg.forma === "pix" && pg.pixCopiaCola) {
      printer.align("ct").text("PIX Copia e Cola");
      await imprimirQrNfce(printer, String(pg.pixCopiaCola));
      printer.align("lt");
    }
  }

  if (troco > 0) {
    printer.text(col2("Recebido:", fmtR$(valorRecebido)));
    printer.text(sepDash());
    printer
      .align("ct")
      .style("b")
      .size(0, 0)
      .text("TROCO: " + fmtR$(troco))
      .style("normal");
    printer.align("lt").text(sepDash());
  } else if (
    pagamentosCupom.length === 1 &&
    pagamentosCupom[0].forma === "dinheiro" &&
    valorRecebido > 0
  ) {
    printer.text(col2("Recebido:", fmtR$(valorRecebido)));
  }

  // Volumes
  const totalVols = itens.reduce((s, i) => s + Number(i.quantidade || 0), 0);
  printer.text(col2("Volumes:", Math.round(totalVols) + " item(ns)"));

  const { resolverIbptCupom, formatarTextoIbptCupom } = require("../../fiscalIbpt");
  // IBPT só no documento fiscal (Lei 12.741) — nunca no cupom auxiliar.
  const ibpt = isFiscal ? resolverIbptCupom(payload) : null;
  const textoIbpt = ibpt ? formatarTextoIbptCupom(ibpt, totalFinal) : "";
  if (textoIbpt) {
    printer.text(sepDash());
    printer.align("ct").text(textoIbpt).align("lt");
  }

  // ── 6. NFC-e ─────────────────────────────────────────────────────────────────
  if (isFiscal) {
    printer.text(sepDash());
    const tituloFiscal = tituloBlocoDocumentoFiscal(payload.chaveNfe);
    printer
      .align("ct")
      .style("b")
      .text(tituloFiscal)
      .style("normal")
      .align("ct")
      .style("b")
      .text(
        linhaNumeroSerieDocumento(payload.chaveNfe, payload.numeroNfe, payload.serieNfe, {
          seriePadrao: seriePadraoCupom(),
        }),
      )
      .style("normal")
      .align("lt");
    if (payload.protocolo) {
      printer.text(`Protocolo: ${String(payload.protocolo).slice(0, 30)}`);
    }
    const chaveLines = formatChaveLines(payload.chaveNfe, getThermalCols());
    if (chaveLines.length) {
      printer.align("ct").text("Chave de acesso");
      chaveLines.forEach((line) => printer.text(line));
    }
    const qrConteudo = resolverQrCodeNfce(payload);
    printer
      .align("ct")
      .text(`Consulte em ${portalConsultaDocumento(payload.chaveNfe, qrConteudo)}`);

    if (qrConteudo && IMPRIMIR_QR_NFCE && isNfceModelo65(payload.chaveNfe)) {
      printer.text("Consulta via QR Code");
      await imprimirQrNfce(printer, qrConteudo);
      printer.align("ct").text("Consulte pela chave ou QR Code");
    } else if (
      IMPRIMIR_QR_NFCE &&
      isNfceModelo65(payload.chaveNfe) &&
      !payload.permitirSemQr
    ) {
      throw new Error(
        "NFC-e autorizada sem URL de QR Code — aguarde sincronização do XML ou reimprima via DANFC-e",
      );
    }
  }

  // Barcodes extras (paridade ACBr renderBarcodesPayload)
  {
    const specs = require("../cupomLayoutShared").barcodeSpecsFromPayload(payload);
    if (specs.length) {
      printer.text(sepDash());
      imprimirBarcodesEscpos(printer, payload);
    }
  }

  // ── 7. Offline / sync local (banner já no topo; reforço se só local) ────────
  if (isLocalSync && !isFiscal && !isOffline) {
    printer.text(sepDash());
    printer.align("ct").text("Aguardando confirmacao do servidor.");
  }

  // ── 8. Rodapé — paridade ACBr ───────────────────────────────────────────────
  printer.align("lt").text(sepEq());
  printer
    .align("ct")
    .style("b")
    .text(FOOTER.obrigado)
    .style("normal")
    .text(FOOTER.volte)
    .text("")
    .text(FOOTER.pdv)
    .text("")
    .text("")
    .text("");
  applyEscposCut(printer);
  phases.bodyMs = performance.now() - tBody;
  const totalRenderMs = performance.now() - t0RenderCupom;
  log.info(
    {
      totalRenderMs,
      ...phases,
      metric: "print.rendercupomconteudo_total",
    },
    "[ImpressoraCore] renderCupomConteudo() TOTAL TIMING — includes logo + items + payments",
  );
  if (totalRenderMs > 500) {
    log.warn(
      {
        totalRenderMs,
        ...phases,
        metric: "print.rendercupomconteudo_slow",
        note: "Alvo PDV <300ms; investigar logoMs/bodyMs",
      },
      "[ImpressoraCore] Render de cupom acima do orçamento",
    );
  }
}

function renderFechamento(printer, payload) {
  return renderFechamentoConteudo(printer, payload);
}

async function renderFechamentoConteudo(printer, payload) {
  const { buildFechamentoLayout } = require("../caixaLayout");
  await renderThermalLayoutEscpos(printer, buildFechamentoLayout(payload), payload);
}

function renderAbertura(printer, payload) {
  return renderAberturaConteudo(printer, payload);
}

async function renderAberturaConteudo(printer, payload) {
  const { buildAberturaLayout } = require("../caixaLayout");
  await renderThermalLayoutEscpos(printer, buildAberturaLayout(payload), payload);
}

async function renderMovimentoCaixa(printer, payload) {
  const { buildMovimentoLayout } = require("../caixaLayout");
  await renderThermalLayoutEscpos(printer, buildMovimentoLayout(payload), payload);
}

async function renderPedido(printer, payload) {
  const { buildPedidoLayout } = require("../pedidoLayout");
  await renderThermalLayoutEscpos(printer, buildPedidoLayout(payload), payload);
}

/** Aplica layout térmico compartilhado (caixa / pedidos) no ESC/POS. */
async function renderThermalLayoutEscpos(printer, layout, payload) {
  const { sep: linha } = helpers();
  const { showLogo, lines } = layout;

  printer.font("a").align("ct");
  if (showLogo) {
    await imprimirLogoCupomEscpos(printer, payload);
  }

  for (const line of lines) {
    if (!line) continue;
    if (line.kind === "blank") {
      printer.feed(1);
      continue;
    }
    if (line.kind === "sep") {
      printer.align("ct").style("normal").size(0, 0).text(line.text || linha());
      continue;
    }

    const text = String(line.text ?? "");
    if (line.center) printer.align("ct");
    else printer.align("lt");

    if (line.size === "lg") {
      printer.style(line.bold ? "b" : "normal").size(1, 1).text(text).size(0, 0).style("normal");
    } else if (line.bold) {
      printer.style("b").size(0, 0).text(text).style("normal");
    } else {
      printer.style("normal").size(0, 0).text(text);
    }
  }

  printer.align("ct");
  require("../cupomLayoutShared").applyEscposCut(printer);
}

// ── API publica ───────────────────────────────────────────────────────────────
/** Poll/status: somente leitura — sync fica em detectar/bootstrap/PUT config. */
async function testar(force = false) {
  try {
    const info = await detectarImpressora(force);
    return !!info?.ok || !!info?.impressora;
  } catch (_) {
    return false;
  }
}

async function getInfo(force = false) {
  return detectarImpressora(force);
}

function listar() {
  // Cache only — nunca Get-Printer síncrono. Refresh em background só se ocioso.
  if (!listagemWindowsBloqueada()) {
    void listarImpressorasWindowsAsync();
  }
  const windows = listarImpressorasWindowsCached().map((p) => ({
    nome: p.Name,
    porta: p.PortName,
    driver: p.DriverName,
    padrao: !!p.Default,
    termicaProvavel:
      !pareceNaoTermica(p.Name || "") &&
      !pareceNaoTermica(p.DriverName || "") &&
      (TERMICA_RX.test(p.Name || "") || TERMICA_RX.test(p.DriverName || "")),
  }));

  // Sempre inclui a porta RAW configurada — UI não fica vazia se Get-Printer
  // falhou/hangueou ou a térmica ainda não entrou no spooler.
  const rawNome = resolverNomeRawConfigurado();
  if (rawNome && !windows.some((w) => String(w.nome).toLowerCase() === rawNome.toLowerCase())) {
    windows.unshift({
      nome: rawNome,
      porta: `RAW:${rawNome}`,
      driver: "configurada",
      padrao: true,
      termicaProvavel: TERMICA_RX.test(rawNome),
      configurada: true,
    });
  }

  let usb = [];
  if (escposUSB) {
    try {
      const devices = escpos.USB.findPrinter() || [];
      usb = devices.map((_, i) => ({ indice: i, metodo: "usb" }));
    } catch (_) {}
  }

  return {
    tipoConfigurado: printerType(),
    nomeConfigurado: printerName() || rawNome || null,
    hostConfigurado: printerHost() || null,
    portaConfigurada: printerPortNum(),
    windows,
    usb,
    ultimaUsada: ultimaImpressoraUsada,
  };
}

function imprimirCupom(payload) {
  const normalizado = normalizarCupomPayload(payload, {
    relaxQr: deveRelaxarQr(payload),
  });
  return imprimirComGavetaOpcional(
    (printer) => renderCupom(printer, normalizado),
    normalizado,
  );
}

function imprimirTeste() {
  // Teste: gaveta já (force), em paralelo com a página — não espera o fim.
  void abrirGaveta({ force: true }).catch(() => {});
  return imprimirComGavetaOpcional(
    async (printer) => {
      // Paridade com página de teste ACBr — logo no topo quando BMP imprimível.
      await imprimirLogoCupomEscpos(printer, { exibirLogo: true });
      printer.font("a").align("ct").style("b").text("TESTE IMPRESSORA").style("normal");
      printer.text("Margin Platform 1.0");
      printer.text(sepDash());
      printer.align("lt").text("Texto: C A E O U R$ acentuacao");
      printer.align("ct").text("QR Code teste");
      await imprimirQrNfce(printer, "https://marginengine.com.br/teste-impressora");
      printer.align("ct").text("PIX Copia e Cola teste");
      await imprimirQrNfce(
        printer,
        "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-426655440000",
      );
      // Barcodes — dialeto configurado (Elgin i9: Function B com byte n correto)
      const dialectMod = require("../barcodeDialect");
      const dialect = dialectMod.resolveBarcodeDialect({});
      printer.align("ct").style("b").text("CODIGO DE BARRAS").style("normal");
      printer.text(`Dialeto: ${dialect.id}`);
      printer.text("VAS01 (vasilhame)");
      const meta = [];
      require("../cupomLayoutShared").imprimirBarcodesEscpos(
        printer,
        { code128: "VAS01" },
        { altura: 64, largura: 2, exibe: true, __collectMeta: meta },
      );
      if (meta[0]?.fullHex) {
        printer.align("lt").size(0, 0);
        printer.text("HEX (diagnostico):");
        // Quebra hex longo em linhas térmicas
        const hex = meta[0].fullHex;
        for (let i = 0; i < hex.length; i += 42) {
          printer.text(hex.slice(i, i + 42));
        }
      }
      printer.align("ct").text("Fim do teste — corte abaixo");
      printer.feed(2);
    },
    { abrirGaveta: true },
    { sempre: true },
  );
}

/**
 * Página só de barcode + metadados (confirmação visual do operador).
 * Retorna hex dump do que foi enviado — comparar com manual Elgin/Epson.
 */
function imprimirTesteBarcode(opts = {}) {
  const dialectMod = require("../barcodeDialect");
  const code = String(opts.code || "VAS01").trim().toUpperCase() || "VAS01";
  const dialectId = opts.dialect || null;
  const meta = [];
  return imprimirRender(async (printer) => {
    const dialect = dialectMod.resolveBarcodeDialect({ dialect: dialectId });
    printer.font("a").align("ct").style("b").size(1, 1).text("TESTE BARCODE").size(0, 0).style("normal");
    printer.text(`Dialeto: ${dialect.label}`);
    printer.text(sepDash());
    printer.style("b").size(1, 1).text(code).size(0, 0).style("normal");
    printer.text("O codigo abaixo saiu como BARRAS?");
    printer.feed(1);
    require("../cupomLayoutShared").imprimirBarcodesEscpos(
      printer,
      { code128: code },
      {
        altura: 72,
        largura: 2,
        exibe: true,
        dialect: dialect.id,
        __collectMeta: meta,
      },
    );
    printer.feed(1);
    printer.align("ct").text("Confirme no PDV: Sim / Nao");
    printer.feed(2);
  }).then((result) => ({
    ...result,
    barcode: {
      code,
      dialect: dialectMod.resolveBarcodeDialect({ dialect: dialectId }).id,
      plan: meta[0]?.plan || [],
      fullHex: meta[0]?.fullHex || null,
      expectedElginCode128:
        dialectMod.bytesToHexDump(
          dialectMod.buildCode128FunctionB(code) || Buffer.alloc(0),
        ) || null,
    },
  }));
}

function imprimirFechamento(payload) {
  return imprimirRender((printer) => renderFechamento(printer, payload));
}

function imprimirAbertura(payload) {
  return imprimirComGavetaOpcional(
    (printer) => renderAbertura(printer, payload),
    payload,
    { sempre: true },
  );
}

function imprimirMovimentoCaixa(payload) {
  return imprimirComGavetaOpcional(
    (printer) => renderMovimentoCaixa(printer, payload),
    payload,
    { sempre: true },
  );
}

function imprimirPedido(payload) {
  const { normalizarPedidoPayload } = require("../pedidoPrint");
  const p = normalizarPedidoPayload(payload);
  return imprimirRender(async (printer) => {
    for (let i = 0; i < p.copies; i++) {
      await renderPedido(printer, p);
    }
  });
}

function imprimirVasilhame(payload) {
  const { normalizarVasilhamePayload } = require("../vasilhameAcbrTags");
  const p = normalizarVasilhamePayload(payload);
  return imprimirRender(async (printer) => {
    await renderVasilhame(printer, p);
  });
}

function imprimirCrediario(payload) {
  const { normalizarCrediarioPayload } = require("../crediarioAcbrTags");
  const p = normalizarCrediarioPayload(payload);
  return imprimirRender(async (printer) => {
    await renderCrediario(printer, p);
  });
}

async function renderCrediario(printer, payload) {
  const { sep: linha, fmt } = helpers();

  printer.font("a").align("ct");
  await imprimirLogoCupomEscpos(printer, payload);

  if (payload.empresa?.nome) {
    printer.style("b").text(tx(payload.empresa.nome)).style("normal");
  }
  if (payload.empresa?.cnpj) {
    printer.text("CNPJ: " + toThermalDoc(payload.empresa.cnpj));
  }

  printer
    .text(linha())
    .style("b")
    .text(tx(payload.titulo || "RECEBIMENTO CREDIARIO"))
    .style("normal")
    .text("Comprovante nao fiscal")
    .text(linha())
    .align("lt");

  if (payload.clienteNome) printer.text("Cliente : " + tx(payload.clienteNome));
  if (payload.clienteDocumento) {
    printer.text("Doc     : " + toThermalDoc(payload.clienteDocumento));
  }
  if (payload.numeroParcela != null && payload.totalParcelas != null) {
    printer.text("Parcela : " + payload.numeroParcela + "/" + payload.totalParcelas);
  } else if (payload.parcelasQuitadas != null || payload.parcelasParciais != null) {
    const q = payload.parcelasQuitadas || 0;
    const partial = payload.parcelasParciais || 0;
    printer.text(
      "Parcelas: " + q + " quitada(s)" + (partial > 0 ? ", " + partial + " parcial(is)" : ""),
    );
  }
  if (payload.vencimento) printer.text("Venc.   : " + tx(payload.vencimento));
  if (payload.dataRecebimento) printer.text("Data/Hr : " + tx(payload.dataRecebimento));
  if (payload.operador) printer.text("Operador: " + tx(payload.operador));
  if (payload.formaPagamento) printer.text("Forma   : " + tx(payload.formaPagamento));

  printer.text(linha());
  printer.style("b").text("Recebido: " + fmt(Number(payload.valorRecebido || 0))).style("normal");
  if (Number(payload.jurosCalculado) > 0) {
    printer.text("Juros   : " + fmt(Number(payload.jurosCalculado)));
  }
  if (Number(payload.multaCalculada) > 0) {
    printer.text("Multa   : " + fmt(Number(payload.multaCalculada)));
  }
  printer.text("Saldo ant.: " + fmt(Number(payload.saldoAnterior || 0)));
  printer.style("b").text("Saldo rem.: " + fmt(Number(payload.saldoRemanescente || 0))).style("normal");

  if (payload.observacao) {
    printer.text(linha()).text("Obs: " + tx(payload.observacao));
  }

  printer
    .align("ct")
    .text(linha())
    .text("Documento nao fiscal")
    .text("Nao substitui NFC-e / cupom fiscal");
  require("../cupomLayoutShared").applyEscposCut(printer);
}

async function renderVasilhame(printer, payload) {
  const { sep: linha, fmt } = helpers();
  const codigo = String(payload.codigoTransacao || "").trim();

  printer.font("a").align("ct");
  await imprimirLogoCupomEscpos(printer, payload);

  if (require("../segundaVia").deveExibirBannerSegundaVia(payload)) {
    printer.style("b").size(1, 1).text("*** SEGUNDA VIA ***").style("normal").size(0, 0);
    printer.feed(1);
    printer.text(linha());
    printer.feed(1);
  }

  if (payload.empresa?.nome) {
    printer.style("b").text(tx(payload.empresa.nome)).style("normal");
  }
  if (payload.empresa?.cnpj) {
    printer.text("CNPJ: " + toThermalDoc(payload.empresa.cnpj));
  }

  printer
    .text(linha())
    .style("b")
    .text("EMPRESTIMO DE VASILHAME")
    .style("normal")
    .text("Comprovante nao fiscal")
    .text(linha())
    .align("lt");

  if (payload.clienteNome) printer.text("Cliente : " + tx(payload.clienteNome));
  if (payload.tipoNome || payload.tipoCodigo) {
    printer.text(
      "Tipo    : " +
        tx([payload.tipoNome, payload.tipoCodigo ? "(" + payload.tipoCodigo + ")" : ""]
          .filter(Boolean)
          .join(" ")),
    );
  }
  if (payload.quantidade != null && !Number.isNaN(Number(payload.quantidade))) {
    printer.text("Qtde    : " + payload.quantidade);
  }
  if (payload.dataMovimento) printer.text("Saida   : " + tx(payload.dataMovimento));
  if (payload.dataPrevistaDevolucao) {
    printer.text("Prevista: " + tx(payload.dataPrevistaDevolucao));
  }
  if (payload.operador) printer.text("Operador: " + tx(payload.operador));

  printer.text(linha());
  if (payload.caucaoCents > 0) {
    printer.style("b").text("Caucao retida: " + fmt(Number(payload.caucaoCents) / 100)).style("normal");
  } else {
    printer.text("Caucao: sem cobranca");
  }

  if (payload.observacao) {
    printer.text(linha()).text("Obs: " + tx(payload.observacao));
  }

  if (codigo) {
    // Etiqueta destacada: código grande legível + CODE128 (com {B no ESC/POS)
    // para colar/identificar o vasilhame na devolução.
    printer
      .align("ct")
      .text(linha())
      .style("b")
      .text("ETIQUETA — COLE NO VASILHAME")
      .style("normal")
      .feed(1)
      .style("b")
      .size(1, 1)
      .text(codigo)
      .size(0, 0)
      .style("normal")
      .text("Apresente na devolucao")
      .feed(1);

    const printed = require("../cupomLayoutShared").imprimirBarcodesEscpos(
      printer,
      { code128: codigo },
      {
        altura: 72,
        largura: 2,
        exibe: true,
        forceCode128Fail: payload.__forceCode128Fail === true,
      },
    );
    // Texto humano sob as barras (mesmo se HRI do firmware vier apagado).
    printer
      .align("ct")
      .style("b")
      .size(1, 1)
      .text(codigo)
      .size(0, 0)
      .style("normal");
    if (!printed) {
      printer.text("(barras indisponiveis nesta impressora)");
    }
    try {
      const { suggestQrModuleSize } = require("../thermalCols");
      printer.raw(bytesQrGsK(codigo, { moduleSize: suggestQrModuleSize() }));
      printer.feed(1);
    } catch (_) {
      /* QR opcional */
    }
  }

  printer
    .align("ct")
    .text(linha())
    .text("Documento nao fiscal")
    .text("Nao substitui NFC-e / cupom fiscal");
  require("../cupomLayoutShared").applyEscposCut(printer);
}

/** Coalesce pulsos próximos — evita gaveta dupla (cupom+job / recusa+DANFE). */
let _lastGavetaPulseAt = 0;

function gavetaCoalesceMs() {
  return Math.max(0, parseInt(process.env.PRINTER_DRAWER_COALESCE_MS || "800", 10) || 800);
}

function markGavetaPulseSent() {
  _lastGavetaPulseAt = Date.now();
}

function gavetaPulseRecente() {
  return Date.now() - _lastGavetaPulseAt < gavetaCoalesceMs();
}

function drawerEnabled() {
  return (process.env.PRINTER_DRAWER || "true").toLowerCase() !== "false";
}

function clampDrawerByte(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Pulso ESC/POS: ESC p m t1 t2 (unidade = 2ms).
 * Defaults 50ms/500ms → 0x19 / 0xFA (compatível com POS80).
 */
function drawerPulseBuffer() {
  const onMs = parseInt(process.env.PRINTER_DRAWER_ON_MS || "50", 10);
  const offMs = parseInt(process.env.PRINTER_DRAWER_OFF_MS || "500", 10);
  const pinRaw = String(process.env.PRINTER_DRAWER_PIN || "0").trim();
  const inverted = String(process.env.PRINTER_DRAWER_INVERTED || "").toLowerCase() === "true";
  let pin = pinRaw === "1" ? 1 : 0;
  if (inverted) pin = pin === 0 ? 1 : 0;
  const t1 = clampDrawerByte(Math.max(1, onMs / 2));
  const t2 = clampDrawerByte(Math.max(1, offMs / 2));
  return Buffer.from([0x1b, 0x70, pin, t1, t2]);
}

/**
 * Decide se o job deve anexar pulso de gaveta.
 * - abrirGaveta true/false no payload manda
 * - PRINTER_DRAWER=false desliga tudo
 * - auto: dinheiro / espécie / cash
 * - opts.sempre: abertura / sangria / suprimento / teste
 */
function deveAbrirGavetaNoPayload(payload, opts = {}) {
  if (!drawerEnabled()) return false;
  if (payload && payload.abrirGaveta === false) return false;
  if (payload && payload.abrirGaveta === true) return true;
  if (opts.sempre === true) return true;
  const forma = String(payload?.formaPagamento || payload?.labelPagamento || "").toLowerCase();
  if (/dinheiro|cash|esp[eé]cie/.test(forma)) return true;
  const pags = payload?.pagamentos;
  if (Array.isArray(pags)) {
    for (const p of pags) {
      const f = String(p?.forma || p?.tipo || p?.formaPagamento || "").toLowerCase();
      if (/dinheiro|cash|esp[eé]cie/.test(f)) return true;
    }
  }
  return false;
}

async function imprimirComGavetaOpcional(renderFn, payload, opts = {}) {
  return comLockImpressao(async () => {
    const tBuf = performance.now();
    let buffer = await gerarBuffer(renderFn);
    const bufferMs = performance.now() - tBuf;
    log.warn(
      {
        bufferMs,
        bytes: buffer.length,
        metric: "print.buffer_generation_timing",
        note: "gerarBuffer (MemoryDevice) — logo só via cache quente",
      },
      "[ImpressoraCore] Buffer ESC/POS generation timing",
    );
    if (bufferMs > 800) {
      log.warn(
        { bufferMs, bytes: buffer.length, metric: "print.buffer_slow" },
        "[ImpressoraCore] Geração de buffer ESC/POS lenta",
      );
    }
    const anexarGaveta =
      deveAbrirGavetaNoPayload(payload, opts) && !gavetaPulseRecente();
    if (anexarGaveta) {
      buffer = Buffer.concat([buffer, drawerPulseBuffer()]);
    }
    const result = await enviarBuffer(buffer);
    if (anexarGaveta) markGavetaPulseSent();
    return result;
  });
}

/**
 * Abre gaveta via ESC/POS nativo (rápido).
 * @param {{ force?: boolean }} [opts] force=true ignora coalesce (botão teste / abertura explícita).
 */
function abrirGaveta(opts = {}) {
  if (!drawerEnabled()) {
    return Promise.resolve({ ok: true, skipped: true, motivo: "PRINTER_DRAWER=false" });
  }
  const force = opts === true || opts?.force === true;
  if (!force && gavetaPulseRecente()) {
    return Promise.resolve({
      ok: true,
      gaveta: true,
      coalesced: true,
      metric: "print.gaveta_coalesced",
    });
  }
  const buffer = drawerPulseBuffer();
  return comLockImpressao(() =>
    enviarBuffer(buffer).then((sendResult) => {
      markGavetaPulseSent();
      return {
        ok: true,
        gaveta: true,
        forced: force,
        bytes: buffer.length,
        provider: "native",
        ...(sendResult && typeof sendResult === "object" ? sendResult : {}),
      };
    }),
  );
}

module.exports = {
  rawHelperDllPath,
  rawWorkDir,
  ensureRawPrintScript,
  testar,
  getInfo,
  listar,
  detectar: () => detectarImpressora(true),
  detectarImpressora,
  invalidateDiscoveryCache,
  invalidateLogoEscposImageCache() {
    logoEscposImageCache = { key: null, image: null, rawBytes: null, paintedAt: 0 };
  },
  isLogoEscposReady() {
    return !!(logoEscposImageCache.rawBytes && logoEscposImageCache.rawBytes.length);
  },
  isPrintHotPathReady,
  isWarmHotPathInFlight,
  async warmLogoEscposImage(caminho, info) {
    if (!caminho) return false;
    if (impressaoEmAndamentoLocal()) return false;
    const size = info?.printSize || require("../printerLogoSize").resolveLogoPrintSize(info || {});
    const density = size.density || "d24";
    const cacheKey = `${info?.sha256 || caminho}|${size.escposWidthDots}|${density}`;
    if (
      logoEscposImageCache.key === cacheKey &&
      logoEscposImageCache.rawBytes &&
      logoEscposImageCache.rawBytes.length
    ) {
      return true;
    }
    const t0 = performance.now();
    const image = await new Promise((resolve, reject) => {
      escpos.Image.load(caminho, (err, img) => {
        if (err) reject(err);
        else resolve(img);
      });
    });
    if (impressaoEmAndamentoLocal()) return false;

    // Pré-raster completo (align + bitmap + feed) — hot path só printer.raw(bytes).
    const device = new MemoryDevice();
    const rawBytes = await new Promise((resolve, reject) => {
      device.open((err) => {
        if (err) return reject(err);
        const printer = new escpos.Printer(device, { encoding: "CP860" });
        try {
          printer.align("ct");
          Promise.resolve(printer.image(image, density))
            .then(() => {
              printer.feed(1);
              device.close(() => resolve(device.getBuffer()));
            })
            .catch(reject);
        } catch (e) {
          reject(e);
        }
      });
    });

    logoEscposImageCache = { key: cacheKey, image, rawBytes, paintedAt: 0 };
    log.info(
      {
        loadMs: performance.now() - t0,
        bytes: rawBytes.length,
        cacheKey: cacheKey.slice(0, 24),
        metric: "print.logo_warm_image",
      },
      "[ImpressoraCore] Logo raster ESC/POS aquecido no cache",
    );
    return true;
  },
  warmRawWin32Helper,
  warmPrintHotPath,
  rawWorkDir,
  ensureRawPrintScript,
  buildRawPrintScriptContent,
  resetRawScriptCacheForTests,
  resolverPortaAcbrConfigurada,
  resolverNomeRawConfigurado,
  bytesQrGsK,
  imprimirCupom,
  imprimirTeste,
  imprimirTesteBarcode,
  abrirGaveta,
  deveAbrirGavetaNoPayload,
  drawerPulseBuffer,
  drawerEnabled,
  imprimirAbertura,
  imprimirFechamento,
  imprimirMovimentoCaixa,
  imprimirPedido,
  imprimirVasilhame,
  imprimirCrediario,
  /** Bytes crus (ZPL/PPLA) — sem ESC/POS/ACBr. */
  enviarBuffer,
  assertPortaTermicaOuFalhar,
  pareceNaoTermica,
  /** @internal regressão COLS / TDZ no render nativo + P2a + gaveta */
  __test: {
    renderCupomConteudo,
    renderFechamentoConteudo,
    rawPrintTimeoutMs,
    rawKillHoldMs,
    makeRawTimeoutError,
    parseRawTimingFromStdout,
    logRawWin32Timing,
    drawerPulseBuffer,
    deveAbrirGavetaNoPayload,
    drawerEnabled,
    markGavetaPulseSent,
    gavetaPulseRecente,
    resetGavetaPulse() {
      _lastGavetaPulseAt = 0;
    },
    gerarBuffer,
    imprimirLogoCupomEscpos,
  },
};
