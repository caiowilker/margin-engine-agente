/**
 * Etiqueta térmica raw (ZPL/PPLA) — normalização + encoding.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizarPayloadRaw,
  bufferFromPayload,
  validarFormatoLeve,
} = require("../print/rawLabelPrint");

describe("rawLabelPrint", () => {
  it("normaliza ZPL utf8 com cópias", () => {
    const n = normalizarPayloadRaw({
      data: "^XA^FO50,50^FDTest^FS^XZ",
      formato: "zpl",
      copies: 3,
    });
    assert.equal(n.encoding, "utf8");
    assert.equal(n.copies, 3);
    assert.equal(n.formato, "zpl");
    const buf = bufferFromPayload(n);
    assert.ok(buf.toString("utf8").includes("^XA"));
    validarFormatoLeve(buf, "zpl");
  });

  it("preserva STX do PPLA em latin1", () => {
    const ppla = "\u0002L\r\nD11\r\n1e4202500010010\r\nE\r\n";
    const n = normalizarPayloadRaw({ data: ppla, formato: "ppla" });
    assert.equal(n.encoding, "latin1");
    const buf = bufferFromPayload(n);
    assert.equal(buf[0], 0x02);
    assert.ok(buf.includes(0x45) /* E */);
  });

  it("rejeita data vazia", () => {
    assert.throws(() => normalizarPayloadRaw({ data: "  " }), /vazio/i);
  });

  it("valida porta RAW/TCP", () => {
    assert.throws(
      () => normalizarPayloadRaw({ data: "^XA^XZ", porta: "USB001" }),
      /RAW:|TCP:/i,
    );
    const n = normalizarPayloadRaw({
      data: "^XA^XZ",
      porta: "RAW:Zebra ZD220",
    });
    assert.equal(n.porta, "RAW:Zebra ZD220");
  });

  it("limita cópias a 99", () => {
    const n = normalizarPayloadRaw({ data: "^XA^XZ", copies: 500 });
    assert.equal(n.copies, 99);
  });

  it("aplica ^PQ no ZPL sem N envios", () => {
    const { aplicarCopiasZpl, pareceImpressoraCupom } = require("../print/rawLabelPrint");
    assert.equal(aplicarCopiasZpl("^XA^FDx^FS^XZ", 5), "^XA^FDx^FS^PQ5^XZ");
    assert.equal(aplicarCopiasZpl("^XA^PQ1^XZ", 3), "^XA^PQ3^XZ");
    assert.equal(aplicarCopiasZpl("^XA^XZ", 1), "^XA^XZ");
    assert.equal(pareceImpressoraCupom("RAW:POS80"), true);
    assert.equal(pareceImpressoraCupom("RAW:Zebra ZD220"), false);
  });

  it("imprimirRaw exige porta de etiquetas", async () => {
    const { imprimirRaw } = require("../print/rawLabelPrint");
    await assert.rejects(
      () => imprimirRaw({ data: "^XA^XZ", formato: "zpl" }),
      /Selecione a impressora/i,
    );
    await assert.rejects(
      () =>
        imprimirRaw({
          data: "^XA^XZ",
          formato: "zpl",
          porta: "RAW:POS-80 Cupom",
        }),
      /cupom/i,
    );
  });
});
