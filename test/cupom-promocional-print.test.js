const assert = require("node:assert/strict");
const {
  renderCupomPromocionalTags,
  normalizarCupomPromocionalPayload,
  linkSeguro,
} = require("../print/cupomPromocionalAcbrTags");
const { validarAntesEnfileirar } = require("../print/printValidate");
const { resolveIdempotencyKey } = require("../print/printIdempotency");
const { resolverTipo } = require("../print/printJobTypes");
const { REQUIRED_METHODS } = require("../print/contract");
const mock = require("../print/drivers/mockPrinterProvider");

const tags = renderCupomPromocionalTags({
  codigo: "primavera10",
  nome: "Primavera",
  regra: "10% de desconto em pizzas acima de R$ 50,00",
  validade: "30/11/2026",
  link: "https://app.marginengine.com.br/cupom/abc/PRIMAVERA10?origem=impresso",
  empresa: { nome: "Pizzaria Teste", cidade: "Recife", uf: "PE" },
});

assert.match(tags, /CUPOM DE DESCONTO/);
assert.match(tags, /PRIMAVERA10/);
assert.match(tags, /<qrcode[^>]*>https:\/\/app\.marginengine\.com\.br\/cupom\/abc\/PRIMAVERA10\?origem=impresso<\/qrcode>/);
assert.match(tags, /Valido ate 30\/11\/2026/);
assert.match(tags, /Documento nao fiscal/);
assert.match(tags, /Pizzaria Teste/);
assert.doesNotMatch(tags, /CPF|Cliente/i);

const semLink = renderCupomPromocionalTags({ codigo: "DEZ", link: "javascript:alert(1)" });
assert.doesNotMatch(semLink, /qrcode/i);
assert.equal(linkSeguro("https://x.com/a|b"), "");
assert.equal(linkSeguro("https://x.com/a b"), "");
assert.equal(linkSeguro("http://x.com/ok"), "http://x.com/ok");

const tres = renderCupomPromocionalTags({ codigo: "DEZ", copias: 3 });
assert.equal((tres.match(/CUPOM DE DESCONTO/g) || []).length, 3);
assert.equal(normalizarCupomPromocionalPayload({ codigo: "DEZ", copias: 999 }).copias, 50);
assert.equal(normalizarCupomPromocionalPayload({ codigo: "D<Z" }).codigo, "");
assert.equal(normalizarCupomPromocionalPayload({ codigo: "x" }).codigo, "");

assert.throws(() => validarAntesEnfileirar("imprimirCupomPromocional", [{ codigo: "a" }]), /sem código válido/);
assert.equal(validarAntesEnfileirar("imprimirCupomPromocional", [{ codigo: "dez" }]).args[0].codigo, "DEZ");

assert.equal(resolveIdempotencyKey("imprimirCupomPromocional", [{ codigo: "dez", clickId: "c1" }]), "cupom-promo:DEZ:c1");
assert.equal(resolveIdempotencyKey("imprimirCupomPromocional", [{ codigo: "dez" }]), null);

assert.equal(resolverTipo("imprimirCupomPromocional", {}), "cupom_promocional");
assert.ok(REQUIRED_METHODS.includes("imprimirCupomPromocional"));
assert.equal(typeof mock.imprimirCupomPromocional, "function");
assert.equal(typeof require("../print/drivers/nativeEscPosProvider").imprimirCupomPromocional, "function");

console.log("cupom-promocional-print.test.js ok");
