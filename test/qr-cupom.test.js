/**
 * QR NFC-e no cupom ESC/POS — garante sequência GS ( k padrão (Epson-compatível).
 * Contexto: printer.qrcode() da lib escpos usa GS Z / ESC Z (proprietário) e
 * impressoras Epson-compatíveis imprimem a URL como texto no lugar do QR.
 */
const escpos = require("escpos");
const { bytesQrGsK } = require("../print/escpos/impressoraCore");
const { extrairQrCodeDoXml } = require("../documentosFiscais");

class MemoryDevice {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  open(cb) {
    cb(null);
  }
  write(data, cb) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (cb) cb(null);
  }
  close(cb) {
    if (cb) cb(null);
  }
}

const QR_URL =
  "https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=31250612343055000183650010000000031287563639|2|1|1|12.50|abc123|000001";

function gerarBuffer(renderFn) {
  return new Promise((resolve, reject) => {
    const device = new MemoryDevice();
    device.open((err) => {
      if (err) return reject(err);
      const printer = new escpos.Printer(device, { encoding: "CP860" });
      const finalizar = () => {
        // printer.close() faz flush do MutableBuffer → adapter.write
        printer.close(() => resolve(device.buffer));
      };
      try {
        const outcome = renderFn(printer);
        if (outcome && typeof outcome.then === "function") {
          outcome.then(finalizar).catch(reject);
        } else {
          finalizar();
        }
      } catch (e) {
        reject(e);
      }
    });
  });
}

function indexOfBytes(haystack, needle) {
  return haystack.indexOf(Buffer.from(needle));
}

async function main() {
  // ── 1. Sequência GS ( k completa e correta ────────────────────────────────
  const seq = bytesQrGsK(QR_URL);
  const dataLen = Buffer.byteLength(QR_URL, "utf8");
  const storeLen = dataLen + 3;

  const fn165 = [0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00];
  const fn167Prefix = [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43];
  const fn169Prefix = [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45];
  const fn180 = [
    0x1d, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, 0x30,
  ];
  const fn181 = [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30];

  if (indexOfBytes(seq, fn165) !== 0) {
    throw new Error("Fn165 (modelo 2) ausente ou fora de ordem");
  }
  if (indexOfBytes(seq, fn167Prefix) < 0) {
    throw new Error("Fn167 (tamanho módulo) ausente");
  }
  if (indexOfBytes(seq, fn169Prefix) < 0) {
    throw new Error("Fn169 (nível correção) ausente");
  }
  const posStore = indexOfBytes(seq, fn180);
  if (posStore < 0) {
    throw new Error("Fn180 (store) ausente ou pL/pH incorretos");
  }
  const posData = posStore + fn180.length;
  if (!seq.slice(posData, posData + dataLen).equals(Buffer.from(QR_URL, "utf8"))) {
    throw new Error("Dados do QR corrompidos dentro do Fn180");
  }
  const posPrint = indexOfBytes(seq, fn181);
  if (posPrint < posData + dataLen) {
    throw new Error("Fn181 (print) deveria vir após os dados");
  }

  // ── 2. Comandos proprietários (GS Z / ESC Z) não podem aparecer ──────────
  if (indexOfBytes(seq, [0x1d, 0x5a]) >= 0 || indexOfBytes(seq, [0x1b, 0x5a]) >= 0) {
    throw new Error("Sequência contém GS Z / ESC Z (proprietário, imprime URL como texto)");
  }

  // ── 3. Integração com Printer.raw() (bytes crus preservados no flush) ────
  const buf = await gerarBuffer((p) => {
    p.align("ct");
    p.raw(bytesQrGsK(QR_URL));
    p.cut();
  });
  if (indexOfBytes(buf, fn180) < 0 || indexOfBytes(buf, fn181) < 0) {
    throw new Error("GS ( k não sobreviveu ao MutableBuffer do driver");
  }

  // ── 4. Fallback raster (qrimage async) continua funcional ────────────────
  const bufRaster = await gerarBuffer(async (p) => {
    await new Promise((res, rej) =>
      p.qrimage(QR_URL, { type: "png", mode: "dhdw", size: 4 }, (e) =>
        e ? rej(e) : res(),
      ),
    );
    p.cut();
  });
  if (bufRaster.length < 500) {
    throw new Error("Fallback raster não gerou imagem");
  }

  // ── 5. Helpers fiscais ────────────────────────────────────────────────────
  const xml = `<infNFeSupl><qrCode><![CDATA[${QR_URL}]]></qrCode></infNFeSupl>`;
  if (extrairQrCodeDoXml(xml) !== QR_URL) {
    throw new Error("extrairQrCodeDoXml falhou");
  }
  const { portalConsultaNfce } = require("../documentosFiscais");
  if (portalConsultaNfce(QR_URL) !== "portalsped.fazenda.mg.gov.br") {
    throw new Error("portalConsultaNfce falhou");
  }

  console.log("OK qr-cupom.test.js", {
    gsK: seq.length,
    integracao: buf.length,
    raster: bufRaster.length,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
