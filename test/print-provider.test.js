#!/usr/bin/env node
/**
 * Testes PrinterProvider — npm run test:print
 */
const assert = require("assert");
const factory = require("../print/factory");
const { assertPrinterProviderContract } = require("../print/contract");
const { renderCupomTags, renderPaginaTeste } = require("../print/cupomAcbrTags");
const { renderDanfeTermicoTags } = require("../print/danfeTermico");
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
    const { normalizarPortaAcbr, parsePortaTcp, portaAcbrValida } = require("../print/printerModelMap");
    assert.strictEqual(normalizarPortaAcbr("192.168.0.10:9100"), "TCP:192.168.0.10:9100");
    assert.strictEqual(normalizarPortaAcbr("TCP:10.0.0.5:9100"), "TCP:10.0.0.5:9100");
    assert.deepStrictEqual(parsePortaTcp("TCP:10.0.0.5:9100"), { host: "10.0.0.5", port: 9100 });
    assert.strictEqual(portaAcbrValida("TCP:10.0.0.5:9100"), true);
  });

  test("normalizarPortaAcbr — rejeita TCP sem pontos (192168150)", () => {
    const {
      normalizarPortaAcbr,
      parsePortaTcp,
      portaAcbrValida,
      isValidIpv4Host,
    } = require("../print/printerModelMap");
    assert.strictEqual(isValidIpv4Host("192168150"), false);
    assert.strictEqual(isValidIpv4Host("192.168.1.50"), true);
    assert.strictEqual(parsePortaTcp("TCP:192168150:9100"), null);
    assert.strictEqual(portaAcbrValida("TCP:192168150:9100"), false);
    // Sem fallback → USB (não propaga host inválido)
    assert.strictEqual(normalizarPortaAcbr("TCP:192168150:9100"), "USB");
    // Com nome Windows → RAW
    assert.strictEqual(
      normalizarPortaAcbr("TCP:192168150:9100", { nomeWindows: "POSPrinter POS80" }),
      "RAW:POSPrinter POS80",
    );
  });

  test("inferirModeloAcbr — POS80 → Epson (1)", () => {
    const { inferirModeloAcbr } = require("../print/printerModelMap");
    assert.strictEqual(
      inferirModeloAcbr("POSPrinter POS80", "", { ignoreEnv: true }),
      "1",
    );
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
      numeroNfe: "30",
      serieNfe: "1",
      qrcodeNfe: "https://example.com/qr",
    });
    assert.ok(tags.includes("</zera>"));
    assert.ok(tags.includes("<qrcode"));
    assert.ok(tags.includes("CUPOM FISCAL NFC-e"));
    assert.ok(tags.includes("DOCUMENTO FISCAL NFC-e"));
    assert.ok(tags.includes("NFC-e:"));
    assert.ok(!tags.includes("NF-e:"));
    assert.ok(tags.includes("<n>"));
    assert.ok(!tags.includes("</fn>"));
    assert.ok(tags.includes("TOTAL:"));
    assert.ok(tags.includes("Consulte em"));
    assert.ok(tags.includes("</corte"));
  });

  test("renderDanfeTermicoTags — URL com pipe usa placeholder BMP", () => {
    const qr =
      "https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?p=abc|2|1";
    const tags = renderDanfeTermicoTags({
      numeroVenda: "V-DT",
      total: 100,
      chaveNfe: "31260712343055000183550010000000121000000016",
      qrcodeNfe: qr,
      empresa: { nomeFantasia: "LOJA" },
    });
    const { QR_BMP_PLACEHOLDER } = require("../print/qrCodeAcbrBmp");
    assert.ok(tags.includes(QR_BMP_PLACEHOLDER));
    assert.ok(!tags.includes("<qrcode"));
  });

  test("renderCupomTags — venda cancelada sem bloco fiscal", () => {
    const tags = renderCupomTags({
      emitidoEm: new Date().toISOString(),
      numeroVenda: "V-CANC",
      total: 10,
      vendaCancelada: true,
      naoFiscal: true,
      empresa: { nomeFantasia: "LOJA" },
      itens: [{ nome: "P", quantidade: 1, precoUnitario: 10, total: 10 }],
      segundaVia: true,
    });
    assert.ok(tags.includes("VENDA CANCELADA"));
    assert.ok(tags.includes("CUPOM NAO FISCAL"));
    assert.ok(!tags.includes("DOCUMENTO FISCAL"));
  });

  test("renderCupomTags — NFC-e com URL oficial usa placeholder BMP (pipes quebram ACBr)", () => {
    const qrComPipe =
      "https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=31250612343055000183650010000000031287563639|2|1|1|12.50|abc|000001";
    const tags = renderCupomTags({
      emitidoEm: new Date().toISOString(),
      numeroVenda: "V-QR",
      total: 10,
      empresa: { nomeFantasia: "LOJA" },
      itens: [{ nome: "P", quantidade: 1, precoUnitario: 10, total: 10 }],
      chaveNfe: "35260611222333000181650010000000301025012345",
      qrcodeNfe: qrComPipe,
    });
    const { QR_BMP_PLACEHOLDER } = require("../print/qrCodeAcbrBmp");
    assert.ok(tags.includes(QR_BMP_PLACEHOLDER));
    assert.ok(!tags.includes("<qrcode"));
    assert.ok(tags.includes("Chave de acesso"));
    assert.ok(tags.includes("<ce>"));
  });

  test("renderCupomTags — NFC-e sem QR não inclui tag qrcode", () => {
    const tags = renderCupomTags({
      emitidoEm: new Date().toISOString(),
      numeroVenda: "V-NOQR",
      total: 1,
      empresa: { nomeFantasia: "LOJA" },
      itens: [{ nome: "P", quantidade: 1, precoUnitario: 1, total: 1 }],
      chaveNfe: "35260611222333000181650010000000301025012345",
      origem: "offline",
    });
    assert.ok(!tags.includes("<qrcode"));
    assert.ok(tags.includes("CUPOM FISCAL"));
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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
