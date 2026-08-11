const assert = require("node:assert/strict");
const { renderVasilhameTags, normalizarVasilhamePayload } = require("../print/vasilhameAcbrTags");

const tags = renderVasilhameTags({
  codigoTransacao: "VAS42",
  clienteNome: "Cliente Teste",
  tipoNome: "Garrafa 600ml",
  tipoCodigo: "GARRAFA",
  quantidade: 2,
  caucaoCents: 1000,
  dataMovimento: "06/08/2026",
  operador: "op@test.com",
});

assert.match(tags, /EMPRESTIMO DE VASILHAME/);
assert.match(tags, /Comprovante nao fiscal/);
assert.match(tags, /VAS42/);
assert.match(tags, /ETIQUETA - COLE NO VASILHAME/);
assert.doesNotMatch(tags, /—/);
assert.match(tags, /COLE NO VASILHAME/);
assert.match(tags, /barcode/i);
assert.match(tags, /CODE128/);
assert.doesNotMatch(tags, /CODE39/);
assert.doesNotMatch(tags, /qrcode/i);
assert.equal((tags.match(/<barcode\b/gi) || []).length, 1);
assert.match(tags, /Caucao retida/);
assert.doesNotMatch(tags, /NFC-e chave/i);
assert.equal(normalizarVasilhamePayload({ codigo: "vas7" }).codigoTransacao, "VAS7");
assert.equal(normalizarVasilhamePayload({ codigoTransacao: "VAS7" }).naoFiscal, true);
assert.equal(normalizarVasilhamePayload({ codigoTransacao: "VAS7" }).cupomSemFiscal, true);

const tagsSv = renderVasilhameTags({
  codigoTransacao: "VAS99",
  reimpressao: true,
  clickId: "abc123",
  motivo: "reimpressao_vasilhame",
});
assert.match(tagsSv, /SEGUNDA VIA/i);
assert.match(tagsSv, /VAS99/);
assert.match(tagsSv, /barcode/i);
assert.equal(normalizarVasilhamePayload({ codigoTransacao: "vas1", clickId: "x" }).reimpressao, true);
assert.equal(normalizarVasilhamePayload({ codigoTransacao: "vas1" }).reimpressao, false);

console.log("vasilhame-print.test.js ok");
