const assert = require("node:assert/strict");
const {
  renderCrediarioTags,
  normalizarCrediarioPayload,
} = require("../print/crediarioAcbrTags");

const tags = renderCrediarioTags({
  clienteNome: "Cliente Teste",
  clienteDocumento: "12345678901",
  numeroParcela: 1,
  totalParcelas: 3,
  valorRecebido: 50.5,
  formaPagamento: "DINHEIRO",
  operador: "op@test.com",
  saldoAnterior: 150,
  saldoRemanescente: 99.5,
  dataRecebimento: "06/08/2026 20:00",
});

assert.match(tags, /RECEBIMENTO CREDIARIO/);
assert.match(tags, /Comprovante nao fiscal/);
assert.match(tags, /Cliente Teste/);
assert.match(tags, /Saldo rem/);
assert.match(tags, /99,50/);
assert.match(tags, /DINHEIRO/);
assert.match(tags, /op@test\.com/);
assert.doesNotMatch(tags, /NFC-e chave/i);
assert.equal(normalizarCrediarioPayload({ totalRecebido: 10 }).valorRecebido, 10);
assert.equal(normalizarCrediarioPayload({}).naoFiscal, true);

console.log("crediario-print.test.js ok");
