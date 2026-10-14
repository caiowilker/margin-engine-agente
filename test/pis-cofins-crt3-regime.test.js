/**
 * CRT 3 — PIS/COFINS sem default silencioso Presumido (auditoria 14/10/2026).
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  montarIniNfce,
  resolverAliquotasPisCofinsCrt3,
} = require("../acbr");

function empresaBase(storage) {
  return {
    cnpj: "11222333000181",
    razaoSocial: "EMPRESA TESTE LTDA",
    nomeFantasia: "EMPRESA TESTE",
    inscricaoEstadual: "1234567890",
    regimeTributario: "3",
    regimeTributarioStorage: storage,
    logradouro: "RUA A",
    numero: "100",
    bairro: "CENTRO",
    cidade: "SAO PAULO",
    uf: "SP",
    cep: "01001000",
    codigoMunicipio: "3550308",
  };
}

function secao(ini, nome) {
  const re = new RegExp(`\\[${nome}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
  const m = ini.match(re);
  assert.ok(m, `seção [${nome}] ausente`);
  return m[1];
}

describe("resolverAliquotasPisCofinsCrt3", () => {
  test("Presumido → 0,65% / 3,00%", () => {
    const r = resolverAliquotasPisCofinsCrt3(
      {},
      { regimeTributarioStorage: "LUCRO_PRESUMIDO" },
      {},
    );
    assert.equal(r.pPis, 0.65);
    assert.equal(r.pCofins, 3.0);
    assert.equal(r.regime, "LUCRO_PRESUMIDO");
  });

  test("Real → 1,65% / 7,60%", () => {
    const r = resolverAliquotasPisCofinsCrt3(
      {},
      { regimeTributarioStorage: "LUCRO_REAL" },
      {},
    );
    assert.equal(r.pPis, 1.65);
    assert.equal(r.pCofins, 7.6);
    assert.equal(r.regime, "LUCRO_REAL");
  });

  test("item pPis/pCofins explícitos têm prioridade", () => {
    const r = resolverAliquotasPisCofinsCrt3(
      { pPis: 1.65, pCofins: 7.6 },
      {},
      {},
    );
    assert.equal(r.regime, "ITEM");
    assert.equal(r.pPis, 1.65);
    assert.equal(r.pCofins, 7.6);
  });

  test("falha clara se CRT 3 sem regime e sem alíquotas", () => {
    assert.throws(
      () => resolverAliquotasPisCofinsCrt3({}, { regimeTributario: "3" }, {}),
      /CRT 3 exige regime de PIS\/COFINS/,
    );
  });
});

describe("INI CRT 3 Presumido", () => {
  test("pPIS=0.65 e pCOFINS=3.00 no INI", () => {
    const ini = montarIniNfce(
      {
        total: 100,
        empresa: empresaBase("LUCRO_PRESUMIDO"),
        itens: [
          {
            codigo: "1",
            nome: "Item",
            quantidade: 1,
            precoUnitario: 100,
            total: 100,
            ncm: "19059090",
            cfop: "5102",
            cst: "00",
            aliquotaIcms: 18,
          },
        ],
        pagamentos: [{ forma: "pix", valor: 100 }],
      },
      { serie: 1, numero: 10 },
    );
    assert.match(secao(ini, "PIS001"), /pPIS=0\.65/);
    assert.match(secao(ini, "COFINS001"), /pCOFINS=3\.00/);
  });
});

describe("INI CRT 3 Real", () => {
  test("pPIS=1.65 e pCOFINS=7.60 no INI", () => {
    const ini = montarIniNfce(
      {
        total: 100,
        empresa: empresaBase("LUCRO_REAL"),
        itens: [
          {
            codigo: "1",
            nome: "Item",
            quantidade: 1,
            precoUnitario: 100,
            total: 100,
            ncm: "19059090",
            cfop: "5102",
            cst: "00",
            aliquotaIcms: 18,
          },
        ],
        pagamentos: [{ forma: "pix", valor: 100 }],
      },
      { serie: 1, numero: 11 },
    );
    assert.match(secao(ini, "PIS001"), /pPIS=1\.65/);
    assert.match(secao(ini, "COFINS001"), /pCOFINS=7\.60/);
  });
});

describe("INI CRT 3 sem regime", () => {
  test("bloqueia montagem do INI antes de emitir", () => {
    assert.throws(
      () =>
        montarIniNfce(
          {
            total: 100,
            empresa: empresaBase(undefined),
            itens: [
              {
                codigo: "1",
                nome: "Item",
                quantidade: 1,
                precoUnitario: 100,
                total: 100,
                ncm: "19059090",
                cfop: "5102",
                cst: "00",
                aliquotaIcms: 18,
              },
            ],
            pagamentos: [{ forma: "pix", valor: 100 }],
          },
          { serie: 1, numero: 12 },
        ),
      /CRT 3 exige regime de PIS\/COFINS/,
    );
  });
});
