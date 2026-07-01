/**
 * Imagens de produtos — Storage via DirectoryManager (sem binário no banco local).
 * Original / medium / thumb + metadados JSON; fail-safe (erros não propagam para PDV).
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getDirectoryManager } = require("../runtime/directoryManager");
const { writeFileAtomicSync } = require("../runtime/atomicWrite");
const auditLog = require("../auditLog");
const log = require("../logger").child({ modulo: "produto_imagens" });

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DIM = 3000;
const MEDIUM_WIDTH = 600;
const THUMB_SIZE = 150;

let sharpLib = null;
function getSharp() {
  if (sharpLib !== null) return sharpLib;
  try {
    sharpLib = require("sharp");
  } catch {
    sharpLib = false;
  }
  return sharpLib;
}

function lerTenantId(fallback) {
  try {
    const { lerConfig } = require("../credenciais");
    const cfg = lerConfig();
    return String(cfg?.tenantId || fallback || process.env.TENANT_ID || "local").trim();
  } catch {
    return String(fallback || process.env.TENANT_ID || "local").trim();
  }
}

function relKey(tenantId, produtoId) {
  return path.posix.join(String(tenantId), String(produtoId));
}

function pathsFor(tenantId, produtoId) {
  const dm = getDirectoryManager();
  const key = relKey(tenantId, produtoId);
  return {
    key,
    original: path.join(dm.dir("produtosOriginal"), key + ".webp"),
    medium: path.join(dm.dir("produtosMedium"), key + ".webp"),
    thumb: path.join(dm.dir("produtosThumb"), key + ".webp"),
    meta: path.join(dm.dir("storageRoot"), "Produtos", "meta", key + ".json"),
    tempDir: path.join(dm.dir("produtosTemp"), key),
  };
}

function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return "image/webp";
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) return "image/tiff";
  const head = buf.slice(0, 256).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.includes("<svg ")) return "image/svg+xml";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  return null;
}

function extFromMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "bin";
}

function validarBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) {
    throw new Error("Arquivo de imagem inválido ou vazio.");
  }
  if (buf.length > MAX_BYTES) {
    throw new Error("Imagem excede 10 MB. Reduza o arquivo antes do envio.");
  }
  const mime = sniffMime(buf);
  if (!mime || !["image/jpeg", "image/png", "image/webp"].includes(mime)) {
    throw new Error("Formato não permitido. Use JPG, PNG ou WEBP.");
  }
  if (mime === "image/gif") {
    const raw = buf.toString("binary");
    let frames = 0;
    for (let i = 0; i < raw.length - 1; i++) {
      if (raw.charCodeAt(i) === 0x21 && raw.charCodeAt(i + 1) === 0xf9) frames++;
      if (frames > 1) throw new Error("GIF animado não é permitido.");
    }
  }
  return mime;
}

function decodeInput(body) {
  if (body?.buffer && Buffer.isBuffer(body.buffer)) return body.buffer;
  if (body?.base64) {
    const raw = String(body.base64).trim();
    const b64 = raw.includes(",") ? raw.split(",").pop() : raw;
    return Buffer.from(b64, "base64");
  }
  return null;
}

function lerMetaFile(metaPath) {
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function urlPath(produtoId, variant) {
  return `/storage/produtos/${encodeURIComponent(produtoId)}/imagem/${variant}`;
}

async function processarComSharp(buf, mime) {
  const sharp = getSharp();
  if (!sharp) {
    throw new Error("Processamento de imagem indisponível neste ambiente (sharp).");
  }
  let img = sharp(buf, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (w <= 0 || h <= 0) throw new Error("Não foi possível ler dimensões da imagem.");

  let originalPipeline = img.clone();
  if (w > MAX_DIM || h > MAX_DIM) {
    originalPipeline = originalPipeline.resize({
      width: MAX_DIM,
      height: MAX_DIM,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  const originalBuf = await originalPipeline.webp({ quality: 88 }).toBuffer();
  const oMeta = await sharp(originalBuf).metadata();

  const mediumBuf = await sharp(originalBuf)
    .resize({ width: MEDIUM_WIDTH, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const mMeta = await sharp(mediumBuf).metadata();

  const thumbBuf = await sharp(originalBuf)
    .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: "cover", position: "centre" })
    .webp({ quality: 78 })
    .toBuffer();
  const tMeta = await sharp(thumbBuf).metadata();

  return {
    originalBuf,
    mediumBuf,
    thumbBuf,
    largura: oMeta.width || w,
    altura: oMeta.height || h,
    mediumWidth: mMeta.width || MEDIUM_WIDTH,
    mediumHeight: mMeta.height || 0,
    thumbWidth: tMeta.width || THUMB_SIZE,
    thumbHeight: tMeta.height || THUMB_SIZE,
    mimeSaida: "image/webp",
    extensao: "webp",
  };
}

/**
 * @param {{ produtoId: string, buffer?: Buffer, base64?: string, nome?: string, usuario?: string, tenantId?: string, ip?: string }} opts
 */
async function salvar(opts = {}) {
  const produtoId = String(opts.produtoId || "").trim();
  if (!produtoId) throw new Error("produtoId é obrigatório.");

  const tenantId = lerTenantId(opts.tenantId);
  const buf = opts.buffer || decodeInput(opts);
  if (!buf) throw new Error("Envie buffer ou base64 da imagem.");

  const mimeEntrada = validarBuffer(buf);
  getDirectoryManager().ensureAll();

  const paths = pathsFor(tenantId, produtoId);
  fs.mkdirSync(path.dirname(paths.original), { recursive: true });
  fs.mkdirSync(path.dirname(paths.medium), { recursive: true });
  fs.mkdirSync(path.dirname(paths.thumb), { recursive: true });
  fs.mkdirSync(path.dirname(paths.meta), { recursive: true });

  const anterior = lerMetaFile(paths.meta);
  const versao = (anterior?.version || 0) + 1;
  const imageId = anterior?.id || crypto.randomUUID();

  const proc = await processarComSharp(buf, mimeEntrada);
  const hash = crypto.createHash("sha256").update(proc.originalBuf).digest("hex");

  writeFileAtomicSync(paths.original, proc.originalBuf);
  writeFileAtomicSync(paths.medium, proc.mediumBuf);
  writeFileAtomicSync(paths.thumb, proc.thumbBuf);

  const nome = String(opts.nome || anterior?.nome || `produto-${produtoId}`).slice(0, 120);
  const agora = new Date().toISOString();
  const meta = {
    id: imageId,
    produtoId,
    tenantId,
    nome,
    extensao: proc.extensao,
    mimeType: proc.mimeSaida,
    mimeEntrada,
    sha256: hash,
    largura: proc.largura,
    altura: proc.altura,
    tamanhoBytes: proc.originalBuf.length,
    version: versao,
    principal: true,
    ordem: 0,
    storageKey: paths.key,
    criadoPor: opts.usuario || anterior?.criadoPor || null,
    criadoEm: anterior?.criadoEm || agora,
    atualizadoEm: agora,
    atualizadoPor: opts.usuario || null,
    urls: {
      thumbnail: urlPath(produtoId, "thumb"),
      medium: urlPath(produtoId, "medium"),
      original: urlPath(produtoId, "original"),
    },
  };

  writeFileAtomicSync(paths.meta, JSON.stringify(meta, null, 2), { encoding: "utf8" });

  try {
    auditLog.registrar("PRODUTO_IMAGEM_UPLOAD", {
      produtoId,
      tenantId,
      imageId,
      version: versao,
      sha256: hash,
      usuario: opts.usuario || null,
    }, opts.ip);
  } catch (err) {
    log.warn({ err: err.message }, "Auditoria imagem falhou (ignorado)");
  }

  log.info({ produtoId, tenantId, version: versao, bytes: proc.originalBuf.length }, "Imagem de produto salva");
  return meta;
}

function obterMeta(produtoId, tenantIdOpt) {
  const tenantId = lerTenantId(tenantIdOpt);
  const paths = pathsFor(tenantId, produtoId);
  const meta = lerMetaFile(paths.meta);
  if (!meta) return null;
  return meta;
}

function obterArquivo(produtoId, variant, tenantIdOpt) {
  const tenantId = lerTenantId(tenantIdOpt);
  const paths = pathsFor(tenantId, produtoId);
  const map = {
    thumb: paths.thumb,
    medium: paths.medium,
    original: paths.original,
  };
  const file = map[String(variant || "").toLowerCase()];
  if (!file || !fs.existsSync(file)) return null;
  return { file, mime: "image/webp" };
}

function remover(produtoId, opts = {}) {
  const tenantId = lerTenantId(opts.tenantId);
  const paths = pathsFor(tenantId, produtoId);
  const meta = lerMetaFile(paths.meta);
  const removidos = [];
  for (const f of [paths.original, paths.medium, paths.thumb, paths.meta]) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        removidos.push(f);
      }
    } catch (err) {
      log.warn({ file: f, err: err.message }, "Falha ao remover arquivo de imagem");
    }
  }
  try {
    if (fs.existsSync(paths.tempDir)) {
      fs.rmSync(paths.tempDir, { recursive: true, force: true });
    }
  } catch (_) {}

  try {
    auditLog.registrar("PRODUTO_IMAGEM_REMOVER", {
      produtoId,
      tenantId,
      imageId: meta?.id || null,
      usuario: opts.usuario || null,
    }, opts.ip);
  } catch (_) {}

  return { ok: true, removidos: removidos.length, metaAnterior: meta };
}

module.exports = {
  MAX_BYTES,
  MAX_DIM,
  MEDIUM_WIDTH,
  THUMB_SIZE,
  sniffMime,
  validarBuffer,
  salvar,
  obterMeta,
  obterArquivo,
  remover,
  urlPath,
  pathsFor,
};
