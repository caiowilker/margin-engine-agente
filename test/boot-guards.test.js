#!/usr/bin/env node
/** Boot guards — produção fiscal sem parity/local INI */
const assert = require("assert");
const { assertProductionGuards, isProducaoFiscal } = require("../bootGuards");

const orig = { ...process.env };

function restore() {
  process.env = { ...orig };
}

assert.strictEqual(isProducaoFiscal(), false);
process.env.EMISSAO_FISCAL = "true";
process.env.AMBIENTE_SEFAZ = "producao";
assert.strictEqual(isProducaoFiscal(), true);

process.env.ACBR_LIB_ALLOW_PARITY = "true";
let threw = false;
try {
  assertProductionGuards();
} catch (e) {
  threw = true;
  assert.match(e.message, /ACBR_LIB_ALLOW_PARITY/);
}
assert.strictEqual(threw, true);

restore();
console.log("boot-guards.test.js OK");
