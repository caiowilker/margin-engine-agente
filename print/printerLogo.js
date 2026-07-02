/**
 * Logo térmico — upload, cache local e tags ACBr (BMP / KC1+KC2).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const log = require("../logger").child({ modulo: "printer_logo" });

const AGENT_ROOT = path.resolve(__dirname, "..");
const LOGO_DIR = path.join(AGENT_ROOT, "data", "printer");
const LOGO_BMP = path.join(LOGO_DIR, "logo.bmp");
const LOGO_META = path.join(LOGO_DIR, "logo.meta.json");

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
      fatorX: process.env.PRINTER_LOGO_FATORX || "1",
      fatorY: process.env.PRINTER_LOGO_FATORY || "1",
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

function decodeBase64(input) {
  const raw = String(input || "").trim();
  const b64 = raw.includes(",") ? raw.split(",").pop() : raw;
  return Buffer.from(b64, "base64");
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
  logoBufferCache = { sha256: null, buffer: null };
  salvarMeta({
    ativo: false,
    modo: "arquivo",
    kc1: process.env.PRINTER_LOGO_KC1 || "48",
    kc2: process.env.PRINTER_LOGO_KC2 || "49",
    fatorX: "1",
    fatorY: "1",
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
  return {
    ...meta,
    ativo: meta.ativo && !!caminhoAbsoluto,
    existe,
    caminhoAbsoluto,
    caminhoRelativo: existe ? path.relative(AGENT_ROOT, LOGO_BMP) : null,
    dir: LOGO_DIR,
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

module.exports = {
  LOGO_DIR,
  LOGO_BMP,
  salvar,
  remover,
  ler,
  isBmpBuffer,
};
