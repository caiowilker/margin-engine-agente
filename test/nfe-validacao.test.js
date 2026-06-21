// Testes unitários — validação NF-e modelo 55 (sem ACBr/SEFAZ)
const assert = require("assert");
const { validarPayloadNfe, validarDestinatarioNfe } = require("../fiscalValidacaoNfe");

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

function destinatarioCompleto() {
  return {
    cpfCnpj: "12345678909",
    razaoSocial: "Cliente Teste LTDA",
    indIEDest: 9,
    endereco: {
      logradouro: "Rua A",
      numero: "100",
      bairro: "Centro",
      cep: "30130010",
      codigoMunicipio: "3106200",
      municipio: "Belo Horizonte",
      uf: "MG",
    },
  };
}

console.log("nfe-validacao.test.js\n");

test("destinatário completo — ok", () => {
  const d = validarDestinatarioNfe(destinatarioCompleto());
  assert.strictEqual(d.cpfCnpj, "12345678909");
});

test("destinatário sem CEP — rejeita antes do ACBr", () => {
  const d = destinatarioCompleto();
  d.endereco.cep = "123";
  assert.throws(() => validarDestinatarioNfe(d), /CEP/);
});

test("payload NF-e sem itens — rejeita", () => {
  assert.throws(
    () =>
      validarPayloadNfe({
        total: 10,
        destinatario: destinatarioCompleto(),
        itens: [],
      }),
    /ao menos 1 item/,
  );
});

test("payload NF-e válido — ok", () => {
  validarPayloadNfe({
    total: 10,
    destinatario: destinatarioCompleto(),
    itens: [{ nome: "Pão", quantidade: 1, precoUnitario: 10, total: 10 }],
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
