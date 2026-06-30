#!/usr/bin/env node
/**
 * Testes ACBrLib solid — npm run test:agent-fiscal
 */
const assert = require("assert");

process.env.ACBR_DRIVER = "lib";
process.env.ACBR_LIB_ALLOW_PARITY = "true";

const factory = require("../fiscal/factory");
factory.resetFiscalDriver();
const lib = factory.createDriver("lib");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

async function run() {
  console.log("acbr-lib-solid.test.js\n");

  await test("testar() retorna boolean em parity", async () => {
    const r = await lib.testar();
    assert.strictEqual(typeof r, "boolean");
  });

  await test("testarLibDetalhe expõe objeto em parity", async () => {
    assert.strictEqual(typeof lib.testarLibDetalhe, "function");
    const d = await lib.testarLibDetalhe();
    assert.strictEqual(typeof d.ok, "boolean");
  });

  await test("emitirNfce monta INI local sem documentIni (parity smoke)", async () => {
    const acbr = require("../acbr");
    acbr.setRuntimeEmissaoFiscal(false);
    await assert.rejects(
      () =>
        lib.emitirNfce({
          numeroVenda: "SOLID-NO-INI",
          total: 0.01,
          empresa: { cnpj: "11222333000181", razaoSocial: "TESTE" },
          itens: [{ nome: "X", quantidade: 1, precoUnitario: 0.01, total: 0.01 }],
        }),
      /(EMISSAO_FISCAL|desabilitada|Dados fiscais incompletos|ACBr|documentIni|CNPJ)/i,
    );
  });

  await test("gerarPdfFiscal delega em parity", async () => {
    assert.strictEqual(typeof lib.gerarPdfFiscal, "function");
    assert.strictEqual(typeof lib.gerarPdfDanfce, "function");
    assert.strictEqual(typeof lib.gerarPdfDanfe, "function");
  });

  await test("enrichParsePosEmissaoAsync exportado do acbr", async () => {
    const acbr = require("../acbr");
    assert.strictEqual(typeof acbr.enrichParsePosEmissaoAsync, "function");
    assert.strictEqual(typeof acbr.assertAutorizada, "function");
  });

  console.log(`\nacbr-lib-solid: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
