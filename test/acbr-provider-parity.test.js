#!/usr/bin/env node
/**
 * Onda B.5 — paridade Monitor vs ACBrLib.
 *
 * Sempre executa: contrato do driver lib (sem DLL).
 * Integração SEFAZ: npm run test:fiscal-parity com ACBR_DRIVER=lib FISCAL_PARITY_RUN=true
 */
const assert = require("assert");
const factory = require("../fiscal/factory");
const { assertFiscalDriverContract, REQUIRED_METHODS } = require("../fiscal/contract");

const INTEGRATION =
  process.env.ACBR_DRIVER === "lib" && process.env.FISCAL_PARITY_RUN === "true";

const CENARIOS = [
  "emissao_nfce_homologacao",
  "emissao_nfe_homologacao",
  "cancelamento",
  "inutilizacao",
  "consulta_chave",
  "contingencia_epec",
  "impressao_pdf",
];

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

process.env.ACBR_DRIVER = "lib";
process.env.ACBR_LIB_ALLOW_PARITY = "true";
factory.resetFiscalDriver();

test("lib driver implementa contrato fiscal mínimo", () => {
  const lib = factory.createDriver("lib");
  assertFiscalDriverContract(lib, "lib");
  assert.strictEqual(typeof lib.emitirNfce, "function");
  assert.strictEqual(typeof lib.emitirNfe, "function");
  assert.strictEqual(typeof lib.getDriverInfo, "function");
});

test("lib driver expõe métodos de paridade SEFAZ", () => {
  const lib = factory.createDriver("lib");
  for (const m of [
    "cancelarNfce",
    "inutilizarNfce",
    "gerarPdfFiscal",
    "consultarChave",
    "statusServico",
  ]) {
    assert.strictEqual(typeof lib[m], "function", `faltando ${m}`);
  }
});

test("contrato REQUIRED_METHODS alinhado com factory lib", () => {
  const lib = factory.createDriver("lib");
  const missing = REQUIRED_METHODS.filter((m) => typeof lib[m] !== "function");
  assert.strictEqual(missing.length, 0, `faltam: ${missing.join(", ")}`);
});

console.log("\nCenários de integração SEFAZ (Windows — você executa):");
if (!INTEGRATION) {
  CENARIOS.forEach((c) => console.log(`  ⊘ ${c}: pendente — rode no Windows com FISCAL_PARITY_RUN=true`));
} else {
  console.log("  ⚠ Integração SEFAZ Monitor vs Lib — compare cStat/chave manualmente (RESULTADO-HOMOLOG.md)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.env.ACBR_DRIVER = "monitor";
delete process.env.ACBR_LIB_ALLOW_PARITY;
factory.resetFiscalDriver();
process.exit(failed > 0 ? 1 : 0);
