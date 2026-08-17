/**
 * Sequencial — printerLogo + cache ESC/POS usam MARGIN_ENGINE_ROOT global.
 * Prova: raster GS v 0 no cache; cupom quente só raw (rápido); cupom frio não espera.
 */
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-gsv0-"));
process.env.MARGIN_ENGINE_ROOT = tmp;
process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");

const printerLogo = require("../print/printerLogo");
const core = require("../print/escpos/impressoraCore");

printerLogo.__test.resetCaches();
core.invalidateLogoEscposImageCache();

(async () => {
  const bmp = printerLogo.makeTestBmp1bpp(16, 8);
  await printerLogo.salvar({ base64: bmp.toString("base64"), ativo: true });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  core.invalidateLogoEscposImageCache();
  assert.equal(core.isLogoEscposReady(), false);

  const png = await printerLogo.prepararArquivoEscpos();
  assert.ok(png && fs.existsSync(png), "logo.print.png deve existir");

  const ok = await core.warmLogoEscposImage(png, printerLogo.ler(), { evenIfPrinting: true });
  assert.equal(ok, true, "warm deve rasterizar GS v 0");
  assert.equal(core.isLogoEscposReady(), true);

  const bytes = core.__test.getLogoEscposRawBytes();
  assert.ok(bytes && bytes.length > 8, `bytes insuficientes: ${bytes && bytes.length}`);
  const gsv0 = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
  assert.ok(bytes.includes(gsv0), "cache deve usar GS v 0");
  assert.equal(bytes.includes(Buffer.from([0x1b, 0x2a, 0x21])), false, "cache não pode ser ESC * d24");

  const chunks = [];
  const tHot = performance.now();
  await core.__test.imprimirLogoCupomEscpos(
    {
      raw(buf) {
        chunks.push(buf);
      },
    },
    { exibirLogo: true },
  );
  const hotMs = performance.now() - tHot;
  assert.ok(chunks.length >= 1, "cache quente deve emitir raw da logo");
  assert.ok(chunks[0].includes(gsv0), "cupom deve levar GS v 0");
  assert.ok(hotMs < 50, `hot path quente deve ser instantâneo, levou ${hotMs.toFixed(1)}ms`);

  core.invalidateLogoEscposImageCache();
  const cold = [];
  const tCold = performance.now();
  await core.__test.imprimirLogoCupomEscpos(
    {
      raw(buf) {
        cold.push(buf);
      },
    },
    { exibirLogo: true },
  );
  const coldMs = performance.now() - tCold;
  assert.equal(cold.length, 0, "cache frio omite logo neste cupom (não espera raster)");
  assert.ok(coldMs < 50, `hot path frio não pode rasterizar no cupom: ${coldMs.toFixed(1)}ms`);

  console.log("logo-escpos-gsv0.test.js ok", { bytes: chunks[0].length, hotMs, coldMs });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
