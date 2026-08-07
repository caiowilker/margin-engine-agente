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

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

const {
  drawerPulseBuffer,
  deveAbrirGavetaNoPayload,
  drawerEnabled,
  markGavetaPulseSent,
  gavetaPulseRecente,
  resetGavetaPulse,
} = core.__test;

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

test("abrirGaveta / isFastNativePath — gaveta e comercial RAW no native", () => {
  const prev = process.env.PRINTER_PORTA;
  const prevFast = process.env.PRINT_FAST_NATIVE;
  delete process.env.PRINT_FAST_NATIVE;
  process.env.PRINTER_PORTA = "RAW:POSPrinter POS80";
  runtime.resetAcbrPosCircuit();
  try {
    assert.strictEqual(preferNativeEscPos({ naoFiscal: true }), true);
    assert.strictEqual(isFastNativePath({ op: "abrirGaveta" }), true);
    assert.strictEqual(isFastNativePath({ payload: { naoFiscal: true } }), true);
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
  assert.ok(/async function abrirGaveta\(/.test(src));
  assert.ok(/return native\.abrirGaveta\(/.test(src));
  const fn = src.match(/async function abrirGaveta\([\s\S]*?\n\}/)?.[0] || "";
  assert.ok(fn && !/abrirGavetaNative\(\)/.test(fn));
});

test("printExecutor — abrirGaveta força native no withProvider", () => {
  const src = require("fs").readFileSync(
    path.join(__dirname, "../print/printExecutor.js"),
    "utf8",
  );
  assert.ok(src.includes('op === "abrirGaveta"'));
  assert.ok(src.includes('reason:\n                op === "abrirGaveta"') || src.includes('? "gaveta"'));
});

test("printJobService — timeout curto para gaveta", () => {
  const src = require("fs").readFileSync(
    path.join(__dirname, "../print/printJobService.js"),
    "utf8",
  );
  assert.ok(src.includes("PRINT_JOB_TIMEOUT_GAVETA_MS"));
  assert.ok(src.includes('row.tipo === "gaveta"') || src.includes('op === "abrirGaveta"'));
});

test("gaveta coalesce — janela recente após mark", () => {
  process.env.PRINTER_DRAWER = "true";
  process.env.PRINTER_DRAWER_COALESCE_MS = "800";
  resetGavetaPulse();
  assert.strictEqual(gavetaPulseRecente(), false);
  markGavetaPulseSent();
  assert.strictEqual(gavetaPulseRecente(), true);
  resetGavetaPulse();
  assert.strictEqual(gavetaPulseRecente(), false);
});

(async () => {
  await testAsync("gaveta coalesce — segundo abrirGaveta retorna coalesced", async () => {
    process.env.PRINTER_DRAWER = "true";
    process.env.PRINTER_DRAWER_COALESCE_MS = "800";
    resetGavetaPulse();
    markGavetaPulseSent();
    const r = await core.abrirGaveta();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.coalesced, true);
    resetGavetaPulse();
  });

  await testAsync("abrirGaveta force=true ignora coalesce", async () => {
    process.env.PRINTER_DRAWER = "true";
    process.env.PRINTER_DRAWER_COALESCE_MS = "800";
    resetGavetaPulse();
    markGavetaPulseSent();
    assert.strictEqual(gavetaPulseRecente(), true);
    // force: não coalesced — tenta enviar (pode falhar sem impressora; não pode ser coalesced)
    const r = await core.abrirGaveta({ force: true }).catch((e) => e);
    if (r && r.ok === true) {
      assert.notStrictEqual(r.coalesced, true);
      assert.strictEqual(r.forced, true);
    } else {
      // Sem spooler no CI — o importante é não ter retornado coalesced
      assert.ok(!(r && r.coalesced === true));
    }
    resetGavetaPulse();
  });

  await testAsync("mark só após sucesso — falha não bloqueia próximo force", async () => {
    process.env.PRINTER_DRAWER = "true";
    resetGavetaPulse();
    assert.strictEqual(gavetaPulseRecente(), false);
    // Sem mark prévio: recente=false
    const r = await core.abrirGaveta({ force: true }).catch(() => null);
    // Se enviou ok, recente=true; se falhou, recente continua false (mark só no success)
    if (!r || r.ok !== true) {
      assert.strictEqual(gavetaPulseRecente(), false);
    }
    resetGavetaPulse();
  });

  console.log(`\ngaveta: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
