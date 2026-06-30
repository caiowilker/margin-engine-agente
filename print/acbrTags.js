/**
 * Builders de tags ACBr PosPrinter — única fonte para QR, barras, logo e formatação.
 * @see docs/ACBRLIB-POSPRINTER.md
 */
const BARCODE_TIPOS = {
  EAN13: "EAN13",
  EAN8: "EAN8",
  CODE128: "CODE128",
  CODE39: "CODE39",
  CODE93: "CODE93",
  UPCA: "UPCA",
  UPCE: "UPCE",
  ITF: "ITF",
  CODABAR: "CODABAR",
  MSI: "MSI",
  /** PDF417: nem todos os firmwares PosPrinter expõem; tentativa com fallback documentado */
  PDF417: "PDF417",
};

function cfgNum(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function tagQrCode(content, opts = {}) {
  const errLevel = opts.errorLevel || process.env.PRINTER_QR_ERROR_LEVEL || "L";
  const moduleSize = opts.moduleSize || process.env.PRINTER_QR_MODULE || "4";
  const tipo = opts.tipo || process.env.PRINTER_QR_TIPO || "2";
  const margem = opts.margem ?? cfgNum("PRINTER_QR_MARGEM", 4);
  return `<qrcode Tipo='${tipo}' ErrorLevel='${errLevel}' ModuleSize='${moduleSize}' Margem='${margem}'>${String(content)}</qrcode>`;
}

function tagBarcode(tipo, code, opts = {}) {
  const t = String(tipo || "CODE128").toUpperCase();
  if (!BARCODE_TIPOS[t]) {
    throw new Error(`Tipo de código de barras inválido: ${tipo}`);
  }
  const altura = opts.altura ?? cfgNum("PRINTER_BARCODE_ALTURA", 50);
  const largura = opts.largura ?? cfgNum("PRINTER_BARCODE_LARGURA", 2);
  const exibeCodigo = opts.exibeCodigo ?? process.env.PRINTER_BARCODE_EXIBE !== "false";
  const content = String(code || "").trim();
  if (!content) return null;
  return `<barcode Tipo='${t}' Altura='${altura}' Largura='${largura}' ExibeCodigo='${exibeCodigo ? "1" : "0"}'>${content}</barcode>`;
}

function tagBarcodeFromSpec(spec) {
  if (!spec) return null;
  if (typeof spec === "string") return tagBarcode("CODE128", spec);
  return tagBarcode(spec.tipo || "CODE128", spec.code || spec.conteudo, spec);
}

function tagBarcodesList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(tagBarcodeFromSpec).filter(Boolean);
}

/** Imagem BMP monocromática — path absoluto, Base64 ou ASCII art */
function tagBmp(conteudo, opts = {}) {
  const c = String(conteudo || "").trim();
  if (!c) return null;
  if (opts.largura) {
    return `<bmp Largura='${opts.largura}'>${c}</bmp>`;
  }
  return `<bmp>${c}</bmp>`;
}

function tagLogoConfig(opts = {}) {
  const kc1 = opts.kc1 ?? process.env.PRINTER_LOGO_KC1 ?? "48";
  const kc2 = opts.kc2 ?? process.env.PRINTER_LOGO_KC2 ?? "49";
  const fx = opts.fatorX ?? process.env.PRINTER_LOGO_FATORX ?? "1";
  const fy = opts.fatorY ?? process.env.PRINTER_LOGO_FATORY ?? "1";
  const imprimir = opts.imprimir !== false ? "1" : "0";
  return `<logo_imprimir>${imprimir}</logo_imprimir>\n<logo_kc1>${kc1}</logo_kc1>\n<logo_kc2>${kc2}</logo_kc2>\n<logo_fatorx>${fx}</logo_fatorx>\n<logo_fatory>${fy}</logo_fatory>`;
}

function tagLogoArquivo(filePath) {
  if (!filePath) return null;
  return tagBmp(filePath.replace(/\\/g, "/"));
}

function tagLogoHeader() {
  try {
    const logo = require("./printerLogo");
    const info = logo.ler();
    if (!info.ativo || !info.caminhoAbsoluto) return "";
    if (info.modo === "kc") {
      return tagLogoConfig(info) + "\n";
    }
    const bmp = tagLogoArquivo(info.caminhoAbsoluto);
    return bmp ? `<ce>${bmp}</ce>\n</linha_simples>\n` : "";
  } catch (_) {
    return "";
  }
}

function tagSegundaViaBanner() {
  return "<ce><n>*** SEGUNDA VIA ***</n></ce>\n</linha_simples>\n";
}

function tagCorte(tipo) {
  const cut = (tipo || process.env.PRINTER_CUT || "partial").toLowerCase();
  return cut === "total" ? "</corte_total>" : "</corte_parcial>";
}

function tagFormato(linhas) {
  return Array.isArray(linhas) ? linhas.filter(Boolean).join("\n") + "\n" : String(linhas || "");
}

module.exports = {
  BARCODE_TIPOS,
  tagQrCode,
  tagBarcode,
  tagBarcodeFromSpec,
  tagBarcodesList,
  tagBmp,
  tagLogoConfig,
  tagLogoArquivo,
  tagLogoHeader,
  tagSegundaViaBanner,
  tagCorte,
  tagFormato,
};
