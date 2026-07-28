#!/usr/bin/env node
/**
 * Política de tamanho da logo térmica.
 */
const assert = require("assert");
const {
  FATOR_PADRAO,
  clampFator,
  resolveLogoFator,
  resolveLogoBmpLargura,
  resolveLogoPrintSize,
} = require("../print/printerLogoSize");
const { tagLogoConfig, tagLogoArquivo } = require("../print/acbrTags");

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

console.log("printer-logo-size.test.js\n");

test("padrão comercial é 2", () => {
  assert.equal(FATOR_PADRAO, 2);
  const s = resolveLogoFator({});
  assert.equal(s.fator, 2);
  assert.equal(s.fatorX, "2");
  assert.equal(s.fatorY, "2");
});

test("meta legado fator 1 promove para 2", () => {
  const s = resolveLogoFator({ fatorX: "1", fatorY: "1" });
  assert.equal(s.fator, 2);
});

test("meta fator 3 é respeitado", () => {
  const s = resolveLogoFator({ fatorX: "3", fatorY: "3" });
  assert.equal(s.fator, 3);
});

test("clamp 1–4", () => {
  assert.equal(clampFator(0), 2);
  assert.equal(clampFator(9), 4);
  assert.equal(clampFator(2.6), 3);
});

test("bmp largura cresce com fator e cabe nas cols", () => {
  const w80 = resolveLogoBmpLargura(48, 2);
  const w58 = resolveLogoBmpLargura(32, 2);
  const w80big = resolveLogoBmpLargura(48, 4);
  assert.ok(w80 > w58);
  assert.ok(w80big >= w80);
  assert.ok(w80 <= 48 * 8);
  assert.ok(w58 <= 32 * 8);
});

test("tagLogoConfig usa fator efetivo ≥ 2", () => {
  const t = tagLogoConfig({ fatorX: "1", fatorY: "1", kc1: "48", kc2: "49" });
  assert.ok(t.includes("<logo_fatorx>2</logo_fatorx>"));
  assert.ok(t.includes("<logo_fatory>2</logo_fatory>"));
});

test("tagLogoArquivo com Largura", () => {
  const t = tagLogoArquivo("C:/logo.bmp", { largura: 360 });
  assert.ok(t.includes("Largura='360'"));
  assert.ok(t.includes("C:/logo.bmp") || t.includes("logo.bmp"));
});

test("resolveLogoPrintSize expõe escposWidthDots", () => {
  const s = resolveLogoPrintSize({ fatorX: "1" });
  assert.equal(s.fator, 2);
  assert.ok(s.escposWidthDots >= 200);
  assert.equal(s.density, "d24");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
