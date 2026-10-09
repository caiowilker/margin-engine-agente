#!/usr/bin/env node
/**
 * Impressão simulada (sem impressora): gera em arquivo o que iria para térmicas de 58 mm e 80 mm —
 * logo raster (escpos.Image via get-pixels/sharp), QR em imagem (qrimage), QR nativo (GS ( k) e etiqueta ZPL —
 * e uma prévia PNG de cada raster para conferência visual.
 *
 * Uso: node scripts/simular-impressao-termica.js [pasta-saida]   (padrão: data/simulacao-impressao)
 */
"use strict";

process.env.LOG_SILENT = process.env.LOG_SILENT || "true";

const fs = require("fs");
const os = require("os");
const path = require("path");
const escpos = require("escpos");
const sharp = require("sharp");
const { bytesQrGsK } = require("../print/escpos/impressoraCore");
const { resolveLogoBmpLargura } = require("../print/printerLogoSize");
const { normalizarPayloadRaw, bufferFromPayload, validarFormatoLeve } = require("../print/rawLabelPrint");

const PAPEIS = [
  { nome: "58mm", cols: 32, larguraDots: 384 },
  { nome: "80mm", cols: 48, larguraDots: 576 },
];
/** Logo típica de loja (texto escuro em fundo claro); o ícone do app é escuro e sairia todo preto no papel. */
const LOGO_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240">'
    + '<rect width="600" height="240" fill="#fff"/>'
    + '<circle cx="110" cy="120" r="80" fill="none" stroke="#000" stroke-width="18"/>'
    + '<path d="M70 150 L105 110 L130 130 L160 85" fill="none" stroke="#000" stroke-width="14"/>'
    + '<rect x="230" y="70" width="320" height="34" fill="#000"/><rect x="230" y="136" width="240" height="34" fill="#000"/>'
    + "</svg>",
);
const QR_URL = "https://app.marginengine.com.br/nfce?p=35261012345678000190650010000000011000000019|2|1|1|ABC";

class DispositivoMemoria {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  open(cb) {
    cb && cb(null);
  }
  write(dados, cb) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(dados) ? dados : Buffer.from(dados)]);
    cb && cb(null);
  }
  close(cb) {
    cb && cb(null);
  }
}

function carregarImagem(caminho) {
  return new Promise((resolve, reject) => {
    escpos.Image.load(caminho, (a, b) => {
      if (a instanceof Error) return reject(a);
      resolve(b || a);
    });
  });
}

function qrImagem(printer, conteudo) {
  return new Promise((resolve, reject) => {
    printer.qrimage(conteudo, { type: "png", mode: "dhdw", size: 4 }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Extrai os blocos GS v 0 (raster) de um buffer ESC/POS. */
function rasters(buf) {
  const out = [];
  for (let i = 0; i + 8 <= buf.length; i++) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      const larguraBytes = buf.readUInt16LE(i + 4);
      const altura = buf.readUInt16LE(i + 6);
      const dados = buf.subarray(i + 8, i + 8 + larguraBytes * altura);
      out.push({ larguraPx: larguraBytes * 8, altura, dados });
      i += 8 + dados.length - 1;
    }
  }
  return out;
}

async function previa(raster, arquivo) {
  const { larguraPx, altura, dados } = raster;
  const cinza = Buffer.alloc(larguraPx * altura, 255);
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < larguraPx; x++) {
      const byte = dados[y * (larguraPx / 8) + (x >> 3)];
      if (byte & (0x80 >> (x & 7))) cinza[y * larguraPx + x] = 0;
    }
  }
  await sharp(cinza, { raw: { width: larguraPx, height: altura, channels: 1 } }).png().toFile(arquivo);
}

async function simular(papel, saida) {
  const larguraLogo = Math.min(papel.larguraDots, resolveLogoBmpLargura(papel.cols, 1));
  const logoTmp = path.join(os.tmpdir(), `logo-${papel.nome}-${process.pid}.png`);
  await sharp(LOGO_SVG).resize({ width: larguraLogo, fit: "inside" }).png().toFile(logoTmp);

  const device = new DispositivoMemoria();
  const printer = new escpos.Printer(device, { width: papel.cols });
  const logo = await carregarImagem(logoTmp);
  printer.align("ct").raster(logo);
  printer.text("PEDIDO #0042 - SIMULACAO");
  await qrImagem(printer, QR_URL);
  printer.text("QR nativo:");
  await new Promise((resolve) => printer.flush(() => resolve()));
  const bufEscpos = Buffer.concat([device.buffer, bytesQrGsK(QR_URL, { modulo: papel.cols <= 32 ? 4 : 6 })]);
  fs.rmSync(logoTmp, { force: true });

  const zpl = bufferFromPayload(normalizarPayloadRaw({
    data: `^XA^PW${papel.larguraDots}^FO20,20^A0N,30,30^FDPIZZA MARGHERITA^FS^FO20,60^BQN,2,4^FDLA,${QR_URL}^FS^XZ`,
    formato: "zpl",
  }));
  validarFormatoLeve(zpl, "zpl");

  fs.writeFileSync(path.join(saida, `cupom-${papel.nome}.bin`), bufEscpos);
  fs.writeFileSync(path.join(saida, `etiqueta-${papel.nome}.zpl`), zpl);
  const blocos = rasters(bufEscpos);
  for (const [i, r] of blocos.entries()) {
    await previa(r, path.join(saida, `previa-${papel.nome}-${i === 0 ? "logo" : "qr"}.png`));
  }
  return {
    papel: papel.nome,
    bytesCupom: bufEscpos.length,
    rasters: blocos.map((r) => `${r.larguraPx}x${r.altura}`),
    larguraMaxDots: papel.larguraDots,
    cabeNoPapel: blocos.every((r) => r.larguraPx <= papel.larguraDots),
    qrNativo: bufEscpos.includes(Buffer.from([0x1d, 0x28, 0x6b])),
    bytesEtiqueta: zpl.length,
  };
}

async function main() {
  const saida = path.resolve(process.argv[2] || path.join(__dirname, "..", "data", "simulacao-impressao"));
  fs.mkdirSync(saida, { recursive: true });
  const resultado = [];
  for (const papel of PAPEIS) resultado.push(await simular(papel, saida));
  fs.writeFileSync(path.join(saida, "resultado.json"), JSON.stringify(resultado, null, 2));
  process.stdout.write(JSON.stringify({ saida, resultado }, null, 2) + "\n");
  if (!resultado.every((r) => r.cabeNoPapel && r.rasters.length >= 2 && r.qrNativo)) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Falha na simulação: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { simular, rasters, PAPEIS };
