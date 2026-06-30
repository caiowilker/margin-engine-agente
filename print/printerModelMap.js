/**
 * Mapeamento fabricante → código modelo ACBr PosPrinter.
 * 0=Genérica | 1=Bematech | 2=Daruma | 3=Epson | 4=Custom | 5=Elgin | ...
 */
const MARCAS = [
  { rx: /bematech|mp-4200|mp4200/i, modelo: "1", label: "Bematech" },
  { rx: /daruma|dr700|dr800/i, modelo: "2", label: "Daruma" },
  { rx: /epson|tm-t|tm t/i, modelo: "3", label: "Epson" },
  { rx: /elgin|i9|i7|fit/i, modelo: "5", label: "Elgin" },
  { rx: /control\s?id|idprint/i, modelo: "6", label: "Control ID" },
  { rx: /citizen/i, modelo: "7", label: "Citizen" },
  { rx: /tanca|tp-|tp650/i, modelo: "8", label: "Tanca" },
  { rx: /star|tsp/i, modelo: "9", label: "Star" },
  { rx: /sunmi/i, modelo: "10", label: "Sunmi" },
  { rx: /gprinter|gp-/i, modelo: "11", label: "GPrinter" },
  { rx: /datecs/i, modelo: "12", label: "Datecs" },
  { rx: /zjiang|zj-/i, modelo: "13", label: "ZJiang" },
  { rx: /vox/i, modelo: "14", label: "Vox" },
  { rx: /diebold|nixdorf/i, modelo: "15", label: "Diebold" },
];

function inferirModeloAcbr(nomeImpressora, driverName) {
  const explicit = process.env.PRINTER_MODEL;
  if (explicit && explicit !== "auto" && /^\d+$/.test(String(explicit))) {
    return String(explicit);
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
};
