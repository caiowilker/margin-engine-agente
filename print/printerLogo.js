/**
 * Logo térmico — upload, cache local e tags ACBr (BMP / KC1+KC2).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const log = require("../logger").child({ modulo: "printer_logo" });
const { FATOR_PADRAO, resolveLogoPrintSize } = require("./printerLogoSize");

const AGENT_ROOT = path.resolve(__dirname, "..");
const LOGO_DIR = path.join(AGENT_ROOT, "data", "printer");
const LOGO_BMP = path.join(LOGO_DIR, "logo.bmp");
const LOGO_META = path.join(LOGO_DIR, "logo.meta.json");
/** PNG escalado para ESC/POS — regenerado sob demanda. */
const LOGO_PRINT_CACHE = path.join(LOGO_DIR, "logo.print.png");
const LOGO_PRINT_KEY = path.join(LOGO_DIR, "logo.print.key");

/** Cache em memória — evita reler BMP a cada cupom. */
let logoBufferCache = { sha256: null, buffer: null };

function ensureDir() {
  fs.mkdirSync(LOGO_DIR, { recursive: true });
}

function lerMeta() {
  if (!fs.existsSync(LOGO_META)) {
    return {
      ativo: false,
      modo: "arquivo",
      kc1: process.env.PRINTER_LOGO_KC1 || "48",
      kc2: process.env.PRINTER_LOGO_KC2 || "49",
      fatorX: process.env.PRINTER_LOGO_FATORX || String(FATOR_PADRAO),
      fatorY: process.env.PRINTER_LOGO_FATORY || String(FATOR_PADRAO),
      atualizadoEm: null,
      sha256: null,
    };
  }
  try {
    return { ...JSON.parse(fs.readFileSync(LOGO_META, "utf8")) };
  } catch (_) {
    return { ativo: false, modo: "arquivo" };
  }
}

function salvarMeta(meta) {
  ensureDir();
  fs.writeFileSync(LOGO_META, JSON.stringify(meta, null, 2), "utf8");
}

function isBmpBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d;
}

/** BMP com dimensões utilizáveis na térmica (rejeita placeholder corrompido 0×0). */
function isBmpPrintable(buf) {
  if (!isBmpBuffer(buf) || buf.length < 26) return false;
  try {
    const width = buf.readInt32LE(18);
    const height = Math.abs(buf.readInt32LE(22));
    return width > 0 && height > 0 && width <= 4096 && height <= 4096;
  } catch (_) {
    return false;
  }
}

function decodeBase64(input) {
  const raw = String(input || "").trim();
  const b64 = raw.includes(",") ? raw.split(",").pop() : raw;
  return Buffer.from(b64, "base64");
}

function invalidatePrintCache() {
  try {
    if (fs.existsSync(LOGO_PRINT_CACHE)) fs.unlinkSync(LOGO_PRINT_CACHE);
  } catch (_) {}
  try {
    if (fs.existsSync(LOGO_PRINT_KEY)) fs.unlinkSync(LOGO_PRINT_KEY);
  } catch (_) {}
  try {
    require("./escpos/impressoraCore").invalidateLogoEscposImageCache?.();
  } catch (_) {}
}

/**
 * @param {{ base64?: string, buffer?: Buffer, modo?: string, kc1?: string, kc2?: string, fatorX?: string, fatorY?: string, ativo?: boolean }} opts
 */
function salvar(opts = {}) {
  ensureDir();
  const meta = lerMeta();

  if (opts.kc1 != null) meta.kc1 = String(opts.kc1);
  if (opts.kc2 != null) meta.kc2 = String(opts.kc2);
  if (opts.fatorX != null) meta.fatorX = String(opts.fatorX);
  if (opts.fatorY != null) meta.fatorY = String(opts.fatorY);
  if (opts.modo) meta.modo = opts.modo;
  if (opts.ativo != null) meta.ativo = !!opts.ativo;

  if (opts.base64 || opts.buffer) {
    const buf = opts.buffer || decodeBase64(opts.base64);
    if (!isBmpBuffer(buf)) {
      throw new Error("Logo deve ser BMP monocromático (header BM). Converta antes do upload.");
    }
    fs.writeFileSync(LOGO_BMP, buf);
    meta.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    logoBufferCache = { sha256: meta.sha256, buffer: buf };
    meta.ativo = opts.ativo !== false;
    meta.modo = opts.modo || "arquivo";
    meta.atualizadoEm = new Date().toISOString();
    if (meta.fatorX == null || Number(meta.fatorX) <= 1) {
      meta.fatorX = String(FATOR_PADRAO);
      meta.fatorY = String(FATOR_PADRAO);
    }
    invalidatePrintCache();
    log.info({ bytes: buf.length }, "[PrinterLogo] Logo BMP salvo");
  }

  salvarMeta(meta);
  return ler();
}

function remover() {
  ensureDir();
  try {
    if (fs.existsSync(LOGO_BMP)) fs.unlinkSync(LOGO_BMP);
  } catch (_) {}
  invalidatePrintCache();
  logoBufferCache = { sha256: null, buffer: null };
  salvarMeta({
    ativo: false,
    modo: "arquivo",
    kc1: process.env.PRINTER_LOGO_KC1 || "48",
    kc2: process.env.PRINTER_LOGO_KC2 || "49",
    fatorX: String(FATOR_PADRAO),
    fatorY: String(FATOR_PADRAO),
    atualizadoEm: new Date().toISOString(),
    sha256: null,
  });
  return ler();
}

function ler() {
  const meta = lerMeta();
  const existe = fs.existsSync(LOGO_BMP);
  const explicitPath = process.env.PRINTER_LOGO_PATH;
  const caminhoAbsoluto =
    existe ? LOGO_BMP : explicitPath && fs.existsSync(explicitPath) ? explicitPath : null;
  const size = resolveLogoPrintSize(meta);
  return {
    ...meta,
    ativo: meta.ativo && !!caminhoAbsoluto,
    existe,
    caminhoAbsoluto,
    caminhoRelativo: existe ? path.relative(AGENT_ROOT, LOGO_BMP) : null,
    dir: LOGO_DIR,
    printSize: size,
    fatorXEfetivo: size.fatorX,
    fatorYEfetivo: size.fatorY,
  };
}

function lerBuffer() {
  const meta = lerMeta();
  if (!meta.ativo) return null;
  const explicitPath = process.env.PRINTER_LOGO_PATH;
  const caminho =
    fs.existsSync(LOGO_BMP)
      ? LOGO_BMP
      : explicitPath && fs.existsSync(explicitPath)
        ? explicitPath
        : null;
  if (!caminho) return null;
  if (logoBufferCache.sha256 === meta.sha256 && logoBufferCache.buffer) {
    return logoBufferCache.buffer;
  }
  const buf = fs.readFileSync(caminho);
  logoBufferCache = { sha256: meta.sha256, buffer: buf };
  return buf;
}

/**
 * Gera PNG escalado para ESC/POS (get-pixels / escpos.Image).
 * @returns {Promise<string|null>} caminho do arquivo de impressão
 */
async function prepararArquivoEscpos(metaOrInfo) {
  const info = metaOrInfo?.caminhoAbsoluto ? metaOrInfo : ler();
  if (!info.caminhoAbsoluto) return null;
  const size = info.printSize || resolveLogoPrintSize(info);
  const cacheKey = `${info.sha256 || info.caminhoAbsoluto}|${size.escposWidthDots}`;
  try {
    if (
      fs.existsSync(LOGO_PRINT_CACHE) &&
      fs.existsSync(LOGO_PRINT_KEY) &&
      fs.readFileSync(LOGO_PRINT_KEY, "utf8") === cacheKey
    ) {
      return LOGO_PRINT_CACHE;
    }
  } catch (_) {}

  ensureDir();
  const sharp = require("sharp");
  await sharp(info.caminhoAbsoluto)
    .resize({
      width: size.escposWidthDots,
      fit: "inside",
      withoutEnlargement: false,
      kernel: sharp.kernel.nearest,
    })
    .png()
    .toFile(LOGO_PRINT_CACHE);
  fs.writeFileSync(LOGO_PRINT_KEY, cacheKey, "utf8");
  return LOGO_PRINT_CACHE;
}

/** Toggle do painel PDV ou env — padrão true (só imprime se BMP existir). */
function exibirLogoCupomHabilitado(payload) {
  if (payload && typeof payload.exibirLogo === "boolean") return payload.exibirLogo;
  const env = process.env.PRINTER_LOGO_EXIBIR ?? process.env.IMPRESSAO_EXIBIR_LOGO;
  if (env != null && String(env).toLowerCase() === "false") return false;
  return true;
}

/** Logo BMP no cupom térmico (fiscal ou não fiscal) — opcional, nunca obrigatória. */
function deveExibirLogoCupom(payload) {
  if (!exibirLogoCupomHabilitado(payload)) return false;
  const info = ler();
  if (!(info.ativo && info.caminhoAbsoluto)) return false;
  try {
    const buf = lerBuffer();
    if (!buf || !isBmpPrintable(buf)) {
      log.warn("[PrinterLogo] BMP inválido/corrompido — logo omitida no cupom");
      return false;
    }
  } catch (_) {
    return false;
  }
  return true;
}

/**
 * Pré-aquece PNG + valida BMP — primeiro cupom com logo não paga sharp frio.
 * @returns {Promise<boolean>}
 */
async function warmLogoEscpos() {
  try {
    const info = ler();
    if (!(info.ativo && info.caminhoAbsoluto)) return false;
    const pathOut = await prepararArquivoEscpos(info);
    return !!pathOut;
  } catch (err) {
    log.debug({ err: err?.message }, "[PrinterLogo] warm falhou");
    return false;
  }
}

module.exports = {
  LOGO_DIR,
  LOGO_BMP,
  LOGO_PRINT_CACHE,
  salvar,
  remover,
  ler,
  isBmpBuffer,
  isBmpPrintable,
  exibirLogoCupomHabilitado,
  deveExibirLogoCupom,
  prepararArquivoEscpos,
  warmLogoEscpos,
  resolveLogoPrintSize,
};
