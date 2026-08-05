/**
 * Logo térmico — upload, cache local e tags ACBr (BMP / KC1+KC2).
 * Path estável (ProgramData) para o worker Windows ler o BMP.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const log = require("../logger").child({ modulo: "printer_logo" });
const { FATOR_PADRAO, resolveLogoPrintSize } = require("./printerLogoSize");

const AGENT_ROOT = path.resolve(__dirname, "..");

function resolveLogoDir() {
  try {
    const { resolveProgramDataRoot } = require("../runtime/windowsEnv");
    const root = resolveProgramDataRoot().root;
    if (root) return path.join(root, "printer");
  } catch (_) {}
  return path.join(AGENT_ROOT, "data", "printer");
}

let LOGO_DIR = resolveLogoDir();
let LOGO_BMP = path.join(LOGO_DIR, "logo.bmp");
let LOGO_META = path.join(LOGO_DIR, "logo.meta.json");
/** PNG escalado para ESC/POS — regenerado sob demanda. */
let LOGO_PRINT_CACHE = path.join(LOGO_DIR, "logo.print.png");
let LOGO_PRINT_KEY = path.join(LOGO_DIR, "logo.print.key");

function refreshLogoPaths() {
  LOGO_DIR = resolveLogoDir();
  LOGO_BMP = path.join(LOGO_DIR, "logo.bmp");
  LOGO_META = path.join(LOGO_DIR, "logo.meta.json");
  LOGO_PRINT_CACHE = path.join(LOGO_DIR, "logo.print.png");
  LOGO_PRINT_KEY = path.join(LOGO_DIR, "logo.print.key");
}

/** Último motivo de omissão da logo no cupom (diagnóstico / teste). */
let lastLogoSkipReason = null;

/** Cache em memória — evita reler BMP a cada cupom. */
let logoBufferCache = { sha256: null, buffer: null };

let loInfoCache = { data: null, expiresAt: 0 };
const LO_INFO_CACHE_TTL_MS = 5000;

let loPrintCacheKeyMemory = { sha256: null, key: null };

function getCachedLoInfo() {
  const now = Date.now();
  if (loInfoCache.data && now < loInfoCache.expiresAt) {
    return loInfoCache.data;
  }
  return null;
}

function setCachedLoInfo(data) {
  loInfoCache = {
    data,
    expiresAt: Date.now() + LO_INFO_CACHE_TTL_MS,
  };
}

function ensureDir() {
  refreshLogoPaths();
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  // Espelho legacy sob data/printer (instaladores antigos / debug).
  try {
    const legacy = path.join(AGENT_ROOT, "data", "printer");
    if (legacy !== LOGO_DIR) fs.mkdirSync(legacy, { recursive: true });
  } catch (_) {}
}

function lerMeta() {
  ensureDir();
  if (!fs.existsSync(LOGO_META)) {
    // Migração: meta/BMP no install dir antigo
    const legacyMeta = path.join(AGENT_ROOT, "data", "printer", "logo.meta.json");
    const legacyBmp = path.join(AGENT_ROOT, "data", "printer", "logo.bmp");
    if (fs.existsSync(legacyMeta) || fs.existsSync(legacyBmp)) {
      try {
        if (fs.existsSync(legacyBmp) && !fs.existsSync(LOGO_BMP)) {
          fs.copyFileSync(legacyBmp, LOGO_BMP);
        }
        if (fs.existsSync(legacyMeta) && !fs.existsSync(LOGO_META)) {
          fs.copyFileSync(legacyMeta, LOGO_META);
        }
      } catch (err) {
        log.warn({ err: err.message }, "[PrinterLogo] Falha ao migrar logo legacy");
      }
    }
  }
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

function bmpBitsPerPixel(buf) {
  if (!isBmpBuffer(buf) || buf.length < 30) return 0;
  try {
    return buf.readUInt16LE(28);
  } catch (_) {
    return 0;
  }
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

function isBmp1bppPrintable(buf) {
  return isBmpPrintable(buf) && bmpBitsPerPixel(buf) === 1;
}

/**
 * Codifica BMP monocromático 1-bpp (bottom-up).
 * raw: 1 byte por pixel (0=preto, >0=branco) ou greyscale 0–255.
 */
function encodeBmp1bppFromRaw(raw, width, height, threshold = 128) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const rowBytes = ((w + 31) >> 5) * 4;
  const pixelArraySize = rowBytes * h;
  const dataOffset = 14 + 40 + 8;
  const buf = Buffer.alloc(dataOffset + pixelArraySize, 0);

  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(dataOffset, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(1, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelArraySize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(2, 46);
  buf.writeUInt32LE(0x00000000, 54);
  buf.writeUInt32LE(0x00ffffff, 58);

  for (let y = 0; y < h; y++) {
    const bmpRow = h - 1 - y;
    const rowStart = dataOffset + bmpRow * rowBytes;
    for (let x = 0; x < w; x++) {
      const v = raw[y * w + x] & 0xff;
      const branco = v >= threshold;
      if (branco) {
        buf[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return buf;
}

/** Gera BMP 1-bpp mínimo válido (testes / probe). */
function makeTestBmp1bpp(width = 8, height = 8) {
  const raw = Buffer.alloc(width * height, 255);
  for (let i = 0; i < width * height; i += 3) raw[i] = 0;
  return encodeBmp1bppFromRaw(raw, width, height);
}

/**
 * Converte PNG/JPEG/BMP colorido → BMP 1-bpp imprimível (ACBr + ESC/POS).
 */
async function convertToPrintableBmp1bpp(inputBuf) {
  if (isBmp1bppPrintable(inputBuf)) return { buffer: inputBuf, converted: false };

  const sharp = require("sharp");
  const maxW = Math.min(
    576,
    Math.max(160, Number(process.env.PRINTER_LOGO_MAX_WIDTH_DOTS || 384) || 384),
  );
  const { data, info } = await sharp(inputBuf)
    .rotate()
    .resize({
      width: maxW,
      fit: "inside",
      withoutEnlargement: true,
      kernel: sharp.kernel.nearest,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!info.width || !info.height) {
    throw new Error("Logo sem dimensões após conversão — envie PNG/JPG/BMP válido.");
  }
  const bmp = encodeBmp1bppFromRaw(data, info.width, info.height, 128);
  if (!isBmp1bppPrintable(bmp)) {
    throw new Error("Falha ao gerar BMP monocromático da logo.");
  }
  return { buffer: bmp, converted: true, width: info.width, height: info.height };
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
  loInfoCache = { data: null, expiresAt: 0 };
  loPrintCacheKeyMemory = { sha256: null, key: null };
}

function mirrorLegacyBmp(buf) {
  try {
    const legacyDir = path.join(AGENT_ROOT, "data", "printer");
    if (legacyDir === LOGO_DIR) return;
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "logo.bmp"), buf);
  } catch (_) {}
}

/**
 * @param {{ base64?: string, buffer?: Buffer, modo?: string, kc1?: string, kc2?: string, fatorX?: string, fatorY?: string, ativo?: boolean }} opts
 * @returns {Promise<object>}
 */
async function salvar(opts = {}) {
  ensureDir();
  const meta = lerMeta();

  if (opts.kc1 != null) meta.kc1 = String(opts.kc1);
  if (opts.kc2 != null) meta.kc2 = String(opts.kc2);
  const fatorAntes = `${meta.fatorX}|${meta.fatorY}`;
  if (opts.fatorX != null) meta.fatorX = String(opts.fatorX);
  if (opts.fatorY != null) meta.fatorY = String(opts.fatorY);
  if (opts.modo) meta.modo = opts.modo;
  if (opts.ativo != null) meta.ativo = !!opts.ativo;

  if (opts.base64 || opts.buffer) {
    const raw = opts.buffer || decodeBase64(opts.base64);
    let printable;
    try {
      printable = await convertToPrintableBmp1bpp(raw);
    } catch (err) {
      const msg = err?.message || String(err);
      throw new Error(
        msg.includes("Logo") || msg.includes("BMP") || msg.includes("Unsupported")
          ? `Logo inválida — envie PNG, JPG ou BMP. ${msg}`
          : `Logo inválida — não foi possível converter para BMP monocromático. ${msg}`,
      );
    }
    const buf = printable.buffer;
    fs.writeFileSync(LOGO_BMP, buf);
    mirrorLegacyBmp(buf);
    meta.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    logoBufferCache = { sha256: meta.sha256, buffer: buf };
    meta.ativo = opts.ativo !== false;
    meta.modo = opts.modo || "arquivo";
    meta.atualizadoEm = new Date().toISOString();
    meta.converted = !!printable.converted;
    if (meta.fatorX == null || Number(meta.fatorX) <= 1) {
      meta.fatorX = String(FATOR_PADRAO);
      meta.fatorY = String(FATOR_PADRAO);
    }
    invalidatePrintCache();
    lastLogoSkipReason = null;
    log.info(
      {
        bytes: buf.length,
        converted: !!printable.converted,
        path: LOGO_BMP,
        width: printable.width,
        height: printable.height,
      },
      "[PrinterLogo] Logo BMP 1-bpp salvo",
    );
  } else if (`${meta.fatorX}|${meta.fatorY}` !== fatorAntes) {
    invalidatePrintCache();
  }

  salvarMeta(meta);
  return ler();
}

function remover() {
  ensureDir();
  try {
    if (fs.existsSync(LOGO_BMP)) fs.unlinkSync(LOGO_BMP);
  } catch (_) {}
  try {
    const legacy = path.join(AGENT_ROOT, "data", "printer", "logo.bmp");
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  } catch (_) {}
  invalidatePrintCache();
  logoBufferCache = { sha256: null, buffer: null };
  lastLogoSkipReason = "sem_arquivo";
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
  const cached = getCachedLoInfo();
  if (cached) {
    return cached;
  }

  const t0 = performance.now();
  ensureDir();
  const meta = lerMeta();
  const existe = fs.existsSync(LOGO_BMP);
  const explicitPath = process.env.PRINTER_LOGO_PATH;
  const caminhoAbsoluto =
    existe
      ? path.resolve(LOGO_BMP)
      : explicitPath && fs.existsSync(explicitPath)
        ? path.resolve(explicitPath)
        : null;
  const size = resolveLogoPrintSize(meta);
  const printable = (() => {
    if (!caminhoAbsoluto) return false;
    try {
      const buf =
        logoBufferCache.sha256 === meta.sha256 && logoBufferCache.buffer
          ? logoBufferCache.buffer
          : fs.readFileSync(caminhoAbsoluto);
      return isBmp1bppPrintable(buf);
    } catch (_) {
      return false;
    }
  })();
  const result = {
    ...meta,
    ativo: meta.ativo && !!caminhoAbsoluto,
    existe,
    caminhoAbsoluto,
    caminhoRelativo: existe ? path.relative(AGENT_ROOT, LOGO_BMP) : null,
    dir: LOGO_DIR,
    printSize: size,
    fatorXEfetivo: size.fatorX,
    fatorYEfetivo: size.fatorY,
    imprimivel: printable,
    lastSkipReason: lastLogoSkipReason,
  };

  setCachedLoInfo(result);

  const elapsedMs = performance.now() - t0;
  if (elapsedMs > 10) {
    log.debug({ elapsedMs, metric: "print.logo_ler_duration" }, "[PrinterLogo] ler() timing");
  }
  return result;
}

function lerBuffer() {
  const t0 = performance.now();
  const meta = lerMeta();
  if (!meta.ativo) return null;

  if (logoBufferCache.sha256 === meta.sha256 && logoBufferCache.buffer) {
    return logoBufferCache.buffer;
  }

  const info = ler();
  if (!info.caminhoAbsoluto) return null;

  const caminho = info.caminhoAbsoluto;
  const tRead = performance.now();
  const buf = fs.readFileSync(caminho);
  const readMs = performance.now() - tRead;

  logoBufferCache = { sha256: meta.sha256, buffer: buf };

  const totalMs = performance.now() - t0;
  log.debug(
    { totalMs, readMs, bytes: buf.length, metric: "print.logo_lerbuffer_duration" },
    "[PrinterLogo] lerBuffer() timing",
  );
  return buf;
}

async function prepararArquivoEscpos(metaOrInfo) {
  const t0 = performance.now();
  const info = metaOrInfo?.caminhoAbsoluto ? metaOrInfo : ler();
  if (!info.caminhoAbsoluto) return null;
  const size = info.printSize || resolveLogoPrintSize(info);
  const cacheKey = `${info.sha256 || info.caminhoAbsoluto}|${size.escposWidthDots}`;

  if (loPrintCacheKeyMemory.sha256 === info.sha256 && loPrintCacheKeyMemory.key === cacheKey) {
    if (fs.existsSync(LOGO_PRINT_CACHE)) {
      log.debug(
        { elapsedMs: performance.now() - t0, metric: "print.prepararescpos_cached" },
        "[PrinterLogo] prepararArquivoEscpos() — cache hit (memory)",
      );
      return LOGO_PRINT_CACHE;
    }
  }

  try {
    if (fs.existsSync(LOGO_PRINT_CACHE) && fs.existsSync(LOGO_PRINT_KEY)) {
      const diskKey = fs.readFileSync(LOGO_PRINT_KEY, "utf8");
      if (diskKey === cacheKey) {
        loPrintCacheKeyMemory = { sha256: info.sha256, key: cacheKey };
        return LOGO_PRINT_CACHE;
      }
    }
  } catch (_) {}

  ensureDir();
  const sharp = require("sharp");
  const tSharp = performance.now();
  await sharp(info.caminhoAbsoluto)
    .resize({
      width: size.escposWidthDots,
      fit: "inside",
      withoutEnlargement: false,
      kernel: sharp.kernel.nearest,
    })
    .png()
    .toFile(LOGO_PRINT_CACHE);
  const sharpMs = performance.now() - tSharp;

  fs.writeFileSync(LOGO_PRINT_KEY, cacheKey, "utf8");
  loPrintCacheKeyMemory = { sha256: info.sha256, key: cacheKey };

  log.info(
    {
      totalMs: performance.now() - t0,
      sharpMs,
      metric: "print.prepararescpos_regenerated",
    },
    "[PrinterLogo] prepararArquivoEscpos() regenerated",
  );
  return LOGO_PRINT_CACHE;
}

function exibirLogoCupomHabilitado(payload) {
  if (payload && typeof payload.exibirLogo === "boolean") return payload.exibirLogo;
  const env = process.env.PRINTER_LOGO_EXIBIR ?? process.env.IMPRESSAO_EXIBIR_LOGO;
  if (env != null && String(env).toLowerCase() === "false") return false;
  return true;
}

/**
 * @returns {{ ok: boolean, reason: string|null }}
 */
function avaliarExibicaoLogo(payload) {
  if (!exibirLogoCupomHabilitado(payload)) {
    lastLogoSkipReason = "toggle_off";
    return { ok: false, reason: "toggle_off" };
  }
  const info = ler();
  if (!(info.ativo && info.caminhoAbsoluto)) {
    lastLogoSkipReason = "sem_arquivo";
    return { ok: false, reason: "sem_arquivo" };
  }
  try {
    const buf = lerBuffer();
    if (!buf || !isBmp1bppPrintable(buf)) {
      lastLogoSkipReason = "bmp_invalido";
      return { ok: false, reason: "bmp_invalido" };
    }
  } catch (_) {
    lastLogoSkipReason = "erro";
    return { ok: false, reason: "erro" };
  }
  lastLogoSkipReason = null;
  return { ok: true, reason: null };
}

function deveExibirLogoCupom(payload) {
  const av = avaliarExibicaoLogo(payload);
  if (!av.ok) {
    if (av.reason === "bmp_invalido") {
      log.warn("[PrinterLogo] BMP inválido/corrompido — logo omitida no cupom");
    }
    return false;
  }
  return true;
}

function getLastLogoSkipReason() {
  return lastLogoSkipReason;
}

async function warmLogoEscpos() {
  try {
    const info = ler();
    if (!(info.ativo && info.caminhoAbsoluto)) return false;
    const pathOut = await prepararArquivoEscpos(info);
    if (!pathOut) return false;
    try {
      const core = require("./escpos/impressoraCore");
      if (typeof core.warmLogoEscposImage === "function") {
        await core.warmLogoEscposImage(pathOut, info);
      }
    } catch (_) {}
    return true;
  } catch (err) {
    log.debug({ err: err?.message }, "[PrinterLogo] warm falhou");
    return false;
  }
}

module.exports = {
  get LOGO_DIR() {
    return LOGO_DIR;
  },
  get LOGO_BMP() {
    return LOGO_BMP;
  },
  get LOGO_PRINT_CACHE() {
    return LOGO_PRINT_CACHE;
  },
  salvar,
  remover,
  ler,
  lerBuffer,
  isBmpBuffer,
  isBmpPrintable,
  isBmp1bppPrintable,
  encodeBmp1bppFromRaw,
  makeTestBmp1bpp,
  convertToPrintableBmp1bpp,
  exibirLogoCupomHabilitado,
  deveExibirLogoCupom,
  avaliarExibicaoLogo,
  getLastLogoSkipReason,
  prepararArquivoEscpos,
  warmLogoEscpos,
  resolveLogoPrintSize,
  invalidatePrintCache,
  __test: {
    resetCaches() {
      logoBufferCache = { sha256: null, buffer: null };
      loInfoCache = { data: null, expiresAt: 0 };
      loPrintCacheKeyMemory = { sha256: null, key: null };
      lastLogoSkipReason = null;
    },
    setLastSkipReason(r) {
      lastLogoSkipReason = r;
    },
  },
};
