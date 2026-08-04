/**
 * Prova objetiva: patch de Printer.prototype.image elimina
 * (a) hang por callback nunca chamado
 * (b) atraso N × 200ms por linha do bitmap
 */
const assert = require("assert");
const path = require("path");

// Carrega o core (aplica o patch no require)
const impressoraCore = require("../print/escpos/impressoraCore");
const escpos = require("escpos");
const Image = escpos.Image;

function makeImage(heightPx, widthPx = 64) {
  const colors = 4;
  const data = new Uint8Array(widthPx * heightPx * colors);
  // fundo branco com faixa preta
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  return new Image({ data, shape: [widthPx, heightPx, colors] });
}

class MemoryDevice {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this._open = true;
  }
  open(cb) {
    cb && cb(null);
  }
  write(data, cb) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    cb && cb(null);
  }
  close(cb) {
    cb && cb(null);
  }
}

async function main() {
  const height = 720; // 720/24 = 30 linhas → lib original = 6000ms se sequencial
  const lines = Math.ceil(height / 24);
  const img = makeImage(height);
  assert.strictEqual(img.toBitmap(24).data.length, lines);

  const device = new MemoryDevice();
  const printer = new escpos.Printer(device, { encoding: "CP860" });

  // 1) Callback deve disparar (lib original NÃO disparava)
  const tCb = performance.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("callback nunca chamado — hang reproduzido")),
      1500,
    );
    printer.image(img, "d24", (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
  const cbMs = performance.now() - tCb;
  console.log(`✓ callback image() em ${cbMs.toFixed(1)}ms (linhas=${lines})`);
  assert.ok(cbMs < 500, `callback lento demais: ${cbMs}ms (esperado <500, NÃO ${lines * 200})`);

  // 2) await Promise (caminho novo do agente)
  const device2 = new MemoryDevice();
  const printer2 = new escpos.Printer(device2, { encoding: "CP860" });
  const tP = performance.now();
  await printer2.image(img, "d24");
  const pMs = performance.now() - tP;
  console.log(`✓ await image() Promise em ${pMs.toFixed(1)}ms`);
  assert.ok(pMs < 500, `Promise lenta: ${pMs}ms`);
  // Bytes ficam no MutableBuffer interno até flush/close — não no device ainda
  const bufLen =
    (printer2.buffer && typeof printer2.buffer.size === "function"
      ? printer2.buffer.size()
      : 0) ||
    (Buffer.isBuffer(printer2.buffer) ? printer2.buffer.length : 0);
  assert.ok(
    bufLen > 0 || (printer2.buffer && printer2.buffer.buffer && printer2.buffer.buffer.length > 0),
    "MutableBuffer do printer deve receber bytes da logo",
  );

  // Orçamento teórico da lib original sequencial
  const originalSequentialMs = lines * 200;
  console.log(
    `✓ economia vs N×200ms: ${originalSequentialMs}ms → ${pMs.toFixed(0)}ms (ganho ~${(
      originalSequentialMs - pMs
    ).toFixed(0)}ms)`,
  );

  // sanitize exports touch
  assert.ok(typeof impressoraCore.invalidateLogoEscposImageCache === "function");
  impressoraCore.invalidateLogoEscposImageCache();

  console.log("OK — patch escpos.image validado");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
