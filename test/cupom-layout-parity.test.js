#!/usr/bin/env node
/** Paridade ACBr tags ↔ ESC/POS nativo — corte, QR, rodapé, banners */
const assert = require("assert");
const { test } = require("node:test");

test("resolveCutMode / tagCorte / applyEscposCut — partial default", () => {
  const { resolveCutMode, isPartialCut, applyEscposCut } = require("../print/cupomLayoutShared");
  const { tagCorte } = require("../print/acbrTags");
  const prev = process.env.PRINTER_CUT;
  delete process.env.PRINTER_CUT;
  try {
    assert.strictEqual(resolveCutMode(), "partial");
    assert.strictEqual(isPartialCut(), true);
    assert.strictEqual(tagCorte(), "</corte_parcial>");
    assert.strictEqual(tagCorte("total"), "</corte_total>");
    assert.strictEqual(tagCorte("none"), "");

    let cutArg = null;
    const fake = {
      feed() {
        return this;
      },
      cut(part) {
        cutArg = part;
        return this;
      },
    };
    applyEscposCut(fake);
    assert.strictEqual(cutArg, true, "native deve corte parcial por default");
    applyEscposCut(fake, "total");
    assert.strictEqual(cutArg, false);
  } finally {
    if (prev === undefined) delete process.env.PRINTER_CUT;
    else process.env.PRINTER_CUT = prev;
  }
});

test("resolveQrPrintOpts — ACBr tag e GS(k) usam mesmos defaults", () => {
  const { resolveQrPrintOpts } = require("../print/cupomLayoutShared");
  const { tagQrCode } = require("../print/acbrTags");
  const core = require("../print/escpos/impressoraCore");
  const prevL = process.env.PRINTER_QR_ERROR_LEVEL;
  const prevM = process.env.PRINTER_QR_MODULE;
  delete process.env.PRINTER_QR_ERROR_LEVEL;
  delete process.env.PRINTER_QR_MODULE;
  process.env.PRINTER_PAPER_MM = "80";
  try {
    const q = resolveQrPrintOpts();
    assert.strictEqual(q.errorLevel, "M");
    assert.ok(q.moduleSize >= 4 && q.moduleSize <= 8);
    const tag = tagQrCode("https://exemplo.com");
    assert.ok(tag.includes(`ErrorLevel='${q.errorLevel}'`));
    assert.ok(tag.includes(`ModuleSize='${q.moduleSize}'`));
    const buf = core.bytesQrGsK("https://exemplo.com");
    assert.ok(Buffer.isBuffer(buf) && buf.length > 20);
    // Fn 167: … 1d 28 6b 03 00 31 43 <module>
    let moduleAt = -1;
    for (let i = 0; i < buf.length - 2; i++) {
      if (buf[i] === 0x31 && buf[i + 1] === 0x43) {
        moduleAt = i + 2;
        break;
      }
    }
    assert.ok(moduleAt > 0);
    assert.strictEqual(buf[moduleAt], q.moduleSize);
  } finally {
    if (prevL === undefined) delete process.env.PRINTER_QR_ERROR_LEVEL;
    else process.env.PRINTER_QR_ERROR_LEVEL = prevL;
    if (prevM === undefined) delete process.env.PRINTER_QR_MODULE;
    else process.env.PRINTER_QR_MODULE = prevM;
    delete process.env.PRINTER_PAPER_MM;
  }
});

test("FOOTER e banners — mesma fonte ACBr e native", () => {
  const { FOOTER, bannersStatusCupom, BANNER } = require("../print/cupomLayoutShared");
  const { renderCupomTags } = require("../print/cupomAcbrTags");
  assert.ok(FOOTER.obrigado);
  assert.ok(FOOTER.volte);
  assert.deepStrictEqual(bannersStatusCupom({ origem: "offline" }), [BANNER.offline]);
  assert.deepStrictEqual(bannersStatusCupom({ origem: "local", vendaCancelada: true }), [
    BANNER.cancelada,
    BANNER.offline,
  ]);
  const tags = renderCupomTags({
    naoFiscal: true,
    empresa: { nomeFantasia: "LOJA" },
    itens: [{ nome: "A", quantidade: 1, precoUnitario: 1, total: 1 }],
    total: 1,
    origem: "offline",
  });
  assert.ok(tags.includes(FOOTER.obrigado));
  assert.ok(tags.includes(FOOTER.volte));
  assert.ok(tags.includes(FOOTER.pdv));
  assert.ok(tags.includes(BANNER.offline));
  assert.ok(tags.includes("</corte_parcial>") || tags.includes("</corte_total>"));
});

test("barcodeSpecsFromPayload — EAN/CODE128", () => {
  const { barcodeSpecsFromPayload } = require("../print/cupomLayoutShared");
  const specs = barcodeSpecsFromPayload({
    ean13: "7891234567890",
    code128: "ABC",
    barcodes: [{ tipo: "EAN8", code: "12345670" }],
  });
  assert.strictEqual(specs.length, 3);
  assert.strictEqual(specs[0].tipo, "EAN13");
});

test("encodeCode128ForEscPos — prefixo {B Epson", () => {
  const { encodeCode128ForEscPos, sanitizeCode39 } = require("../print/cupomLayoutShared");
  assert.strictEqual(encodeCode128ForEscPos("VAS01"), "{BVAS01");
  assert.strictEqual(encodeCode128ForEscPos("{BVAS01"), "{BVAS01");
  assert.strictEqual(encodeCode128ForEscPos("{AVAS01"), "{AVAS01");
  assert.strictEqual(encodeCode128ForEscPos(""), "");
  assert.strictEqual(sanitizeCode39("vas-01*x"), "VAS-01X");
});
