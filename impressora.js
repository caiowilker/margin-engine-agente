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
const { execFileSync } = require("child_process");

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
  /epson|elgin|bematech|daruma|tanca|jetway|thermal|tm-|mp-|i9|i7|pos|cupom|nfce|receipt|termica/i;

const REDE_PORTAS = [9100, 9101, 515];
const CACHE_TTL_MS = 30000;
const AGENT_PORT = parseInt(process.env.PORT || "9100", 10);
const IMPRIMIR_QR_NFCE =
  (process.env.IMPRIMIR_QR_NFCE || "false").toLowerCase() === "true";

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
      try {
        const printer = new escpos.Printer(device, { encoding: "CP860" });
        renderFn(printer);
        const finalizar = () => device.close(() => resolve(device.buffer));
        if (typeof printer.close === "function") {
          printer.close(finalizar);
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
function listarImpressorasWindows() {
  if (!IS_WIN) return [];
  try {
    const raw = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-Printer | Select-Object Name,PortName,DriverName,Default | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (_) {
    return [];
  }
}

function escolherImpressoraWindows(lista) {
  if (!lista.length) return null;

  // 1. Busca por nome exato ou parcial (PRINTER_NAME)
  if (PRINTER_NAME) {
    const exata = lista.find(
      (p) => p.Name && p.Name.toLowerCase() === PRINTER_NAME.toLowerCase(),
    );
    if (exata) return exata;
    const parcial = lista.find(
      (p) =>
        p.Name && p.Name.toLowerCase().includes(PRINTER_NAME.toLowerCase()),
    );
    if (parcial) return parcial;
  }

  // 2. Busca pela porta física (PRINTER_PATH: USB001, USB002, COM3...)
  if (PRINTER_PATH) {
    const porta = lista.find(
      (p) =>
        p.PortName && p.PortName.toLowerCase() === PRINTER_PATH.toLowerCase(),
    );
    if (porta) return porta;
  }

  const termicas = lista.filter(
    (p) =>
      TERMICA_RX.test(p.Name || "") ||
      TERMICA_RX.test(p.DriverName || "") ||
      /USB|COM|WSD|TCP|IP_/i.test(p.PortName || ""),
  );

  const padrao = lista.find((p) => p.Default);
  return termicas[0] || padrao || lista[0];
}

function enviarRawWindows(nomeImpressora, buffer) {
  const tmpBin = path.join(os.tmpdir(), `pdv-print-${Date.now()}.bin`);
  const tmpCfg = path.join(os.tmpdir(), `pdv-print-${Date.now()}.json`);
  fs.writeFileSync(tmpBin, buffer);
  fs.writeFileSync(
    tmpCfg,
    JSON.stringify({ printer: nomeImpressora, file: tmpBin }),
    "utf8",
  );

  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        RAW_PRINT_SCRIPT,
        tmpCfg,
      ],
      { timeout: 15000, windowsHide: true },
    );
    return true;
  } finally {
    try {
      fs.unlinkSync(tmpCfg);
    } catch (_) {}
    try {
      fs.unlinkSync(tmpBin);
    } catch (_) {}
  }
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

function obterHostsRede() {
  const hosts = [];
  if (PRINTER_HOST) hosts.push(PRINTER_HOST);

  // Extrai IP de impressoras Windows (ex: IP_192.168.1.50, 192.168.1.50)
  for (const p of listarImpressorasWindows()) {
    const ip = extrairIpPorta(p.PortName);
    if (ip) hosts.push(ip);
  }

  // Nunca escaneia localhost — seria o proprio agente na porta 9100
  return [...new Set(hosts.filter(Boolean))];
}

async function detectarRede() {
  const hosts = obterHostsRede();
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

function detectarWindows() {
  const lista = listarImpressorasWindows();
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
  const win = detectarWindows();
  if (win) candidatos.push(win);
  const usb = detectarUsb();
  if (usb) candidatos.push(usb);
  const rede = await detectarRede();
  if (rede) candidatos.push(rede);

  let escolhida = null;
  if (PRINTER_TYPE === "windows" && win) escolhida = win;
  else if (PRINTER_TYPE === "usb" && usb) escolhida = usb;
  else if (PRINTER_TYPE === "network" && rede) escolhida = rede;
  else if (PRINTER_TYPE === "network" && PRINTER_HOST)
    escolhida = {
      metodo: "network",
      host: PRINTER_HOST,
      porta: PRINTER_PORT,
      nome: `${PRINTER_HOST}:${PRINTER_PORT}`,
    };
  else if (IS_WIN && win) escolhida = win;
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

  if (PRINTER_TYPE === "windows" || PRINTER_TYPE === "auto") {
    add("windows", async () => {
      const win =
        cacheImpressoraEscolhida?.resultado?.impressora?.metodo === "windows"
          ? cacheImpressoraEscolhida.resultado.impressora
          : detectarWindows();
      if (!win) throw new Error("Nenhuma impressora Windows encontrada.");
      enviarRawWindows(win.nome, buffer);
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
        rede = { host: PRINTER_HOST, porta: PRINTER_PORT };
      }
      if (!rede && PRINTER_TYPE === "network") {
        rede = await detectarRede();
      }
      if (!rede && PRINTER_TYPE === "auto" && !IS_WIN) {
        rede = await detectarRede();
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

  const ordem =
    PRINTER_TYPE === "windows"
      ? ["windows"]
      : PRINTER_TYPE === "network"
        ? ["network", "windows", "usb"]
        : PRINTER_TYPE === "usb"
          ? ["usb", "windows", "network"]
          : IS_WIN
            ? ["windows", "network", "usb"]
            : ["usb", "network", "windows"];

  for (const metodo of ordem) {
    const t = tentativas.find((x) => x.metodo === metodo);
    if (!t) continue;
    try {
      await t.fn();
      return { ok: true, metodo, ultima: ultimaImpressoraUsada };
    } catch (err) {
      erros.push(`${metodo}: ${err.message}`);
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

// ── Helpers de layout ─────────────────────────────────────────────────────────
function helpers() {
  const largura = 48;
  const linha = (txt) => txt.padEnd(largura, " ").slice(0, largura);
  const sep = () => "-".repeat(largura);
  const centro = (txt) => {
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
  return { largura, linha, sep, centro, moeda, direita, fmt };
}

// ── Formatadores locais ───────────────────────────────────────────────────────
const COLS = 48; // colunas da fonte "A" em 80 mm (48 colunas)

function padR(txt, len) {
  return String(txt).slice(0, len).padEnd(len);
}
function padL(txt, len) {
  return String(txt).slice(0, len).padStart(len);
}
function col2(esq, dir, total = COLS) {
  const e = String(esq);
  const d = String(dir);
  const sp = Math.max(1, total - e.length - d.length);
  return e + " ".repeat(sp) + d;
}
function centro(txt, total = COLS) {
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
  return "=".repeat(COLS);
}
function sepDash() {
  return "-".repeat(COLS);
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
  const empresa = payload.empresa || {};
  const itens = payload.itens || [];
  const isFiscal = !!(payload.chaveNfe && payload.chaveNfe.trim());
  const isOffline = payload.origem === "offline";

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

  // Nome da loja: tamanho duplo (largura + altura) → âncora de marca
  const nomeEmpresa = (
    empresa.nomeFantasia ||
    empresa.razaoSocial ||
    "ESTABELECIMENTO"
  ).toUpperCase();
  printer.style("b").size(1, 1).text(nomeEmpresa).size(0, 0).style("normal");

  if (empresa.razaoSocial && empresa.razaoSocial !== empresa.nomeFantasia)
    printer.text(empresa.razaoSocial);
  if (empresa.cnpj) printer.text("CNPJ: " + empresa.cnpj);
  if (empresa.endereco) {
    const end = [empresa.endereco, empresa.numero, empresa.bairro]
      .filter(Boolean)
      .join(", ");
    printer.text(end.slice(0, COLS));
  }
  if (empresa.cidade)
    printer.text(
      `${empresa.cidade}${empresa.uf ? " - " + empresa.uf : ""}`.slice(0, COLS),
    );
  if (empresa.telefone) printer.text("Tel: " + empresa.telefone);

  // ── 2. Título do cupom — centralizado entre separadores duplos ──────────────
  printer.align("lt").text(sepEq());
  printer.align("ct").style("b");
  printer.text(isFiscal ? "CUPOM FISCAL NFC-e" : "CUPOM NAO FISCAL");
  printer.style("normal");
  printer.align("lt").text(sepEq());

  // ── 3. Identificação — alinhada col2 (esq:dir) ──────────────────────────────
  const dtVenda = new Date(payload.emitidoEm || Date.now());
  const dataStr = dtVenda.toLocaleDateString("pt-BR");
  const horaStr = dtVenda.toLocaleTimeString("pt-BR");

  printer.align("lt");
  printer.text(col2("Nro:", payload.numeroVenda || ""));
  printer.text(col2("Data:", dataStr + "  " + horaStr));
  if (payload.operador) printer.text(col2("Operador:", payload.operador));
  if (payload.nomeCliente && payload.nomeCliente !== "Consumidor")
    printer.text(col2("Cliente:", payload.nomeCliente.slice(0, 28)));
  if (payload.cpfCliente) printer.text(col2("CPF:", payload.cpfCliente));

  // ── 4. Itens ─────────────────────────────────────────────────────────────────
  printer.text(sepDash());
  // Cabeçalho de coluna: DESCRICAO à esq, UNIT centralizado, TOTAL à dir
  printer.text(padR("DESCRICAO", 26) + padL("UNIT", 8) + padL("TOTAL", 8));
  printer.text(sepDash());

  itens.forEach((item, idx) => {
    const num = String(idx + 1).padStart(2, "0");
    const nome = String(item.nome || "").slice(0, COLS);
    const total = item.total ?? item.precoUnitario * item.quantidade;
    // Valores sem "R$ " para economizar colunas na tabela
    const valUnit = Number(item.precoUnitario).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const valTotal = Number(total).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const fUnit = fmtR$(item.precoUnitario);

    if (nome.length <= 24) {
      // Nome curto: tudo em uma linha
      printer.text(
        num + " " + padR(nome, 23) + padL(valUnit, 9) + padL(valTotal, 9),
      );
    } else {
      // Nome longo: nome em linha própria, valores na linha seguinte
      printer.text(num + " " + nome.slice(0, COLS - 3));
      printer.text("   " + padR("", 22) + padL(valUnit, 9) + padL(valTotal, 9));
    }

    // Linha de detalhe de quantidade — discreta, indentada
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
  const formaLabel =
    LABEL_PGTO[payload.formaPagamento] ||
    (payload.formaPagamento || "").toUpperCase();
  if (formaLabel) printer.text(col2("Pagamento:", formaLabel));

  if (valorRecebido > 0 && payload.formaPagamento === "dinheiro") {
    printer.text(col2("Recebido:", fmtR$(valorRecebido)));
    // TROCO em destaque — bold, tamanho normal para respeitar largura
    printer.text(sepDash());
    printer
      .align("ct")
      .style("b")
      .size(0, 0)
      .text("TROCO: " + fmtR$(troco))
      .style("normal");
    printer.align("lt").text(sepDash());
  }

  // Volumes
  const totalVols = itens.reduce((s, i) => s + Number(i.quantidade || 0), 0);
  printer.text(col2("Volumes:", Math.round(totalVols) + " item(ns)"));

  // ── 6. NFC-e ─────────────────────────────────────────────────────────────────
  if (isFiscal) {
    printer.text(sepDash());
    printer
      .align("ct")
      .style("b")
      .text("DOCUMENTO FISCAL NFC-e")
      .style("normal")
      .text(
        `NF-e: ${payload.numeroNfe || ""}  Serie: ${payload.serieNfe || "001"}`,
      );
    const chave = String(payload.chaveNfe || "");
    if (chave) {
      printer.text("Chave:");
      printer.text(chave.slice(0, 22));
      printer.text(chave.slice(22, 44));
    }
    printer.text("Consulte: nfce.fazenda.gov.br");
    if (payload.qrcodeNfe && IMPRIMIR_QR_NFCE) {
      try {
        printer.qrimage(payload.qrcodeNfe, {
          type: "png",
          mode: "dhdw",
          size: 3,
        });
      } catch (_) {
        printer.text("[QR Code indisponivel]");
      }
    }
  }

  // ── 7. Offline ───────────────────────────────────────────────────────────────
  if (isOffline) {
    printer.text(sepDash());
    printer
      .align("ct")
      .style("b")
      .text("** VENDA OFFLINE **")
      .style("normal")
      .text("Sera sincronizada com a internet em breve.");
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
  const { sep: linha, fmt, direita } = helpers();

  printer
    .font("a")
    .align("ct")
    .style("b")
    .size(1, 1)
    .text(payload.empresa?.nome || "PDV")
    .style("normal")
    .size(0, 0);

  if (payload.empresa?.cnpj) printer.text("CNPJ: " + payload.empresa.cnpj);
  if (payload.empresa?.endereco) printer.text(payload.empresa.endereco);

  printer
    .text(linha())
    .style("b")
    .text("FECHAMENTO DE CAIXA")
    .style("normal")
    .text(linha());

  printer
    .align("lt")
    .text("Caixa   : " + (payload.numeroCaixa || "Principal"))
    .text("Operador: " + payload.operador)
    .text("Abertura: " + (payload.aberturaEm || "-"))
    .text("Fecham. : " + payload.fechamentoEm);

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
    .text("Vendas      : " + payload.quantidadeVendas)
    .text("Faturamento : " + fmt(payload.totalVendas))
    .text("Lucro total : " + fmt(payload.totalLucro))
    .text("Margem media: " + Number(payload.margemMedia).toFixed(1) + "%");

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
        }[forma] || forma;
      printer
        .align("lt")
        .text(
          label.padEnd(10) +
            fmt(d.total).padStart(10) +
            (" " + d.quantidade + " venda(s)").padStart(12),
        );
    });

  printer
    .align("ct")
    .text(linha())
    .style("b")
    .text("CONFERENCIA DE CAIXA")
    .style("normal")
    .align("lt")
    .text("Fundo abertura: " + fmt(payload.valorAbertura))
    .text("Valor contado : " + fmt(payload.valorContado));

  const diff = payload.diferenca;
  const diffStr =
    Math.abs(diff) < 0.02
      ? "OK — caixa confere"
      : diff > 0
        ? "Sobra: " + fmt(diff)
        : "Falta: " + fmt(Math.abs(diff));
  printer.text("Diferenca     : " + diffStr);

  if (payload.observacao) {
    printer
      .align("ct")
      .text(linha())
      .align("lt")
      .text("Obs: " + payload.observacao);
  }

  printer
    .align("ct")
    .text(linha())
    .text("Caixa encerrado em " + payload.fechamentoEm)
    .feed(4)
    .cut();
}

function renderAbertura(printer, payload) {
  const { sep: linha, fmt } = helpers();

  printer
    .font("a")
    .align("ct")
    .style("b")
    .size(1, 1)
    .text("ABERTURA DE CAIXA")
    .style("normal")
    .size(0, 0);

  if (payload.empresa?.nome) {
    printer.text(payload.empresa.nome);
  }
  if (payload.empresa?.cnpj) {
    printer.text("CNPJ: " + payload.empresa.cnpj);
  }

  printer
    .text(linha())
    .align("lt")
    .text("Caixa   : " + (payload.numeroCaixa || "Principal"))
    .text("Operador: " + (payload.operador || "-"))
    .text(
      "Data/Hr : " + (payload.aberturaEm || new Date().toLocaleString("pt-BR")),
    )
    .align("ct")
    .text(linha())
    .style("b")
    .align("lt")
    .text("Fundo   : " + fmt(payload.valorAbertura || 0))
    .style("normal")
    .align("ct")
    .text(linha())
    .feed(3)
    .cut();
}

function renderMovimentoCaixa(printer, payload) {
  const { sep: linha, fmt } = helpers();
  const tipoLabel = payload.tipo === "suprimento" ? "SUPRIMENTO" : "SANGRIA";

  printer
    .font("a")
    .align("ct")
    .style("b")
    .size(1, 1)
    .text(tipoLabel + " DE CAIXA")
    .style("normal")
    .size(0, 0)
    .text(linha())
    .align("lt")
    .text("Caixa   : " + (payload.numeroCaixa || "Principal"))
    .text("Operador: " + payload.operador)
    .text("Data/Hr : " + payload.emitidoEm)
    .align("ct")
    .text(linha())
    .style("b")
    .align("lt")
    .text("Valor   : " + fmt(payload.valor))
    .style("normal")
    .text("Motivo  : " + payload.motivo)
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
    return info.ok;
  } catch (_) {
    return false;
  }
}

async function getInfo(force = false) {
  return detectarImpressora(force);
}

function listar() {
  const windows = listarImpressorasWindows().map((p) => ({
    nome: p.Name,
    porta: p.PortName,
    driver: p.DriverName,
    padrao: !!p.Default,
    termicaProvavel:
      TERMICA_RX.test(p.Name || "") || TERMICA_RX.test(p.DriverName || ""),
  }));

  let usb = [];
  if (escposUSB) {
    try {
      const devices = escpos.USB.findPrinter() || [];
      usb = devices.map((_, i) => ({ indice: i, metodo: "usb" }));
    } catch (_) {}
  }

  return {
    tipoConfigurado: PRINTER_TYPE,
    nomeConfigurado: PRINTER_NAME || null,
    hostConfigurado: PRINTER_HOST || null,
    portaConfigurada: PRINTER_PORT,
    windows,
    usb,
    ultimaUsada: ultimaImpressoraUsada,
  };
}

function imprimirCupom(payload) {
  return imprimirRender((printer) => renderCupom(printer, payload));
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

function abrirGaveta() {
  const buffer = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  return comLockImpressao(() => enviarBuffer(buffer));
}

module.exports = {
  testar,
  getInfo,
  listar,
  detectar: () => detectarImpressora(true),
  imprimirCupom,
  abrirGaveta,
  imprimirAbertura,
  imprimirFechamento,
  imprimirMovimentoCaixa,
};
