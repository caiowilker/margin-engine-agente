#!/usr/bin/env node
/**
 * Testes estendidos impressão — npm run test:agent-print
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  tagQrCode,
  tagBarcode,
  tagBarcodesList,
  tagLogoConfig,
  BARCODE_TIPOS,
} = require("../print/acbrTags");
const { renderDanfeTermicoTags } = require("../print/danfeTermico");
const { marcarSegundaVia, montarPayloadSegundaVia } = require("../print/segundaVia");
const { renderPayloadTags, escolherRenderizador } = require("../print/renderPrint");
const printerLogo = require("../print/printerLogo");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

test("acbrTags — QR com margem e tipo", () => {
  const t = tagQrCode("https://x.com", { tipo: "2", margem: 2 });
  assert.ok(t.includes("<qrcode"));
  assert.ok(t.includes("Margem='2'"));
});

test("acbrTags — barcodes EAN13 EAN8 CODE128", () => {
  assert.ok(tagBarcode("EAN13", "7894900011517").includes("EAN13"));
  assert.ok(tagBarcode("EAN8", "96385074").includes("EAN8"));
  assert.ok(tagBarcode("CODE128", "ABC-123").includes("CODE128"));
  assert.ok(BARCODE_TIPOS.PDF417);
});

test("acbrTags — lista barcodes", () => {
  const tags = tagBarcodesList([
    { tipo: "EAN13", code: "7894900011517" },
    { tipo: "CODE128", code: "X" },
  ]);
  assert.strictEqual(tags.length, 2);
});

test("acbrTags — logo config KC", () => {
  const t = tagLogoConfig({ kc1: "48", kc2: "49" });
  assert.ok(t.includes("<logo_kc1>48</logo_kc1>"));
});

test("segundaVia — marcar banner", () => {
  const p = marcarSegundaVia({ numeroVenda: "V1", total: 1 });
  assert.strictEqual(p.segundaVia, true);
  assert.strictEqual(p.reimpressao, true);
});

test("segundaVia — payload direto", () => {
  const p = montarPayloadSegundaVia({
    payload: { numeroVenda: "V2", total: 10, itens: [], empresa: {} },
  });
  assert.strictEqual(p.segundaVia, true);
});

test("danfeTermico — tags NF-e 55", () => {
  const tags = renderDanfeTermicoTags({
    chaveNfe: "35260611222333000181550010000000301025012345",
    numeroVenda: "V-NFE",
    total: 100,
    empresa: { razaoSocial: "EMITENTE" },
    destinatario: { razaoSocial: "CLIENTE" },
    protocolo: "123456789012345",
    qrcodeNfe: "https://example.com/nfe",
  });
  assert.ok(tags.includes("DANFE SIMPLIFICADO"));
  assert.ok(tags.includes("<qrcode"));
  assert.ok(tags.includes("CODE128"));
});

test("renderPrint — escolhe danfe termico", () => {
  assert.strictEqual(
    escolherRenderizador({ chaveNfe: "35260611222333000181550010000000301025012345", danfeTermico: true }),
    "danfe",
  );
  assert.strictEqual(escolherRenderizador({ total: 1, itens: [] }), "cupom");
});

test("renderPayloadTags — cupom longo", () => {
  const tags = renderPayloadTags({
    emitidoEm: new Date().toISOString(),
    numeroVenda: "LONG",
    total: 500,
    empresa: { nomeFantasia: "LOJA" },
    itens: Array.from({ length: 30 }, (_, i) => ({
      nome: `Item ${i}`,
      quantidade: 1,
      precoUnitario: 10,
      total: 10,
    })),
    formaPagamento: "dinheiro",
  });
  assert.ok(tags.length > 800);
  assert.ok(tags.includes("TOTAL:"));
});

test("printerLogo — rejeita nao-BMP", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-test-"));
  process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");
  assert.throws(
    () => printerLogo.salvar({ base64: Buffer.from("PNG").toString("base64") }),
    /BMP monocromático/,
  );
});

test("printerLogo — aceita BMP header", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-bmp-"));
  process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");
  const bmp = Buffer.alloc(64);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  const info = printerLogo.salvar({ base64: bmp.toString("base64"), ativo: true });
  assert.strictEqual(info.ativo, true);
  assert.ok(info.sha256);
});

console.log(`\nprint-extended: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
