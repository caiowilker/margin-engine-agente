/**
 * QR Code NFC-e como BMP para ACBr — URLs oficiais contêm "|" que quebram o parser
 * de tags <qrcode> no POS_Imprimir. Gera BMP monocromático 1-bpp direto da matriz
 * do QR (sem sharp — a lib não suporta saída BMP).
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const qrImage = require("qr-image");
const { tagBmp } = require("./acbrTags");

const QR_BMP_PLACEHOLDER = "{{ME_QR_BMP}}";
const CACHE_DIR = path.join(os.tmpdir(), "margin-engine-qr-bmp");
/** Quiet zone da especificação QR (módulos de margem em cada lado). */
const QR_QUIET_ZONE_MODULES = 4;

function qrPrecisaBmp(content) {
  const s = String(content || "").trim();
  if (!s) return false;
  if (process.env.PRINTER_QR_BMP === "true") return true;
  // Pipe é separador de parâmetros no POS_Imprimir — URL NFC-e sempre contém |
  return s.includes("|");
}

function hashConteudo(content) {
  return crypto.createHash("sha256").update(String(content)).digest("hex").slice(0, 16);
}

/**
 * Codifica BMP monocromático (1-bpp, bottom-up) a partir da matriz do QR.
 * Paleta: índice 0 = preto, índice 1 = branco.
 */
function encodeBmpMonocromatico(matrix, scale) {
  const modules = matrix.length;
  const dim = modules + 2 * QR_QUIET_ZONE_MODULES;
  const size = dim * scale;
  const rowBytes = ((size + 31) >> 5) * 4;
  const pixelArraySize = rowBytes * size;
  const dataOffset = 14 + 40 + 8;
  const buf = Buffer.alloc(dataOffset + pixelArraySize, 0);

  // BITMAPFILEHEADER
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(dataOffset, 10);
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(size, 18);
  buf.writeInt32LE(size, 22);
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(1, 28); // 1 bpp
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixelArraySize, 34);
  buf.writeInt32LE(2835, 38); // ~72 dpi
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(2, 46); // cores usadas
  // Paleta: 0 = preto (BGRA), 1 = branco
  buf.writeUInt32LE(0x00000000, 54);
  buf.writeUInt32LE(0x00ffffff, 58);

  // Pixels: bit 1 = branco (fundo), bit 0 = preto (módulo escuro)
  for (let y = 0; y < size; y++) {
    const bmpRow = size - 1 - y; // bottom-up
    const rowStart = dataOffset + bmpRow * rowBytes;
    const moduleY = Math.floor(y / scale) - QR_QUIET_ZONE_MODULES;
    const linha =
      moduleY >= 0 && moduleY < modules ? matrix[moduleY] : null;
    for (let x = 0; x < size; x++) {
      const moduleX = Math.floor(x / scale) - QR_QUIET_ZONE_MODULES;
      const escuro =
        linha != null && moduleX >= 0 && moduleX < modules && !!linha[moduleX];
      if (!escuro) {
        buf[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return buf;
}

function gerarBufferBmpQr(texto) {
  const matrix = qrImage.matrix(texto, "M");
  const largura = Number(process.env.PRINTER_QR_BMP_WIDTH || 280);
  const dim = matrix.length + 2 * QR_QUIET_ZONE_MODULES;
  const scale = Math.max(2, Math.floor(largura / dim));
  return encodeBmpMonocromatico(matrix, scale);
}

async function gerarBmpQrAcbr(content) {
  const texto = String(content || "").trim();
  if (!texto) throw new Error("Conteúdo QR vazio");

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const bmpPath = path.join(CACHE_DIR, `nfce-${hashConteudo(texto)}.bmp`);
  if (fs.existsSync(bmpPath) && fs.statSync(bmpPath).size > 64) {
    return bmpPath;
  }

  fs.writeFileSync(bmpPath, gerarBufferBmpQr(texto));
  return bmpPath;
}

function tagQrBmpPlaceholder() {
  return QR_BMP_PLACEHOLDER;
}

function coletarConteudosQrBmp(payload) {
  const { resolverQrCodeNfce } = require("./cupomValidate");
  const vistos = new Set();
  const lista = [];

  function add(raw) {
    const c = String(raw || "").trim();
    if (!c || !qrPrecisaBmp(c) || vistos.has(c)) return;
    vistos.add(c);
    lista.push(c);
  }

  add(resolverQrCodeNfce(payload));
  for (const pg of payload?.pagamentos || []) {
    add(pg?.pixCopiaCola);
  }
  if (payload?.pixCopiaCola) add(payload.pixCopiaCola);

  return lista;
}

async function resolverQrBmpPlaceholders(tags, payloadOrContent) {
  let out = String(tags || "");
  if (!out.includes(QR_BMP_PLACEHOLDER)) return out;

  const conteudos = Array.isArray(payloadOrContent)
    ? payloadOrContent.filter((c) => qrPrecisaBmp(c))
    : typeof payloadOrContent === "object" && payloadOrContent !== null
      ? coletarConteudosQrBmp(payloadOrContent)
      : qrPrecisaBmp(payloadOrContent)
        ? [String(payloadOrContent).trim()]
        : [];

  for (const conteudo of conteudos) {
    if (!out.includes(QR_BMP_PLACEHOLDER)) break;
    const bmpPath = await gerarBmpQrAcbr(conteudo);
    const bmpTag = `<ce>${tagBmp(bmpPath.replace(/\\/g, "/"))}</ce>`;
    out = out.replace(QR_BMP_PLACEHOLDER, bmpTag);
  }

  if (out.includes(QR_BMP_PLACEHOLDER)) {
    out = out.split(QR_BMP_PLACEHOLDER).join("");
  }
  return out;
}

module.exports = {
  QR_BMP_PLACEHOLDER,
  qrPrecisaBmp,
  gerarBmpQrAcbr,
  gerarBufferBmpQr,
  tagQrBmpPlaceholder,
  coletarConteudosQrBmp,
  resolverQrBmpPlaceholders,
};
