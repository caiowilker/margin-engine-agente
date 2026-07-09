#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  normalizarFormatoPdfNfce,
  suffixPdfModelo,
  paramsImprimirDanfePdfMonitor,
  deveAplicarLogoDanfe,
  MARCA_DAGUA_MARGIN,
} = require("../fiscalPdfFormato");

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    return false;
  }
}

async function main() {
  console.log("fiscal-pdf-formato.test.js");
  let ok = 0;
  let fail = 0;

  const cases = [
    [
      "normalizarFormatoPdfNfce — NFC-e térmico padrão",
      () => {
        assert.strictEqual(normalizarFormatoPdfNfce(undefined, "65"), "termico");
        assert.strictEqual(normalizarFormatoPdfNfce("termico", "65"), "termico");
      },
    ],
    [
      "normalizarFormatoPdfNfce — NFC-e A4",
      () => {
        assert.strictEqual(normalizarFormatoPdfNfce("a4", "65"), "a4");
        assert.strictEqual(normalizarFormatoPdfNfce("pagamento", "65"), "a4");
      },
    ],
    [
      "normalizarFormatoPdfNfce — NF-e sempre A4",
      () => {
        assert.strictEqual(normalizarFormatoPdfNfce("termico", "55"), "a4");
      },
    ],
    [
      "suffixPdfModelo — sufixos distintos",
      () => {
        assert.strictEqual(suffixPdfModelo("65", "termico"), "danfce");
        assert.strictEqual(suffixPdfModelo("65", "a4"), "danfce-a4");
        assert.strictEqual(suffixPdfModelo("55", "termico"), "danfe");
      },
    ],
    [
      "paramsImprimirDanfePdfMonitor — NFC-e A4 vs térmico",
      () => {
        const termico = paramsImprimirDanfePdfMonitor("65", "termico");
        const a4 = paramsImprimirDanfePdfMonitor("65", "a4");
        assert.strictEqual(termico.simplificado, "1");
        assert.strictEqual(a4.simplificado, "0");
        assert.strictEqual(termico.marcaDagua, MARCA_DAGUA_MARGIN);
      },
    ],
    [
      "paramsImprimirDanfePdfMonitor — NF-e A4",
      () => {
        const nfe = paramsImprimirDanfePdfMonitor("55", "a4");
        assert.strictEqual(nfe.simplificado, "0");
      },
    ],
    [
      "deveAplicarLogoDanfe — só A4",
      () => {
        assert.strictEqual(deveAplicarLogoDanfe("55", "termico"), true);
        assert.strictEqual(deveAplicarLogoDanfe("65", "a4"), true);
        assert.strictEqual(deveAplicarLogoDanfe("65", "termico"), false);
      },
    ],
  ];

  for (const [name, fn] of cases) {
    if (await test(name, fn)) ok++;
    else fail++;
  }

  console.log(`\n${ok}/${ok + fail} testes passaram`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
