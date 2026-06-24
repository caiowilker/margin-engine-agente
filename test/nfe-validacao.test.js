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

test("destinatário com codigoIbge (alias front) — ok", () => {
  const d = destinatarioCompleto();
  d.endereco.codigoIbge = d.endereco.codigoMunicipio;
  delete d.endereco.codigoMunicipio;
  const out = validarDestinatarioNfe(d);
  assert.strictEqual(out.endereco.codigoMunicipio, "3106200");
});

const docs = require("../documentosFiscais");

test("extrairProtNFe — lê cStat 100 do XML", () => {
  const xml =
    '<?xml version="1.0"?><nfeProc><protNFe><infProt><cStat>100</cStat><xMotivo>Autorizado</xMotivo><nProt>123</nProt><chNFe>31260612343055000183650010000000091816823438</chNFe></infProt></protNFe></nfeProc>';
  const prot = docs.extrairProtNFe(xml);
  assert.strictEqual(prot.cStat, "100");
  assert.strictEqual(prot.nProt, "123");
});

test("extrairXmlDaResposta — aceita resposta em array (sessão multi-comando ACBr)", () => {
  const xml = '<?xml version="1.0"?><nfeProc><NFe></NFe></nfeProc>';
  const out = docs.extrairXmlDaResposta(["OK", `ChaveNFe=123\n${xml}`]);
  assert.ok(out && out.includes("nfeProc"));
});

test("payload NF-e válido — ok", () => {
  validarPayloadNfe({
    total: 10,
    destinatario: destinatarioCompleto(),
    itens: [{ nome: "Pão", quantidade: 1, precoUnitario: 10, total: 10 }],
  });
});

test("NFC-e — CNPJ consumidor 14 dígitos — ok", () => {
  const { validarPayloadNfce } = require("../fiscalValidacao");
  validarPayloadNfce({
    total: 10,
    cnpjCliente: "12345678000195",
    itens: [{ nome: "Pão", quantidade: 1, precoUnitario: 10, total: 10 }],
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
