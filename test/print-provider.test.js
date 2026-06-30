#!/usr/bin/env node
/**
 * Testes PrinterProvider — npm run test:print
 */
const assert = require("assert");
const factory = require("../print/factory");
const { assertPrinterProviderContract } = require("../print/contract");
const { renderCupomTags, renderPaginaTeste } = require("../print/cupomAcbrTags");
const { normalizarCupomPayload, validarCupomPayload } = require("../print/cupomValidate");
const { classifyPrintError } = require("../print/printErrors");

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

async function run() {
  console.log("print-provider.test.js\n");

  process.env.PRINTER_PROVIDER = "mock";
  factory.resetPrintProvider();
  const mock = factory.getPrintProvider();
  test("mock provider contrato", () => assertPrinterProviderContract(mock, "mock"));

  process.env.PRINTER_PROVIDER = "native";
  factory.resetPrintProvider();
  test("native provider contrato", () =>
    assertPrinterProviderContract(factory.createProvider("native"), "native"),
  );

  process.env.PRINTER_PROVIDER = "acbr-posprinter";
  process.env.PRINTER_ALLOW_PARITY = "true";
  factory.resetPrintProvider();
  test("acbr-posprinter provider contrato (parity)", () =>
    assertPrinterProviderContract(factory.getPrintProvider(), "acbr-posprinter"),
  );

  test("mock provider — imprimirSegundaVia no contrato", () => {
    assert.strictEqual(typeof mock.imprimirSegundaVia, "function");
  });

  test("normalizarPortaAcbr — TCP para rede", () => {
    const { normalizarPortaAcbr, parsePortaTcp } = require("../print/printerModelMap");
    assert.strictEqual(normalizarPortaAcbr("192.168.0.10:9100"), "TCP:192.168.0.10:9100");
    assert.strictEqual(normalizarPortaAcbr("TCP:10.0.0.5:9100"), "TCP:10.0.0.5:9100");
    assert.deepStrictEqual(parsePortaTcp("TCP:10.0.0.5:9100"), { host: "10.0.0.5", port: 9100 });
  });

  test("printerBootstrap — porta vazia precisa detecção", () => {
    const { portaEfetivaPrecisaDeteccao } = require("../print/printerBootstrap");
    assert.strictEqual(portaEfetivaPrecisaDeteccao(""), true);
    assert.strictEqual(portaEfetivaPrecisaDeteccao("USB"), true);
    assert.strictEqual(portaEfetivaPrecisaDeteccao("TCP:10.0.0.1:9100"), false);
    assert.strictEqual(portaEfetivaPrecisaDeteccao("RAW:Elgin i9"), false);
  });

  test("renderCupomTags — contém tags ACBr e QR", () => {
    const tags = renderCupomTags({
      emitidoEm: new Date().toISOString(),
      numeroVenda: "V-001",
      total: 10.5,
      troco: 0,
      formaPagamento: "pix",
      empresa: { nomeFantasia: "LOJA TESTE", cnpj: "11222333000181" },
      itens: [{ nome: "Produto", quantidade: 1, precoUnitario: 10.5, total: 10.5 }],
      chaveNfe: "35260611222333000181650010000000301025012345",
      qrcodeNfe: "https://example.com/qr",
    });
    assert.ok(tags.includes("</zera>"));
    assert.ok(tags.includes("<qrcode"));
    assert.ok(tags.includes("CUPOM FISCAL"));
    assert.ok(tags.includes("</corte"));
  });

  test("renderCupomTags — desconto e pagamento misto", () => {
    const tags = renderCupomTags({
      emitidoEm: new Date().toISOString(),
      numeroVenda: "V-002",
      total: 90,
      desconto: 10,
      pagamentos: [
        { forma: "pix", valor: 50 },
        { forma: "dinheiro", valor: 50, troco: 10 },
      ],
      empresa: { nomeFantasia: "LOJA" },
      itens: [{ nome: "Item", quantidade: 1, precoUnitario: 100, total: 100 }],
    });
    assert.ok(tags.includes("Desconto:"));
    assert.ok(tags.includes("PIX"));
    assert.ok(tags.includes("TROCO:"));
  });

  test("renderPaginaTeste — página diagnóstico", () => {
    const tags = renderPaginaTeste();
    assert.ok(tags.includes("TESTE IMPRESSORA"));
    assert.ok(tags.includes("<qrcode"));
  });

  test("cupomValidate — NFC-e sem QR rejeita (fail-closed)", () => {
    assert.throws(
      () =>
        validarCupomPayload({
          chaveNfe: "35260611222333000181650010000000301025012345",
          origem: "sefaz",
        }),
      /sem URL de QR Code/,
    );
  });

  test("cupomValidate — offline permite sem QR", () => {
    const p = normalizarCupomPayload({
      chaveNfe: "35260611222333000181650010000000301025012345",
      origem: "offline",
    });
    assert.ok(p);
  });

  test("classifyPrintError — payload permanente não sugere fallback", () => {
    const c = classifyPrintError(new Error("NFC-e autorizada sem URL de QR Code"));
    assert.strictEqual(c.permanente, true);
    assert.strictEqual(c.fallbackSuggested, false);
  });

  test("factory — fallback efetivo acbr unconfigured → native", () => {
    delete process.env.PRINTER_ALLOW_PARITY;
    process.env.PRINTER_PROVIDER = "acbr-posprinter";
    process.env.PRINTER_FALLBACK = "native";
    factory.resetPrintProvider();
    assert.strictEqual(factory.resolveEffectiveProviderName(), "native");
  });

  process.env.PRINTER_PROVIDER = "mock";
  factory.resetPrintProvider();
  await testAsync("mock imprimirCupom registra job", async () => {
    const m = factory.getPrintProvider();
    m._clearJobs();
    await m.imprimirCupom({ numeroVenda: "T-1", total: 1 });
    assert.strictEqual(m._jobs.length, 1);
    assert.strictEqual(m._jobs[0].tipo, "cupom");
  });

  await testAsync("mock imprimirTeste registra job", async () => {
    const m = factory.getPrintProvider();
    m._clearJobs();
    await m.imprimirTeste();
    assert.strictEqual(m._jobs.length, 1);
    assert.strictEqual(m._jobs[0].tipo, "teste");
  });

  await testAsync("printerService imprimirTeste via mock", async () => {
    process.env.PRINTER_PROVIDER = "mock";
    process.env.PRINTER_FALLBACK = "mock";
    factory.resetPrintProvider();
    const ps = require("../printerService");
    ps.resetPrintProvider();
    const mock = factory.getPrintProvider();
    mock._clearJobs();
    const r = await ps.imprimirTeste();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(mock._jobs[0].tipo, "teste");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
