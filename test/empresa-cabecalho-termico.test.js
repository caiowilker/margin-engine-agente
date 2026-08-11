const assert = require("node:assert/strict");
const {
  formatarLinhaEnderecoEmpresa,
  formatarCidadeUfEmpresa,
  resolverCabecalhoEmpresa,
  linhasCabecalhoEmpresaTags,
} = require("../print/empresaCabecalhoTermico");
const { renderVasilhameTags } = require("../print/vasilhameAcbrTags");

const logradouro = {
  nome: "Distribuidora Agua",
  cnpj: "12.345.678/0001-99",
  logradouro: "Av. Central",
  numero: "50",
  bairro: "Centro",
  cidade: "Recife",
  uf: "PE",
  telefone: "(81) 3333-4444",
};

assert.equal(
  formatarLinhaEnderecoEmpresa(logradouro),
  "Av. Central, 50, Centro",
);
assert.equal(formatarCidadeUfEmpresa(logradouro), "Recife - PE");
assert.equal(formatarLinhaEnderecoEmpresa({ endereco: "Rua Velha 10" }), "Rua Velha 10");
assert.equal(formatarCidadeUfEmpresa({ cidade: "Olinda" }), "Olinda");
assert.equal(formatarCidadeUfEmpresa({}), "");

const h = resolverCabecalhoEmpresa(logradouro);
assert.equal(h.nome, "Distribuidora Agua");
assert.match(h.cnpj, /12\.345\.678\/0001-99/);
assert.equal(h.telefone, "(81) 3333-4444");

const tags = linhasCabecalhoEmpresaTags(logradouro, 48);
assert.ok(tags.some((l) => /Distribuidora Agua/.test(l)));
assert.ok(tags.some((l) => /CNPJ:/.test(l)));
assert.ok(tags.some((l) => /Av\. Central, 50, Centro/.test(l)));
assert.ok(tags.some((l) => /Recife - PE/.test(l)));
assert.ok(tags.some((l) => /Tel: \(81\) 3333-4444/.test(l)));
assert.deepEqual(linhasCabecalhoEmpresaTags(null, 48), []);

const cupom = renderVasilhameTags({
  codigoTransacao: "VAS1",
  dataPrevistaDevolucao: "20/08/2026",
  empresa: logradouro,
});
assert.match(cupom, /Devolucao: 20\/08\/2026/);
assert.match(cupom, /Av\. Central, 50, Centro/);
assert.match(cupom, /Tel: \(81\) 3333-4444/);

const texts = [];
const printer = {
  style() {
    return this;
  },
  text(t) {
    texts.push(String(t));
    return this;
  },
};
require("../print/empresaCabecalhoTermico").aplicarCabecalhoEmpresaEscpos(
  printer,
  logradouro,
  48,
);
assert.ok(texts.includes("Distribuidora Agua"));
assert.ok(texts.some((t) => t.startsWith("CNPJ:")));
assert.ok(texts.includes("Av. Central, 50, Centro"));
assert.ok(texts.includes("Recife - PE"));
assert.ok(texts.some((t) => t.startsWith("Tel:")));

console.log("empresa-cabecalho-termico.test.js ok");
