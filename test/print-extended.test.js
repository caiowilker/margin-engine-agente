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
const pendentes = [];

function test(name, fn) {
  const registrar = (ok, err) => {
    if (ok) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.error(`  ✗ ${name}:`, err.message);
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      pendentes.push(
        out.then(
          () => registrar(true),
          (e) => registrar(false, e),
        ),
      );
      return;
    }
    registrar(true);
  } catch (e) {
    registrar(false, e);
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
  assert.ok(t.includes("<logo_fatorx>2</logo_fatorx>"));
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

test("segundaVia — banner só com reimpressao/motivo", () => {
  const { deveExibirBannerSegundaVia, montarPayloadCupomFiscalLocal } = require("../print/segundaVia");
  assert.strictEqual(deveExibirBannerSegundaVia({ segundaVia: true }), false);
  assert.strictEqual(deveExibirBannerSegundaVia({ reimpressao: true }), true);
  assert.strictEqual(deveExibirBannerSegundaVia({ motivo: "segunda_via" }), true);
  const local = montarPayloadCupomFiscalLocal({
    payload: { numeroVenda: "V3", total: 1, itens: [], empresa: {} },
  });
  assert.strictEqual(local.segundaVia, false);
  assert.strictEqual(local.reimpressao, false);
  assert.strictEqual(deveExibirBannerSegundaVia(local), false);
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

test("printerLogo — converte PNG para BMP 1-bpp", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-png-"));
  process.env.MARGIN_ENGINE_ROOT = tmp;
  process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");
  printerLogo.__test.resetCaches();
  // PNG 1x1 via sharp-friendly buffer: use makeTest path — tiny valid PNG
  const sharp = require("sharp");
  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  const info = await printerLogo.salvar({ base64: png.toString("base64"), ativo: true });
  assert.strictEqual(info.ativo, true);
  assert.ok(info.imprimivel);
  assert.ok(printerLogo.isBmp1bppPrintable(printerLogo.lerBuffer()));
  assert.strictEqual(printerLogo.deveExibirLogoCupom({}), true);
  assert.strictEqual(printerLogo.getLastLogoSkipReason(), null);
});

test("printerLogo — rejeita lixo sem imagem", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-test-"));
  process.env.MARGIN_ENGINE_ROOT = tmp;
  process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");
  await assert.rejects(
    () => printerLogo.salvar({ base64: Buffer.from("not-an-image").toString("base64") }),
    /Logo inválida/,
  );
});

test("printerLogo — aceita BMP 1-bpp válido", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-bmp-"));
  process.env.MARGIN_ENGINE_ROOT = tmp;
  process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");
  printerLogo.__test.resetCaches();
  const bmp = printerLogo.makeTestBmp1bpp(16, 8);
  const info = await printerLogo.salvar({ base64: bmp.toString("base64"), ativo: true });
  assert.strictEqual(info.ativo, true);
  assert.ok(info.sha256);
  assert.ok(info.imprimivel);
});

test("printerLogo — sem BMP não exibe logo", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-empty-"));
  process.env.MARGIN_ENGINE_ROOT = tmp;
  printerLogo.__test.resetCaches();
  const { tagLogoHeader } = require("../print/acbrTags");
  printerLogo.remover();
  assert.strictEqual(printerLogo.deveExibirLogoCupom({}), false);
  assert.strictEqual(printerLogo.getLastLogoSkipReason(), "sem_arquivo");
  assert.strictEqual(tagLogoHeader({}), "");
});

test("printerLogo — exibirLogo false no payload ignora BMP", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-off-"));
  process.env.MARGIN_ENGINE_ROOT = tmp;
  process.env.PRINTER_LOCAL_ENV_OVERRIDE = path.join(tmp, ".env");
  printerLogo.__test.resetCaches();
  const bmp = printerLogo.makeTestBmp1bpp(8, 8);
  await printerLogo.salvar({ base64: bmp.toString("base64"), ativo: true });
  assert.strictEqual(printerLogo.deveExibirLogoCupom({ exibirLogo: false }), false);
  assert.strictEqual(printerLogo.getLastLogoSkipReason(), "toggle_off");
  const { tagLogoHeader } = require("../print/acbrTags");
  assert.strictEqual(tagLogoHeader({ exibirLogo: false }), "");
});

test("printerLogo — tagLogoHeader inclui bmp path quando ativo", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logo-tag-"));
  process.env.MARGIN_ENGINE_ROOT = tmp;
  printerLogo.__test.resetCaches();
  await printerLogo.salvar({
    base64: printerLogo.makeTestBmp1bpp(8, 8).toString("base64"),
    ativo: true,
  });
  const { tagLogoHeader } = require("../print/acbrTags");
  const tags = tagLogoHeader({});
  assert.ok(/<bmp\b/i.test(tags), tags);
});

test("printMetrics — record/get", () => {
  const m = require("../print/printMetrics");
  m.recordPrintResult({
    durationMs: 120,
    provider: "acbr-posprinter",
    op: "imprimirTeste",
    logoIncluded: true,
    logoSkipReason: null,
    ok: true,
  });
  const g = m.getLastPrintMetrics();
  assert.strictEqual(g.durationMs, 120);
  assert.strictEqual(g.provider, "acbr-posprinter");
  assert.strictEqual(g.logoIncluded, true);
});

test("diagnostico — inclui acbr_deps e logo_imprimivel", () => {
  const diag = require("../print/diagnosticoImpressao");
  const r = diag.coletarDiagnosticoImpressaoSync({});
  const ids = r.checks.map((c) => c.id);
  assert.ok(ids.includes("acbr_deps"), ids.join(","));
  assert.ok(ids.includes("porta_raw_valida") || ids.includes("acbr_circuito"), ids.join(","));
});

test("impressoraCore — teste nativo chama logo", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../print/escpos/impressoraCore.js"),
    "utf8",
  );
  const fn = src.slice(src.indexOf("function imprimirTeste"), src.indexOf("function imprimirFechamento"));
  assert.ok(fn.includes("imprimirLogoCupomEscpos"), "teste native deve imprimir logo");
});

test("danfeTermico — respeita exibirLogo false", () => {
  const tags = renderDanfeTermicoTags({
    numeroVenda: "V1",
    empresa: { nomeFantasia: "Loja", cnpj: "00" },
    chaveNfe: "31260712343055000183550010000000121000000016",
    exibirLogo: false,
  });
  assert.ok(!/<logo>/i.test(tags) && !/logo/i.test(tags.split("\n")[1] || ""));
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

/** Isola INI/.env: portaEhRawWindows() lê printerLocalConfig antes do env. */
function withCleanPrinterPorta(fn) {
  const runtime = require("../print/acbrPosPrinterRuntime");
  const localCfg = require("../print/printerLocalConfig");
  const iniPath = runtime.resolveIniPath();
  const prevPorta = process.env.PRINTER_PORTA;
  const prevIni = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, "utf8") : null;
  delete process.env.PRINTER_PORTA;
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  fs.writeFileSync(iniPath, "[PosPrinter]\nPorta=\nModelo=1\n", "utf8");
  if (typeof localCfg.invalidateLerCache === "function") localCfg.invalidateLerCache();
  runtime.resetAcbrPosCircuit();
  try {
    return fn({ iniPath, runtime });
  } finally {
    if (prevPorta === undefined) delete process.env.PRINTER_PORTA;
    else process.env.PRINTER_PORTA = prevPorta;
    if (prevIni != null) fs.writeFileSync(iniPath, prevIni, "utf8");
    else {
      try {
        fs.unlinkSync(iniPath);
      } catch (_) {}
    }
    if (typeof localCfg.invalidateLerCache === "function") localCfg.invalidateLerCache();
    runtime.resetAcbrPosCircuit();
  }
}

test("printFiscalCoord — fiscalEmUso sem lock ativo", () => {
  const {
    fiscalEmUso,
    fiscalAcabouDeUsar,
    isFastNativePath,
  } = require("../print/printFiscalCoordination");
  assert.strictEqual(fiscalEmUso(), false);
  assert.strictEqual(fiscalAcabouDeUsar(1), false);
  const prev = process.env.PRINT_FAST_NATIVE;
  delete process.env.PRINT_FAST_NATIVE;
  try {
    withCleanPrinterPorta(() => {
      // Default raw: sem porta RAW → ACBr; gaveta sempre native
      assert.strictEqual(isFastNativePath({ payload: { naoFiscal: true } }), false);
      assert.strictEqual(isFastNativePath({ op: "imprimirPedido" }), false);
      assert.strictEqual(isFastNativePath({ op: "abrirGaveta" }), true);

      // RAW:Windows comercial → native (evita Ativar hang)
      process.env.PRINTER_PORTA = "RAW:POSPrinter POS80";
      assert.strictEqual(isFastNativePath({ payload: { naoFiscal: true } }), true);
      assert.strictEqual(isFastNativePath({ op: "imprimirPedido" }), true);
      assert.strictEqual(isFastNativePath({ op: "abrirGaveta" }), true);
      assert.strictEqual(
        isFastNativePath({
          payload: { chaveNfe: "3526" + "0".repeat(40), naoFiscal: false },
        }),
        false,
      );

      delete process.env.PRINTER_PORTA;
      process.env.PRINT_FAST_NATIVE = "true";
      assert.strictEqual(isFastNativePath({ payload: { naoFiscal: true } }), true);
      assert.strictEqual(isFastNativePath({ op: "imprimirPedido" }), true);
      assert.strictEqual(
        isFastNativePath({
          payload: { chaveNfe: "3526" + "0".repeat(40), naoFiscal: false },
        }),
        false,
      );
    });
  } finally {
    if (prev === undefined) delete process.env.PRINT_FAST_NATIVE;
    else process.env.PRINT_FAST_NATIVE = prev;
  }
});

test("imprimirLogoCupomEscpos — hot path sem Image.load / sharp (só cache rawBytes)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../print/escpos/impressoraCore.js"),
    "utf8",
  );
  const fnStart = src.indexOf("async function imprimirLogoCupomEscpos");
  const fnEnd = src.indexOf("async function renderCupomConteudo", fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart);
  const body = src
    .slice(fnStart, fnEnd)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.ok(body.includes("logo_hotpath_cache_miss"));
  assert.ok(body.includes("rawBytes"));
  assert.ok(body.includes("exibirLogoCupomHabilitado"));
  assert.ok(!/escpos\.Image\.load/.test(body), "hot path não pode Image.load");
  assert.ok(!/prepararArquivoEscpos/.test(body), "hot path não pode sharp/prepararArquivo");
  assert.ok(!/printer\.image\(/.test(body), "hot path não pode toBitmap via image()");
  assert.ok(!/get-pixels/.test(body));
  assert.ok(!/\.ler\(\)/.test(body), "hot path não pode ler() (BMP sync)");
});

test("RAW script — ASCII-only (PowerShell 5.1 sem BOM)", () => {
  const core = require("../print/escpos/impressoraCore");
  const content = core.buildRawPrintScriptContent
    ? core.buildRawPrintScriptContent("C:\\\\x\\\\RawPrinterHelper.dll")
    : null;
  // Se não exportado, valida o fonte.
  const src = fs.readFileSync(
    path.join(__dirname, "../print/escpos/impressoraCore.js"),
    "utf8",
  );
  const marker = src.indexOf("function buildRawPrintScriptContent");
  const end = src.indexOf("function ensureRawPrintScript", marker);
  const builder = src.slice(marker, end);
  assert.ok(
    !/ausente —/.test(builder),
    "em-dash Unicode no PS1 quebra PowerShell 5.1 (ParserError) e zera impressão",
  );
  assert.ok(/ausente - aquecimento/.test(builder));
  if (content) {
    assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(content), "script RAW deve ser ASCII");
  }
});

test("preferNativeEscPos — naoFiscal rápido; fiscal com chave fica no ACBr", () => {
  const { preferNativeEscPos } = require("../print/drivers/acbrPosPrinterProvider");
  const prev = process.env.PRINT_FAST_NATIVE;
  process.env.PRINT_FAST_NATIVE = "true";
  try {
    assert.strictEqual(preferNativeEscPos({ naoFiscal: true, numeroVenda: "V1" }), true);
    assert.strictEqual(preferNativeEscPos({ cupomSemFiscal: true }), true);
    assert.strictEqual(
      preferNativeEscPos({ chaveNfe: "3526" + "0".repeat(40), naoFiscal: false }),
      false,
    );
    assert.strictEqual(preferNativeEscPos({ layout: "danfe-termico" }), false);
    assert.strictEqual(preferNativeEscPos({}), true);
  } finally {
    if (prev === undefined) delete process.env.PRINT_FAST_NATIVE;
    else process.env.PRINT_FAST_NATIVE = prev;
  }
});

test("preferNativeEscPos — sem RAW (default raw) permanece ACBr", () => {
  const { preferNativeEscPos } = require("../print/drivers/acbrPosPrinterProvider");
  const prev = process.env.PRINT_FAST_NATIVE;
  delete process.env.PRINT_FAST_NATIVE;
  try {
    withCleanPrinterPorta(() => {
      assert.strictEqual(preferNativeEscPos({ naoFiscal: true }), false);
      assert.strictEqual(preferNativeEscPos({}), false);
    });
  } finally {
    if (prev === undefined) delete process.env.PRINT_FAST_NATIVE;
    else process.env.PRINT_FAST_NATIVE = prev;
  }
});

test("preferNativeEscPos — PRINT_FAST_NATIVE=false em RAW ainda usa native (anti-hang)", () => {
  const { preferNativeEscPos } = require("../print/drivers/acbrPosPrinterProvider");
  const runtime = require("../print/acbrPosPrinterRuntime");
  const prev = process.env.PRINT_FAST_NATIVE;
  const prevPorta = process.env.PRINTER_PORTA;
  process.env.PRINT_FAST_NATIVE = "false";
  process.env.PRINTER_PORTA = "RAW:POSPrinter POS80";
  runtime.resetAcbrPosCircuit();
  try {
    assert.strictEqual(preferNativeEscPos({ naoFiscal: true }), true);
    assert.strictEqual(preferNativeEscPos({}), true);
    assert.strictEqual(
      preferNativeEscPos({ chaveNfe: "35" + "0".repeat(42), naoFiscal: false }),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.PRINT_FAST_NATIVE;
    else process.env.PRINT_FAST_NATIVE = prev;
    if (prevPorta === undefined) delete process.env.PRINTER_PORTA;
    else process.env.PRINTER_PORTA = prevPorta;
    runtime.resetAcbrPosCircuit();
  }
});

test("preferNativeEscPos — PRINT_FAST_NATIVE=false em TCP força ACBr comercial", () => {
  const { preferNativeEscPos } = require("../print/drivers/acbrPosPrinterProvider");
  const runtime = require("../print/acbrPosPrinterRuntime");
  const prev = process.env.PRINT_FAST_NATIVE;
  const prevPorta = process.env.PRINTER_PORTA;
  const origOpen = runtime.isAcbrPosCircuitOpen;
  process.env.PRINT_FAST_NATIVE = "false";
  process.env.PRINTER_PORTA = "TCP:192.168.1.50:9100";
  runtime.isAcbrPosCircuitOpen = () => false;
  try {
    assert.strictEqual(preferNativeEscPos({ naoFiscal: true }), false);
    assert.strictEqual(preferNativeEscPos({}), false);
  } finally {
    runtime.isAcbrPosCircuitOpen = origOpen;
    if (prev === undefined) delete process.env.PRINT_FAST_NATIVE;
    else process.env.PRINT_FAST_NATIVE = prev;
    if (prevPorta === undefined) delete process.env.PRINTER_PORTA;
    else process.env.PRINTER_PORTA = prevPorta;
    runtime.resetAcbrPosCircuit();
  }
});

test("preferNativeEscPos — RAW:Windows comercial usa native (default raw)", () => {
  const { preferNativeEscPos } = require("../print/drivers/acbrPosPrinterProvider");
  const runtime = require("../print/acbrPosPrinterRuntime");
  const prev = process.env.PRINT_FAST_NATIVE;
  const prevPorta = process.env.PRINTER_PORTA;
  delete process.env.PRINT_FAST_NATIVE;
  process.env.PRINTER_PORTA = "RAW:POSPrinter POS80";
  runtime.resetAcbrPosCircuit();
  try {
    assert.strictEqual(preferNativeEscPos({ naoFiscal: true }), true);
    assert.strictEqual(preferNativeEscPos({}), true);
    assert.strictEqual(
      preferNativeEscPos({ chaveNfe: "35" + "0".repeat(42), naoFiscal: false }),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.PRINT_FAST_NATIVE;
    else process.env.PRINT_FAST_NATIVE = prev;
    if (prevPorta === undefined) delete process.env.PRINTER_PORTA;
    else process.env.PRINTER_PORTA = prevPorta;
    runtime.resetAcbrPosCircuit();
  }
});

test("preferNativeEscPos — circuito RAW aberto usa native em comercial e fiscal", () => {
  const { preferNativeEscPos } = require("../print/drivers/acbrPosPrinterProvider");
  const runtime = require("../print/acbrPosPrinterRuntime");
  const prev = process.env.PRINT_FAST_NATIVE;
  const prevPorta = process.env.PRINTER_PORTA;
  delete process.env.PRINT_FAST_NATIVE;
  process.env.PRINTER_PORTA = "RAW:POSPrinter POS80";
  runtime.resetAcbrPosCircuit();
  try {
    runtime.openAcbrPosCircuit("POS_Ativar (-10)");
    assert.strictEqual(preferNativeEscPos({ naoFiscal: true }), true);
    assert.strictEqual(preferNativeEscPos({}), true);
    assert.strictEqual(
      preferNativeEscPos({ chaveNfe: "35" + "0".repeat(42) }),
      true,
      "RAW + circuito: fiscal native (sem Ativar tax)",
    );
  } finally {
    if (prev === undefined) delete process.env.PRINT_FAST_NATIVE;
    else process.env.PRINT_FAST_NATIVE = prev;
    if (prevPorta === undefined) delete process.env.PRINTER_PORTA;
    else process.env.PRINTER_PORTA = prevPorta;
    runtime.resetAcbrPosCircuit();
  }
});

test("printerModelMap — Epson/POS80 → modelo 1 (enum ACBr oficial)", () => {
  const { inferirModeloAcbr } = require("../print/printerModelMap");
  assert.strictEqual(inferirModeloAcbr("EPSON TM-T20", ""), "1");
  assert.strictEqual(inferirModeloAcbr("POSPrinter POS80", ""), "1");
  assert.strictEqual(inferirModeloAcbr("Bematech MP-4200", ""), "2");
});

test("printExecutor — hardDrainMs curto (PDV comercial)", () => {
  const { hardDrainMs } = require("../print/printExecutor");
  const prev = process.env.PRINT_HARD_DRAIN_MS;
  delete process.env.PRINT_HARD_DRAIN_MS;
  try {
    assert.ok(hardDrainMs(4000) <= 2000);
    assert.ok(hardDrainMs(4000) >= 1000);
    assert.ok(hardDrainMs(12000) <= 2000);
  } finally {
    if (prev === undefined) delete process.env.PRINT_HARD_DRAIN_MS;
    else process.env.PRINT_HARD_DRAIN_MS = prev;
  }
});

test("printErrors — hard drain genérico sem fase NÃO sugere fallback", () => {
  const { classifyPrintError } = require("../print/printErrors");
  const err = new Error("Timeout hard");
  err.code = "PRINT_HARD_DRAIN";
  err.printTimedOut = true;
  const cls = classifyPrintError(err);
  assert.strictEqual(cls.retryable, false);
  assert.strictEqual(cls.fallbackSuggested, false);
});

test("printErrors — hard drain fase config sugere fallback", () => {
  const { classifyPrintError } = require("../print/printErrors");
  const err = new Error("Timeout de impressão (4000+2000ms) — envio não concluiu");
  err.code = "PRINT_HARD_DRAIN";
  err.printTimedOut = true;
  err.acbrPhase = "config";
  const cls = classifyPrintError(err);
  assert.strictEqual(cls.fallbackSuggested, true);
});

test("printErrors — RAW_PRINT_TIMEOUT nunca sugere fallback", () => {
  const { classifyPrintError } = require("../print/printErrors");
  const err = new Error("RAW Windows timeout");
  err.code = "RAW_PRINT_TIMEOUT";
  err.printTimedOut = true;
  err.acbrPhase = "idle";
  assert.strictEqual(classifyPrintError(err).fallbackSuggested, false);
});

test("printErrors — timeout pré-impressão ConfigGravar sugere fallback", () => {
  const { classifyPrintError } = require("../print/printErrors");
  const err = new Error(
    "Timeout de impressão (4000ms): [ACBrPosPrinter] POS_ConfigGravarValor ret=-10",
  );
  err.code = "PRINT_TIMEOUT";
  err.printTimedOut = true;
  err.acbrRet = -10;
  const cls = classifyPrintError(err);
  assert.strictEqual(cls.retryable, false);
  assert.strictEqual(cls.fallbackSuggested, true);
});

test("printErrors — worker timeout imprimirTags NÃO sugere fallback (anti-dupla)", () => {
  const { classifyPrintError } = require("../print/printErrors");
  const err = new Error("Timeout ACBr PosPrinter worker (5000ms) cmd=imprimirTags");
  err.code = "ACBR_POS_WORKER_KILLED";
  err.printTimedOut = true;
  err.acbrPhase = "imprimir";
  const cls = classifyPrintError(err);
  assert.strictEqual(cls.retryable, false);
  assert.strictEqual(cls.fallbackSuggested, false);
});

test("printErrors — worker timeout init sugere fallback", () => {
  const { classifyPrintError } = require("../print/printErrors");
  const err = new Error("Timeout ACBr PosPrinter worker (5000ms) cmd=init");
  err.code = "ACBR_POS_WORKER_KILLED";
  err.printTimedOut = true;
  err.acbrPhase = "init";
  assert.strictEqual(classifyPrintError(err).fallbackSuggested, true);
});

test("printerLocalConfig — PaginaDeCodigo UTF8=5 e CortaPapel coerente", () => {
  const {
    normalizePaginaDeCodigo,
    encodingToPaginaDeCodigo,
    cutToIniFields,
    gerarIniContent,
  } = require("../print/printerLocalConfig");
  assert.strictEqual(normalizePaginaDeCodigo("65001"), "5");
  assert.strictEqual(encodingToPaginaDeCodigo("UTF8"), "5");
  assert.deepStrictEqual(cutToIniFields("total"), { cortaPapel: "1", tipoCorte: "0" });
  assert.deepStrictEqual(cutToIniFields("partial"), { cortaPapel: "1", tipoCorte: "1" });
  assert.deepStrictEqual(cutToIniFields("none"), { cortaPapel: "0", tipoCorte: "0" });
  const ini = gerarIniContent({
    modelo: "1",
    porta: "RAW:POS80",
    pageCode: "65001",
    cut: "total",
    colunas: "48",
  });
  assert.ok(/PaginaDeCodigo=5/.test(ini));
  assert.ok(/CortaPapel=1/.test(ini));
  assert.ok(/TipoCorte=0/.test(ini));
});

test("isFastNativePath — circuito RAW aberto força fiscal native", () => {
  const { isFastNativePath } = require("../print/printFiscalCoordination");
  const runtime = require("../print/acbrPosPrinterRuntime");
  const prev = process.env.PRINT_FAST_NATIVE;
  const prevPorta = process.env.PRINTER_PORTA;
  delete process.env.PRINT_FAST_NATIVE;
  process.env.PRINTER_PORTA = "RAW:POSPrinter POS80";
  runtime.resetAcbrPosCircuit();
  try {
    runtime.openAcbrPosCircuit("test-fiscal");
    assert.strictEqual(isFastNativePath({ payload: { naoFiscal: true } }), true);
    assert.strictEqual(
      isFastNativePath({
        payload: { chaveNfe: "35" + "0".repeat(42), naoFiscal: false },
      }),
      true,
    );
  } finally {
    if (prev === undefined) delete process.env.PRINT_FAST_NATIVE;
    else process.env.PRINT_FAST_NATIVE = prev;
    if (prevPorta === undefined) delete process.env.PRINTER_PORTA;
    else process.env.PRINTER_PORTA = prevPorta;
    runtime.resetAcbrPosCircuit();
  }
});

test("printerBootstrap — porta RAW configurada não exige detecção", () => {
  const { portaEfetivaPrecisaDeteccao } = require("../print/printerBootstrap");
  assert.strictEqual(portaEfetivaPrecisaDeteccao("RAW:POSPrinter POS80"), false);
  assert.strictEqual(portaEfetivaPrecisaDeteccao(""), true);
});

test("qrCodeAcbrBmp — URL com pipe usa placeholder e gera BMP", async () => {
  const {
    qrPrecisaBmp,
    tagQrBmpPlaceholder,
    resolverQrBmpPlaceholders,
    gerarBmpQrAcbr,
    QR_BMP_PLACEHOLDER,
  } = require("../print/qrCodeAcbrBmp");
  const url =
    "https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=abc|2|1|1|10|hash|1";
  assert.strictEqual(qrPrecisaBmp(url), true);
  assert.strictEqual(tagQrBmpPlaceholder(), QR_BMP_PLACEHOLDER);
  const resolvido = await resolverQrBmpPlaceholders(
    `pix\n${QR_BMP_PLACEHOLDER}\nnfce\n${QR_BMP_PLACEHOLDER}`,
    {
      qrcodeNfe: url,
      pagamentos: [{ forma: "pix", valor: 10, pixCopiaCola: url }],
    },
  );
  assert.ok(!resolvido.includes(QR_BMP_PLACEHOLDER));
  assert.ok(resolvido.includes("<bmp>"));

  // BMP físico deve ser monocromático válido (header BM, 1 bpp)
  const bmpPath = await gerarBmpQrAcbr(url);
  const buf = fs.readFileSync(bmpPath);
  assert.strictEqual(buf.toString("ascii", 0, 2), "BM");
  assert.strictEqual(buf.readUInt32LE(2), buf.length);
  assert.strictEqual(buf.readUInt16LE(28), 1); // 1 bpp
  assert.ok(buf.readInt32LE(18) >= 100); // largura útil para leitura
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

Promise.all(pendentes).then(() => {
  console.log(`\nprint-extended: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
