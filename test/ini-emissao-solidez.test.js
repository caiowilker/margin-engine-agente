/**
 * Solidez do INI local (fallback/contingência) — totais, ST, finNFe, tpEmis.
 * Formato ACBr preservado; só corrige inconsistências que emitiriam errado.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { montarIniNfce, montarIniNfe } = require("../acbr");
const {
  aplicarTpEmisOffline,
  inspecionarIniIdentificacao,
} = require("../fiscal/contingenciaOffline");

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

function empresaNormal() {
  return { ...empresaSimples(), regimeTributario: "3" };
}

function secao(ini, nome) {
  const re = new RegExp(`\\[${nome}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
  const m = ini.match(re);
  assert.ok(m, `seção [${nome}] ausente`);
  return m[1];
}

function destinatarioOk() {
  return {
    cpfCnpj: "39053344705",
    razaoSocial: "CONSUMIDOR TESTE",
    endereco: {
      logradouro: "RUA B",
      numero: "50",
      bairro: "CENTRO",
      municipio: "SAO PAULO",
      uf: "SP",
      cep: "01001000",
      codigoMunicipio: "3550308",
    },
  };
}

test("NFC-e: vProd = bruto da linha; vDesc no Total (não liquida vProd)", () => {
  const ini = montarIniNfce(
    {
      total: 90,
      desconto: 0,
      empresa: empresaSimples(),
      itens: [
        {
          codigo: "1",
          nome: "Item com desconto",
          quantidade: 1,
          precoUnitario: 100,
          total: 90,
          desconto: 10,
          ncm: "19059090",
          cfop: "5102",
          csosn: "102",
        },
      ],
      pagamentos: [{ forma: "dinheiro", valor: 90 }],
    },
    { serie: 1, numero: 1 },
  );
  const prod = secao(ini, "Produto001");
  const total = secao(ini, "Total");
  assert.match(prod, /vProd=100\.00/);
  assert.match(prod, /vDesc=10\.00/);
  assert.match(total, /vProd=100\.00/);
  assert.match(total, /vDesc=10\.00/);
  assert.match(total, /vNF=90\.00/);
});

test("NFC-e: ST do item sobe para ICMS e Total (sem inventar)", () => {
  const ini = montarIniNfce(
    {
      total: 119.8,
      empresa: empresaSimples(),
      itens: [
        {
          codigo: "1",
          nome: "Item ST",
          quantidade: 1,
          precoUnitario: 100,
          total: 100,
          ncm: "22021000",
          cfop: "5405",
          csosn: "500",
          vBCST: 110,
          pICMSST: 18,
          vICMSST: 19.8,
        },
      ],
      pagamentos: [{ forma: "dinheiro", valor: 119.8 }],
    },
    { serie: 1, numero: 2 },
  );
  const icms = secao(ini, "ICMS001");
  const total = secao(ini, "Total");
  assert.match(icms, /vBCST=110\.00/);
  assert.match(icms, /vICMSST=19\.80/);
  assert.match(total, /vBCST=110\.00/);
  assert.match(total, /vST=19\.80/);
});

test("NFC-e CRT 3: vBC/vICMS calculados; Total reflete", () => {
  const ini = montarIniNfce(
    {
      total: 100,
      empresa: empresaNormal(),
      itens: [
        {
          codigo: "1",
          nome: "Item normal",
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
    { serie: 1, numero: 3 },
  );
  const icms = secao(ini, "ICMS001");
  const total = secao(ini, "Total");
  assert.match(icms, /CST=00/);
  assert.match(icms, /vBC=100\.00/);
  assert.match(icms, /pICMS=18\.00/);
  assert.match(icms, /vICMS=18\.00/);
  assert.match(total, /vBC=100\.00/);
  assert.match(total, /vICMS=18\.00/);
});

test("NFC-e contig: tpEmis=9 gera dhCont/xJust; patch offline não destrói Total", () => {
  const ini = montarIniNfce(
    {
      total: 50,
      tpEmis: 9,
      empresa: empresaSimples(),
      itens: [
        {
          codigo: "1",
          nome: "Item",
          quantidade: 1,
          precoUnitario: 50,
          total: 50,
          ncm: "19059090",
          cfop: "5102",
          csosn: "102",
        },
      ],
      pagamentos: [{ forma: "dinheiro", valor: 50 }],
    },
    { serie: 1, numero: 4 },
  );
  const id = inspecionarIniIdentificacao(ini);
  assert.equal(id.mod, "65");
  assert.equal(id.tpEmis, "9");
  assert.ok(id.dhCont && id.dhCont !== "0");
  assert.ok(id.xJust.length >= 15);

  const patched = aplicarTpEmisOffline(ini, {
    dhCont: new Date(2026, 7, 14, 15, 30, 0),
    xJust: "Falha de comunicacao com a SEFAZ",
  });
  assert.match(patched, /tpEmis=9/);
  assert.match(patched, /dhCont=14\/08\/2026 15:30:00/);
  assert.match(patched, /\[Total\]/);
  assert.match(patched, /vProd=50\.00/);
  assert.match(patched, /mod=65/);
});

test("NFC-e: payload.total divergente dos totais → erro permanente", () => {
  assert.throws(
    () =>
      montarIniNfce(
        {
          total: 50,
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
            },
          ],
          pagamentos: [{ forma: "dinheiro", valor: 50 }],
        },
        { serie: 1, numero: 99 },
      ),
    (err) => err?.permanente === true && /Totais inconsistentes/i.test(err.message),
  );
});

test("NF-e: finNFe devolução + tpNF=0; vProd bruto; pagamentos com tpIntegra", () => {
  const ini = montarIniNfe(
    {
      total: 80,
      tipoEmissaoNfe: "DEVOLUCAO",
      empresa: empresaSimples(),
      itens: [
        {
          codigo: "1",
          nome: "Devolucao",
          quantidade: 1,
          precoUnitario: 100,
          total: 80,
          desconto: 20,
          ncm: "19059090",
          cfop: "1202",
          csosn: "102",
        },
      ],
      pagamentos: [{ forma: "pix", valor: 80 }],
    },
    { serie: 1, numero: 10 },
    destinatarioOk(),
  );
  assert.match(ini, /mod=55/);
  assert.match(ini, /finNFe=4/);
  assert.match(ini, /tpNF=0/);
  const total = secao(ini, "Total");
  assert.match(total, /vProd=100\.00/);
  assert.match(total, /vDesc=20\.00/);
  const pag = secao(ini, "PAG001");
  assert.match(pag, /tPag=17/);
  assert.match(pag, /tpIntegra=2/);
});

test("NF-e: frete/outro do item sobem para Total", () => {
  const ini = montarIniNfe(
    {
      total: 115,
      empresa: empresaSimples(),
      itens: [
        {
          codigo: "1",
          nome: "Com frete",
          quantidade: 1,
          precoUnitario: 100,
          total: 100,
          vFrete: 10,
          vOutro: 5,
          ncm: "19059090",
          cfop: "5102",
          csosn: "102",
        },
      ],
      pagamentos: [{ forma: "dinheiro", valor: 115 }],
    },
    { serie: 1, numero: 11 },
    destinatarioOk(),
  );
  const prod = secao(ini, "Produto001");
  const total = secao(ini, "Total");
  assert.match(prod, /vFrete=10\.00/);
  assert.match(prod, /vOutro=5\.00/);
  assert.match(total, /vFrete=10\.00/);
  assert.match(total, /vOutro=5\.00/);
  assert.match(total, /vProd=100\.00/);
});
