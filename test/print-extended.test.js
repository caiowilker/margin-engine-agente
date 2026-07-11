#!/usr/bin/env node
/**
 * Testes estendidos impressão — npm run test:agent-print
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  tagQrCode,
  tagBarcode,
  tagBarcodesList,
  tagLogoConfig,
  BARCODE_TIPOS,
} = require("../print/acbrTags");
const { renderDanfeTermicoTags } = require("../print/danfeTermico");
const { marcarSegundaVia, montarPayloadSegundaVia } = require("../print/segundaVia");
const { normalizarCupomPayload } = require("../print/cupomValidate");
const { validarAntesEnfileirar } = require("../print/printValidate");
const { renderPayloadTags, escolherRenderizador } = require("../print/renderPrint");
const printerLogo = require("../print/printerLogo");

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

test("acbrTags — QR com margem e tipo", () => {
  const t = tagQrCode("https://x.com", { tipo: "2", margem: 2 });
  assert.ok(t.includes("<qrcode"));
  assert.ok(t.includes("Margem='2'"));
});

test("acbrTags — barcodes EAN13 EAN8 CODE128", () => {
  assert.ok(tagBarcode("EAN13", "7894900011517").includes("EAN13"));
  assert.ok(tagBarcode("EAN8", "96385074").includes("EAN8"));
  assert.ok(tagBarcode("CODE128", "ABC-123").includes("CODE128"));
  assert.ok(BARCODE_TIPOS.PDF417);
});

test("acbrTags — lista barcodes", () => {
  const tags = tagBarcodesList([
    { tipo: "EAN13", code: "7894900011517" },
    { tipo: "CODE128", code: "X" },
  ]);
  assert.strictEqual(tags.length, 2);
});

test("acbrTags — logo config KC", () => {
  const t = tagLogoConfig({ kc1: "48", kc2: "49" });
  assert.ok(t.includes("<logo_kc1>48</logo_kc1>"));
});

test("segundaVia — marcar banner", () => {
  const p = marcarSegundaVia({ numeroVenda: "V1", total: 1 });
  assert.strictEqual(p.segundaVia, true);
  assert.strictEqual(p.reimpressao, true);
});

test("segundaVia — payload direto", () => {
  const p = montarPayloadSegundaVia({
    payload: { numeroVenda: "V2", total: 10, itens: [], empresa: {} },
  });
  assert.strictEqual(p.segundaVia, true);
});

test("danfeTermico — tags NF-e 55", () => {
  const tags = renderDanfeTermicoTags({
    chaveNfe: "35260611222333000181550010000000301025012345",
    numeroVenda: "V-NFE",
    total: 100,
    empresa: { razaoSocial: "EMITENTE" },
    destinatario: { razaoSocial: "CLIENTE" },
    protocolo: "123456789012345",
    qrcodeNfe: "https://example.com/nfe",
  });
  assert.ok(tags.includes("DANFE SIMPLIFICADO"));
  assert.ok(tags.includes("<qrcode"));
  assert.ok(tags.includes("CODE128"));
});

test("renderPrint — escolhe danfe termico", () => {
  assert.strictEqual(
    escolherRenderizador({ chaveNfe: "35260611222333000181550010000000301025012345", danfeTermico: true }),
    "danfe",
  );
  assert.strictEqual(escolherRenderizador({ total: 1, itens: [] }), "cupom");
});

test("renderPayloadTags — cupom longo", () => {
  const tags = renderPayloadTags({
    emitidoEm: new Date().toISOString(),
    numeroVenda: "LONG",
    total: 500,
    empresa: { nomeFantasia: "LOJA" },
    itens: Array.from({ length: 30 }, (_, i) => ({
      nome: `Item ${i}`,
      quantidade: 1,
      precoUnitario: 10,
      total: 10,
    })),
    formaPagamento: "dinheiro",
  });
  assert.ok(tags.length > 800);
  assert.ok(tags.includes("TOTAL:"));
});

test("printerLogo — rejeita nao-BMP", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-test-"));
  process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");
  assert.throws(
    () => printerLogo.salvar({ base64: Buffer.from("PNG").toString("base64") }),
    /BMP monocromático/,
  );
});

test("printerLogo — aceita BMP header", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-bmp-"));
  process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");
  const bmp = Buffer.alloc(64);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  const info = printerLogo.salvar({ base64: bmp.toString("base64"), ativo: true });
  assert.strictEqual(info.ativo, true);
  assert.ok(info.sha256);
});

test("printerLogo — sem BMP não exibe logo", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-empty-"));
  const logoDir = path.join(tmp, "printer");
  fs.mkdirSync(logoDir, { recursive: true });
  const prevData = path.join(__dirname, "..", "data", "printer");
  const { tagLogoHeader } = require("../print/acbrTags");
  printerLogo.remover();
  assert.strictEqual(printerLogo.deveExibirLogoCupom({}), false);
  assert.strictEqual(tagLogoHeader({}), "");
});

test("printerLogo — exibirLogo false no payload ignora BMP", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-off-"));
  process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");
  const bmp = Buffer.alloc(64);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  printerLogo.salvar({ base64: bmp.toString("base64"), ativo: true });
  assert.strictEqual(printerLogo.deveExibirLogoCupom({ exibirLogo: false }), false);
  const { tagLogoHeader } = require("../print/acbrTags");
  assert.strictEqual(tagLogoHeader({ exibirLogo: false }), "");
});

test("cupomValidate — segunda via sem QR não bloqueia impressão", () => {
  const chave = "35260611222333000181550010000000301025012345";
  const p = normalizarCupomPayload(
    { chaveNfe: chave, numeroVenda: "V1", segundaVia: true },
    { relaxQr: true },
  );
  assert.strictEqual(p.chaveNfe, chave);
  const enq = validarAntesEnfileirar("imprimirSegundaVia", [p]);
  assert.ok(enq.args[0].segundaVia);
});

test("cupomValidate — cupom não fiscal sem chave", () => {
  const p = normalizarCupomPayload(
    { numeroVenda: "V2", cupomSemFiscal: true, total: 10 },
    { relaxQr: true },
  );
  assert.strictEqual(p.numeroVenda, "V2");
});

test("printerModelMap — ControlePorta RAW no Windows", () => {
  const { resolveControlePorta } = require("../print/printerModelMap");
  const prev = process.env.PRINTER_CONTROLE_PORTA;
  delete process.env.PRINTER_CONTROLE_PORTA;
  assert.strictEqual(resolveControlePorta("RAW:Elgin i9"), "0");
  assert.strictEqual(resolveControlePorta("TCP:192.168.1.10:9100"), "1");
  process.env.PRINTER_CONTROLE_PORTA = "1";
  assert.strictEqual(resolveControlePorta("RAW:X"), "1");
  if (prev === undefined) delete process.env.PRINTER_CONTROLE_PORTA;
  else process.env.PRINTER_CONTROLE_PORTA = prev;
});

test("acbrPosPrinterErrors — mensagem -10", () => {
  const { formatAcbrPosError } = require("../print/acbrPosPrinterErrors");
  const err = formatAcbrPosError("POS_Imprimir", -10, "Falha ao abrir porta", {
    porta: "RAW:Elgin i9",
  });
  assert.strictEqual(err.acbrRet, -10);
  assert.ok(err.message.includes("(-10)"));
  assert.ok(err.message.includes("RAW:Elgin i9"));
});

test("cupomContraste — modelo 0 usa modo alto (corpo sem negrito)", () => {
  const prev = process.env.PRINTER_MODEL;
  process.env.PRINTER_MODEL = "0";
  delete require.cache[require.resolve("../print/cupomContraste")];
  const { modoContraste, corpo, destaque } = require("../print/cupomContraste");
  assert.strictEqual(modoContraste(), "alto");
  assert.strictEqual(corpo("linha"), "linha");
  assert.strictEqual(destaque("x"), "<n>x</n>");
  if (prev === undefined) delete process.env.PRINTER_MODEL;
  else process.env.PRINTER_MODEL = prev;
});

test("renderCupomTags — corpo principal sem negrito simulado (contraste)", () => {
  const { renderCupomTags } = require("../print/cupomAcbrTags");
  const tags = renderCupomTags({
    emitidoEm: new Date().toISOString(),
    numeroVenda: "V-CONTRASTE",
    total: 10,
    empresa: { nomeFantasia: "LOJA" },
    itens: [{ nome: "Item", quantidade: 1, precoUnitario: 10, total: 10 }],
  });
  assert.ok(tags.includes("Nro:"));
  assert.ok(!tags.includes("<n>Nro:"));
  assert.ok(tags.includes("<n>TOTAL:") || tags.includes("TOTAL:"));
  assert.ok(!tags.includes("</fn>"));
});

test("printFiscalCoord — fiscalEmUso sem lock ativo", () => {
  const { fiscalEmUso } = require("../print/printFiscalCoordination");
  assert.strictEqual(fiscalEmUso(), false);
});

test("printerBootstrap — porta RAW configurada não exige detecção", () => {
  const { portaEfetivaPrecisaDeteccao } = require("../print/printerBootstrap");
  assert.strictEqual(portaEfetivaPrecisaDeteccao("RAW:POSPrinter POS80"), false);
  assert.strictEqual(portaEfetivaPrecisaDeteccao(""), true);
});

test("documentosFiscais — resolverDocumentoFiscalLocal retorna null sem dados", () => {
  const { resolverDocumentoFiscalLocal } = require("../documentosFiscais");
  assert.strictEqual(resolverDocumentoFiscalLocal("00000000000000000000000000000000000000000000", "V-INEXISTENTE"), null);
});

test("acbrPosPrinterRuntime — buildRuntimeValues não usa USB no Windows com porta vazia", () => {
  if (process.platform !== "win32") return;
  const prevPorta = process.env.PRINTER_PORTA;
  const prevName = process.env.PRINTER_NAME;
  delete process.env.PRINTER_PORTA;
  delete process.env.PRINTER_NAME;
  const runtime = require("../print/acbrPosPrinterRuntime");
  const iniPath = runtime.resolveIniPath();
  const fs = require("fs");
  const prevIni = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, "utf8") : null;
  if (fs.existsSync(iniPath)) fs.writeFileSync(iniPath, "[PosPrinter]\nPorta=\nModelo=0\n", "utf8");
  try {
    const vals = runtime.buildRuntimeValues();
    assert.notStrictEqual(vals.PosPrinter.Porta, "USB");
    assert.strictEqual(vals.PosPrinter.Porta, "");
  } finally {
    if (prevPorta === undefined) delete process.env.PRINTER_PORTA;
    else process.env.PRINTER_PORTA = prevPorta;
    if (prevName === undefined) delete process.env.PRINTER_NAME;
    else process.env.PRINTER_NAME = prevName;
    if (prevIni != null) fs.writeFileSync(iniPath, prevIni, "utf8");
  }
});

console.log(`\nprint-extended: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
