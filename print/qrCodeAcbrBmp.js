/**
 * QR Code NFC-e como BMP para ACBr — URLs oficiais contêm "|" que quebram o parser
 * de tags <qrcode> no POS_Imprimir. Gera BMP monocromático via qr-image + sharp.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const qrImage = require("qr-image");
const sharp = require("sharp");
const { tagBmp } = require("./acbrTags");

const QR_BMP_PLACEHOLDER = "{{ME_QR_BMP}}";
const CACHE_DIR = path.join(os.tmpdir(), "margin-engine-qr-bmp");

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

async function gerarBmpQrAcbr(content) {
  const texto = String(content || "").trim();
  if (!texto) throw new Error("Conteúdo QR vazio");

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const bmpPath = path.join(CACHE_DIR, `nfce-${hashConteudo(texto)}.bmp`);
  if (fs.existsSync(bmpPath) && fs.statSync(bmpPath).size > 64) {
    return bmpPath;
  }

  const png = qrImage.imageSync(texto, { type: "png", margin: 1, size: 5 });
  const largura = Number(process.env.PRINTER_QR_BMP_WIDTH || 280);
  await sharp(png)
    .resize(largura, largura, { fit: "inside", withoutEnlargement: true })
    .grayscale()
    .toFormat("bmp")
    .toFile(bmpPath);

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
  tagQrBmpPlaceholder,
  coletarConteudosQrBmp,
  resolverQrBmpPlaceholders,
};
