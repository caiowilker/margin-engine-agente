/**
 * Sequencial — printerLogo usa MARGIN_ENGINE_ROOT global (não paralelo).
 */
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const printerLogo = require("../print/printerLogo");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-src-"));
process.env.MARGIN_ENGINE_ROOT = tmp;
process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");
printerLogo.__test.resetCaches();

(async () => {
  const bmp = printerLogo.makeTestBmp1bpp(16, 8);
  await printerLogo.salvar({ base64: bmp.toString("base64"), ativo: true });
  const source = path.join(printerLogo.LOGO_DIR, "logo.source.png");
  assert.ok(fs.existsSync(source), "salvar BMP 1-bpp deve gerar logo.source.png");

  fs.unlinkSync(source);
  printerLogo.invalidatePrintCache();
  printerLogo.__test.resetCaches();

  const decoded = printerLogo.decodeBmp1bppToRawGrey(bmp);
  assert.ok(decoded);
  assert.equal(decoded.width, 16);
  assert.equal(decoded.height, 8);

  const out = await printerLogo.prepararArquivoEscpos();
  assert.ok(out);
  assert.ok(fs.existsSync(source), "logo.source.png deve ser sintetizado do BMP");
  assert.ok(fs.existsSync(out));
  console.log("printer-logo-source.test.js ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
