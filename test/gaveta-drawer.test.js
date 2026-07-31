#!/usr/bin/env node
/**
 * Gaveta — pulso ESC/POS, política de payload e native-first.
 */
const assert = require("assert");
const path = require("path");

process.env.LOG_SILENT = "true";
process.env.PRINTER_PROVIDER = "mock";

const core = require("../print/escpos/impressoraCore");
const { preferNativeEscPos } = require("../print/drivers/acbrPosPrinterProvider");
const { isFastNativePath } = require("../print/printFiscalCoordination");
const runtime = require("../print/acbrPosPrinterRuntime");

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

const { drawerPulseBuffer, deveAbrirGavetaNoPayload, drawerEnabled } = core.__test;

test("drawerPulseBuffer — defaults POS80 0x19/0xFA", () => {
  delete process.env.PRINTER_DRAWER_ON_MS;
  delete process.env.PRINTER_DRAWER_OFF_MS;
  delete process.env.PRINTER_DRAWER_PIN;
  delete process.env.PRINTER_DRAWER_INVERTED;
  const buf = drawerPulseBuffer();
  assert.deepStrictEqual([...buf], [0x1b, 0x70, 0x00, 0x19, 0xfa]);
});

test("drawerPulseBuffer — ON/OFF ms configuráveis", () => {
  process.env.PRINTER_DRAWER_ON_MS = "100";
  process.env.PRINTER_DRAWER_OFF_MS = "200";
  const buf = drawerPulseBuffer();
  assert.strictEqual(buf[3], 50);
  assert.strictEqual(buf[4], 100);
  delete process.env.PRINTER_DRAWER_ON_MS;
  delete process.env.PRINTER_DRAWER_OFF_MS;
});

test("deveAbrirGavetaNoPayload — dinheiro auto", () => {
  process.env.PRINTER_DRAWER = "true";
  assert.strictEqual(deveAbrirGavetaNoPayload({ formaPagamento: "dinheiro" }), true);
  assert.strictEqual(deveAbrirGavetaNoPayload({ formaPagamento: "pix" }), false);
  assert.strictEqual(
    deveAbrirGavetaNoPayload({
      pagamentos: [{ forma: "dinheiro" }, { forma: "pix" }],
    }),
    true,
  );
  assert.strictEqual(deveAbrirGavetaNoPayload({ abrirGaveta: false, formaPagamento: "dinheiro" }), false);
  assert.strictEqual(deveAbrirGavetaNoPayload({ abrirGaveta: true, formaPagamento: "pix" }), true);
});

test("deveAbrirGavetaNoPayload — PRINTER_DRAWER=false desliga", () => {
  process.env.PRINTER_DRAWER = "false";
  assert.strictEqual(deveAbrirGavetaNoPayload({ formaPagamento: "dinheiro" }), false);
  assert.strictEqual(deveAbrirGavetaNoPayload({ abrirGaveta: true }), false);
  assert.strictEqual(drawerEnabled(), false);
  process.env.PRINTER_DRAWER = "true";
});

test("abrirGaveta / isFastNativePath — RAW comercial", () => {
  const prev = process.env.PRINTER_PORTA;
  const prevFast = process.env.PRINT_FAST_NATIVE;
  delete process.env.PRINT_FAST_NATIVE;
  process.env.PRINTER_PORTA = "RAW:POSPrinter POS80";
  runtime.resetAcbrPosCircuit();
  try {
    assert.strictEqual(preferNativeEscPos({ naoFiscal: true }), true);
    assert.strictEqual(isFastNativePath({ op: "abrirGaveta" }), true);
  } finally {
    if (prev === undefined) delete process.env.PRINTER_PORTA;
    else process.env.PRINTER_PORTA = prev;
    if (prevFast === undefined) delete process.env.PRINT_FAST_NATIVE;
    else process.env.PRINT_FAST_NATIVE = prevFast;
    runtime.resetAcbrPosCircuit();
  }
});

test("acbrPosPrinterProvider.abrirGaveta sempre chama native", () => {
  const src = require("fs").readFileSync(
    path.join(__dirname, "../print/drivers/acbrPosPrinterProvider.js"),
    "utf8",
  );
  assert.ok(/async function abrirGaveta\(\)[\s\S]*return native\.abrirGaveta\(\)/.test(src));
  assert.ok(!/abrirGavetaNative\(\)/.test(src.match(/async function abrirGaveta[\s\S]*?\n\}/)[0]));
});

console.log(`\ngaveta: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
