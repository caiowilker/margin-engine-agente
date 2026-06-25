const escpos = require("escpos");
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
      const finalizar = () => device.close(() => resolve(device.buffer));
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

async function main() {
  const bufSync = await gerarBuffer((p) => {
    p.qrcode(QR_URL, 10, "M", 6);
    p.cut();
  });

  const bufBroken = await gerarBuffer((p) => {
    p.qrimage(QR_URL, { type: "png", mode: "dhdw", size: 4 });
    p.cut();
  });

  const bufFixed = await gerarBuffer(async (p) => {
    await new Promise((res, rej) =>
      p.qrimage(QR_URL, { type: "png", mode: "dhdw", size: 4 }, (e) =>
        e ? rej(e) : res(),
      ),
    );
    p.cut();
  });

  if (bufBroken.length >= bufFixed.length) {
    throw new Error("async qrimage deveria aumentar o buffer vs sync bug");
  }
  if (bufSync.length < 20) {
    throw new Error("QR nativo não gerou buffer");
  }

  const xml = `<infNFeSupl><qrCode><![CDATA[${QR_URL}]]></qrCode></infNFeSupl>`;
  if (extrairQrCodeDoXml(xml) !== QR_URL) {
    throw new Error("extrairQrCodeDoXml falhou");
  }

  const { portalConsultaNfce } = require("../documentosFiscais");
  if (portalConsultaNfce(QR_URL) !== "portalsped.fazenda.mg.gov.br") {
    throw new Error("portalConsultaNfce falhou");
  }

  console.log("OK qr-cupom.test.js", {
    sync: bufSync.length,
    broken: bufBroken.length,
    fixed: bufFixed.length,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
