const { test } = require("node:test");
const assert = require("node:assert/strict");
const dh = require("../fiscal/fiscalDhEmiIni");

test("converte ISO para formato ACBr INI", () => {
  const ini = `[Identificacao]
dhEmi=2026-06-30T23:48:44-03:00
dhSaiEnt=2026-06-22T14:53:03
`;
  const out = dh.prepararIniParaEmissao(ini);
  assert.match(out, /dhEmi=\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
  assert.match(out, /dhSaiEnt=\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(out, /T\d{2}:/);
});

test("corrige formato híbrido inválido", () => {
  const out = dh.normalizarDatasIni("dhEmi=2026/06/30T23:48:44\n");
  assert.match(out, /^dhEmi=30\/06\/2026 23:48:44$/m);
});

test("formatarDhEmiAcbrIni padrão BR", () => {
  const d = new Date(2026, 5, 30, 23, 48, 44);
  assert.equal(dh.formatarDhEmiAcbrIni(d), "30/06/2026 23:48:44");
});

// ---------------------------------------------------------------------------
// Regressão: acbrLibDriver.js usava fiscalDhEmiIni sem importá-lo — qualquer
// emissão com documentIni lançava "ReferenceError: fiscalDhEmiIni is not defined".
//
// Causa raiz: o módulo foi importado em acbr.js mas omitido em
// fiscal/drivers/acbrLibDriver.js. A correção adicionou o require no driver.
//
// Estes testes verificam:
// 1. acbrLibDriver carrega sem ReferenceError (o require foi adicionado).
// 2. A path montarIniLib(documentIni) chama prepararIniParaEmissao sem explodir —
//    exercitado indiretamente via emitirNfce em modo parity com documentIni.
// ---------------------------------------------------------------------------

test("acbrLibDriver carrega sem ReferenceError — fiscalDhEmiIni resolvido", () => {
  // Antes da correção este require lançava pois fiscalDhEmiIni não estava importado
  // e o módulo já tentava avaliar a referência ao ser carregado.
  let driver;
  process.env.ACBR_LIB_ALLOW_PARITY = "true";
  assert.doesNotThrow(() => {
    driver = require("../fiscal/drivers/acbrLibDriver");
  }, "acbrLibDriver deve carregar sem ReferenceError");
  assert.equal(typeof driver.emitirNfce, "function");
});

test("emitirNfce com documentIni não lança ReferenceError (regressão fiscalDhEmiIni)", async () => {
  // Cenário original: venda enviada pelo backend com documentIni pré-montado.
  // O ACBr (Monitor TCP) não está disponível em CI → esperamos erro de conexão/
  // emissão, mas NÃO ReferenceError de variável indefinida.
  process.env.ACBR_LIB_ALLOW_PARITY = "true";
  process.env.ACBR_DRIVER = "lib";

  const factory = require("../fiscal/factory");
  factory.resetFiscalDriver();
  const lib = factory.createDriver("lib");

  // INI mínimo que o backend MFCS pode enviar com dhEmi em ISO
  const documentIni = [
    "[NFCe]",
    "[Identificacao]",
    "Modelo=65",
    "Serie=001",
    "Numero=1",
    "dhEmi=2026-06-30T23:48:44-03:00",
    "dhSaiEnt=2026-06-30T23:48:44-03:00",
    "[Emitente]",
    "CNPJ=11222333000181",
    "[Totais]",
    "vNF=10.00",
    "[Pagamentos]",
    "vTroco=0.00",
  ].join("\n");

  let threw = null;
  try {
    await lib.emitirNfce({
      numeroVenda: "REGR-DHEMI-001",
      documentIni,
      empresa: { cnpj: "11222333000181", razaoSocial: "TESTE REGRESSAO" },
    });
  } catch (err) {
    threw = err;
  }

  // O erro esperado é de emissão (ACBr, SEFAZ, conexão) — nunca ReferenceError.
  if (threw) {
    assert.notEqual(
      threw instanceof ReferenceError,
      true,
      `Não deveria lançar ReferenceError; obteve: ${threw.message}`,
    );
    assert.doesNotMatch(
      threw.message,
      /fiscalDhEmiIni is not defined/,
      `Não deve lançar 'fiscalDhEmiIni is not defined'; obteve: ${threw.message}`,
    );
  }
  // Se não lançou, também está correto (parity delegou ao Monitor TCP e obteve resposta).
});
