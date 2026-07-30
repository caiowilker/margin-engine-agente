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

/** Extrai host/porta de Porta ACBr no formato TCP:ip:porta */
function parsePortaTcp(porta) {
  const m = String(porta || "").trim().match(/^TCP:([^:]+):(\d+)$/i);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

/** Porta ACBr utilizável para impressão física (evita RAW: vazio herdado de INI padrão). */
function portaAcbrValida(porta) {
  const p = String(porta || "").trim();
  if (!p || /^USB$/i.test(p)) return false;
  if (/^RAW:\s*$/i.test(p)) return false;
  if (/^RAW:$/i.test(p)) return false;
  return true;
}

/**
 * Normaliza porta para ACBr PosPrinter: TCP:ip:porta | RAW:nome | USB | COMn
 */
function normalizarPortaAcbr(porta, opts = {}) {
  const p = String(porta || "").trim();
  if (!p) {
    if (opts.host) {
      return `TCP:${opts.host}:${opts.port || process.env.PRINTER_PORT || "9100"}`;
    }
    return "USB";
  }
  if (/^(TCP|RAW|USB|COM)/i.test(p)) return p;
  const ipPort = p.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
  if (ipPort) {
    return `TCP:${ipPort[1]}:${ipPort[2] || opts.port || process.env.PRINTER_PORT || "9100"}`;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(p)) {
    const [host, port] = p.split(":");
    return `TCP:${host}:${port}`;
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
      opts,
    );
  }
  if (opts.portaWindows) {
    const ip = String(opts.portaWindows).match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    if (ip) {
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
};
