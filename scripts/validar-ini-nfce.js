#!/usr/bin/env node
/**
 * Valida montagem do INI NFC-e (sem chamar ACBr).
 * Uso: node scripts/validar-ini-nfce.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const acbr = require("../acbr");
const fiscalNumeracao = require("../fiscalNumeracao");

const payload = {
  numeroVenda: "TESTE-001",
  total: 10,
  desconto: 0,
  formaPagamento: "dinheiro",
  ibpt: { federal: 0.94, estadual: 0.59, municipal: 0, total: 1.53, percentualTotal: 15.3 },
  empresa: {
    cnpj: "00000000000191",
    inscricaoEstadual: "123456789",
    razaoSocial: "EMPRESA TESTE LTDA",
    nomeFantasia: "EMPRESA TESTE",
    logradouro: "RUA TESTE",
    numero: "100",
    bairro: "CENTRO",
    cidade: "SAO FRANCISCO",
    uf: "MG",
    cep: "39300000",
    codigoIbge: "3161000",
    regimeTributario: "1",
  },
  itens: [
    {
      codigo: "1",
      nome: "PRODUTO TESTE",
      quantidade: 1,
      precoUnitario: 10,
      total: 10,
      ncm: "02012000",
      cfop: "5102",
    },
  ],
};

fiscalNumeracao.init();
const numeracao = fiscalNumeracao.reservarProximoNumero("1");

(async () => {
  const empresa = await acbr.enriquecerEmpresa(payload.empresa);
  const ini = acbr.montarIniNfce({ ...payload, empresa }, numeracao);
  const secoesObrigatorias = [
    "[ICMS001]",
    "[PIS001]",
    "[COFINS001]",
    "[PAG001]",
    "dhEmi=",
    "tpAmb=",
    "modFrete=9",
  ];
  const faltando = secoesObrigatorias.filter((s) => !ini.includes(s));
  if (faltando.length) {
    console.error("Seções/campos ausentes no INI:", faltando.join(", "));
    process.exit(1);
  }
  if (/\[Produto001\][\s\S]*CSOSN=/m.test(ini)) {
    console.error("ERRO: CSOSN não deve ficar inline em [Produto] — use [ICMS001]");
    process.exit(1);
  }
  const vTotTribItem = ini.match(/\[Produto001\][\s\S]*?vTotTrib=([\d.]+)/)?.[1];
  const vTotTribTotal = ini.match(/\[Total\][\s\S]*?vTotTrib=([\d.]+)/)?.[1];
  if (vTotTribItem && vTotTribTotal && vTotTribItem !== vTotTribTotal) {
    console.error(
      `ERRO cStat 685: vTotTrib item (${vTotTribItem}) != total (${vTotTribTotal})`,
    );
    process.exit(1);
  }
  console.log("--- INI gerado ---");
  console.log(ini);
  console.log("--- OK: estrutura INI montada ---");
})();
