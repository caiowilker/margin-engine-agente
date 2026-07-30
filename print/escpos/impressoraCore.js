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

const escpos = require("escpos");

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
const PRINTER_TYPE = (process.env.PRINTER_TYPE || "auto")
  .toLowerCase()
  // "winusb" é alias de "windows" — usa o spooler do Windows (RAW) via winspool.drv
  .replace(/^winusb$/, "windows");
const PRINTER_HOST = (process.env.PRINTER_HOST || "").trim();
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || "9100", 10);
const PRINTER_NAME = (process.env.PRINTER_NAME || "").trim();
// Porta física da impressora no Windows (USB001, USB002, COM3...).
// Quando definida, é usada para localizar a impressora correta mesmo sem PRINTER_NAME.
const PRINTER_PATH = (process.env.PRINTER_PATH || "").trim();

const TERMICA_RX =
  /elgin|bematech|daruma|tanca|jetway|thermal|tm-|mp-|i9|i7|pos\s*80|pos80|posprinter|cupom|nfce|receipt|termica|tm-t|tm-m/i;
/** Jato/laser — ESC/POS RAW trava spooler ~2min e derruba o agente. */
const NAO_TERMICA_RX =
  /l4260|l3250|l3210|l1250|l3150|l4150|l5290|inkjet|deskjet|officejet|laserjet|ecosys|brother\s*hl|dcp-|mfc-|et-2|et-2[78]|workforce|stylus|pixma|onenote|microsoft\s*print\s*to\s*pdf|fax|xps|onenote|send\s*to\s*onenote|pdf|microsoft\s*xps|anydesk|snagit|adobe\s*pdf/i;

const REDE_PORTAS = [9100, 9101, 515];
const CACHE_TTL_MS = 30000;
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

const RAW_PRINT_SCRIPT = path.join(os.tmpdir(), "pdv-margin-raw-print.ps1");
if (IS_WIN) {
  try {
    fs.writeFileSync(
      RAW_PRINT_SCRIPT,
      `$cfg = Get-Content -Raw $args[0] | ConvertFrom-Json
$bytes = [System.IO.File]::ReadAllBytes($cfg.file)
if (-not ("RawPrinterHelper" -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
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
'@
}
$h = [IntPtr]::Zero
if (-not [RawPrinterHelper]::OpenPrinter($cfg.printer, [ref]$h, [IntPtr]::Zero)) {
  throw "Nao foi possivel abrir a impressora: $($cfg.printer)"
}
try {
  $di = New-Object RawPrinterHelper+DOCINFOA
  $di.pDocName = "PDV Cupom"
  $di.pDatatype = "RAW"
  if (-not [RawPrinterHelper]::StartDocPrinter($h, 1, $di)) { throw "StartDocPrinter falhou" }
  try {
    if (-not [RawPrinterHelper]::StartPagePrinter($h)) { throw "StartPagePrinter falhou" }
    $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $p, $bytes.Length)
    $written = 0
    if (-not [RawPrinterHelper]::WritePrinter($h, $p, $bytes.Length, [ref]$written)) { throw "WritePrinter falhou" }
    [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
    [RawPrinterHelper]::EndPagePrinter($h) | Out-Null
  } finally { [RawPrinterHelper]::EndDocPrinter($h) | Out-Null }
} finally { [RawPrinterHelper]::ClosePrinter($h) | Out-Null }
Remove-Item $cfg.file -Force -ErrorAction SilentlyContinue
`,
      "utf8",
    );
  } catch (_) {}
}

function comLockImpressao(fn) {
  const exec = printLock.then(() => fn());
  printLock = exec.catch(() => {});
  return exec;
}

// ── Device em memoria (gera buffer ESC/POS) ───────────────────────────────────
class MemoryDevice {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this._open = false;
  }

  open(cb) {
    this._open = true;
    this.buffer = Buffer.alloc(0);
    cb(null);
  }

  write(data, cb) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (cb) cb(null);
  }

  close(cb) {
    this._open = false;
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
        const done = () => device.close(() => resolve(device.buffer));
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
const LISTAR_PRINTERS_TIMEOUT_MS = parseInt(
  process.env.PRINTER_LIST_TIMEOUT_MS || "5000",
  10,
);
const RAW_PRINT_TIMEOUT_MS = parseInt(
  process.env.PRINTER_RAW_TIMEOUT_MS || "8000",
  10,
);

let printersWinCache = { list: [], at: 0 };
let printersWinInflight = null;

/**
 * Lista impressoras Windows sem congelar o event loop.
 * Single-flight + cache 30s — Get-Printer via execFile (nunca execFileSync).
 */
function listarImpressorasWindowsAsync(force = false) {
  if (!IS_WIN) return Promise.resolve([]);
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

    const killTree = (pid) => {
      if (!pid) return;
      try {
        execFile(
          "taskkill",
          ["/F", "/T", "/PID", String(pid)],
          { windowsHide: true, timeout: 5000 },
          () => {},
        );
      } catch (_) {}
    };

    const softKill = setTimeout(() => {
      killTree(child.pid);
      try {
        child.kill();
      } catch (_) {}
      finish(printersWinCache.list);
    }, LISTAR_PRINTERS_TIMEOUT_MS);
    const hardKill = setTimeout(() => {
      killTree(child.pid);
    }, LISTAR_PRINTERS_TIMEOUT_MS + 1500);
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

/** Nome Windows da porta RAW configurada (PRINTER_PORTA / local config). */
function resolverNomeRawConfigurado() {
  try {
    const porta =
      require("../printerLocalConfig").ler()?.porta ||
      process.env.PRINTER_PORTA ||
      "";
    const m = /^RAW:(.+)$/i.exec(String(porta).trim());
    if (m && m[1].trim()) return m[1].trim();
  } catch (_) {
    /* ignore */
  }
  if (PRINTER_NAME) return PRINTER_NAME;
  return null;
}

function escolherImpressoraWindows(lista) {
  if (!lista.length) return null;

  const usaveis = lista.filter(
    (p) => !pareceNaoTermica(p.Name || "") && !pareceNaoTermica(p.DriverName || ""),
  );

  // 1. Busca por nome exato ou parcial (PRINTER_NAME) — só se não for jato/virtual
  if (PRINTER_NAME) {
    const pool = usaveis.length ? usaveis : lista;
    const exata = pool.find(
      (p) => p.Name && p.Name.toLowerCase() === PRINTER_NAME.toLowerCase(),
    );
    if (exata && !pareceNaoTermica(exata.Name)) return exata;
    const parcial = pool.find(
      (p) =>
        p.Name && p.Name.toLowerCase().includes(PRINTER_NAME.toLowerCase()),
    );
    if (parcial && !pareceNaoTermica(parcial.Name)) return parcial;
  }

  // 2. Busca pela porta física (PRINTER_PATH: USB001, USB002, COM3...)
  if (PRINTER_PATH) {
    const porta = usaveis.find(
      (p) =>
        p.PortName && p.PortName.toLowerCase() === PRINTER_PATH.toLowerCase(),
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
 */
function enviarRawWindows(nomeImpressora, buffer) {
  assertPortaTermicaOuFalhar(nomeImpressora);
  const tmpBin = path.join(
    os.tmpdir(),
    `pdv-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`,
  );
  const tmpCfg = path.join(
    os.tmpdir(),
    `pdv-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(tmpBin, buffer);
  fs.writeFileSync(
    tmpCfg,
    JSON.stringify({ printer: nomeImpressora, file: tmpBin }),
    "utf8",
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      try {
        fs.unlinkSync(tmpCfg);
      } catch (_) {}
      try {
        fs.unlinkSync(tmpBin);
      } catch (_) {}
    };
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(softKill);
      clearTimeout(hardKill);
      cleanup();
      fn(val);
    };

    /** SIGTERM/SIGKILL não derrubam árvore PowerShell no Windows — taskkill /T. */
    const killTree = (pid) => {
      if (!pid) return;
      if (process.platform === "win32") {
        try {
          execFile(
            "taskkill",
            ["/F", "/T", "/PID", String(pid)],
            { windowsHide: true, timeout: 5000 },
            () => {},
          );
        } catch (_) {}
        return;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch (_) {}
    };

    const child = execFile(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        RAW_PRINT_SCRIPT,
        tmpCfg,
      ],
      { windowsHide: true },
      (err) => {
        if (settled) return;
        if (err) {
          const timedOut =
            err.killed ||
            /SIGKILL|SIGTERM|ETIMEDOUT|timeout|taskkill/i.test(
              String(err.signal || "") + String(err.message || ""),
            );
          return finish(
            reject,
            new Error(
              timedOut
                ? `RAW Windows timeout (${RAW_PRINT_TIMEOUT_MS}ms): ${nomeImpressora}`
                : `RAW Windows falhou: ${err.message}`,
            ),
          );
        }
        finish(resolve, true);
      },
    );

    // Soft: rejeita na hora + mata árvore (antes o kill não rejeitava → ~120s hang)
    const softKill = setTimeout(() => {
      killTree(child.pid);
      try {
        child.kill();
      } catch (_) {}
      finish(
        reject,
        new Error(
          `RAW Windows timeout (${RAW_PRINT_TIMEOUT_MS}ms): ${nomeImpressora}`,
        ),
      );
    }, RAW_PRINT_TIMEOUT_MS);
    const hardKill = setTimeout(() => {
      killTree(child.pid);
    }, RAW_PRINT_TIMEOUT_MS + 1500);
    child.on("exit", () => {
      clearTimeout(softKill);
      clearTimeout(hardKill);
    });
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
  if (PRINTER_HOST) hosts.push(PRINTER_HOST);

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
      [PRINTER_PORT, ...REDE_PORTAS].filter(
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
      nome: PRINTER_NAME || `USB (${devices.length} dispositivo(s))`,
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

  const candidatos = [];
  const win = await detectarWindows(force);
  if (win) candidatos.push(win);
  const usb = detectarUsb();
  if (usb) candidatos.push(usb);
  // Com RAW configurado, não gasta tempo em scan de rede na descoberta
  const rede = resolverNomeRawConfigurado()
    ? null
    : await detectarRede();
  if (rede) candidatos.push(rede);

  let escolhida = null;
  if (PRINTER_TYPE === "windows" && win) escolhida = win;
  else if (PRINTER_TYPE === "usb" && usb) escolhida = usb;
  else if (PRINTER_TYPE === "network" && rede) escolhida = rede;
  else if (PRINTER_TYPE === "network" && PRINTER_HOST) {
    const port = Number(PRINTER_PORT) || 9100;
    if (await testarRede(PRINTER_HOST, port, 1500)) {
      escolhida = {
        metodo: "network",
        host: PRINTER_HOST,
        porta: port,
        nome: `${PRINTER_HOST}:${port}`,
      };
    }
  } else if (PRINTER_TYPE === "auto") {
    const portaAcbr = String(process.env.PRINTER_PORTA || "").trim();
    const prefereWindows =
      !!PRINTER_NAME ||
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
    tipoConfigurado: PRINTER_TYPE,
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

  const rawConfigurado = resolverNomeRawConfigurado();

  if (stationOverride && /^TCP:/i.test(stationOverride)) {
    const { parsePortaTcp } = require("../printerModelMap");
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
  } else if (rawConfigurado && IS_WIN) {
    // Caminho rápido: porta RAW já configurada — sem Get-Printer / scan de rede
    add("windows-raw-config", async () => {
      await enviarRawWindows(rawConfigurado, buffer);
      ultimaImpressoraUsada = { metodo: "windows", nome: rawConfigurado };
    });
  }

  if (PRINTER_TYPE === "windows" || PRINTER_TYPE === "auto") {
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

  if (PRINTER_TYPE === "network" || PRINTER_TYPE === "auto") {
    add("network", async () => {
      let rede =
        cacheImpressoraEscolhida?.resultado?.impressora?.metodo === "network"
          ? cacheImpressoraEscolhida.resultado.impressora
          : null;
      if (!rede && PRINTER_HOST) {
        const port = Number(PRINTER_PORT) || 9100;
        if (await testarRede(PRINTER_HOST, port, 1500)) {
          rede = { host: PRINTER_HOST, porta: port };
        }
      }
      if (!rede && (PRINTER_TYPE === "network" || PRINTER_TYPE === "auto")) {
        // Com RAW configurado, não gastar tempo em scan de rede
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

  if (PRINTER_TYPE === "usb" || PRINTER_TYPE === "auto") {
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

  // RAW configurado: NÃO varrer rede/USB (segundos a mais + agente “pesado”).
  // Só RAW → rediscovery Windows (cache/Get-Printer). Strict = falha na hora.
  const rawStrict =
    String(process.env.PRINT_RAW_STRICT || "false").toLowerCase() === "true";
  const rawOnlyPath = !!(rawConfigurado && IS_WIN && !stationOverride);

  const ordemBase = rawOnlyPath
    ? rawStrict
      ? []
      : ["windows"]
    : PRINTER_TYPE === "windows"
      ? ["windows"]
      : PRINTER_TYPE === "network"
        ? ["network", "windows", "usb"]
        : PRINTER_TYPE === "usb"
          ? ["usb", "windows", "network"]
          : IS_WIN
            ? ["windows", "network", "usb"]
            : ["usb", "network", "windows"];

  const ordem = [
    "network-station",
    "windows-station",
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
      "\nDica: instale o driver da impressora no Windows ou configure PRINTER_NAME / PRINTER_HOST no .env",
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
  const data = Buffer.from(String(conteudo), "utf8");
  const moduleSize = Math.min(16, Math.max(1, Number(opts.moduleSize) || qrNfceModuleSize()));
  const nivelCfg = String(
    opts.errorLevel || process.env.PRINTER_QR_ERROR_LEVEL || "M",
  ).toUpperCase();
  const nivel = QR_GS_K_NIVEIS[nivelCfg] ?? QR_GS_K_NIVEIS.M;
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
  try {
    const printerLogo = require("../printerLogo");
    if (!printerLogo.deveExibirLogoCupom(payload)) return;
    const info = printerLogo.ler();
    if (!info.caminhoAbsoluto) return;
    const size = info.printSize || require("../printerLogoSize").resolveLogoPrintSize(info);
    let caminho = info.caminhoAbsoluto;
    try {
      const scaled = await printerLogo.prepararArquivoEscpos(info);
      if (scaled) caminho = scaled;
    } catch (_) {
      /* usa BMP original se sharp falhar */
    }
    const image = await new Promise((resolve, reject) => {
      escpos.Image.load(caminho, (err, img) => {
        if (err) reject(err);
        else resolve(img);
      });
    });
    await new Promise((resolve, reject) => {
      printer.align("ct").image(image, size.density || "d24", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    printer.feed(1);
  } catch (_) {
    /* logo opcional — cupom segue sem imagem */
  }
}

async function renderCupomConteudo(printer, payload) {
  const COLS = getThermalCols();
  const empresa = payload.empresa || {};
  const itens = payload.itens || [];
  const isFiscal =
    !payload.naoFiscal &&
    !payload.cupomSemFiscal &&
    !!(payload.chaveNfe && String(payload.chaveNfe).trim());
  const isOffline = payload.origem === "offline";
  const isLocalSync = payload.origem === "local";

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

  await imprimirLogoCupomEscpos(printer, payload);

  if (require("../segundaVia").deveExibirBannerSegundaVia(payload)) {
    printer.style("b").text("*** SEGUNDA VIA ***").style("normal");
    printer.text(sepDash());
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
  if (empresa.inscricaoEstadual) {
    printer.text("IE: " + toThermalDoc(empresa.inscricaoEstadual));
  }
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
  if (payload.vendaCancelada) {
    printer.align("ct").style("b").text("*** VENDA CANCELADA ***").style("normal");
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
    const nome = tx(String(item.nome || ""));
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
          seriePadrao: "001",
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

  // ── 7. Offline / sync local ─────────────────────────────────────────────────
  if (isOffline) {
    printer.text(sepDash());
    printer
      .align("ct")
      .style("b")
      .text("** VENDA OFFLINE **")
      .style("normal")
      .text("Sera sincronizada com a internet em breve.");
  } else if (isLocalSync && !isFiscal) {
    printer.text(sepDash());
    printer
      .align("ct")
      .text("Aguardando confirmacao do servidor.");
  }

  // ── 8. Rodapé — tudo centralizado, emocional ─────────────────────────────────
  printer.align("lt").text(sepEq());
  printer
    .align("ct")
    .style("b")
    .text("Obrigado pela preferencia!")
    .style("normal")
    .text("Volte sempre. Voce e especial pra nos!")
    .text("")
    .text("PDV Margin Engine")
    .text(new Date().toLocaleString("pt-BR"))
    .text("")
    .text("")
    .text("")
    .cut();
}

function renderFechamento(printer, payload) {
  return renderFechamentoConteudo(printer, payload);
}

async function renderFechamentoConteudo(printer, payload) {
  const COLS = getThermalCols();
  printer.font("a").align("ct");
  await imprimirLogoCupomEscpos(printer, payload);

  const { sep: linha, fmt, direita } = helpers();

  printer
    .style("b")
    .size(1, 1)
    .text(
      tx(
        (
          payload.empresa?.nome ||
          payload.empresa?.nomeFantasia ||
          payload.empresa?.razaoSocial ||
          "PDV"
        ).toUpperCase(),
      ),
    )
    .style("normal")
    .size(0, 0);

  if (payload.empresa?.cnpj)
    printer.text("CNPJ: " + toThermalDoc(payload.empresa.cnpj));
  const linhaEndereco = formatarLinhaEnderecoEmpresa(payload.empresa);
  if (linhaEndereco) printer.text(linhaEndereco.slice(0, COLS));

  printer
    .text(linha())
    .style("b")
    .text("FECHAMENTO DE CAIXA")
    .style("normal")
    .text(linha());

  printer
    .align("lt")
    .text("Caixa   : " + (payload.numeroCaixa || "Principal"))
    .text("Operador: " + tx(payload.operador || "-"))
    .text("Abertura: " + (payload.aberturaEm || "-"))
    .text("Fecham. : " + (payload.fechamentoEm || "-"));

  if (payload.minutosAberto) {
    const h = Math.floor(payload.minutosAberto / 60);
    const m = payload.minutosAberto % 60;
    printer.text(
      "Tempo   : " +
        (h > 0 ? h + "h " : "") +
        String(m).padStart(2, "0") +
        "min",
    );
  }

  printer
    .align("ct")
    .text(linha())
    .style("b")
    .text("RESUMO DO DIA")
    .style("normal");
  printer
    .align("lt")
    .text("Vendas      : " + (payload.quantidadeVendas ?? 0))
    .text("Faturamento : " + fmt(payload.totalVendas));
  if (payload.totalLucro != null && Number(payload.totalLucro) !== 0) {
    printer.text("Lucro total : " + fmt(payload.totalLucro));
  }
  if (payload.margemMedia != null && Number(payload.margemMedia) !== 0) {
    printer.text(
      "Margem media: " + Number(payload.margemMedia).toFixed(1) + "%",
    );
  }

  printer
    .align("ct")
    .text(linha())
    .style("b")
    .text("POR FORMA DE PAGAMENTO")
    .style("normal");

  const formas = payload.resumoPorForma || {};
  Object.entries(formas)
    .sort(([, a], [, b]) => b.total - a.total)
    .forEach(([forma, d]) => {
      const label =
        {
          dinheiro: "Dinheiro",
          pix: "PIX",
          credito: "Credito",
          debito: "Debito",
          fiado: "Fiado",
          voucher: "Voucher",
          outros: "Outros",
          crediario: "Crediario",
        }[forma] || forma;
      const qtd = Number(d.quantidade || 0);
      printer
        .align("lt")
        .text(
          label.padEnd(10) +
            fmt(d.total).padStart(10) +
            (qtd > 0
              ? (" " + qtd + " venda(s)").padStart(12)
              : "".padStart(12)),
        );
    });

  printer
    .align("ct")
    .text(linha())
    .style("b")
    .text("CONFERENCIA DE CAIXA")
    .style("normal")
    .align("lt");
  if (payload.valorAbertura == null || Number.isNaN(Number(payload.valorAbertura))) {
    printer.text("Fundo abertura: --");
  } else {
    printer.text("Fundo abertura: " + fmt(payload.valorAbertura));
  }
  printer.text("Valor contado : " + fmt(payload.valorContado));

  const diff = Number(payload.diferenca ?? 0);
  const diffStr =
    Math.abs(diff) < 0.02
      ? "OK - caixa confere"
      : diff > 0
        ? "Sobra: " + fmt(diff)
        : "Falta: " + fmt(Math.abs(diff));
  printer.text("Diferenca     : " + tx(diffStr));

  if (payload.observacao) {
    printer
      .align("ct")
      .text(linha())
      .align("lt")
      .text("Obs: " + tx(payload.observacao));
  }

  printer
    .align("ct")
    .text(linha())
    .text("Caixa encerrado em " + payload.fechamentoEm)
    .feed(4)
    .cut();
}

function renderAbertura(printer, payload) {
  return renderAberturaConteudo(printer, payload);
}

async function renderAberturaConteudo(printer, payload) {
  const { sep: linha, fmt } = helpers();

  printer.font("a").align("ct");
  await imprimirLogoCupomEscpos(printer, payload);

  printer
    .style("b")
    .size(1, 1)
    .text("ABERTURA DE CAIXA")
    .style("normal")
    .size(0, 0);

  if (payload.empresa?.nome) {
    printer.text(tx(payload.empresa.nome));
  }
  if (payload.empresa?.cnpj) {
    printer.text("CNPJ: " + toThermalDoc(payload.empresa.cnpj));
  }

  printer
    .text(linha())
    .align("lt")
    .text("Caixa   : " + (payload.numeroCaixa || "Principal"))
    .text("Operador: " + tx(payload.operador || "-"))
    .text(
      "Data/Hr : " + (payload.aberturaEm || new Date().toLocaleString("pt-BR")),
    )
    .align("ct")
    .text(linha())
    .style("b")
    .align("lt")
    .text(
      "Fundo   : " +
        (payload.valorAbertura == null || Number.isNaN(Number(payload.valorAbertura))
          ? "--"
          : fmt(payload.valorAbertura)),
    )
    .style("normal")
    .align("ct")
    .text(linha())
    .feed(3)
    .cut();
}

async function renderPedido(printer, payload) {
  const { sep: linha } = helpers();
  const {
    normalizarPedidoPayload,
    labelEventType,
    tituloPedidoTermico,
    deveExibirTotalPedido,
    fmtQty,
    fmtTotal,
    wrapThermalLines,
  } = require("../pedidoPrint");
  const p = normalizarPedidoPayload(payload);
  const cancelado = p.eventType === "ORDER_CANCELLED";
  const showTotal = deveExibirTotalPedido(p.printType, p.eventType);

  printer.font("a").align("ct");
  await imprimirLogoCupomEscpos(printer, payload);

  printer
    .style("b")
    .size(1, 1)
    .text(tituloPedidoTermico(p.printType, p.eventType))
    .style("normal")
    .size(0, 0)
    .text(labelEventType(p.eventType));

  if (cancelado) {
    printer.style("b").text("*** CANCELADO ***").style("normal");
  }

  printer.text(linha()).align("lt");

  if (p.orderNumber) printer.text("Pedido : " + tx(p.orderNumber));
  if (p.tableCode) printer.text("Mesa   : " + tx(p.tableCode));
  if (p.customerName) printer.text("Cliente: " + tx(p.customerName));
  if (p.customerPhone) printer.text("Tel    : " + tx(p.customerPhone));
  if (p.deliveryAddress) {
    const cols = getThermalCols();
    const addrLines = wrapThermalLines(tx(p.deliveryAddress), cols - 2);
    if (addrLines.length === 1 && addrLines[0].length <= cols - 9) {
      printer.text("Endere.: " + addrLines[0]);
    } else {
      printer.text("Endereco:");
      for (const line of addrLines) {
        printer.text("  " + line);
      }
    }
  }
  if (p.createdAt) printer.text("Data/Hr: " + tx(p.createdAt));
  if (p.elapsedSeconds > 0) printer.text("Tempo  : " + p.elapsedSeconds + "s");
  if (p.priority && p.priority !== "normal") {
    printer.text("Prior. : " + tx(p.priority).toUpperCase());
  }

  printer.align("ct").text(linha()).align("lt").style("b").text("ITENS").style("normal");
  printer.align("ct").text(linha()).align("lt");

  if (!p.items.length) {
    printer.text("(sem itens)");
  } else {
    for (const item of p.items) {
      const qty = fmtQty(item.quantity, item.unit);
      const nome = tx(item.name || item.code || "Item");
      printer.style("b").text(qty + " x " + nome).style("normal");
      if (showTotal && item.lineTotal != null) {
        const unitFmt = item.unitPrice != null ? fmtTotal(item.unitPrice) : null;
        const lineFmt = fmtTotal(item.lineTotal);
        if (unitFmt && lineFmt) {
          printer.text("  " + unitFmt + "  =  " + lineFmt);
        } else if (lineFmt) {
          printer.text("  " + lineFmt);
        }
      }
      if (item.notes) {
        printer.text("  * " + tx(item.notes));
      }
      if (item.code && item.name) {
        printer.text("  Cod: " + tx(item.code));
      }
    }
  }

  const totalFmt = showTotal ? fmtTotal(p.total) : null;
  if (totalFmt) {
    printer.align("ct").text(linha()).align("lt").style("b").text("Total : " + totalFmt).style("normal");
  }
  if (p.notes) {
    printer.text("Obs: " + tx(p.notes));
  }

  printer.align("ct").text(linha()).feed(3).cut();
}

async function renderMovimentoCaixa(printer, payload) {
  const { sep: linha, fmt } = helpers();
  const tipoLabel = payload.tipo === "suprimento" ? "SUPRIMENTO" : "SANGRIA";

  printer.font("a").align("ct");
  await imprimirLogoCupomEscpos(printer, payload);

  printer
    .style("b")
    .size(1, 1)
    .text(tipoLabel + " DE CAIXA")
    .style("normal")
    .size(0, 0)
    .text(linha())
    .align("lt")
    .text("Caixa   : " + (payload.numeroCaixa || "Principal"))
    .text("Operador: " + tx(payload.operador || "-"))
    .text("Data/Hr : " + (payload.emitidoEm || "-"))
    .align("ct")
    .text(linha())
    .style("b")
    .align("lt")
    .text("Valor   : " + fmt(payload.valor))
    .style("normal")
    .text("Motivo  : " + tx(payload.motivo || "-"))
    .text("Saldo   : " + fmt(payload.saldoAtual))
    .align("ct")
    .text(linha())
    .feed(3)
    .cut();
}

// ── API publica ───────────────────────────────────────────────────────────────
async function testar(force = false) {
  try {
    const info = await detectarImpressora(force);
    if (info?.impressora) {
      try {
        require("../printerLocalConfig").sincronizarDeDeteccao(info);
      } catch (_) {}
    }
    return info.ok;
  } catch (_) {
    return false;
  }
}

async function getInfo(force = false) {
  return detectarImpressora(force);
}

function listar() {
  // Cache only — nunca Get-Printer síncrono. Refresh em background.
  void listarImpressorasWindowsAsync();
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
    tipoConfigurado: PRINTER_TYPE,
    nomeConfigurado: PRINTER_NAME || rawNome || null,
    hostConfigurado: PRINTER_HOST || null,
    portaConfigurada: PRINTER_PORT,
    windows,
    usb,
    ultimaUsada: ultimaImpressoraUsada,
  };
}

function imprimirCupom(payload) {
  const normalizado = normalizarCupomPayload(payload, {
    relaxQr: deveRelaxarQr(payload),
  });
  return imprimirRender((printer) => renderCupom(printer, normalizado));
}

function imprimirTeste() {
  return imprimirRender(async (printer) => {
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
    printer.align("ct").text("Fim do teste — corte abaixo");
    printer.feed(2);
  });
}

function imprimirFechamento(payload) {
  return imprimirRender((printer) => renderFechamento(printer, payload));
}

function imprimirAbertura(payload) {
  return imprimirRender((printer) => renderAbertura(printer, payload));
}

function imprimirMovimentoCaixa(payload) {
  return imprimirRender((printer) => renderMovimentoCaixa(printer, payload));
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

function abrirGaveta() {
  const buffer = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  return comLockImpressao(() => enviarBuffer(buffer));
}

module.exports = {
  testar,
  getInfo,
  listar,
  detectar: () => detectarImpressora(true),
  detectarImpressora,
  bytesQrGsK,
  imprimirCupom,
  imprimirTeste,
  abrirGaveta,
  imprimirAbertura,
  imprimirFechamento,
  imprimirMovimentoCaixa,
  imprimirPedido,
  assertPortaTermicaOuFalhar,
  pareceNaoTermica,
  /** @internal regressão COLS / TDZ no render nativo */
  __test: {
    renderCupomConteudo,
    renderFechamentoConteudo,
  },
};
