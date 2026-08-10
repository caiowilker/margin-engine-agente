/**
 * Builders de tags ACBr PosPrinter — única fonte para QR, barras, logo e formatação.
 * Defaults QR/corte alinhados a print/cupomLayoutShared.js (paridade com native).
 * @see docs/ACBRLIB-POSPRINTER.md
 */
const {
  resolveCutMode,
  resolveQrPrintOpts,
} = require("./cupomLayoutShared");

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
  const q = resolveQrPrintOpts(opts);
  return `<qrcode Tipo='${q.tipo}' ErrorLevel='${q.errorLevel}' ModuleSize='${q.moduleSize}' Margem='${q.margem}'>${String(content)}</qrcode>`;
}

/**
 * QR NFC-e seguro para POS_Imprimir — URLs com "|" usam placeholder BMP (ver qrCodeAcbrBmp.js).
 */
function tagQrCodeSeguro(content, opts = {}) {
  const c = String(content || "").trim();
  if (!c) return "";
  const { qrPrecisaBmp, tagQrBmpPlaceholder } = require("./qrCodeAcbrBmp");
  if (qrPrecisaBmp(c)) return tagQrBmpPlaceholder();
  return tagQrCode(c, opts);
}

function tagBarcode(tipo, code, opts = {}) {
  const t = String(tipo || "CODE128").toUpperCase();
  if (!BARCODE_TIPOS[t]) {
    return null;
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
  const { resolveLogoFator } = require("./printerLogoSize");
  const size = resolveLogoFator(opts);
  const kc1 = opts.kc1 ?? process.env.PRINTER_LOGO_KC1 ?? "48";
  const kc2 = opts.kc2 ?? process.env.PRINTER_LOGO_KC2 ?? "49";
  const fx = opts.fatorXEfetivo ?? size.fatorX;
  const fy = opts.fatorYEfetivo ?? size.fatorY;
  const imprimir = opts.imprimir !== false ? "1" : "0";
  return `<logo_imprimir>${imprimir}</logo_imprimir>\n<logo_kc1>${kc1}</logo_kc1>\n<logo_kc2>${kc2}</logo_kc2>\n<logo_fatorx>${fx}</logo_fatorx>\n<logo_fatory>${fy}</logo_fatory>`;
}

function tagLogoArquivo(filePath, opts = {}) {
  if (!filePath) return null;
  const pathNorm = filePath.replace(/\\/g, "/");
  const largura = opts.largura;
  return tagBmp(pathNorm, largura ? { largura } : {});
}

function tagLogoHeader(opts = {}) {
  try {
    const logo = require("./printerLogo");
    const av = logo.avaliarExibicaoLogo
      ? logo.avaliarExibicaoLogo(opts)
      : { ok: logo.deveExibirLogoCupom(opts), reason: null };
    if (!av.ok) return "";
    const info = logo.ler();
    if (!info.ativo || !info.caminhoAbsoluto) return "";
    if (info.modo === "kc") {
      return tagLogoConfig(info) + "\n";
    }
    const size = info.printSize || require("./printerLogoSize").resolveLogoPrintSize(info);
    const bmp = tagLogoArquivo(info.caminhoAbsoluto, { largura: size.bmpLargura });
    return bmp ? `<ce>${bmp}</ce>\n</linha_simples>\n` : "";
  } catch (err) {
    try {
      require("./printerLogo").__test?.setLastSkipReason?.("erro");
    } catch (_) {}
    return "";
  }
}

function tagSegundaViaBanner() {
  // Negrito + linhas de respiro — inconfundível em 58/80mm.
  return (
    "</linha_simples>\n" +
    "<ce><e><n>*** SEGUNDA VIA ***</n></e></ce>\n" +
    "</linha_simples>\n"
  );
}

/**
 * CODE128 com fallback CODE39 (tag-time).
 * `forceCode128Fail` simula firmware/sem suporte — usado em testes.
 */
function barcodeTagsWithCode39Fallback(code, opts = {}, flags = {}) {
  const content = String(code || "").trim();
  if (!content) return [];
  const forceFail = flags.forceCode128Fail === true;
  const tags = [];
  if (!forceFail) {
    const bc128 = tagBarcode("CODE128", content, opts);
    if (bc128) tags.push(bc128);
  }
  if (tags.length === 0 || forceFail) {
    const c39 = content.toUpperCase().replace(/[^0-9A-Z\-.\s/$+%]/g, "");
    if (c39) {
      const bc39 = tagBarcode("CODE39", c39, opts);
      if (bc39) tags.push(bc39);
    }
  }
  return tags;
}

function tagCorte(tipo) {
  const cut = resolveCutMode(tipo);
  if (cut === "none" || cut === "0") return "";
  return cut === "total" || cut === "full" ? "</corte_total>" : "</corte_parcial>";
}

function tagFormato(linhas) {
  return Array.isArray(linhas) ? linhas.filter(Boolean).join("\n") + "\n" : String(linhas || "");
}

/** Negrito — melhora legibilidade em térmicas (evita cupom “apagado”). */
function tagNegrito(texto) {
  const t = String(texto ?? "");
  if (!t) return "";
  if (/<\/?n>/i.test(t)) return t;
  return `<n>${t}</n>`;
}

/** Negrito + expandido — cabeçalho da loja (paridade com ESC/POS size 1,1). */
function tagNegritoExpandido(texto) {
  const t = String(texto ?? "");
  if (!t) return "";
  return `<e><n>${t}</n></e>`;
}

/** @deprecated Evitar após </zera> — pode deixar o cupom apagado em modelo 0 (ppTexto/RAW). */
function tagResetFonte() {
  return "</fn>";
}

module.exports = {
  BARCODE_TIPOS,
  tagQrCode,
  tagQrCodeSeguro,
  tagBarcode,
  barcodeTagsWithCode39Fallback,
  tagBarcodeFromSpec,
  tagBarcodesList,
  tagBmp,
  tagLogoConfig,
  tagLogoArquivo,
  tagLogoHeader,
  tagSegundaViaBanner,
  tagCorte,
  tagFormato,
  tagNegrito,
  tagNegritoExpandido,
  tagResetFonte,
};
