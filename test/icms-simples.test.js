// ICMS Simples Nacional — zeros no próprio; crédito SN em 101/201
const assert = require("assert");
const { montarIniNfce } = require("../acbr");

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

function empresaSimples() {
  return {
    cnpj: "11222333000181",
    razaoSocial: "EMPRESA TESTE LTDA",
    nomeFantasia: "EMPRESA TESTE",
    inscricaoEstadual: "1234567890",
    regimeTributario: "1",
    logradouro: "RUA A",
    numero: "100",
    bairro: "CENTRO",
    cidade: "SAO PAULO",
    uf: "SP",
    cep: "01001000",
    codigoMunicipio: "3550308",
  };
}

function secaoIcms(ini) {
  const i = ini.indexOf("[ICMS");
  assert.ok(i >= 0, "seção ICMS ausente");
  const j = ini.indexOf("\n[", i + 1);
  return j > 0 ? ini.slice(i, j) : ini.slice(i);
}

console.log("icms-simples.test.js\n");

test("CSOSN 102 — ICMS próprio zerado sem crédito SN", () => {
  const ini = montarIniNfce(
    {
      total: 100,
      desconto: 0,
      empresa: empresaSimples(),
      itens: [
        {
          codigo: "1",
          nome: "Item",
          quantidade: 1,
          precoUnitario: 100,
          total: 100,
          ncm: "19059090",
          cfop: "5102",
          csosn: "102",
          aliquotaIcms: 18,
        },
      ],
      pagamentos: [{ forma: "dinheiro", valor: 100 }],
    },
    { serie: 1, numero: 1 },
  );
  const icms = secaoIcms(ini);
  assert.match(icms, /CSOSN=102/);
  assert.match(icms, /vBC=0\.00/);
  assert.match(icms, /pICMS=0\.00/);
  assert.match(icms, /vICMS=0\.00/);
  assert.doesNotMatch(icms, /pCredSN/);
});

test("CSOSN 101 — pCredSN e vCredICMSSN; próprio zerado", () => {
  const ini = montarIniNfce(
    {
      total: 200,
      desconto: 0,
      empresa: empresaSimples(),
      itens: [
        {
          codigo: "1",
          nome: "Item B2B",
          quantidade: 1,
          precoUnitario: 200,
          total: 200,
          ncm: "19059090",
          cfop: "5102",
          csosn: "101",
          aliquotaIcms: 1.25,
        },
      ],
      pagamentos: [{ forma: "pix", valor: 200 }],
    },
    { serie: 1, numero: 2 },
  );
  const icms = secaoIcms(ini);
  assert.match(icms, /CSOSN=101/);
  assert.match(icms, /pICMS=0\.00/);
  assert.match(icms, /pCredSN=1\.25/);
  assert.match(icms, /vCredICMSSN=2\.50/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
