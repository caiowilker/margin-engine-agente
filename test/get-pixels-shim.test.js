/**
 * get-pixels substituído (vendor/get-pixels-sharp): sem `request`, só arquivo/Buffer, pixels idênticos ao PNG
 * de origem; escpos.Image e qrimage continuam funcionando; simulação 58/80 mm cabe no papel.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const getPixels = require("get-pixels");

function decodificar(origem, tipo) {
  return new Promise((resolve, reject) => getPixels(origem, tipo, (err, px) => (err ? reject(err) : resolve(px))));
}

test("é o substituto local e a árvore não tem mais request", () => {
  assert.equal(require("get-pixels/package.json").version, "3.3.3-margin.1");
  assert.throws(() => require.resolve("request"));
});

test("PNG em Buffer: RGBA idêntico ao original, shape [largura, altura, 4]", async () => {
  const largura = 3;
  const altura = 2;
  const original = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    255, 255, 255, 255, 0, 0, 0, 255, 10, 20, 30, 0,
  ]);
  const png = await sharp(original, { raw: { width: largura, height: altura, channels: 4 } }).png().toBuffer();
  const px = await decodificar(png, "image/png");
  assert.deepEqual(px.shape, [largura, altura, 4]);
  assert.deepEqual(Buffer.from(px.data), original);
});

test("cinza sem alfa vira RGBA (4 canais)", async () => {
  const png = await sharp(Buffer.from([0, 128, 255, 64]), { raw: { width: 2, height: 2, channels: 1 } })
    .png()
    .toBuffer();
  const px = await decodificar(png);
  assert.deepEqual(px.shape, [2, 2, 4]);
  assert.deepEqual([...px.data.subarray(4, 8)], [128, 128, 128, 255]);
});

test("arquivo local funciona; URL e data URI são recusados", async () => {
  const arq = path.join(os.tmpdir(), `gp-${process.pid}.png`);
  await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).png().toFile(arq);
  try {
    assert.deepEqual((await decodificar(arq)).shape, [4, 4, 4]);
  } finally {
    fs.rmSync(arq, { force: true });
  }
  await assert.rejects(decodificar("https://exemplo.com/logo.png"), /URL não suportada/);
  await assert.rejects(decodificar("data:image/png;base64,AAAA"), /URL não suportada/);
});

test("simulação 58/80 mm: logo e QR em raster dentro da largura, QR nativo e etiqueta ZPL", async () => {
  const { simular, PAPEIS } = require("../scripts/simular-impressao-termica");
  const saida = fs.mkdtempSync(path.join(os.tmpdir(), "sim-termica-"));
  try {
    for (const papel of PAPEIS) {
      const r = await simular(papel, saida);
      assert.equal(r.rasters.length, 2, `${papel.nome}: logo + QR`);
      assert.ok(r.cabeNoPapel, `${papel.nome}: raster mais largo que o papel`);
      assert.ok(r.qrNativo);
      assert.ok(r.bytesEtiqueta > 0);
    }
  } finally {
    fs.rmSync(saida, { recursive: true, force: true });
  }
});
