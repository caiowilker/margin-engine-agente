/**
 * Emissão ST: payload é passthrough; oráculo compara (não altera valor).
 * FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA=OFF|AVISAR|BLOQUEAR
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  montarIniNfce,
  verificarConsistenciaStEmissao,
} = require("../acbr");

function empresaPresumido() {
  return {
    cnpj: "11222333000181",
    razaoSocial: "EMPRESA TESTE LTDA",
    nomeFantasia: "EMPRESA TESTE",
    inscricaoEstadual: "1234567890",
    regimeTributario: "3",
    regimeTributarioStorage: "LUCRO_PRESUMIDO",
    logradouro: "RUA A",
    numero: "100",
    bairro: "CENTRO",
    cidade: "BELO HORIZONTE",
    uf: "MG",
    cep: "30110000",
    codigoMunicipio: "3106200",
  };
}

/** Caso canônico: vProd 1000, frete 50, IPI 100, MVA 40%, inter 12%, int 18% → ST 163,80 */
function itemStCorreto() {
  return {
    codigo: "1",
    nome: "Item ST",
    quantidade: 1,
    precoUnitario: 1000,
    total: 1000,
    ncm: "22021000",
    cfop: "5405",
    cst: "10",
    aliquotaIcms: 12,
    aliquotaIcmsInter: 12,
    aliquotaInternaSt: 18,
    vFrete: 50,
    vIPI: 100,
    mvaPercentual: 40,
    vBCST: 1610,
    pICMSST: 18,
    vICMSST: 163.8,
  };
}

describe("verificarConsistenciaStEmissao (oráculo)", () => {
  test("aceita ST 163,80 com frete na base própria e IPI fora", () => {
    const r = verificarConsistenciaStEmissao(itemStCorreto(), 1);
    assert.equal(r.ok, true);
    assert.equal(r.esperado, 163.8);
  });

  test("detecta divergência > R$ 0,01", () => {
    const prev = process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA;
    process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA = "AVISAR";
    try {
      const item = { ...itemStCorreto(), vICMSST: 150 };
      const r = verificarConsistenciaStEmissao(item, 1);
      assert.equal(r.ok, false);
      assert.ok(Math.abs(r.esperado - 163.8) < 0.001);
    } finally {
      if (prev == null) delete process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA;
      else process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA = prev;
    }
  });

  test("BLOQUEAR impede montar INI sem alterar valor", () => {
    const prev = process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA;
    process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA = "BLOQUEAR";
    try {
      assert.throws(
        () =>
          montarIniNfce(
            {
              total: 1213.8,
              empresa: empresaPresumido(),
              itens: [{ ...itemStCorreto(), vICMSST: 150 }],
              pagamentos: [{ forma: "pix", valor: 1213.8 }],
            },
            { serie: 1, numero: 20 },
          ),
        /diverge do oráculo/,
      );
    } finally {
      if (prev == null) delete process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA;
      else process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA = prev;
    }
  });

  test("OFF não verifica", () => {
    const prev = process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA;
    process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA = "OFF";
    try {
      assert.equal(
        verificarConsistenciaStEmissao(
          { ...itemStCorreto(), vICMSST: 1 },
          1,
        ),
        null,
      );
    } finally {
      if (prev == null) delete process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA;
      else process.env.FISCAL_ICMS_ST_EMISSAO_CONSISTENCIA = prev;
    }
  });

  test("pauta/PMPF (modBCST≠4) não dispara oráculo MVA", () => {
    const r = verificarConsistenciaStEmissao(
      { ...itemStCorreto(), modBCST: "0", vICMSST: 1 },
      1,
    );
    assert.equal(r, null);
  });
});
