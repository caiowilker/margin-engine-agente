#!/usr/bin/env node
/** fiscalDriverNfceSetup — npm run test:fiscal-setup */
const assert = require("assert");

process.env.ACBR_DRIVER = "lib";
process.env.ACBR_LIB_ALLOW_PARITY = "true";

const setup = require("../fiscalDriverNfceSetup");

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

test("isLibDriver quando ACBR_DRIVER=lib", () => {
  assert.strictEqual(setup.isLibDriver(), true);
});

test("validar retorna checklist lib", () => {
  const r = setup.validar();
  assert.ok(r.driver === "lib" || r.uf);
  assert.ok(Array.isArray(r.acoes));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
