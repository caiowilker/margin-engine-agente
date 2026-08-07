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
assert.match(tags, /barcode/i);
assert.match(tags, /qrcode/i);
assert.match(tags, /Caucao retida/);
assert.doesNotMatch(tags, /NFC-e chave/i);
assert.equal(normalizarVasilhamePayload({ codigo: "vas7" }).codigoTransacao, "VAS7");
assert.equal(normalizarVasilhamePayload({ codigoTransacao: "VAS7" }).naoFiscal, true);
assert.equal(normalizarVasilhamePayload({ codigoTransacao: "VAS7" }).cupomSemFiscal, true);

console.log("vasilhame-print.test.js ok");
