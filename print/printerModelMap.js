/**
 * Mapeamento fabricante → código modelo ACBr PosPrinter (TACBrPosPrinterModelo).
 *
 * Enum oficial (ACBrPosPrinter.pas):
 *  0=ppTexto | 1=ppEscPosEpson | 2=ppEscBematech | 3=ppEscDaruma |
 *  4=ppEscVox | 5=ppEscDiebold | 6=ppEscEpsonP2 | 7=ppCustomPos |
 *  8=ppEscPosStar | 9=ppEscZJiang | 10=ppEscGPrinter | 11=ppEscDatecs |
 *  12=ppEscSunmi | 13=ppExterno
 *
 * Marcas ESC/POS sem entrada própria (Elgin, Tanca, POS80, Control ID…) → Epson (1).
 */
const MARCAS = [
  { rx: /bematech|mp-4200|mp4200/i, modelo: "2", label: "Bematech" },
  { rx: /daruma|dr700|dr800/i, modelo: "3", label: "Daruma" },
  { rx: /epson|tm-t|tm t|tm-m/i, modelo: "1", label: "Epson" },
  { rx: /diebold|nixdorf/i, modelo: "5", label: "Diebold" },
  { rx: /vox/i, modelo: "4", label: "Vox" },
  { rx: /custom/i, modelo: "7", label: "Custom" },
  { rx: /star|tsp/i, modelo: "8", label: "Star" },
  { rx: /zjiang|zj-/i, modelo: "9", label: "ZJiang" },
  { rx: /gprinter|gp-/i, modelo: "10", label: "GPrinter" },
  { rx: /datecs/i, modelo: "11", label: "Datecs" },
  { rx: /sunmi/i, modelo: "12", label: "Sunmi" },
  // Clones ESC/POS Epson-compatíveis (sem enum dedicado)
  {
    rx: /elgin|i9|i7|fit|tanca|tp-|tp650|control\s?id|idprint|citizen|jetway|pos\s*80|pos80|posprinter|thermal|termica|cupom|nfce|receipt/i,
    modelo: "1",
    label: "Epson-compativel",
  },
];

function inferirModeloAcbr(nomeImpressora, driverName, opts = {}) {
  if (!opts.ignoreEnv) {
    const explicit = process.env.PRINTER_MODEL;
    if (explicit && explicit !== "auto" && /^\d+$/.test(String(explicit))) {
      return String(explicit);
    }
  }
  const texto = `${nomeImpressora || ""} ${driverName || ""}`;
  if (!texto.trim()) return "0";
  for (const m of MARCAS) {
    if (m.rx.test(texto)) return m.modelo;
  }
  return "0";
}

/** PE Machine: 0x8664=x64, 0x14c=x86. Null se não for PE. */
function peMachineType(filePath) {
  try {
    const fs = require("fs");
    const buf = fs.readFileSync(filePath);
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null;
    const e_lfanew = buf.readUInt32LE(0x3c);
    if (buf.length < e_lfanew + 6) return null;
    return buf.readUInt16LE(e_lfanew + 4);
  } catch (_) {
    return null;
  }
}

/**
 * InterfaceEpsonNF.dll / Hprt* no bundle devem ser x64 (mesmo arch do ACBrPosPrinter64).
 * DLLs x86 fazem LoadLibrary falhar e POS_* retornar -10 / hang.
 */
function vendorPosSideDllsAreX64(libDir) {
  const fs = require("fs");
  const path = require("path");
  const dir = libDir || "";
  const names = ["InterfaceEpsonNF.dll", "HprtPrinter.dll", "hprtio.dll"];
  for (const name of names) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    if (peMachineType(p) !== 0x8664) return false;
  }
  // Sem DLL de vendor: Epson embutida no ACBr (ok) ou modelo texto.
  return true;
}

/**
 * Modelo ACBr efetivo: se Epson-compatível (1) mas side DLL x86, desce para 0 (ppTexto).
 */
function resolveModeloAcbrSeguro(modelo, libDir) {
  const m = String(modelo == null ? "0" : modelo);
  if (m !== "1" && m !== "6") return m;
  if (vendorPosSideDllsAreX64(libDir)) return m;
  return "0";
}

/** IPv4 dotted decimal (ex.: 192.168.1.50) — rejeita 192168150. */
function isValidIpv4Host(host) {
  const h = String(host || "").trim();
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = Number(o);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function isValidTcpHost(host) {
  const h = String(host || "").trim();
  if (!h) return false;
  // Hostname simples (não IP colado sem pontos)
  if (/^[a-zA-Z][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(h) && h.includes(".")) return true;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(h)) return true; // localhost-style single label
  return isValidIpv4Host(h);
}

/** Extrai host/porta de Porta ACBr no formato TCP:ip:porta */
function parsePortaTcp(porta) {
  const m = String(porta || "").trim().match(/^TCP:([^:]+):(\d+)$/i);
  if (!m) return null;
  const host = m[1].trim();
  const port = Number(m[2]);
  if (!isValidTcpHost(host) || !Number.isFinite(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host, port };
}

/** Porta ACBr utilizável para impressão física (evita RAW: vazio e TCP sem IP válido). */
function portaAcbrValida(porta) {
  const p = String(porta || "").trim();
  if (!p || /^USB$/i.test(p)) return false;
  if (/^RAW:\s*$/i.test(p)) return false;
  if (/^RAW:$/i.test(p)) return false;
  if (/^TCP:/i.test(p)) {
    return !!parsePortaTcp(p);
  }
  // Host digit-only colado (192168150) sem prefixo
  if (/^\d{8,12}(?::\d+)?$/.test(p) && !isValidIpv4Host(p.split(":")[0])) {
    return false;
  }
  return true;
}

/**
 * Normaliza porta para ACBr PosPrinter: TCP:ip:porta | RAW:nome | USB | COMn
 * Rejeita TCP com host inválido (ex.: TCP:192168150:9100).
 */
function normalizarPortaAcbr(porta, opts = {}) {
  const p = String(porta || "").trim();
  if (!p) {
    if (opts.host && isValidTcpHost(opts.host)) {
      return `TCP:${opts.host}:${opts.port || process.env.PRINTER_PORT || "9100"}`;
    }
    return "USB";
  }

  if (/^TCP:/i.test(p)) {
    const tcp = parsePortaTcp(p);
    if (tcp) return `TCP:${tcp.host}:${tcp.port}`;
    // TCP malformado — não propagar; tenta opts.host
    if (opts.host && isValidTcpHost(opts.host)) {
      return `TCP:${opts.host}:${opts.port || process.env.PRINTER_PORT || "9100"}`;
    }
    if (opts.nomeWindows) return `RAW:${opts.nomeWindows}`;
    return "USB";
  }

  if (/^(RAW|USB|COM)/i.test(p)) return p;

  const ipPort = p.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
  if (ipPort && isValidIpv4Host(ipPort[1])) {
    return `TCP:${ipPort[1]}:${ipPort[2] || opts.port || process.env.PRINTER_PORT || "9100"}`;
  }

  if (opts.host && isValidTcpHost(opts.host)) {
    return `TCP:${opts.host}:${opts.port || process.env.PRINTER_PORT || "9100"}`;
  }

  if (opts.nomeWindows && !/^COM/i.test(p)) {
    return `RAW:${opts.nomeWindows}`;
  }
  return p;
}

/**
 * ControlePorta no ACBr: em RAW (spooler Windows) usar 0 evita -10 genérico na impressão.
 * COM/TCP mantém 1. Override: PRINTER_CONTROLE_PORTA=0|1
 */
function resolveControlePorta(porta) {
  const explicit = process.env.PRINTER_CONTROLE_PORTA;
  if (explicit === "0" || explicit === "false") return "0";
  if (explicit === "1" || explicit === "true") return "1";
  const p = String(porta || "").trim();
  if (/^RAW:/i.test(p)) return "0";
  return "1";
}

function inferirPortaAcbr(opts = {}) {
  if (process.env.PRINTER_PORTA) {
    return normalizarPortaAcbr(process.env.PRINTER_PORTA, opts);
  }
  if (process.env.PRINTER_PATH) {
    return normalizarPortaAcbr(process.env.PRINTER_PATH, opts);
  }
  if (process.env.PRINTER_HOST) {
    return normalizarPortaAcbr(
      `${process.env.PRINTER_HOST}:${process.env.PRINTER_PORT || "9100"}`,
      { ...opts, host: process.env.PRINTER_HOST, port: process.env.PRINTER_PORT || "9100" },
    );
  }
  if (opts.portaWindows) {
    const ip = String(opts.portaWindows).match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    if (ip && isValidIpv4Host(ip[1])) {
      return `TCP:${ip[1]}:${process.env.PRINTER_PORT || "9100"}`;
    }
    return normalizarPortaAcbr(opts.portaWindows, opts);
  }
  if (opts.nomeWindows) return `RAW:${opts.nomeWindows}`;
  if (opts.nomeWindows && /^USB/i.test(String(opts.portaWindows || ""))) return "USB";
  return "USB";
}

module.exports = {
  MARCAS,
  inferirModeloAcbr,
  inferirPortaAcbr,
  normalizarPortaAcbr,
  parsePortaTcp,
  portaAcbrValida,
  resolveControlePorta,
  isValidIpv4Host,
  isValidTcpHost,
  peMachineType,
  vendorPosSideDllsAreX64,
  resolveModeloAcbrSeguro,
};
