#!/usr/bin/env node
/**
 * Testes do fiscal driver factory — npm run test:fiscal-driver
 */
const assert = require("assert");

process.env.ACBR_DRIVER = "monitor";

const factory = require("../fiscal/factory");
const fiscalDriver = require("../fiscalDriver");
const { assertFiscalDriverContract } = require("../fiscal/contract");

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

factory.resetFiscalDriver();

test("driver monitor quando ACBR_DRIVER=monitor", () => {
  assert.strictEqual(factory.resolveDriverName(), "monitor");
});

test("default driver é lib sem env", () => {
  const prev = process.env.ACBR_DRIVER;
  delete process.env.ACBR_DRIVER;
  delete process.env.FISCAL_PROVIDER;
  delete process.env.FISCAL_DRIVER;
  factory.resetFiscalDriver();
  assert.strictEqual(factory.resolveDriverName(), "lib");
  if (prev) process.env.ACBR_DRIVER = prev;
  else process.env.ACBR_DRIVER = "monitor";
  factory.resetFiscalDriver();
});

test("fiscalDriver delega getDriverName", () => {
  assert.strictEqual(fiscalDriver.getDriverName(), "monitor");
});

test("fiscalDriver expõe EMISSAO_FISCAL", () => {
  assert.strictEqual(typeof fiscalDriver.EMISSAO_FISCAL, "boolean");
});

test("fiscalDriver expõe inferirModeloDaChave", () => {
  assert.strictEqual(typeof fiscalDriver.inferirModeloDaChave, "function");
});

test("monitor driver satisfaz contrato fiscal", () => {
  const monitor = factory.createDriver("monitor");
  assertFiscalDriverContract(monitor, "monitor");
});

test("alias acbr-lib normaliza para lib", () => {
  process.env.ACBR_DRIVER = "acbr-lib";
  factory.resetFiscalDriver();
  assert.strictEqual(factory.resolveDriverName(), "lib");
  process.env.ACBR_DRIVER = "monitor";
  factory.resetFiscalDriver();
});

test("lib driver expõe getDriverInfo ready", () => {
  process.env.ACBR_DRIVER = "lib";
  process.env.ACBR_LIB_ALLOW_PARITY = "true";
  factory.resetFiscalDriver();
  const lib = factory.createDriver("lib");
  const info = lib.getDriverInfo();
  assert.strictEqual(info.provider, "acbr-lib");
  assert.strictEqual(info.mode, "parity");
  assert.strictEqual(info.ready, true);
  assert.strictEqual(typeof lib.patchNumeracaoIniLib, "function");
  process.env.ACBR_DRIVER = "monitor";
  delete process.env.ACBR_LIB_ALLOW_PARITY;
  factory.resetFiscalDriver();
});

test("lib driver sem DLL e sem ALLOW_PARITY fica unconfigured", () => {
  process.env.ACBR_DRIVER = "lib";
  delete process.env.ACBR_LIB_ALLOW_PARITY;
  const prevLib = process.env.ACBR_LIB_PATH;
  process.env.ACBR_LIB_PATH = "/tmp/margin-sem-dll/ACBrNFe64.dll";
  factory.resetFiscalDriver();
  const lib = factory.createDriver("lib");
  assert.strictEqual(lib.getIntegrationMode(), "unconfigured");
  if (prevLib) process.env.ACBR_LIB_PATH = prevLib;
  else delete process.env.ACBR_LIB_PATH;
  process.env.ACBR_DRIVER = "monitor";
  factory.resetFiscalDriver();
});

test("patchNumeracaoIniLib aplica cNF determinístico", () => {
  process.env.ACBR_DRIVER = "lib";
  factory.resetFiscalDriver();
  const lib = factory.createDriver("lib");
  const ini = "[Identificacao]\nserie=0\nnNF=0\ncNF=99999999\n";
  const patched = lib.patchNumeracaoIniLib(ini, { serie: 1, numero: 1, cNf: "00000001" });
  assert(patched.includes("cNF=00000001"), "cNF deve ser patchado");
  assert(patched.includes("nNF=1"), "nNF deve ser patchado");
  process.env.ACBR_DRIVER = "monitor";
  factory.resetFiscalDriver();
});

test("lib driver satisfaz contrato fiscal (paridade Monitor)", () => {
  process.env.ACBR_DRIVER = "lib";
  process.env.ACBR_LIB_ALLOW_PARITY = "true";
  factory.resetFiscalDriver();
  const lib = factory.createDriver("lib");
  assertFiscalDriverContract(lib, "lib");
  assert.strictEqual(lib.getIntegrationMode(), "parity");
  process.env.ACBR_DRIVER = "monitor";
  delete process.env.ACBR_LIB_ALLOW_PARITY;
  factory.resetFiscalDriver();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
