#!/usr/bin/env node
const assert = require("assert");
const { renderCupomTags } = require("../print/cupomAcbrTags");

const tags = renderCupomTags({
  numeroVenda: "TESTE-ENCARGO",
  emitidoEm: "2026-11-18T12:00:00-03:00",
  empresa: { nomeFantasia: "Loja Teste", cnpj: "00000000000100" },
  itens: [{ codigo: "1", nome: "Pizza", quantidade: 1, precoUnitario: 50, total: 50 }],
  desconto: 0,
  acrescimo: 10,
  encargos: [{ tipo: "ENTREGA", descricao: "Entrega — Bairro Centro", valor: 10 }],
  total: 60,
  formaPagamento: "dinheiro",
  valorRecebido: 60,
  troco: 0,
  cupomLayoutPerfil: "COMPACTO",
});

assert.match(tags, /Subtotal:\s+R\$ 50,00/);
assert.match(tags, /Entrega — Bairro Centro:\s+\+ R\$ 10,00/);
assert.match(tags, /TOTAL: R\$ 60,00/);
console.log("cupom-encargos.test.js — OK");
