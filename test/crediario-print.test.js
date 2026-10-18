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
  empresa: {
    nome: "Loja Exemplo",
    cnpj: "12345678000199",
    endereco: "Rua A, 10",
    cidade: "Sao Paulo",
    uf: "SP",
    telefone: "11999990000",
  },
});

assert.match(tags, /RECEBIMENTO CREDIARIO/);
assert.match(tags, /Comprovante nao fiscal/);
assert.match(tags, /Cliente Teste/);
assert.match(tags, /Saldo remanescente/);
assert.match(tags, /99,50/);
assert.match(tags, /Dinheiro/);
assert.match(tags, /VALOR RECEBIDO/);
assert.match(tags, /Guarde este comprovante/);
assert.match(tags, /Loja Exemplo/);
assert.match(tags, /op@test\.com/);
assert.doesNotMatch(tags, /NFC-e chave/i);
assert.equal(normalizarCrediarioPayload({ totalRecebido: 10 }).valorRecebido, 10);
assert.equal(normalizarCrediarioPayload({}).naoFiscal, true);

const tagsReimp = renderCrediarioTags({
  valorRecebido: 10,
  clienteNome: "Y",
  reimpressao: true,
});
assert.match(tagsReimp, /SEGUNDA VIA/);

const tagsClickIdSo = renderCrediarioTags({
  valorRecebido: 10,
  clienteNome: "Z",
  clickId: "abc-123",
});
assert.doesNotMatch(tagsClickIdSo, /SEGUNDA VIA/);

console.log("crediario-print.test.js ok");

const tagsQuit = renderCrediarioTags({
  titulo: "QUITACAO CREDIARIO",
  clienteNome: "Cliente Teste",
  valorRecebido: 80,
  parcelasQuitadas: 2,
  parcelasParciais: 1,
  formaPagamento: "PIX",
  saldoRemanescente: 0,
});
assert.match(tagsQuit, /QUITACAO CREDIARIO/);
assert.match(tagsQuit, /2 quitada/);
assert.match(tagsQuit, /1 parcial/);

const tagsParcial = renderCrediarioTags({
  titulo: "PAGAMENTO PARCIAL CREDIARIO",
  valorRecebido: 20,
  clienteNome: "X",
});
assert.match(tagsParcial, /PAGAMENTO PARCIAL/);
