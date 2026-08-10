/**
 * Dialetos barcode + hex dump — regressão do bug Elgin i9 ("?" no CODE128).
 *
 * Causa raiz: escpos.utils.codeLength omitia o byte `n` para payloads < 16 chars.
 * Bytes errados: 1D 6B 49 7B 42 …  ({ interpretado como n=123)
 * Bytes certos:  1D 6B 49 07 7B 42 … (n=7 = len de {BVAS01)
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildCode128FunctionB,
  buildCode39FunctionA,
  buildBarcodeSequence,
  resolveBarcodeDialect,
  bytesToHexDump,
  nextDialectAfterVisualFail,
  encodeCode128Payload,
} = require("../print/barcodeDialect");

/** Simula o bug do escpos.utils.codeLength */
function brokenEscposCode128Hex(code) {
  const data = encodeCode128Payload(code, "B");
  const codeLength = Buffer.from(data.length.toString(16), "hex").toString();
  const packet = Buffer.from("\x1d\x6b\x49" + codeLength + data + "\x00", "binary");
  return bytesToHexDump(packet);
}

test("Elgin i9 — CODE128 Function B tem byte n correto (não '?')", () => {
  const buf = buildCode128FunctionB("VAS01");
  assert.ok(buf);
  const hex = bytesToHexDump(buf);
  // 1D 6B 49 07 7B 42 56 41 53 30 31
  assert.equal(hex, "1D 6B 49 07 7B 42 56 41 53 30 31");
  assert.equal(buf[3], 7); // n
  assert.equal(buf[4], 0x7b); // {
  assert.equal(buf[5], 0x42); // B
});

test("Bug escpos — length omitido faz { virar n (causa do '?' na Elgin)", () => {
  const broken = brokenEscposCode128Hex("VAS01");
  // Sem n: 1D 6B 49 7B 42 … — 7B=123 interpretado como comprimento
  assert.equal(broken.startsWith("1D 6B 49 7B"), true);
  assert.notEqual(broken.startsWith("1D 6B 49 07"), true);

  const fixed = bytesToHexDump(buildCode128FunctionB("VAS01"));
  assert.equal(fixed.startsWith("1D 6B 49 07 7B 42"), true);
  assert.notEqual(broken, fixed);
});

test("Dialeto elgin — dual CODE128 + CODE39", () => {
  const seq = buildBarcodeSequence("VAS01", { dialect: "elgin", altura: 64, largura: 2 });
  assert.equal(seq.dialect, "elgin");
  const tipos = seq.plan.map((p) => p.tipo);
  assert.deepEqual(tipos, ["CODE128", "CODE39"]);
  assert.match(seq.fullHex, /1D 6B 49 07/);
  assert.match(seq.fullHex, /1D 6B 04/); // CODE39 Function A
});

test("Dialeto code39 — só CODE39 (após visual fail)", () => {
  const seq = buildBarcodeSequence("VAS01", { dialect: "code39" });
  assert.equal(seq.plan.length, 1);
  assert.equal(seq.plan[0].tipo, "CODE39");
});

test("forceCode128Fail → só CODE39 no plano", () => {
  const seq = buildBarcodeSequence("VAS01", {
    dialect: "epson",
    forceCode128Fail: true,
  });
  assert.equal(seq.plan.every((p) => p.tipo === "CODE39"), true);
});

test("resolveBarcodeDialect — nome Elgin i9 → elgin", () => {
  const d = resolveBarcodeDialect({
    dialect: null,
    nomeImpressora: "Elgin i9 USB",
    modeloAcbr: "1",
  });
  assert.equal(d.id, "elgin");
  assert.equal(d.maxWidth, 2);
});

test("resolveBarcodeDialect — Bematech / Daruma", () => {
  assert.equal(
    resolveBarcodeDialect({ nomeImpressora: "Bematech MP-4200" }).id,
    "bematech",
  );
  assert.equal(resolveBarcodeDialect({ nomeImpressora: "Daruma DR800" }).id, "daruma");
});

test("nextDialectAfterVisualFail avança até code39", () => {
  assert.equal(nextDialectAfterVisualFail("epson"), "elgin");
  assert.equal(nextDialectAfterVisualFail("elgin"), "bematech");
  assert.equal(nextDialectAfterVisualFail("bematech"), "daruma");
  assert.equal(nextDialectAfterVisualFail("daruma"), "code39");
  assert.equal(nextDialectAfterVisualFail("code39"), "code39");
});

test("CODE39 Function A — NUL terminator", () => {
  const buf = buildCode39FunctionA("VAS01");
  assert.ok(buf);
  assert.equal(buf[0], 0x1d);
  assert.equal(buf[1], 0x6b);
  assert.equal(buf[2], 0x04);
  assert.equal(buf[buf.length - 1], 0x00);
});

test("Hex dump documentado no manual Elgin (d1=123, d2=A|B|C)", () => {
  const buf = buildCode128FunctionB("VAS01");
  assert.equal(buf[4], 123); // {
  assert.ok(buf[5] >= 65 && buf[5] <= 67);
});

console.log("barcode-dialect.test.js ok");
