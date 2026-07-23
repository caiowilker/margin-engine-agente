// GTIN / NCM — emissão sem inventar código inválido
const assert = require("assert");
const { gtinValido, resolverGtin } = require("../gtin");
const { validarPayloadNfce } = require("../fiscalValidacao");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

console.log("codigos-fiscais.test.js\n");

test("gtinValido — EAN-13 Coca Cola", () => {
  assert.strictEqual(gtinValido("7894900011517"), true);
});

test("gtinValido — rejeita SKU sem DV", () => {
  assert.strictEqual(gtinValido("12345678"), false);
  assert.strictEqual(gtinValido("00000000"), false);
});

test("resolverGtin — não usa codigo/SKU interno", () => {
  assert.strictEqual(
    resolverGtin({ codigo: "7894900011517", nome: "X" }),
    "",
  );
  assert.strictEqual(
    resolverGtin({ ean: "7894900011517", codigo: "SKU1" }),
    "7894900011517",
  );
});

test("validarPayloadNfce — exige NCM 8 dígitos", () => {
  assert.throws(
    () =>
      validarPayloadNfce({
        total: 10,
        itens: [
          { nome: "Item", quantidade: 1, precoUnitario: 10, total: 10, cfop: "5102" },
        ],
      }),
    /NCM obrigatório/,
  );
});

test("validarPayloadNfce — rejeita NCM 00000000", () => {
  assert.throws(
    () =>
      validarPayloadNfce({
        total: 10,
        itens: [
          {
            nome: "Item",
            quantidade: 1,
            precoUnitario: 10,
            total: 10,
            ncm: "00000000",
            cfop: "5102",
          },
        ],
      }),
    /NCM obrigatório/,
  );
});

test("validarPayloadNfce — exige CFOP", () => {
  assert.throws(
    () =>
      validarPayloadNfce({
        total: 10,
        itens: [
          {
            nome: "Item",
            quantidade: 1,
            precoUnitario: 10,
            total: 10,
            ncm: "02013000",
          },
        ],
      }),
    /CFOP obrigatório/,
  );
});

test("validarPayloadNfce — item ok", () => {
  validarPayloadNfce({
    total: 10,
    itens: [
      {
        nome: "Item",
        quantidade: 1,
        precoUnitario: 10,
        total: 10,
        ncm: "02013000",
        cfop: "5102",
      },
    ],
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
