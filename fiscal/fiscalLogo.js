/**
 * Logo DANFE A4 (NF-e 55 + NFC-e via consumidor) — PNG/JPG em ProgramData.
 * Separado do logo térmico BMP (print/printerLogo.js).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const log = require("../logger").child({ modulo: "fiscal_logo" });
const { ensureDirs, getPaths } = require("../marginPaths");

const LOGO_DIR = () => {
  const p = getPaths();
  return p.assetsLogo || path.join(p.root, "assets", "logo");
};
const logoDir = () => LOGO_DIR();
const LOGO_PNG = () => path.join(logoDir(), "logo.png");
const LOGO_JPG = () => path.join(logoDir(), "logo.jpg");
const LOGO_META = () => path.join(logoDir(), "logo.meta.json");

const MAX_BYTES = parseInt(process.env.FISCAL_LOGO_MAX_BYTES || "524288", 10);

function ensureDir() {
  ensureDirs();
  fs.mkdirSync(logoDir(), { recursive: true });
}

function lerMeta() {
  if (!fs.existsSync(LOGO_META())) {
    return {
      ativo: false,
      extensao: "png",
      origem: null,
      sha256: null,
      sha256Remoto: null,
      atualizadoEm: null,
      sincronizadoEm: null,
    };
  }
  try {
    return { ...JSON.parse(fs.readFileSync(LOGO_META(), "utf8")) };
  } catch (_) {
    return { ativo: false, extensao: "png" };
  }
}

function salvarMeta(meta) {
  ensureDir();
  fs.writeFileSync(LOGO_META(), JSON.stringify(meta, null, 2), "utf8");
}

function decodeBase64(input) {
  const raw = String(input || "").trim();
  const b64 = raw.includes(",") ? raw.split(",").pop() : raw;
  return Buffer.from(b64, "base64");
}

function detectarImagem(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    throw new Error("Arquivo de logo inválido ou vazio");
  }
  if (buf.length > MAX_BYTES) {
    throw new Error(`Logo excede ${Math.round(MAX_BYTES / 1024)} KB — reduza o arquivo`);
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mime: "image/png", dest: LOGO_PNG(), removeAlt: LOGO_JPG() };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg", dest: LOGO_JPG(), removeAlt: LOGO_PNG() };
  }
  throw new Error("Logo deve ser PNG ou JPG — SVG e BMP não são suportados no DANFE A4");
}

function resolverCaminhoAtivo(meta) {
  const png = fs.existsSync(LOGO_PNG());
  const jpg = fs.existsSync(LOGO_JPG());
  if (meta.extensao === "jpg" && jpg) return LOGO_JPG();
  if (png) return LOGO_PNG();
  if (jpg) return LOGO_JPG();
  return null;
}

/**
 * @param {{ base64?: string, buffer?: Buffer, ativo?: boolean, origem?: string, sha256Remoto?: string }} opts
 */
function salvar(opts = {}) {
  ensureDir();
  const meta = lerMeta();

  if (opts.ativo != null) meta.ativo = !!opts.ativo;
  if (opts.origem) meta.origem = String(opts.origem);
  if (opts.sha256Remoto) meta.sha256Remoto = String(opts.sha256Remoto);

  if (opts.base64 || opts.buffer) {
    const buf = opts.buffer || decodeBase64(opts.base64);
    const img = detectarImagem(buf);
    fs.writeFileSync(img.dest, buf);
    try {
      if (fs.existsSync(img.removeAlt)) fs.unlinkSync(img.removeAlt);
    } catch (_) {
      /* ignore */
    }
    meta.extensao = img.ext;
    meta.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    meta.ativo = opts.ativo !== false;
    meta.atualizadoEm = new Date().toISOString();
    meta.sincronizadoEm = opts.origem === "backend" ? meta.atualizadoEm : meta.sincronizadoEm;
    log.info({ bytes: buf.length, ext: img.ext }, "[FiscalLogo] Logo DANFE salvo");
  }

  salvarMeta(meta);
  return ler();
}

function remover() {
  ensureDir();
  for (const f of [LOGO_PNG(), LOGO_JPG()]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {
      /* ignore */
    }
  }
  salvarMeta({
    ativo: false,
    extensao: "png",
    origem: null,
    sha256: null,
    sha256Remoto: null,
    atualizadoEm: new Date().toISOString(),
    sincronizadoEm: null,
  });
  return ler();
}

function ler() {
  const meta = lerMeta();
  const caminhoAbsoluto = resolverCaminhoAtivo(meta);
  const existe = Boolean(caminhoAbsoluto && fs.existsSync(caminhoAbsoluto));
  let previewBase64 = null;
  if (existe && meta.ativo) {
    try {
      const buf = fs.readFileSync(caminhoAbsoluto);
      const mime = meta.extensao === "jpg" ? "image/jpeg" : "image/png";
      previewBase64 = `data:${mime};base64,${buf.toString("base64")}`;
    } catch (_) {
      /* ignore */
    }
  }
  return {
    ...meta,
    ativo: meta.ativo && existe,
    existe,
    caminhoAbsoluto: existe ? caminhoAbsoluto : null,
    dir: logoDir(),
    previewBase64,
    maxBytes: MAX_BYTES,
  };
}

/**
 * Path absoluto no staging da DLL. PathLogo do ACBr carrega a imagem do
 * filesystem — caminho relativo ao cwd falha ou desenha a logo quebrada.
 */
function caminhoParaAcbr(runtime) {
  const info = ler();
  if (!info.ativo || !info.caminhoAbsoluto) return null;
  try {
    const acbrLibRuntime = require("../fiscal/drivers/acbrLibRuntime");
    return acbrLibRuntime.ensureNativeDocumentPath(info.caminhoAbsoluto, runtime);
  } catch (_) {
    return info.caminhoAbsoluto;
  }
}

function precisaSincronizar(sha256Remoto) {
  if (!sha256Remoto) return false;
  const meta = lerMeta();
  const caminhoAbsoluto = resolverCaminhoAtivo(meta);
  const existe = Boolean(caminhoAbsoluto && fs.existsSync(caminhoAbsoluto));
  if (!existe) return true;
  return meta.sha256 !== sha256Remoto;
}

module.exports = {
  logoDir,
  MAX_BYTES,
  salvar,
  remover,
  ler,
  caminhoParaAcbr,
  precisaSincronizar,
  decodeBase64,
};
